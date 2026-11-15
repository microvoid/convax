import type { ConnectionSnapshot, MediaKind, ProviderCheckpoint, ProviderRuntime, ProviderSnapshot } from '../types.ts'
import { failed, record, string, unknownSubmission, type CliRunner } from './common.ts'

type Command = (connection: ConnectionSnapshot, args: readonly string[], signal: AbortSignal) => ReturnType<CliRunner['run']>

function data(result: Awaited<ReturnType<Command>>): Record<string, unknown> {
  if (result.exitCode !== 0 || result.json?.ok === false || result.json?.data === undefined) throw new Error('Jimeng could not complete the requested operation')
  return record(result.json.data)
}

function credits(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Jimeng did not return a valid credit quote')
  return value
}

/** A saved media draft owns its quote and stable submission identity across approval and recovery. */
export class JimengGeneration {
  constructor(private readonly command: Command) {}

  async save(
    args: readonly string[], checkpoint: ProviderCheckpoint, runtime: ProviderRuntime, kind: MediaKind,
  ): Promise<ProviderSnapshot> {
    await runtime.checkpoint(checkpoint)
    try {
      const saved = data(await this.command(runtime.connection, args, runtime.signal))
      if (record(saved.node).nodeId !== checkpoint.data.nodeId) throw new Error('Jimeng returned a different saved draft')
      const ready = await this.saved(checkpoint, runtime)
      const limit = runtime.connection.settings.creditCeiling
      return await this.runWithin(ready, limit === undefined ? undefined : credits(limit), runtime, kind)
    } catch {
      runtime.signal.throwIfAborted()
      return { state: 'submission-unknown', message: 'The Jimeng draft or submission could not be confirmed. Check the saved task before continuing.' }
    }
  }

  async approve(
    checkpoint: ProviderCheckpoint, creditCeiling: number, runtime: ProviderRuntime, kind: MediaKind,
  ): Promise<ProviderSnapshot> {
    credits(creditCeiling)
    const observed = await this.status(checkpoint, runtime)
    if (observed?.state === 'awaiting_confirmation' && observed.submission !== undefined && record(observed.submission).resubmittable === true) {
      return this.runWithin(await this.saved(checkpoint, runtime), creditCeiling, runtime, kind)
    }
    const resumed = await this.observed(observed, checkpoint, runtime, kind)
    if (resumed !== undefined) return resumed
    // "absent" alone is not evidence to charge again. Only a durable pre-run phase or an
    // explicit server resubmission decision permits the first paid dispatch.
    if (checkpoint.data.phase !== 'saved') return unknownSubmission()
    return this.runWithin(checkpoint, creditCeiling, runtime, kind)
  }

  async reconcile(checkpoint: ProviderCheckpoint, runtime: ProviderRuntime, kind: MediaKind): Promise<ProviderSnapshot> {
    let current = checkpoint
    if (current.data.phase === 'saving') {
      const result = data(await this.command(runtime.connection, ['node', 'show', ...this.nodeArgs(current)], runtime.signal))
      const node = Array.isArray(result.nodes) ? result.nodes.map(record).find(item => item.result === 'FOUND'
        && record(item.node).nodeId === current.data.nodeId) : undefined
      if (node === undefined) return unknownSubmission()
      current = await this.saved(current, runtime)
    }
    const observed = await this.status(current, runtime)
    const resumed = await this.observed(observed, current, runtime, kind)
    if (resumed !== undefined) return resumed
    return current.data.phase === 'saved' ? this.awaiting(current, await this.quote(current, runtime), kind) : unknownSubmission()
  }

  private nodeArgs(checkpoint: ProviderCheckpoint): string[] {
    return ['--project-id', string(checkpoint.data.projectId, 'project ID'), '--node-id', string(checkpoint.data.nodeId, 'node ID')]
  }

  private async saved(checkpoint: ProviderCheckpoint, runtime: ProviderRuntime): Promise<ProviderCheckpoint> {
    const next = { ...checkpoint, data: { ...checkpoint.data, phase: 'saved' } }
    await runtime.checkpoint(next)
    return next
  }

  private async quote(checkpoint: ProviderCheckpoint, runtime: ProviderRuntime): Promise<number> {
    const quote = data(await this.command(runtime.connection, ['node', 'quote', ...this.nodeArgs(checkpoint)], runtime.signal))
    const items = Array.isArray(quote.items) ? quote.items.map(record) : []
    const item = items[0]
    if (quote.confirmable === false || items.length !== 1 || item === undefined
      || item.nodeId !== checkpoint.data.nodeId || item.error !== undefined) {
      throw new Error('The saved Jimeng draft cannot currently be quoted. Check its model and account access.')
    }
    credits(item.maxCredits)
    return credits(quote.totalMaxCredits)
  }

  private awaiting(checkpoint: ProviderCheckpoint, amount: number, kind: MediaKind): ProviderSnapshot {
    return { state: 'awaiting-approval', checkpoint, approval: { credits: amount, unit: 'credits',
      message: `Approve the quoted credits to generate this saved Jimeng ${kind}.` } }
  }

  private async runWithin(
    checkpoint: ProviderCheckpoint, ceiling: number | undefined, runtime: ProviderRuntime, kind: MediaKind,
  ): Promise<ProviderSnapshot> {
    const amount = await this.quote(checkpoint, runtime)
    if (ceiling === undefined || amount > ceiling) return this.awaiting(checkpoint, amount, kind)
    const confirmation = await this.command(runtime.connection,
      ['node', 'confirm', ...this.nodeArgs(checkpoint), '--credit-ceiling', String(ceiling)], runtime.signal)
    if (confirmation.exitCode === 10) return this.awaiting(checkpoint, await this.quote(checkpoint, runtime), kind)
    const confirmed = data(confirmation)
    if (credits(confirmed.creditCeiling) !== ceiling) throw new Error('Jimeng returned a different approval ceiling')
    const token = string(confirmed.creditConfirmationToken, 'credit confirmation token')
    // The token stays in this call only; persistence records no reusable approval secret.
    const submitting: ProviderCheckpoint = { ...checkpoint, data: { ...checkpoint.data, phase: 'submitting' } }
    await runtime.checkpoint(submitting)
    try {
      await this.command(runtime.connection, ['node', 'run', ...this.nodeArgs(submitting),
        '--submit-id', string(submitting.data.submitId, 'submit ID'), '--credit-token', token], runtime.signal)
    } catch { runtime.signal.throwIfAborted() }
    // Lost replies and nonzero exits can follow an accepted dispatch. Query only the same ID.
    return this.reconcile(submitting, runtime, kind)
  }

  private async status(checkpoint: ProviderCheckpoint, runtime: ProviderRuntime): Promise<Record<string, unknown> | undefined> {
    try {
      return data(await this.command(runtime.connection, ['operation', 'status', string(checkpoint.data.submitId, 'submit ID'),
        '--project-id', string(checkpoint.data.projectId, 'project ID')], runtime.signal))
    } catch { runtime.signal.throwIfAborted(); return undefined }
  }

  private async observed(
    result: Record<string, unknown> | undefined, checkpoint: ProviderCheckpoint, runtime: ProviderRuntime, kind: MediaKind,
  ): Promise<ProviderSnapshot | undefined> {
    if (result === undefined) return undefined
    const resources = (Array.isArray(result.resources) ? result.resources : []).map(record)
    const outputs = resources.filter(item => item.state === 'succeeded').map(item => ({
      outputId: string(item.resourceId, 'resource ID'), kind,
      locator: { projectId: string(checkpoint.data.projectId, 'project ID'), resourceId: string(item.resourceId, 'resource ID') },
    }))
    if (resources.length && resources.every(item => ['succeeded', 'failed'].includes(String(item.state)))) {
      if (resources.some(item => item.state === 'failed')) return { state: 'failed', outputs,
        issue: { stage: 'generation', code: 'jimeng-generation-failed', message: 'Some Jimeng outputs failed; successful outputs remain available.', recovery: 'new-generation' } }
      return { state: 'completed', outputs }
    }
    if (result.state === 'awaiting_confirmation') {
      const submission = result.submission === undefined ? undefined : record(result.submission)
      if (submission?.resubmittable !== true) return unknownSubmission()
      const saved = await this.saved(checkpoint, runtime)
      return this.awaiting(saved, await this.quote(saved, runtime), kind)
    }
    if (result.state === 'failed' || result.submissionOutcome === 'rejected') return failed('Jimeng rejected this generation.', 'jimeng-submission-rejected', 'submission')
    if (['running', 'pending', 'submitted', 'accepted'].includes(String(result.state))) return { state: 'running', checkpoint, outputs }
    const submission = result.submission === undefined ? undefined : record(result.submission)
    if (resources.length || submission !== undefined && submission.state !== 'absent' || result.submissionOutcome !== undefined) return unknownSubmission()
    return undefined
  }
}
