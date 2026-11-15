/** Host-owned generation lifecycle, independent of mounted Chats and live Agents. */
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { DeliverablePublisher } from '@deepseek-ai/dsh-tool-present'
import { CreationStore } from './store.ts'
import { CreationSerial } from './serial.ts'
import { existingOutput, importOutput } from './media.ts'
import type { JobRecord } from './schema.ts'
import type { AssetId, CancelReceipt, CreationIssue, CreationProvider, JobId, ProviderRuntime, ProviderSnapshot } from './types.ts'

export interface RunnerDependencies {
  store: CreationStore
  provider(id: string): CreationProvider | undefined
  publisher: Pick<DeliverablePublisher, 'publish'>
  maxBytes: number
  pollMs: number
  report(error: unknown): void
}

/** Errors are retained at the failed stage; retry never implicitly generates a new output. */
export class CreationJobRunner {
  private readonly active = new Map<JobId, { controller: AbortController; promise: Promise<void> }>()
  private readonly commits = new CreationSerial()
  private closed = false
  constructor(private readonly deps: RunnerDependencies) {}

  recover(): void {
    for (const [, job] of this.deps.store.jobs.entries()) {
      if (!['completed', 'cancelled', 'failed', 'blocked', 'awaiting-approval'].includes(job.state)
        && (job.generationDone || this.deps.provider(job.connection.providerId) !== undefined)) this.start(job.id)
    }
  }

  async suspendProvider(providerId: string): Promise<void> {
    const pending: Promise<void>[] = []
    for (const [id, entry] of this.active) if (this.deps.store.get(id).connection.providerId === providerId) {
      entry.controller.abort()
      pending.push(entry.promise)
    }
    await Promise.allSettled(pending)
  }

  start(id: JobId): void {
    if (this.closed || this.active.has(id)) return
    const controller = new AbortController()
    const promise = Promise.resolve().then(() => this.run(id, controller.signal)).catch((error: unknown) => {
      this.deps.report(error)
    }).finally(() => { this.active.delete(id) })
    this.active.set(id, { controller, promise })
  }

  async retry(id: JobId): Promise<void> {
    const job = this.deps.store.get(id)
    if (job.state === 'awaiting-approval') return
    if (job.cancellation !== undefined) throw new Error('Cancelled tasks cannot resume generation or delivery')
    if (job.issues.some(value => value.recovery === 'new-generation') && job.outputs.length === 0) {
      throw new Error('Generation failed; submit a new request to generate again')
    }
    if (this.active.has(id)) return
    await this.deps.store.update(id, value => value.cancellation !== undefined ? value : ({ ...value,
      state: value.generationDone ? 'materializing' : value.state === 'queued' ? 'queued' : 'reconciling',
      issues: value.generationDone
        ? value.issues.filter(issue => issue.stage === 'configuration' || issue.stage === 'submission' || issue.stage === 'generation') : [],
    }))
    this.start(id)
  }

  /** Persist consent before execution; a restarted Host resumes only this draft and ceiling. */
  async approve(id: JobId, quoteId: string): Promise<void> {
    if (this.deps.store.get(id).state === 'awaiting-approval') await this.active.get(id)?.promise
    await this.commits.run(id, async () => {
      const job = this.deps.store.get(id)
      if (job.cancellation !== undefined) throw new Error('This generation was cancelled')
      if (job.approval?.quoteId !== quoteId) throw new Error('The quote has changed; review the current quote')
      if (job.state === 'approving' || (job.approvedCredits !== undefined && job.state !== 'awaiting-approval')) return
      if (job.state !== 'awaiting-approval') throw new Error('This generation is not awaiting approval')
      if (this.deps.provider(job.connection.providerId)?.approve === undefined) throw new Error('The Provider cannot resume this generation')
      await this.deps.store.update(id, current => ({ ...current, state: 'approving', approvedCredits: job.approval?.credits }))
    })
    this.start(id)
  }

  async cancel(id: JobId): Promise<CancelReceipt> {
    await this.commits.run(id, async () => {
      const job = this.deps.store.get(id)
      if (job.state === 'completed') return
      await this.deps.store.update(id, current => ({ ...current, state: 'cancelled',
        outputs: current.outputs.map(output => output.delivery === 'published' || output.delivery === 'projected' ? output : { ...output, delivery: 'suppressed' }), cancellation: {
          jobId: id, futureDelivery: 'suppressed', provider: { state: 'requested' },
        } }))
      this.active.get(id)?.controller.abort()
    })
    const job = this.deps.store.get(id)
    if (job.state === 'completed') return { jobId: id, futureDelivery: 'already-settled', provider: { state: 'already-terminal' } }
    const provider = this.deps.provider(job.connection.providerId)
    let result: CancelReceipt['provider']
    try {
      result = provider === undefined ? { state: 'unsupported' } : await provider.cancel(job.checkpoint, this.runtime(job, AbortSignal.timeout(30_000)))
    } catch (error) { result = { state: 'unknown', issue: this.issue('cancellation', error, 'retry-cancellation') } }
    const cancellation: CancelReceipt = { jobId: id, futureDelivery: 'suppressed', provider: result }
    await this.deps.store.update(id, current => ({ ...current, cancellation }))
    return cancellation
  }

  private runtime(job: JobRecord, signal: AbortSignal): ProviderRuntime {
    return { operationId: job.operationId, connection: job.connection, signal, workDirectory: job.directory, maxBytes: this.deps.maxBytes,
      checkpoint: async (value) => { await this.deps.store.update(job.id, current => ({ ...current, checkpoint: value })) },
    }
  }

  private async run(id: JobId, signal: AbortSignal): Promise<void> {
    try {
      let job = this.deps.store.get(id)
      if (job.cancellation !== undefined || job.state === 'awaiting-approval' || job.state === 'completed') return
      const provider = this.deps.provider(job.connection.providerId)
      if (provider === undefined && !job.generationDone) throw new Error('The generation Provider is not loaded')
      await mkdir(job.directory, { recursive: true })
      if (!job.generationDone) {
        if (provider === undefined) throw new Error('The generation Provider is not loaded')
        const first = job.state === 'queued'
        const approving = job.state === 'approving'
        job = await this.deps.store.update(id, current => current.cancellation !== undefined ? current
          : ({ ...current, state: first ? 'submitting' : approving ? 'approving' : 'reconciling' }))
        signal.throwIfAborted()
        if (job.cancellation !== undefined) return
        let snapshot = approving ? await this.resumeApproval(provider, job, signal)
          : first ? await provider.submit(job.request, this.runtime(job, signal))
            : await provider.reconcile(job.request, job.checkpoint, this.runtime(job, signal))
        for (;;) {
          signal.throwIfAborted()
          const proceed = await this.recordSnapshot(id, snapshot)
          if (!proceed) return
          await this.deliver(id, provider, signal)
          job = this.deps.store.get(id)
          if (job.generationDone) break
          await delay(this.deps.pollMs, undefined, { signal })
          snapshot = await provider.reconcile(job.request, job.checkpoint, this.runtime(job, signal))
        }
      } else await this.deliver(id, provider, signal)
      await this.commits.run(id, async () => {
        if (this.deps.store.get(id).cancellation !== undefined) return
        await this.deps.store.update(id, current => ({ ...current,
          state: current.outputs.some(value => value.delivery === 'failed') || current.issues.length > 0 ? 'failed' : 'completed',
        }))
      })
    } catch (error) {
      if (signal.aborted) return
      const job = this.deps.store.get(id)
      const stage = job.generationDone ? 'materialization' : job.state === 'submitting' ? 'submission' : 'generation'
      const issue = this.issue(stage, error, job.generationDone ? 'retry-transfer' : 'check-status')
      await this.deps.store.update(id, current => current.cancellation !== undefined ? current : ({ ...current, state: job.generationDone ? 'failed' : 'blocked', issues: [issue] }))
    }
  }

  private async resumeApproval(provider: CreationProvider, job: JobRecord, signal: AbortSignal): Promise<ProviderSnapshot> {
    if (provider.approve === undefined || job.checkpoint === undefined || job.approvedCredits === undefined) {
      throw new Error('The approved generation cannot resume without its saved draft and credit limit')
    }
    return provider.approve(job.request, job.checkpoint, job.approvedCredits, this.runtime(job, signal))
  }

  private async recordSnapshot(id: JobId, snapshot: ProviderSnapshot): Promise<boolean> {
    if (snapshot.state === 'awaiting-approval') {
      await this.deps.store.update(id, current => current.cancellation !== undefined ? current : ({ ...current,
        state: 'awaiting-approval', checkpoint: snapshot.checkpoint, generationDone: false, issues: [],
        approval: { ...snapshot.approval, quoteId: randomUUID() }, approvedCredits: undefined,
      }))
      return false
    }
    if (snapshot.state === 'submission-unknown' || snapshot.state === 'not-submitted') {
      await this.deps.store.update(id, current => current.cancellation !== undefined ? current : ({ ...current, state: 'blocked', issues: [{ stage: 'submission',
        code: snapshot.state, message: snapshot.state === 'not-submitted' ? 'No submitted task was found; submit a new generation request' : snapshot.message,
        recovery: snapshot.state === 'not-submitted' ? 'new-generation' : 'check-status' }] }))
      return false
    }
    await this.deps.store.update(id, (current) => {
      if (current.cancellation !== undefined) return current
      const outputs = [...current.outputs]
      for (const output of snapshot.outputs ?? []) {
        const prior = outputs.find(value => value.output.outputId === output.outputId)
        if (prior !== undefined) continue
        if (output.kind !== current.request.kind) throw new Error('Provider returned an unexpected media type')
        if (outputs.length >= current.maxOutputs) throw new Error('Provider exceeded the configured output limit')
        const assetId = randomUUID() as AssetId
        outputs.push({ assetId, output, filename: output.suggestedFilename ?? `${output.kind}-${outputs.length + 1}`, delivery: 'pending', issues: [] })
      }
      return { ...current, outputs, state: snapshot.state === 'failed' ? 'failed' : snapshot.state === 'completed' ? 'materializing' : 'running',
        generationDone: snapshot.state !== 'running',
        ...(snapshot.state === 'running' ? { checkpoint: snapshot.checkpoint } : {}),
        issues: snapshot.state === 'failed' ? [snapshot.issue] : current.issues }
    })
    if (snapshot.state === 'failed' && this.deps.store.get(id).outputs.length === 0) return false
    return true
  }

  private async deliver(id: JobId, provider: CreationProvider | undefined, signal: AbortSignal): Promise<void> {
    for (const output of this.deps.store.get(id).outputs) {
      signal.throwIfAborted()
      if (output.delivery === 'published' || output.delivery === 'projected' || output.delivery === 'suppressed') continue
      let job = this.deps.store.get(id)
      if (job.cancellation !== undefined) return
      let stage: CreationIssue['stage'] = 'materialization'
      try {
        const directory = join(job.directory, 'outputs')
        await mkdir(directory, { recursive: true })
        let media = await existingOutput(directory, output.assetId, output.output.kind, this.deps.maxBytes)
        if (media === undefined) {
          if (provider === undefined) throw new Error('The generation Provider is not loaded')
          const staging = join(directory, `${output.assetId}.partial`)
          await provider.collect(output.output, { path: staging }, this.runtime(job, signal))
          signal.throwIfAborted()
          media = await importOutput(staging, directory, output.assetId, output.output.kind, this.deps.maxBytes)
        }
        const verified = media
        await this.deps.store.update(id, current => ({ ...current, outputs: current.outputs.map(value =>
          value.assetId !== output.assetId ? value
            : { ...value, file: { path: verified.path, mimeType: verified.mimeType, bytes: verified.bytes,
              ...(verified.width === undefined ? {} : { width: verified.width }),
              ...(verified.height === undefined ? {} : { height: verified.height }) }, issues: [] }) }))
        stage = 'publication'
        await this.commits.run(id, async () => {
          job = this.deps.store.get(id)
          if (job.cancellation !== undefined) return
          signal.throwIfAborted()
          await this.deps.publisher.publish({ deliveryKey: `creation:${id}:${output.output.outputId}`, origin: job.origin,
            files: [{ path: verified.path, description: output.filename }] }, signal)
          await this.deps.store.update(id, current => ({ ...current, outputs: current.outputs.map(value => value.assetId === output.assetId ? { ...value, delivery: 'published', issues: [] } : value) }))
        })
      } catch (error) {
        if (signal.aborted) throw error
        const issue = this.issue(stage, error, stage === 'publication' ? 'retry-publication' : 'retry-transfer')
        await this.deps.store.update(id, current => ({ ...current, outputs: current.outputs.map(value => value.assetId === output.assetId ? { ...value, delivery: 'failed', issues: [issue] } : value) }))
      }
    }
  }

  private issue(stage: CreationIssue['stage'], error: unknown, recovery: CreationIssue['recovery']): CreationIssue {
    return { stage, code: 'creation-operation-failed', message: error instanceof Error ? error.message : 'Creation operation failed', recovery }
  }

  async close(): Promise<void> {
    this.closed = true
    for (const entry of this.active.values()) entry.controller.abort()
    await Promise.allSettled([...this.active.values()].map(entry => entry.promise))
    await this.commits.drain()
  }
}
