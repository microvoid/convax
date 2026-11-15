/** Connection visibility follows the real durable canvas commit, including failed and lost acknowledgements. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { expect, it, onTestFinished, vi } from 'vitest'
import { MemoryCredentials } from '../../../libs/dsh/packages/credentials/credentials/tests/memory.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../libs/dsh/packages/storage/storage-domain/tests/helpers/memory-backend.ts'
import { CanvasDatabase } from '../../plugin-host/src/database.ts'
import { CanvasRepository } from '../../plugin-host/src/repository.ts'
import { CanvasNodeRegistry } from '../../plugin-host/src/registry.ts'
import { ConvaxHost } from '../../plugin-host/src/index.ts'
import { CanvasWorkingDirectories } from '../../plugin-host/src/directories.ts'
import { registerDefaultNodes } from '../../plugin-inernal-nodes-host/src/definitions.ts'
import type { CanvasConnectionId, CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId } from '../../plugin-host/src/types.ts'
import { creationDomain, jobRecord, jsonObject, workbenchData } from '../src/schema.ts'
import { CreationStore } from '../src/store.ts'
import { ConvaxCreationHost } from '../src/service.ts'
import { CreationJobRunner } from '../src/runner.ts'
import { CreationProviderSetup } from '../src/setup.ts'
import { JimengProvider } from '../src/providers/jimeng.ts'
import type { ConnectAndApplyInput, ConnectionInspection, ConnectionSnapshot, CreationInvocation, ProviderPreparation, ProviderDescriptor, ProviderId, ProviderRequest, ProviderRuntime } from '../src/types.ts'
import { FixtureCreationProvider } from './fixtures/provider.ts'

class ConfigurationProvider extends FixtureCreationProvider {
  override readonly descriptor: ProviderDescriptor = { id: 'configured-media' as ProviderId, title: 'Configured media', usesApiKey: true,
    configuration: [
      { key: 'imageModel', label: 'Image model', type: 'text', mediaKind: 'image' },
      { key: 'videoModel', label: 'Video model', type: 'text', mediaKind: 'video' },
      { key: 'audioModel', label: 'Audio model', type: 'text', mediaKind: 'audio' },
    ] }
  beforeDescribe: (() => Promise<void>) | undefined
  readonly received: { request: ProviderRequest; connection: ConnectionSnapshot }[] = []
  override submit(request: ProviderRequest, runtime: ProviderRuntime) {
    this.received.push({ request, connection: runtime.connection })
    return super.submit(request, runtime)
  }
  override async describe(connection?: ConnectionSnapshot): Promise<ConnectionInspection> {
    await this.beforeDescribe?.()
    if (connection?.settings.imageModel === 'bad') return { state: 'unavailable', reason: 'invalid-configuration', message: 'Unknown image model' }
    return { state: 'ready', capabilities: (['image', 'video', 'audio'] as const).flatMap((kind) => {
      const modelId = connection?.settings[`${kind}Model`]
      return typeof modelId !== 'string' ? [] : [{ kind, modelId, parameterSchema: { type: 'object' }, inputs: [], maxOutputs: 1 }]
    }), submissionRecovery: 'recoverable-resource', cancellation: 'supported' }
  }
}

async function fixture(options: { root?: string; pool?: MemoryMediaPool } = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'convax-creation-connections-'))
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  const pool = options.pool ?? new MemoryMediaPool()
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  const store = new CreationStore(await facility.open(creationDomain))
  const database = await CanvasDatabase.open({ path: join(root, 'canvas.sqlite') })
  const registry = new CanvasNodeRegistry(() => {})
  registerDefaultNodes((definition) => { registry.register(definition) })
  registry.register({ id: 'convax.creation' as CanvasNodeTypeId, dataVersion: 1,
    capabilities: { provides: ['creation'] },
    ports: [{ id: 'output', direction: 'output', valueKind: 'capability' }], parse: value => jsonObject.parse(workbenchData.parse(value)) })
  const repository = new CanvasRepository(database, registry, () => {})
  const directories = new CanvasWorkingDirectories(ctx, database, repository, join(root, 'workspaces'))
  const canvas = new ConvaxHost(ctx, repository, { previewBytes: 1024, documentBytes: 1024, mediaChunkBytes: 1024 }, { directories })
  const provider = new ConfigurationProvider()
  const runner: CreationJobRunner = new CreationJobRunner({ store, provider: id => host.provider(id), publisher: { publish: vi.fn() },
    maxBytes: 16 * 1024, pollMs: 1, report: () => {} })
  const setup = new CreationProviderSetup({ subprocess: ctx.subprocess, readCredential: () => Promise.resolve(undefined) })
  const host: ConvaxCreationHost = new ConvaxCreationHost(ctx, store, runner, 16 * 1024, undefined, setup)
  host.registerProvider(provider)
  const ref = { canvasId: 'canvas' as CanvasId, nodeId: 'workbench' as CanvasNodeId }
  if (repository.snapshot().canvases.length === 0) {
    expect((await repository.execute({ canvasId: ref.canvasId, expectedRevision: 0, operationId: 'create' as CanvasOperationId,
      command: { kind: 'create', title: 'Creation' } })).ok).toBe(true)
    expect((await canvas.commit({ canvasId: ref.canvasId, expectedRevision: 1, operationId: 'node' as CanvasOperationId, ops: [{ op: 'node.add',
      id: ref.nodeId, typeId: 'convax.creation' as CanvasNodeTypeId, dataVersion: 1, position: { x: 0, y: 0 }, data: { title: 'Workbench', routes: {} } }] })).ok).toBe(true)
  }
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await host.close(); await canvas.close(); await store.close(); repository.close(); await database.close(); await ctx.fiber.dispose()
  }
  onTestFinished(async () => { await close(); if (options.root === undefined) await rm(root, { recursive: true, force: true }) })
  const input = (operation: string, settings: Record<string, string> = { imageModel: 'image-one' }): ConnectAndApplyInput => ({
    ref, operationId: operation as CanvasOperationId, expectedRevision: repository.snapshot().canvases[0]!.revision,
    connection: { providerId: provider.descriptor.id, label: 'My media', settings },
  })
  return { root, ctx, pool, store, database, repository, canvas, host, provider, ref, input, close }
}

async function jimengFixture(options: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture(options)
  const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
  const calls: string[][] = []
  let failCreate = false
  f.ctx.subprocess.resolveExecutable = () => Promise.resolve(process.execPath)
  f.ctx.subprocess.spawn = (spec) => {
    const args = spec.argv.slice(1)
    calls.push([...args])
    const error = args[0] === 'canvas' && failCreate
    const data = args[0] === 'auth' ? { loggedIn: true }
      : args[0] === 'model' ? { items: [{ model: 'image-one', displayName: 'Image one', modes: [{ name: 't2i', flags: [] }] }] }
        : { project: { projectId: args[args.indexOf('--project-id') + 1], name: args[2] } }
    const payload = JSON.stringify(error ? { ok: false, error: { code: 500 } } : { ok: true, data })
    return spawn({ ...spec, argv: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(payload)});process.exitCode=${error ? 1 : 0}`] })
  }
  const provider = new JimengProvider({ subprocess: f.ctx.subprocess, readCredential: () => Promise.resolve(undefined) })
  f.host.registerProvider(provider)
  const input = (operation: string): ConnectAndApplyInput => ({ ...f.input(operation),
    connection: { providerId: provider.descriptor.id, label: 'Jimeng', settings: { imageModel: 'image-one', cwd: f.root } } })
  return { ...f, calls, input, failCreate(value: boolean) { failCreate = value } }
}

it('creates a private Jimeng canvas only after validation and reuses it across connection retries and restart', async () => {
  const f = await jimengFixture()
  const invalid = f.input('invalid-model')
  invalid.connection.settings.imageModel = 'missing-model'
  expect(await f.host.connectAndApply(invalid)).toMatchObject({ ok: false, code: 'provider-unavailable' })
  expect(await f.host.connectAndApply({ ...f.input('missing-target-model'), targetKind: 'video' }))
    .toMatchObject({ ok: false, code: 'invalid-command' })
  expect(f.calls.some(args => args[0] === 'canvas')).toBe(false)
  const first = f.input('connect')
  const result = await f.host.connectAndApply(first)
  if (!result.ok) throw new Error(result.message)
  const projectId = result.connection.settings.projectId
  expect(projectId).toMatch(/^[\da-f]{8}-[\da-f]{4}-5[\da-f]{3}-a[\da-f]{3}-[\da-f]{12}$/)
  expect(f.calls.filter(args => args[0] === 'canvas')).toHaveLength(1)
  expect(f.calls.some(args => args.includes('--use'))).toBe(false)
  expect(await f.host.connectAndApply(first)).toMatchObject({ ok: true })
  await f.close()
  const reopened = await jimengFixture({ root: f.root, pool: f.pool })
  const edit = reopened.input('edit-after-restart')
  edit.connection.id = result.connection.id
  expect(await reopened.host.connectAndApply(edit)).toMatchObject({ ok: true, connection: { settings: { projectId } } })
  expect(reopened.calls.some(args => args[0] === 'canvas')).toBe(false)
})

it('retains a managed canvas identity after a lost create response and preserves explicit legacy projects', async () => {
  const f = await jimengFixture()
  f.failCreate(true)
  expect(await f.host.connectAndApply(f.input('lost-create'))).toMatchObject({ ok: false, code: 'provider-unavailable' })
  expect(await f.host.listConnections(f.ref)).toEqual([])
  const attempt = f.calls.find(args => args[0] === 'canvas')!
  const projectId = attempt[attempt.indexOf('--project-id') + 1]
  await f.close()
  const reopened = await jimengFixture({ root: f.root, pool: f.pool })
  expect(await reopened.host.connectAndApply(reopened.input('new-form-operation'))).toMatchObject({ ok: true, connection: { settings: { projectId } } })
  const create = reopened.calls.find(args => args[0] === 'canvas')!
  expect(create[create.indexOf('--project-id') + 1]).toBe(projectId)
  const legacy = reopened.input('legacy')
  legacy.connection.settings.projectId = '49e12936-cec9-4421-a9d7-413d02b6e001'
  expect(await reopened.host.connectAndApply(legacy)).toMatchObject({
    ok: true, connection: { settings: { projectId: legacy.connection.settings.projectId } },
  })
  expect(reopened.calls.filter(args => args[0] === 'canvas')).toHaveLength(1)
})

it('saves models once, applies supported empty routes, and retains already configured services', async () => {
  const f = await fixture()
  const result = await f.host.connectAndApply({ ...f.input('first', { imageModel: 'image-one', audioModel: 'voice-one' }), apiKey: 'test-secret',
    data: { title: 'Renamed workbench', routes: {} } })
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.message)
  expect(result.connection.credentialConfigured).toBe(true)
  expect(JSON.stringify(result)).not.toContain('test-secret')
  expect(result.applied).toEqual(['image', 'audio'])
  const before = await f.host.describeWorkbench(f.ref)
  expect(before.data).toEqual({ title: 'Renamed workbench', routes: {
    image: { connectionId: result.connection.id }, audio: { connectionId: result.connection.id },
  } })
  const second = await f.host.connectAndApply(f.input('second', { imageModel: 'image-two', videoModel: 'video-one' }))
  expect(second.ok).toBe(true)
  if (!second.ok) throw new Error(second.message)
  expect(second.applied).toEqual(['video'])
  expect((await f.host.describeWorkbench(f.ref)).data.routes).toEqual({ ...before.data.routes,
    video: { connectionId: second.connection.id } })
})

it('rejects unavailable models before persisting connections or API keys', async () => {
  const f = await fixture()
  expect(await f.host.connectAndApply({ ...f.input('bad', { imageModel: 'bad' }), apiKey: 'test-secret' })).toMatchObject({ ok: false, code: 'provider-unavailable' })
  expect(await f.host.listConnections(f.ref)).toEqual([])
  expect(await f.ctx.credentials.listRecords()).toEqual([])
  expect((await f.host.describeWorkbench(f.ref)).data.routes).toEqual({})
})

it('connects one selected media route without filling empty routes or changing other model overrides', async () => {
  const f = await fixture()
  const first = await f.host.connectAndApply(f.input('base', { imageModel: 'image-one', videoModel: 'video-one' }))
  if (!first.ok) throw new Error(first.message)
  const current = await f.host.describeWorkbench(f.ref)
  current.data.routes.video = { connectionId: first.connection.id, modelId: 'video-selected', defaults: { duration: 5 } }
  expect((await f.host.configureWorkbench({ ref: f.ref, expectedRevision: current.canvasRevision,
    operationId: 'video-override' as CanvasOperationId, data: current.data })).ok).toBe(true)
  const input = { ...f.input('image-only', { imageModel: 'image-two', videoModel: 'unused-video', audioModel: 'unused-audio' }), targetKind: 'image' as const }
  const result = await f.host.connectAndApply(input)
  if (!result.ok) throw new Error(result.message)
  expect(result.applied).toEqual(['image'])
  const expected = { image: { connectionId: result.connection.id }, video: current.data.routes.video }
  expect((await f.host.describeWorkbench(f.ref)).data.routes).toEqual(expected)
  expect(await f.host.connectAndApply(input)).toMatchObject({ ok: true, applied: ['image'] })
  await expect(f.host.connectAndApply({ ...input, targetKind: 'audio' })).rejects.toThrow('different connection settings')
  expect((await f.host.describeWorkbench(f.ref)).data.routes).toEqual(expected)
})

it('retains non-target models when reconnecting a media row and rejects a missing target capability', async () => {
  const f = await fixture()
  const first = await f.host.connectAndApply(f.input('base', { imageModel: 'image-one', videoModel: 'video-one', audioModel: 'voice-one' }))
  if (!first.ok) throw new Error(first.message)
  const current = await f.host.describeWorkbench(f.ref)
  current.data.routes.video = { connectionId: first.connection.id, modelId: 'video-selected', defaults: { duration: 5 } }
  expect((await f.host.configureWorkbench({ ref: f.ref, expectedRevision: current.canvasRevision,
    operationId: 'video-override' as CanvasOperationId, data: current.data })).ok).toBe(true)
  const input = f.input('edit-image', { imageModel: 'image-two' })
  const result = await f.host.connectAndApply({ ...input, targetKind: 'image', connection: { ...input.connection, id: first.connection.id } })
  if (!result.ok) throw new Error(result.message)
  expect(result.applied).toEqual(['image'])
  expect(result.connection.settings).toEqual({ imageModel: 'image-two', videoModel: 'video-one', audioModel: 'voice-one' })
  expect((await f.host.describeWorkbench(f.ref)).data.routes).toEqual(current.data.routes)
  const before = await f.host.listConnections(f.ref)
  expect(await f.host.connectAndApply({ ...f.input('wrong-kind', { imageModel: 'image-only' }), targetKind: 'video' }))
    .toMatchObject({ ok: false, code: 'invalid-command' })
  expect(await f.host.listConnections(f.ref)).toEqual(before)
  expect((await f.host.describeWorkbench(f.ref)).data.routes).toEqual(current.data.routes)
})

it('generates each media with its selected Provider and model, including a newly enabled kind on an existing connection', async () => {
  const f = await fixture()
  const alternate = new ConfigurationProvider()
  alternate.descriptor.id = 'alternate-media' as ProviderId
  f.host.registerProvider(alternate)
  const primary = await f.host.connectAndApply(f.input('primary', { imageModel: 'primary-image', videoModel: 'primary-video', audioModel: 'primary-audio' }))
  if (!primary.ok) throw new Error(primary.message)
  const otherInput = f.input('alternate', { imageModel: 'alternate-image' })
  const secondary = await f.host.connectAndApply({ ...otherInput, targetKind: 'image',
    connection: { ...otherInput.connection, providerId: alternate.descriptor.id } })
  if (!secondary.ok) throw new Error(secondary.message)
  const current = await f.host.describeWorkbench(f.ref)
  current.data.routes.image = { connectionId: secondary.connection.id, modelId: 'selected-image', defaults: { size: 'large' } }
  current.data.routes.video = { connectionId: primary.connection.id, modelId: 'selected-video', defaults: { duration: 5 } }
  expect((await f.host.configureWorkbench({ ref: f.ref, expectedRevision: current.canvasRevision,
    operationId: 'pick-models' as CanvasOperationId, data: current.data })).ok).toBe(true)
  const chatId = 'mixed-chat' as CanvasNodeId
  const caller: CreationInvocation = { sessionId: 'mixed-thread' as CreationInvocation['sessionId'], turn: 1, callId: 'image' as CreationInvocation['callId'] }
  const connected = await f.canvas.commit({ canvasId: f.ref.canvasId, expectedRevision: f.repository.revision(f.ref.canvasId),
    operationId: 'mixed-chat' as CanvasOperationId, ops: [
      { op: 'node.add', id: chatId, typeId: 'convax.chat' as CanvasNodeTypeId, dataVersion: 1,
        position: { x: 400, y: 0 }, data: { title: 'Media conversation', cwd: f.root } },
      { op: 'edge.add', id: 'mixed-capability' as CanvasConnectionId, source: f.ref.nodeId, sourcePort: 'output',
        target: chatId, targetPort: 'input', purpose: 'capability' },
    ] })
  expect(connected).toMatchObject({ ok: true })
  await f.repository.coordination.reserveThread({ kind: 'create', canvasId: f.ref.canvasId, nodeId: chatId,
    expectedRevision: f.repository.revision(f.ref.canvasId), operationId: 'mixed-thread' as CanvasOperationId }, f.root)
  expect(await f.repository.coordination.completeThread('mixed-thread' as CanvasOperationId, caller.sessionId, 0)).toBe(true)
  const jobs: Awaited<ReturnType<ConvaxCreationHost['generate']>>[] = []
  for (const kind of ['image', 'video', 'audio'] as const) {
    jobs.push(await f.host.generate({ kind, prompt: `Create ${kind}` }, { ...caller, callId: kind as CreationInvocation['callId'] }))
  }
  await vi.waitFor(() => { expect(jobs.map(job => f.store.get(job.jobId).state)).toEqual(['completed', 'completed', 'completed']) })
  expect(alternate.received.map(value => value.request)).toEqual([
    { kind: 'image', modelId: 'selected-image', prompt: 'Create image', parameters: { size: 'large' }, references: [] },
  ])
  expect(f.provider.received.map(value => value.request)).toEqual([
    { kind: 'video', modelId: 'selected-video', prompt: 'Create video', parameters: { duration: 5 }, references: [] },
    { kind: 'audio', modelId: 'primary-audio', prompt: 'Create audio', parameters: {}, references: [] },
  ])
  const switched = await f.host.describeWorkbench(f.ref)
  switched.data.routes.video = { connectionId: secondary.connection.id, modelId: 'alternate-video' }
  expect((await f.host.configureWorkbench({ ref: f.ref, expectedRevision: switched.canvasRevision,
    operationId: 'switch-video-provider' as CanvasOperationId, data: switched.data })).ok).toBe(true)
  const next = await f.host.generate({ kind: 'video', prompt: 'Another video' }, { ...caller, callId: 'next-video' as CreationInvocation['callId'] })
  await vi.waitFor(() => { expect(f.store.get(next.jobId).state).toBe('completed') })
  expect(alternate.received.at(-1)?.request).toEqual({ kind: 'video', modelId: 'alternate-video', prompt: 'Another video', parameters: {}, references: [] })
  expect(alternate.received.at(-1)?.connection.settings).toEqual({ imageModel: 'selected-image', videoModel: 'alternate-video' })
  expect(f.store.connections.get(secondary.connection.id)?.settings).toEqual({ imageModel: 'alternate-image' })
  expect(f.store.get(jobs[1]!.jobId).connection.providerId).toBe(f.provider.descriptor.id)
  expect(f.store.get(jobs[1]!.jobId).request.modelId).toBe('selected-video')
  expect((await f.host.describeWorkbench(f.ref)).data.routes).toEqual(switched.data.routes)
  expect(f.provider.submissions).toBe(2)
  expect(alternate.submissions).toBe(2)
})

it('keeps configuration unchanged when credential or connection persistence fails', async () => {
  const f = await fixture()
  vi.spyOn(f.ctx.credentials, 'modifyRecord').mockRejectedValueOnce(new Error('keychain locked'))
  await expect(f.host.connectAndApply({ ...f.input('key-failure'), apiKey: 'test-secret' })).rejects.toThrow('keychain locked')
  f.pool.failNextWrites = 1
  await expect(f.host.connectAndApply({ ...f.input('store-failure'), apiKey: 'test-secret' })).rejects.toThrow('injected write failure')
  expect(await f.host.listConnections(f.ref)).toEqual([])
  expect(await f.ctx.credentials.listRecords()).toEqual([])
  expect(f.repository.snapshot().canvases[0]?.revision).toBe(2)
})

it('rejects a concurrent canvas change and rolls back the staged connection and new key', async () => {
  const f = await fixture()
  f.provider.beforeDescribe = async () => {
    f.provider.beforeDescribe = undefined
    await f.canvas.commit({ canvasId: f.ref.canvasId, expectedRevision: 2, operationId: 'other-edit' as CanvasOperationId,
      ops: [{ op: 'node.set', id: f.ref.nodeId, dataVersion: 1, data: { title: 'Other edit', routes: {} } }] })
  }
  expect(await f.host.connectAndApply({ ...f.input('conflict'), apiKey: 'test-secret' })).toMatchObject({ ok: false, code: 'conflict' })
  expect(await f.host.listConnections(f.ref)).toEqual([])
  expect(await f.ctx.credentials.listRecords()).toEqual([])
  expect((await f.host.describeWorkbench(f.ref)).data).toEqual({ title: 'Other edit', routes: {} })
})

it('deduplicates concurrent retries and rejects changed payloads using a consumed identity', async () => {
  const f = await fixture()
  const input = f.input('one-operation')
  const [first, second] = await Promise.all([f.host.connectAndApply(input), f.host.connectAndApply(input)])
  expect(first).toEqual(second)
  expect(await f.host.listConnections(f.ref)).toHaveLength(1)
  expect(f.repository.snapshot().canvases[0]?.revision).toBe(3)
  await expect(f.host.connectAndApply({ ...input, connection: { ...input.connection, settings: { imageModel: 'different' } } })).rejects.toThrow('different connection settings')
})

it('updates the one model source and removes unsupported routes belonging to the edited connection', async () => {
  const f = await fixture()
  const first = await f.host.connectAndApply(f.input('initial', { imageModel: 'old-image', audioModel: 'old-voice' }))
  if (!first.ok) throw new Error(first.message)
  const current = await f.host.describeWorkbench(f.ref)
  current.data.routes.image = { connectionId: first.connection.id, modelId: 'old-image', defaults: { oldOnlyParameter: true } }
  await f.host.configureWorkbench({ ref: f.ref, operationId: 'legacy-route' as CanvasOperationId, expectedRevision: current.canvasRevision, data: current.data })
  const next = f.input('edit', { imageModel: 'new-image' })
  expect((await f.host.connectAndApply({ ...next, connection: { ...next.connection, id: first.connection.id } })).ok).toBe(true)
  const view = await f.host.describeWorkbench(f.ref)
  expect(view.data.routes).toEqual({ image: { connectionId: first.connection.id } })
  expect(view.connections[0]?.inspection).toMatchObject({ state: 'ready', capabilities: [{ kind: 'image', modelId: 'new-image' }] })
})

it('switches a workbench model without rewriting its saved connection or another workbench', async () => {
  const f = await fixture()
  const first = await f.host.connectAndApply(f.input('base-model'))
  if (!first.ok) throw new Error(first.message)
  const other = { ...f.ref, nodeId: 'second-workbench' as CanvasNodeId }
  await f.canvas.commit({ canvasId: other.canvasId, expectedRevision: f.repository.snapshot().canvases[0]!.revision,
    operationId: 'second-workbench' as CanvasOperationId, ops: [{ op: 'node.add', id: other.nodeId,
      typeId: 'convax.creation' as CanvasNodeTypeId, dataVersion: 1, position: { x: 500, y: 0 }, data: { title: 'Second', routes: {} } }] })
  const second = await f.host.connectAndApply({ ...f.input('second-model'), ref: other })
  if (!second.ok) throw new Error(second.message)
  const view = await f.host.describeWorkbench(f.ref)
  const changed = { ref: f.ref, expectedRevision: view.canvasRevision, operationId: 'inline-model' as CanvasOperationId,
    data: { ...view.data, routes: { image: { connectionId: first.connection.id, modelId: 'image-two' } } } }
  expect((await f.host.configureWorkbench(changed)).ok).toBe(true)
  expect((await f.host.inspectConnection(f.ref, first.connection.id))).toMatchObject({ state: 'ready', capabilities: [{ modelId: 'image-two' }] })
  expect((await f.host.listConnections(f.ref))[0]?.settings.imageModel).toBe('image-one')
  expect((await f.host.inspectConnection(other, second.connection.id))).toMatchObject({ state: 'ready', capabilities: [{ modelId: 'image-one' }] })
  // A lost acknowledgement replays the exact graph mutation even while the Provider is offline.
  f.provider.beforeDescribe = () => Promise.reject(new Error('Provider offline'))
  expect((await f.host.configureWorkbench(changed)).ok).toBe(true)
  f.provider.beforeDescribe = undefined
  const updated = await f.host.describeWorkbench(f.ref)
  await expect(f.host.configureWorkbench({ ...changed, operationId: 'invalid-model' as CanvasOperationId,
    expectedRevision: updated.canvasRevision,
    data: { ...updated.data, routes: { image: { connectionId: first.connection.id, modelId: 'bad' } } } })).rejects.toThrow('Unknown image model')
  await expect(f.host.configureWorkbench({ ...changed, ref: other, operationId: 'foreign-connection' as CanvasOperationId,
    expectedRevision: updated.canvasRevision })).rejects.toThrow('does not belong')
  const edit = f.input('label-edit')
  edit.connection.id = first.connection.id
  edit.connection.label = 'Renamed connection'
  expect((await f.host.connectAndApply(edit)).ok).toBe(true)
  expect((await f.host.describeWorkbench(f.ref)).data.routes.image?.modelId).toBe('image-two')
  await f.close()
  const reopened = await fixture({ root: f.root, pool: f.pool })
  expect(await reopened.host.inspectConnection(reopened.ref, first.connection.id)).toMatchObject({ state: 'ready', capabilities: [{ modelId: 'image-two' }] })
})

it('hides a staged connection until the graph commits and resumes the exact operation after a transport failure', async () => {
  const f = await fixture()
  const input = { ...f.input('resume'), apiKey: 'test-secret' }
  vi.spyOn(f.canvas, 'commit').mockRejectedValueOnce(new Error('graph unavailable'))
  await expect(f.host.connectAndApply(input)).rejects.toThrow('graph unavailable')
  expect(await f.host.listConnections(f.ref)).toEqual([])
  expect(f.store.connections.size).toBe(0)
  expect(await f.ctx.credentials.listRecords()).toEqual([])
  expect((await f.host.describeWorkbench(f.ref)).data.routes).toEqual({})
  const result = await f.host.connectAndApply(input)
  expect(result.ok).toBe(true)
  expect(await f.host.listConnections(f.ref)).toHaveLength(1)
  expect(f.repository.snapshot().canvases[0]?.revision).toBe(3)
})

it('recovers a lost graph acknowledgement after reopening both stores without duplicating the application', async () => {
  const f = await fixture()
  const input = f.input('lost-ack')
  const commit = f.canvas.commit.bind(f.canvas)
  vi.spyOn(f.canvas, 'commit').mockImplementationOnce(async (request) => { await commit(request); throw new Error('lost acknowledgement') })
  await expect(f.host.connectAndApply(input)).rejects.toThrow('lost acknowledgement')
  expect(await f.host.listConnections(f.ref)).toHaveLength(1)
  await f.close()
  const reopened = await fixture({ root: f.root, pool: f.pool })
  expect(await reopened.host.listConnections(reopened.ref)).toHaveLength(1)
  expect((await reopened.host.connectAndApply(input)).ok).toBe(true)
  expect(reopened.repository.snapshot().canvases[0]?.revision).toBe(3)
  expect([...reopened.store.connections.entries()][0]?.[1].application?.phase).toBe('applied')
})

it('restores the previous connection after reopening an interrupted edit without its old operation identity', async () => {
  const f = await fixture()
  const first = await f.host.connectAndApply(f.input('original'))
  if (!first.ok) throw new Error(first.message)
  const changed = f.input('interrupted-edit', { imageModel: 'image-two' })
  vi.spyOn(f.canvas, 'commit').mockRejectedValueOnce(new Error('interrupted before graph commit'))
  await expect(f.host.connectAndApply({ ...changed, connection: { ...changed.connection, id: first.connection.id } }))
    .rejects.toThrow('interrupted before graph commit')
  await f.close()
  const reopened = await fixture({ root: f.root, pool: f.pool })
  const connections = await reopened.host.listConnections(reopened.ref)
  expect(connections).toHaveLength(1)
  expect(connections[0]).toMatchObject({ id: first.connection.id, revision: 1, settings: { imageModel: 'image-one' } })
  expect(reopened.store.connections.get(first.connection.id)?.application).toBeUndefined()
  expect((await reopened.host.describeWorkbench(reopened.ref)).data.routes).toEqual({ image: { connectionId: first.connection.id } })
})

it('retains successful visibility when local finalization fails and completes it on the next read', async () => {
  const f = await fixture()
  const commit = f.canvas.commit.bind(f.canvas)
  vi.spyOn(f.canvas, 'commit').mockImplementationOnce(async (request) => {
    const result = await commit(request)
    f.pool.failNextWrites = 1
    return result
  })
  const result = await f.host.connectAndApply(f.input('finalize'))
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.message)
  expect(f.store.connections.get(result.connection.id)?.application?.phase).toBe('staged')
  expect(await f.host.listConnections(f.ref)).toHaveLength(1)
  expect(f.store.connections.get(result.connection.id)?.application?.phase).toBe('applied')
  await f.database.table('operations').delete('finalize' as CanvasOperationId)
  expect(await f.host.listConnections(f.ref)).toHaveLength(1)
})

it('never treats an unrelated committed graph operation as a successful connection', async () => {
  const f = await fixture()
  f.provider.beforeDescribe = async () => {
    f.provider.beforeDescribe = undefined
    await f.canvas.commit({ canvasId: f.ref.canvasId, expectedRevision: 2, operationId: 'raced-operation' as CanvasOperationId,
      ops: [{ op: 'node.set', id: f.ref.nodeId, dataVersion: 1, data: { title: 'Unrelated edit', routes: {} } }] })
  }
  expect(await f.host.connectAndApply(f.input('raced-operation'))).toMatchObject({ ok: false, code: 'invalid-command' })
  expect(await f.host.listConnections(f.ref)).toEqual([])
  expect((await f.host.describeWorkbench(f.ref)).data).toEqual({ title: 'Unrelated edit', routes: {} })
})

it('prepares incomplete settings without saving the form or a transient API key', async () => {
  const f = await fixture()
  const prepare = vi.fn(async (_connection: ConnectionSnapshot, _signal: AbortSignal, key?: string): Promise<ProviderPreparation> => {
    expect(key).toBe('transient-secret')
    return { state: 'ready', models: [{ id: 'image-one', label: 'Image one', kind: 'image' }] }
  })
  const extended = Object.assign(f.provider, { prepare })
  expect(await f.host.prepareConnection({ ref: f.ref, connection: { providerId: extended.descriptor.id, label: 'Draft', settings: {} }, apiKey: 'transient-secret' }))
    .toEqual({ state: 'ready', models: [{ id: 'image-one', label: 'Image one', kind: 'image' }] })
  expect(await f.host.listConnections(f.ref)).toEqual([])
  expect(await f.ctx.credentials.listRecords()).toEqual([])
})

it('exposes pending quotes only to their workbench and rejects cross-workbench approval and rejection', async () => {
  const f = await fixture()
  const other = { ...f.ref, nodeId: 'other-workbench' as CanvasNodeId }
  expect((await f.canvas.commit({ canvasId: f.ref.canvasId,
    expectedRevision: f.repository.snapshot().canvases[0]!.revision, operationId: 'other-workbench' as CanvasOperationId,
    ops: [{ op: 'node.add', id: other.nodeId, typeId: 'convax.creation' as CanvasNodeTypeId, dataVersion: 1,
      position: { x: 400, y: 0 }, data: { title: 'Other', routes: {} } }] })).ok).toBe(true)
  const job = jobRecord.parse({ id: 'needs-approval', operationId: 'generation', input: { kind: 'image', prompt: 'Review this image' },
    origin: { canvasId: f.ref.canvasId, chatNodeId: 'chat', workbenchNodeId: f.ref.nodeId, sessionId: 'thread', turn: 1, callId: 'call' },
    connection: { id: 'connection', providerId: f.provider.descriptor.id, revision: 1, accountBinding: 'account', settings: {} },
    request: { kind: 'image', prompt: 'Review this image', parameters: {}, references: [] }, directory: join(f.root, 'job'),
    state: 'awaiting-approval', generationDone: false, outputs: [], issues: [],
    approval: { quoteId: 'quote-one', credits: 12, unit: 'credits', message: 'One image' } })
  await f.store.jobs.put(job.id, job)
  expect(await f.host.listPendingApprovals(f.ref)).toEqual([{ jobId: job.id, kind: 'image', prompt: 'Review this image', approval: job.approval }])
  expect(await f.host.listPendingApprovals(other)).toEqual([])
  expect(await f.host.listWorkbenchJobs(f.ref)).toMatchObject([{ jobId: job.id, prompt: 'Review this image', state: 'awaiting-approval' }])
  expect(await f.host.listWorkbenchJobs(other)).toEqual([])
  await expect(f.host.approveGeneration({ ref: other, jobId: job.id, quoteId: 'quote-one' })).rejects.toThrow('another workbench')
  await expect(f.host.rejectGeneration({ ref: other, jobId: job.id })).rejects.toThrow('another workbench')
  await expect(f.host.approveGeneration({ ref: f.ref, jobId: job.id, quoteId: 'obsolete-quote' })).rejects.toThrow('quote has changed')
  expect(f.store.get(job.id).state).toBe('awaiting-approval')
  expect(f.store.get(job.id).approvedCredits).toBeUndefined()
  expect(f.provider.submissions).toBe(0)
  expect(f.provider.cancellations).toBe(0)
  await f.store.update(job.id, current => ({ ...current, state: 'running', checkpoint: { version: 1, data: { privateToken: 'fixture-secret' } } }))
  const running = await f.host.listWorkbenchJobs(f.ref)
  expect(running).toMatchObject([{ jobId: job.id, state: 'running' }])
  expect(running[0]?.approval).toBeUndefined()
  expect(JSON.stringify(running)).not.toContain('fixture-secret')
  await f.store.update(job.id, current => ({ ...current, state: 'completed', generationDone: true }))
  expect(await f.host.listWorkbenchJobs(f.ref)).toMatchObject([{ jobId: job.id, state: 'completed' }])
  // Persist out of timestamp order so the history limit cannot depend on backend iteration order.
  for (let index = 24; index >= 0; index--) {
    const record = jobRecord.parse({ ...job, id: `settled-${index}`, admittedAt: index + 1, state: 'completed', generationDone: true })
    await f.store.jobs.put(record.id, record)
  }
  const active = jobRecord.parse({ ...job, id: 'old-active', admittedAt: 0, state: 'running' })
  await f.store.jobs.put(active.id, active)
  const history = await f.host.listWorkbenchJobs(f.ref)
  expect(history.map(item => item.jobId)).toEqual(['old-active', ...Array.from({ length: 20 }, (_, index) => `settled-${index + 5}`)])
  expect(await f.host.listWorkbenchJobs(other)).toEqual([])
})
