/** Background retries, process recovery and cancellation own separate workflow stages. */
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SessionStore, { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { DeliverablePublisher } from '@deepseek-ai/dsh-tool-present'
import type { PublishDeliverables } from '@deepseek-ai/dsh-tool-present'
import { expect, it, onTestFinished, vi } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../libs/dsh/packages/storage/storage-domain/tests/helpers/memory-backend.ts'
import { CreationStore } from '../src/store.ts'
import { CreationJobRunner } from '../src/runner.ts'
import { ConvaxCreationHost } from '../src/service.ts'
import { creationDomain, jobRecord, type JobRecord } from '../src/schema.ts'
import type { JobId, MediaKind, CreationProvider } from '../src/types.ts'
import { FixtureCreationProvider } from './fixtures/provider.ts'

async function fixture(options: { root?: string; pool?: MemoryMediaPool } = {}) {
  const root = options.root ?? await realpath(await mkdtemp(join(tmpdir(), 'convax-creation-runner-')))
  const ctx = new Context()
  await ctx.plugin(Storage)
  const pool = options.pool ?? new MemoryMediaPool()
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  const store = new CreationStore(await facility.open(creationDomain))
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions'), compression: 'none' })
  const sessionId = SessionId('original-thread')
  if (await ctx.sessionPersistence.stat(sessionId) === undefined) {
    const session = Session.create(sessionId, [], {
      id: sessionId, version: SESSION_FORMAT_VERSION, cwd: root, createdAt: 0, isSeeded: false,
    })
    for (const turn of [1, 2, 3]) {
      session.append('turn/start', { turn })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    const writer = await ctx.sessionPersistence.create(session.header)
    try { await writer.append(session.snapshotEvents()); await writer.flush() } finally { await writer.close() }
  }
  const publisher = new DeliverablePublisher(ctx)
  await publisher.start()
  const provider = new FixtureCreationProvider()
  let providerAvailable = true
  const publish = vi.fn((input: PublishDeliverables, signal?: AbortSignal) => publisher.publish(input, signal))
  const errors: unknown[] = []
  const runner = new CreationJobRunner({ store, provider: () => providerAvailable ? provider : undefined,
    publisher: { publish }, maxBytes: 1024 * 1024, pollMs: 1,
    report: (error) => { errors.push(error) } })
  const close = async () => { await runner.close(); await publisher.close(); await store.close(); await ctx.fiber.dispose() }
  onTestFinished(async () => { await close(); if (options.root === undefined) await rm(root, { recursive: true, force: true }) })
  const seed = async (kind: MediaKind = 'image', overrides: Partial<JobRecord> = {}) => {
    const job = jobRecord.parse({ id: 'job', operationId: 'operation', input: { kind, prompt: 'Create media' },
      origin: { canvasId: 'canvas', chatNodeId: 'chat', workbenchNodeId: 'workbench', sessionId: 'original-thread', turn: 3, callId: 'original-call' },
      connection: { id: 'connection', providerId: provider.descriptor.id, revision: 1, accountBinding: 'account', settings: {} },
      request: { kind, prompt: 'Create media', parameters: {}, references: [] }, directory: join(root, 'job'),
      state: 'queued', generationDone: false, outputs: [], issues: [], ...overrides })
    await store.jobs.put(job.id, job)
    return job
  }
  const wait = (id: JobId, predicate: (value: JobRecord) => boolean): Promise<JobRecord> => {
    if (predicate(store.get(id))) return Promise.resolve(store.get(id))
    return new Promise((resolve, reject) => {
      const unsubscribe = ctx.on('domain/changed', (change) => {
        if (change.domain !== creationDomain.name || change.table !== 'jobs' || change.key !== id) return
        const value = store.get(id)
        if (predicate(value)) { unsubscribe(); resolve(value) }
        else if (['failed', 'blocked', 'completed', 'cancelled'].includes(value.state)
          && !value.outputs.some(output => output.delivery === 'pending')) {
          unsubscribe(); reject(new Error(`Unexpected terminal job: ${JSON.stringify(value)}`))
        }
      })
    })
  }
  const stored = async () => {
    const reader = await ctx.sessionPersistence.open(sessionId, 'read')
    try { return (await reader.read()).events.filter(event => event.type === 'deliverables/presented') }
    finally { await reader.close() }
  }
  return { root, pool, ctx, store, provider, publisher, publish, runner, errors, seed, wait, close, stored,
    unloadProvider: () => { providerAvailable = false } }
}

it.each(['image', 'video', 'audio'] as const)('imports %s and publishes using the captured original invocation', async (kind) => {
  const f = await fixture()
  const job = await f.seed(kind)
  f.runner.start(job.id)
  const done = await f.wait(job.id, value => value.state === 'completed')
  expect(done.outputs).toHaveLength(1)
  expect(done.outputs[0]?.delivery).toBe('published')
  expect((await stat(done.outputs[0]!.file!.path)).size).toBeGreaterThan(0)
  expect(f.publish).toHaveBeenCalledExactlyOnceWith({ deliveryKey: `creation:${job.id}:${kind}-output`, origin: job.origin,
    files: [{ path: done.outputs[0]!.file!.path, description: `Created ${kind}` }] }, expect.any(AbortSignal))
  expect(f.provider.submissions).toBe(1)
  expect(f.errors).toEqual([])
})

it('retries a failed publication from imported bytes without regenerating or downloading', async () => {
  const f = await fixture()
  f.publish.mockRejectedValueOnce(new Error('Session writer temporarily unavailable'))
  const job = await f.seed()
  f.runner.start(job.id)
  const failed = await f.wait(job.id, value => value.state === 'failed')
  expect(failed.outputs[0]?.issues[0]).toMatchObject({ stage: 'publication', recovery: 'retry-publication' })
  await f.runner.suspendProvider(f.provider.descriptor.id)
  await f.runner.retry(job.id)
  const done = await f.wait(job.id, value => value.state === 'completed')
  expect(done.outputs[0]?.assetId).toBe(failed.outputs[0]?.assetId)
  expect(f.publish).toHaveBeenCalledTimes(2)
  expect(f.provider.submissions).toBe(1)
  expect(f.provider.collections).toBe(1)
  expect(f.provider.reconciliations).toBe(0)
})

it('retries a lost job acknowledgement after durable publication without duplicate Session declarations', async () => {
  const f = await fixture()
  f.publish.mockImplementationOnce(async (input, signal) => {
    const receipt = await f.publisher.publish(input, signal)
    f.pool.failNextWrites = 1
    return receipt
  })
  const job = await f.seed()
  f.runner.start(job.id)
  await f.wait(job.id, value => value.state === 'failed')
  const first = await f.stored()
  expect(first).toHaveLength(1)
  await f.runner.suspendProvider(f.provider.descriptor.id)
  await f.runner.retry(job.id)
  await f.wait(job.id, value => value.state === 'completed')
  expect(f.publish).toHaveBeenCalledTimes(2)
  expect(await f.stored()).toEqual(first)
  expect(f.provider.submissions).toBe(1)
  expect(f.provider.collections).toBe(1)
})

it('rejects an HTML download without declaring a file and retries transfer without regenerating', async () => {
  const f = await fixture()
  vi.spyOn(f.provider, 'collect').mockImplementationOnce(async (_output, destination) => {
    await writeFile(destination.path, '<html>Temporary provider error</html>')
  })
  const job = await f.seed()
  f.runner.start(job.id)
  const failed = await f.wait(job.id, value => value.state === 'failed')
  expect(failed.outputs[0]?.issues[0]).toMatchObject({ stage: 'materialization', recovery: 'retry-transfer' })
  expect(failed.outputs[0]?.file).toBeUndefined()
  expect(f.publish).not.toHaveBeenCalled()
  expect(await f.stored()).toEqual([])
  await f.runner.suspendProvider(f.provider.descriptor.id)
  await f.runner.retry(job.id)
  const recovered = await f.wait(job.id, value => value.state === 'completed')
  expect(recovered.outputs[0]?.assetId).toBe(failed.outputs[0]?.assetId)
  expect(f.provider.submissions).toBe(1)
  expect(await f.stored()).toHaveLength(1)
})

it('retries delivery of partial failed generation while retaining the remote failure', async () => {
  const f = await fixture()
  const issue = { stage: 'generation' as const, code: 'partially-failed', message: 'One remote output could not finish', recovery: 'new-generation' as const }
  const submit = vi.spyOn(f.provider, 'submit').mockResolvedValue({ state: 'failed', issue,
    outputs: [{ outputId: 'image-output', kind: 'image', locator: {}, suggestedFilename: 'Created image' }] })
  f.publish.mockRejectedValueOnce(new Error('Session writer unavailable'))
  const job = await f.seed()
  f.runner.start(job.id)
  await f.wait(job.id, value => value.state === 'failed' && value.outputs[0]?.delivery === 'failed')
  await f.runner.suspendProvider(f.provider.descriptor.id)
  await f.runner.retry(job.id)
  const settled = await f.wait(job.id, value => value.state === 'failed' && value.outputs[0]?.delivery === 'published')
  expect(settled.issues).toEqual([issue])
  expect(submit).toHaveBeenCalledTimes(1)
  expect(f.provider.collections).toBe(1)
  expect(await f.stored()).toHaveLength(1)
  const service = new ConvaxCreationHost(f.ctx, f.store, f.runner, 1024 * 1024)
  onTestFinished(() => service.close())
  expect(await service.getJob(job.id, job.origin)).toMatchObject({ state: 'failed', outcome: 'partially-succeeded' })
})

it('reopens committed job state and reconciles a prior submission without resubmitting', async () => {
  const initial = await fixture()
  const job = await initial.seed('image', { state: 'submitting', checkpoint: { version: 1, data: { task: 'existing-remote-task' } } })
  await initial.close()
  const resumed = await fixture({ root: initial.root, pool: initial.pool })
  resumed.runner.recover()
  await resumed.wait(job.id, value => value.state === 'completed')
  expect(resumed.provider.submissions).toBe(0)
  expect(resumed.provider.reconciliations).toBe(1)
  expect(resumed.publish).toHaveBeenCalledTimes(1)
})

it('recovers imported unpublished bytes after restart without the original Provider', async () => {
  const initial = await fixture()
  initial.publish.mockRejectedValueOnce(new Error('Publication interrupted'))
  const job = await initial.seed()
  initial.runner.start(job.id)
  await initial.wait(job.id, value => value.state === 'failed')
  await initial.runner.suspendProvider(initial.provider.descriptor.id)
  await initial.store.update(job.id, value => ({ ...value, state: 'publishing' }))
  await initial.close()
  const resumed = await fixture({ root: initial.root, pool: initial.pool })
  resumed.unloadProvider()
  resumed.runner.recover()
  await resumed.wait(job.id, value => value.state === 'completed')
  expect(resumed.provider.submissions).toBe(0)
  expect(resumed.provider.collections).toBe(0)
  expect(await resumed.stored()).toHaveLength(1)
})

it('durably suppresses late collection after cancellation and refuses retry', async () => {
  const f = await fixture()
  const collecting = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  f.provider.beforeCollect = async () => { collecting.resolve(undefined); await release.promise }
  const job = await f.seed()
  f.runner.start(job.id)
  await collecting.promise
  const receipt = await f.runner.cancel(job.id)
  expect(receipt).toMatchObject({ futureDelivery: 'suppressed', provider: { state: 'confirmed' } })
  release.resolve(undefined)
  await f.runner.suspendProvider(f.provider.descriptor.id)
  expect(f.publish).not.toHaveBeenCalled()
  expect(f.store.get(job.id).state).toBe('cancelled')
  await expect(f.runner.retry(job.id)).rejects.toThrow('Cancelled tasks')
  expect(f.provider.submissions).toBe(1)
})

it('keeps a quoted draft paused across retry and restart until its exact quote is approved', async () => {
  const initial = await fixture()
  const checkpoint = { version: 1, data: { nodeId: 'saved-draft', submitId: 'same-submission' } }
  vi.spyOn(initial.provider, 'submit').mockResolvedValue({ state: 'awaiting-approval', checkpoint,
    approval: { credits: 7, unit: 'credits', message: 'Seven credits' } })
  const job = await initial.seed()
  initial.runner.start(job.id)
  const pending = await initial.wait(job.id, value => value.state === 'awaiting-approval')
  await initial.runner.retry(job.id)
  expect(initial.provider.reconciliations).toBe(0)
  expect(initial.publish).not.toHaveBeenCalled()
  await initial.close()
  const resumed = await fixture({ root: initial.root, pool: initial.pool })
  const approve = vi.fn<NonNullable<CreationProvider['approve']>>().mockResolvedValue({ state: 'completed',
    outputs: [{ outputId: 'approved-image', kind: 'image', locator: {} }] })
  Object.assign(resumed.provider, { approve })
  resumed.runner.recover()
  expect(resumed.store.get(job.id).state).toBe('awaiting-approval')
  await expect(resumed.runner.approve(job.id, 'stale-quote')).rejects.toThrow('quote has changed')
  expect(approve).not.toHaveBeenCalled()
  await Promise.all([resumed.runner.approve(job.id, pending.approval!.quoteId), resumed.runner.approve(job.id, pending.approval!.quoteId)])
  await resumed.wait(job.id, value => value.state === 'completed')
  expect(approve).toHaveBeenCalledExactlyOnceWith(job.request, checkpoint, 7, expect.objectContaining({ operationId: job.operationId }))
  expect(resumed.provider.submissions).toBe(0)
  expect(resumed.publish).toHaveBeenCalledTimes(1)
})

it('requires a new explicit approval when the Provider raises its quote', async () => {
  const f = await fixture()
  const checkpoint = { version: 1, data: { nodeId: 'draft' } }
  const job = await f.seed('image', { state: 'awaiting-approval', checkpoint,
    approval: { quoteId: 'original-quote', credits: 3, unit: 'credits', message: '' } })
  const approve = vi.fn<NonNullable<CreationProvider['approve']>>().mockResolvedValue({ state: 'awaiting-approval', checkpoint,
    approval: { credits: 6, unit: 'credits', message: 'The price changed' } })
  Object.assign(f.provider, { approve })
  await f.runner.approve(job.id, 'original-quote')
  const next = await f.wait(job.id, value => value.state === 'awaiting-approval' && value.approval?.credits === 6)
  expect(next.approvedCredits).toBeUndefined()
  expect(next.approval?.quoteId).not.toBe('original-quote')
  await expect(f.runner.approve(job.id, 'original-quote')).rejects.toThrow('quote has changed')
  expect(f.publish).not.toHaveBeenCalled()
  await f.runner.cancel(job.id)
  await expect(f.runner.approve(job.id, next.approval!.quoteId)).rejects.toThrow('cancelled')
  expect(approve).toHaveBeenCalledTimes(1)
})

it('recovers durable consent with the captured ceiling and original draft instead of resubmitting', async () => {
  const initial = await fixture()
  const checkpoint = { version: 1, data: { nodeId: 'draft', submitId: 'original-submission' } }
  const job = await initial.seed('image', { state: 'approving', checkpoint, approvedCredits: 9,
    approval: { quoteId: 'accepted-quote', credits: 9, unit: 'credits', message: '' } })
  await initial.close()
  const resumed = await fixture({ root: initial.root, pool: initial.pool })
  const approve = vi.fn<NonNullable<CreationProvider['approve']>>().mockResolvedValue({ state: 'submission-unknown', message: 'Submission receipt is uncertain' })
  Object.assign(resumed.provider, { approve })
  resumed.runner.recover()
  const blocked = await resumed.wait(job.id, value => value.state === 'blocked')
  expect(approve).toHaveBeenCalledExactlyOnceWith(job.request, checkpoint, 9, expect.anything())
  expect(blocked.checkpoint).toEqual(checkpoint)
  expect(resumed.provider.submissions).toBe(0)
  expect(resumed.publish).not.toHaveBeenCalled()
})

it('retains cancellation when an uncertain submission snapshot arrives concurrently', async () => {
  const f = await fixture()
  const job = await f.seed()
  vi.spyOn(f.provider, 'submit').mockResolvedValue({ state: 'submission-unknown', message: 'Receipt unavailable' })
  const update = f.store.update.bind(f.store)
  let intercepted = false
  vi.spyOn(f.store, 'update').mockImplementation(async (id, transform) => {
    if (!intercepted && f.store.get(id).state === 'submitting') {
      intercepted = true
      await f.runner.cancel(id)
    }
    return update(id, transform)
  })
  f.runner.start(job.id)
  await f.wait(job.id, value => value.cancellation !== undefined)
  await f.runner.suspendProvider(f.provider.descriptor.id)
  expect(f.store.get(job.id).state).toBe('cancelled')
  expect(f.publish).not.toHaveBeenCalled()
})
