/** One connection action commits configuration and workbench routing together. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasWorkspace } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { ConnectionId, CreationRemote, ProviderId, ProviderPreparation, WorkbenchView } from '@deepseek-ai/dsh-convax-plugin-creation-host/types'
import { CreationWorkbenches } from '../src/client/workbenches.ts'

function pending<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Promise executor did not initialize') }
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const canvasId = 'canvas' as CanvasId
const nodeId = 'workbench' as CanvasNodeId
const connectionId = 'local-cli' as ConnectionId
const providerId = 'fixture' as ProviderId
const ref = { canvasId, nodeId }
function workspace(): CanvasWorkspace {
  return { revision: 1, nodeTypes: [], nodeIssues: [], chats: [], canvases: [{ id: canvasId, revision: 4, title: 'Board', connections: [], nodes: [
    { id: nodeId, typeId: 'convax.creation' as CanvasNodeTypeId, revision: 1, dataVersion: 1, data: { title: 'Studio', routes: {} }, position: { x: 0, y: 0 } },
  ] }] }
}
function fixture(cli = false, installable = false, setup = false) {
  const graph = workspace()
  const connection = { id: connectionId, providerId, label: 'Local CLI', revision: 1, settings: { imageModel: 'image-v1' }, credentialConfigured: true }
  const ready = { state: 'ready' as const, capabilities: [{ kind: 'image' as const, modelId: 'image-v1', parameterSchema: {}, inputs: [], maxOutputs: 1 }], cancellation: 'unsupported' as const, submissionRecovery: 'unsupported' as const }
  const view: WorkbenchView = { ref, canvasRevision: 4, data: { title: 'Studio', routes: {} }, connections: [{ connection, inspection: ready }] }
  const remote = {
    describeWorkbench: vi.fn<CreationRemote['describeWorkbench']>().mockImplementation(async () => structuredClone(view)),
    listProviders: vi.fn<CreationRemote['listProviders']>().mockResolvedValue([{ id: providerId, title: 'Fixture', usesApiKey: true,
      connectionKind: cli ? 'cli' : 'api', supportedKinds: ['image'],
      ...(setup ? { authorization: true } : {}),
      ...(installable ? { installation: { supported: true, helpUrl: 'https://example.com/install' } } : {}), configuration: [
        { key: 'executable', label: 'Executable', type: 'text', advanced: true, affectsSetup: true },
        { key: 'profile', label: 'Profile', type: 'text', advanced: true, affectsSetup: true },
        { key: 'projectId', label: 'Project', type: 'text', managed: true },
        { key: 'imageModel', label: 'Image model', type: 'text', mediaKind: 'image' },
        { key: 'creditCeiling', label: 'Credit ceiling', type: 'number', advanced: true },
        { key: 'watermark', label: 'Watermark', type: 'boolean', default: true },
      ] }]),
    listConnections: vi.fn<CreationRemote['listConnections']>().mockResolvedValue([connection]),
    saveConnection: vi.fn<CreationRemote['saveConnection']>().mockResolvedValue(connection),
    prepareConnection: vi.fn<CreationRemote['prepareConnection']>().mockResolvedValue({ state: 'ready', models: [{ id: 'image-v1', label: 'Image v1', kind: 'image' }] }),
    installationStatus: vi.fn<CreationRemote['installationStatus']>().mockResolvedValue({ state: 'idle' }),
    installProvider: vi.fn<CreationRemote['installProvider']>().mockResolvedValue({ state: 'checking' }),
    beginAuthorization: vi.fn<CreationRemote['beginAuthorization']>().mockResolvedValue({ state: 'waiting', verificationUrl: 'https://example.com/authorize' }),
    authorizationStatus: vi.fn<CreationRemote['authorizationStatus']>().mockResolvedValue({ state: 'idle' }),
    listProviderCanvases: vi.fn<CreationRemote['listProviderCanvases']>().mockResolvedValue({ state: 'ready', items: [{ id: 'existing-canvas', label: 'A familiar canvas' }] }),
    createProviderCanvas: vi.fn<CreationRemote['createProviderCanvas']>().mockResolvedValue({ state: 'ready', canvas: { id: 'new-canvas', label: 'Studio' } }),
    listPendingApprovals: vi.fn<CreationRemote['listPendingApprovals']>().mockResolvedValue([]),
    listWorkbenchJobs: vi.fn<CreationRemote['listWorkbenchJobs']>().mockResolvedValue([]),
    approveGeneration: vi.fn<CreationRemote['approveGeneration']>().mockResolvedValue(undefined),
    rejectGeneration: vi.fn<CreationRemote['rejectGeneration']>().mockResolvedValue(undefined),
    connectAndApply: vi.fn<CreationRemote['connectAndApply']>().mockImplementation(async (input) => {
      view.data = structuredClone(input.data ?? view.data)
      view.data.routes.image ??= { connectionId }
      return { ok: true, workspace: graph, connection, inspection: ready, applied: ['image'] }
    }),
    inspectConnection: vi.fn<CreationRemote['inspectConnection']>().mockResolvedValue(ready),
    configureWorkbench: vi.fn<CreationRemote['configureWorkbench']>().mockResolvedValue({ ok: true, workspace: graph }),
  }
  const publish = vi.fn(), report = vi.fn(), openExternal = vi.fn()
  const cards = new CreationWorkbenches(remote, publish, report, openExternal)
  onTestFinished(() => { cards.dispose() })
  cards.observe(graph)
  const state = () => cards.state(nodeId)!.getSnapshot()
  const open = async () => { cards.open(nodeId); await vi.waitFor(() => { expect(state().loading).toBe(false) }) }
  return { cards, remote, graph, view, publish, report, openExternal, state, open }
}

describe('Creation workbench configuration', () => {
  it('selects each media model once in one connection and can keep only video and audio enabled', async () => {
    const f = fixture()
    f.remote.listProviders.mockResolvedValue([{ id: providerId, title: 'Three media models', supportedKinds: ['image', 'video', 'audio'],
      configuration: [
        { key: 'imageModel', label: 'Image model', type: 'text', mediaKind: 'image' },
        { key: 'videoModel', label: 'Video model', type: 'text', mediaKind: 'video' },
        { key: 'audioModel', label: 'Audio model', type: 'text', mediaKind: 'audio' },
      ] }])
    await f.open()
    f.cards.newConnection(nodeId, providerId)
    f.cards.connectionSetting(nodeId, 'imageModel', 'image-v1')
    f.cards.enableKind(nodeId, 'video', true)
    f.cards.connectionSetting(nodeId, 'videoModel', 'video-v1')
    f.cards.enableKind(nodeId, 'audio', true)
    f.cards.connectionSetting(nodeId, 'audioModel', 'audio-v1')
    f.cards.enableKind(nodeId, 'image', false)
    await f.cards.saveConnection(nodeId)
    expect(f.remote.connectAndApply).toHaveBeenCalledOnce()
    expect(f.remote.connectAndApply.mock.calls[0]?.[0]).toMatchObject({
      connection: { settings: { videoModel: 'video-v1', audioModel: 'audio-v1' } }, data: { routes: {} },
    })
    expect(f.remote.connectAndApply.mock.calls[0]?.[0].connection.settings.imageModel).toBeUndefined()
    expect(f.remote.saveConnection).not.toHaveBeenCalled()
    expect(f.remote.configureWorkbench).not.toHaveBeenCalled()
    f.cards.dispose()
  })

  it('starts authorization only on request and resumes the same profile after closing', async () => {
    const f = fixture(true, false, true)
    f.remote.prepareConnection.mockResolvedValue({ state: 'unavailable', reason: 'not-authorized', message: 'CLI login required' })
    await f.open()
    f.cards.newConnection(nodeId, providerId)
    await vi.waitFor(() => { expect(f.state().authorization?.status?.state).toBe('idle') })
    expect(f.remote.beginAuthorization).not.toHaveBeenCalled()
    f.cards.connectionSetting(nodeId, 'profile', 'studio-account')
    await f.cards.prepare(nodeId)
    await vi.waitFor(() => { expect(f.state().authorization?.pending).toBe(false) })
    await f.cards.beginAuthorization(nodeId)
    expect(f.remote.beginAuthorization.mock.calls[0][0].connection.settings.profile).toBe('studio-account')
    expect(f.openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com/authorize')
    await f.cards.saveConnection(nodeId)
    expect(f.remote.connectAndApply).not.toHaveBeenCalled()
    f.cards.close(nodeId)
    f.remote.authorizationStatus.mockResolvedValue({ state: 'waiting', verificationUrl: 'https://example.com/authorize' })
    await f.open()
    await vi.waitFor(() => { expect(f.state().authorization?.status?.state).toBe('waiting') })
    expect(f.state().connectionDraft?.settings.profile).toBe('studio-account')
    expect(f.remote.beginAuthorization).toHaveBeenCalledOnce()
    expect(f.openExternal).toHaveBeenCalledOnce()
    f.remote.prepareConnection.mockResolvedValue({ state: 'ready', models: [{ id: 'image-v1', kind: 'image', label: 'Image v1' }] })
    f.remote.authorizationStatus.mockResolvedValue({ state: 'authorized' })
    await f.cards.checkAuthorization(nodeId)
    await vi.waitFor(() => { expect(f.state().preparation?.state).toBe('ready') })
    expect(f.state().preparation?.state).toBe('ready')
    expect(f.remote.createProviderCanvas).not.toHaveBeenCalled()
    f.cards.dispose()
  })

  it('ignores an old authorization result after changing the CLI profile', async () => {
    const f = fixture(true, false, true)
    f.remote.prepareConnection.mockResolvedValue({ state: 'unavailable', reason: 'not-authorized', message: 'Login required' })
    await f.open()
    f.cards.newConnection(nodeId, providerId)
    await vi.waitFor(() => { expect(f.state().authorization?.status?.state).toBe('idle') })
    const old = pending<Awaited<ReturnType<CreationRemote['beginAuthorization']>>>()
    f.remote.beginAuthorization.mockReturnValueOnce(old.promise)
    const authorizing = f.cards.beginAuthorization(nodeId)
    f.cards.connectionSetting(nodeId, 'profile', 'another-account')
    await f.cards.prepare(nodeId)
    old.resolve({ state: 'authorized' })
    await authorizing
    expect(f.state().preparation?.state).toBe('unavailable')
    expect(f.remote.listProviderCanvases).not.toHaveBeenCalled()
    expect(f.openExternal).not.toHaveBeenCalled()
    expect(f.remote.authorizationStatus.mock.calls.at(-1)?.[0].connection.settings.profile).toBe('another-account')
    f.cards.dispose()
  })

  it('connects selected models without exposing or requesting a remote canvas', async () => {
    const f = fixture(true, false, true)
    await f.open()
    f.cards.newConnection(nodeId, providerId)
    await vi.waitFor(() => { expect(f.state().preparing).toBe(false) })
    f.cards.connectionSetting(nodeId, 'projectId', 'injected-project')
    f.cards.connectionSetting(nodeId, 'imageModel', 'image-v1')
    await f.cards.saveConnection(nodeId)
    expect(f.remote.connectAndApply).toHaveBeenCalledOnce()
    expect(f.remote.connectAndApply.mock.calls[0]?.[0].connection.settings.projectId).toBeUndefined()
    expect(f.remote.listProviderCanvases).not.toHaveBeenCalled()
    expect(f.remote.createProviderCanvas).not.toHaveBeenCalled()
  })

  it('selecting and clearing a model enables and disables that capability without a second control', async () => {
    const f = fixture()
    await f.open()
    f.cards.newConnection(nodeId, providerId)
    f.cards.connectionSetting(nodeId, 'imageModel', 'image-v1')
    expect(f.state().connectionDraft?.enabledKinds).toContain('image')
    f.cards.connectionSetting(nodeId, 'imageModel', '')
    expect(f.state().connectionDraft?.enabledKinds).not.toContain('image')
  })

  it('owns native Chat pending state and allows a failed creation to be retried', async () => {
    const f = fixture()
    const started = pending<undefined>()
    const create = vi.fn().mockReturnValueOnce(started.promise).mockRejectedValueOnce(new Error('Cannot create Chat'))
    const creating = f.cards.newChat(nodeId, create)
    expect(f.state().chatPending).toBe(true)
    await f.cards.newChat(nodeId, create)
    expect(create).toHaveBeenCalledOnce()
    started.resolve(undefined)
    await creating
    expect(f.state().chatPending).toBe(false)
    await f.cards.newChat(nodeId, create)
    expect(f.state()).toMatchObject({ chatPending: false, error: 'chatFailed' })
  })

  it('refreshes the selected model only once when graph publication already notifies the workbench', async () => {
    const f = fixture()
    f.view.data.routes.image = { connectionId }
    await f.open()
    f.cards.close(nodeId)
    f.remote.prepareConnection.mockResolvedValue({ state: 'ready', models: [{ id: 'image-v2', label: 'Image Two', kind: 'image' }] })
    await f.cards.openModels(nodeId, 'image')
    const updated = structuredClone(f.graph)
    updated.canvases[0].nodes[0].revision += 1
    f.remote.configureWorkbench.mockResolvedValue({ ok: true, workspace: updated })
    f.publish.mockImplementation((next: CanvasWorkspace) => { f.cards.observe(next) })
    f.remote.describeWorkbench.mockClear()
    await f.cards.selectModel(nodeId, JSON.stringify([connectionId, 'image-v2']))
    await vi.waitFor(() => { expect(f.state().loading).toBe(false) })
    expect(f.remote.describeWorkbench).toHaveBeenCalledOnce()
  })

  it('connects one target kind, keeps other route overrides and preserves hidden saved models', async () => {
    const f = fixture(true)
    f.view.data.routes.image = { connectionId, modelId: 'old-image' }
    f.view.data.routes.video = { connectionId, modelId: 'special-video', defaults: { duration: 10 } }
    f.view.connections[0].connection.settings.videoModel = 'saved-video'
    await f.open()
    f.cards.close(nodeId)
    f.cards.connectProvider(nodeId, 'image', providerId)
    await vi.waitFor(() => { expect(f.state().preparing).toBe(false) })
    expect(f.state().targetKind).toBe('image')
    f.cards.connectionSetting(nodeId, 'imageModel', 'new-image')
    await f.cards.saveConnection(nodeId)
    expect(f.remote.connectAndApply.mock.calls[0]?.[0]).toMatchObject({ targetKind: 'image',
      connection: { settings: { imageModel: 'new-image', videoModel: 'saved-video' } },
      data: { routes: { video: { connectionId, modelId: 'special-video', defaults: { duration: 10 } } } },
    })
    expect(f.state().targetKind).toBeUndefined()
  })

  it('cancels target setup and does not carry its scope into later ordinary management', async () => {
    const f = fixture()
    await f.open()
    f.cards.close(nodeId)
    f.cards.connectProvider(nodeId, 'image', providerId)
    expect(f.state().connectionDraft?.targetKind).toBe('image')
    f.cards.close(nodeId)
    expect(f.remote.connectAndApply).not.toHaveBeenCalled()
    await f.open()
    f.cards.editConnection(nodeId, connectionId, false)
    expect(f.state().targetKind).toBeUndefined()
    expect(f.state().connectionDraft?.targetKind).toBeUndefined()
  })

  it('keeps the target form revision paired with its draft when an older background read settles', async () => {
    const f = fixture()
    await f.open()
    f.cards.close(nodeId)
    const reading = pending<WorkbenchView>()
    f.remote.describeWorkbench.mockReturnValueOnce(reading.promise)
    const updated = structuredClone(f.graph)
    updated.canvases[0].nodes[0].revision += 1
    f.cards.observe(updated)
    f.cards.connectProvider(nodeId, 'image', providerId)
    reading.resolve({ ...f.view, canvasRevision: 5, data: { ...f.view.data, routes: {
      video: { connectionId, modelId: 'another-window-video' },
    } } })
    // The observer already awaits this read in Promise.all; settle its queued continuation before asserting.
    await Promise.all([reading.promise])
    expect(f.state().view?.canvasRevision).toBe(4)
    expect(f.state().loading).toBe(false)
    f.cards.connectionSetting(nodeId, 'imageModel', 'image-v1')
    await f.cards.saveConnection(nodeId)
    expect(f.remote.connectAndApply.mock.calls[0]?.[0].expectedRevision).toBe(4)
  })

  it('connects, applies capabilities and closes in one request with each model configured once', async () => {
    const f = fixture()
    await f.open()
    f.cards.title(nodeId, 'New studio')
    f.cards.newConnection(nodeId, providerId)
    f.cards.connectionField(nodeId, 'apiKey', 'transient-secret')
    f.cards.connectionSetting(nodeId, 'imageModel', 'image-v1')
    f.cards.connectionSetting(nodeId, 'creditCeiling', '25')
    await f.cards.saveConnection(nodeId)
    expect(f.remote.connectAndApply).toHaveBeenCalledOnce()
    expect(f.remote.connectAndApply.mock.calls[0]?.[0]).toMatchObject({ ref, expectedRevision: 4,
      connection: { providerId, label: 'Fixture', settings: { imageModel: 'image-v1', creditCeiling: 25, watermark: true } },
      apiKey: 'transient-secret', data: { title: 'New studio', routes: {} } })
    expect(f.remote.saveConnection).not.toHaveBeenCalled()
    expect(f.remote.configureWorkbench).not.toHaveBeenCalled()
    expect(f.publish).toHaveBeenCalledWith(f.graph)
    expect(f.state()).toMatchObject({ open: false, saving: false, draft: undefined, connectionDraft: undefined })
    expect(JSON.stringify(f.state())).not.toContain('transient-secret')
    await f.open()
    expect(f.state().draft?.routes.image).toEqual({ connectionId })
    f.cards.dispose()
  })

  it('retains the complete draft on failure and retries the same operation until an edit', async () => {
    const f = fixture()
    await f.open()
    f.cards.newConnection(nodeId, providerId)
    f.cards.connectionField(nodeId, 'apiKey', 'keep-on-error')
    f.cards.connectionSetting(nodeId, 'imageModel', 'image-v1')
    f.remote.connectAndApply.mockRejectedValueOnce(new Error('Disconnected'))
    await f.cards.saveConnection(nodeId)
    expect(f.state()).toMatchObject({ open: true, saving: false, error: 'connectionFailed', connectionDraft: { apiKey: 'keep-on-error' } })
    expect(f.publish).not.toHaveBeenCalled()
    f.remote.connectAndApply.mockResolvedValueOnce({ ok: false, code: 'invalid-command', message: 'Unavailable', workspace: f.graph,
      inspection: { state: 'unavailable', reason: 'invalid-configuration', message: 'Choose another model' } })
    await f.cards.saveConnection(nodeId)
    expect(f.state().issue).toBe('Choose another model')
    const first = f.remote.connectAndApply.mock.calls[0][0]
    expect(f.remote.connectAndApply.mock.calls[1][0].operationId).toBe(first.operationId)
    f.cards.connectionSetting(nodeId, 'imageModel', 'image-v2')
    await f.cards.saveConnection(nodeId)
    expect(f.remote.connectAndApply.mock.calls[2][0].operationId).not.toBe(first.operationId)
    f.cards.dispose()
  })

  it('passes existing route choices along with connection settings without changing their model', async () => {
    const f = fixture()
    f.view.data.routes.video = { connectionId: 'other-provider' as ConnectionId }
    await f.open()
    f.cards.newConnection(nodeId, providerId)
    f.cards.connectionSetting(nodeId, 'imageModel', 'image-v1')
    await f.cards.saveConnection(nodeId)
    expect(f.remote.connectAndApply.mock.calls[0]?.[0].data?.routes.video).toEqual({ connectionId: 'other-provider' })
    expect(f.view.data.routes.video).toEqual({ connectionId: 'other-provider' })
    f.cards.dispose()
  })

  it('saves the workbench name without changing media selections', async () => {
    const f = fixture()
    f.view.data.routes.image = { connectionId, modelId: 'image-v2' }
    f.view.data.routes.video = { connectionId, modelId: 'video-v1', defaults: { duration: 5 } }
    await f.open()
    f.cards.title(nodeId, 'Updated studio')
    await f.cards.save(nodeId)
    expect(f.remote.configureWorkbench.mock.calls[0]?.[0].data).toEqual({ title: 'Updated studio', routes: f.view.data.routes })
    expect(f.remote.connectAndApply).not.toHaveBeenCalled()
  })

  it('uses exactly one credential source and removes disabled models from the submitted connection', async () => {
    const f = fixture()
    await f.open()
    f.cards.newConnection(nodeId, providerId)
    f.cards.connectionField(nodeId, 'apiKey', 'not-for-env')
    f.cards.credentialSource(nodeId, 'environment')
    expect(f.state().connectionDraft?.apiKey).toBe('')
    f.cards.connectionField(nodeId, 'credentialRef', 'MEDIA_API_KEY')
    f.cards.connectionSetting(nodeId, 'imageModel', 'image-v1')
    f.cards.enableKind(nodeId, 'image', false)
    await f.cards.saveConnection(nodeId)
    const input = f.remote.connectAndApply.mock.calls[0][0]
    expect(input.apiKey).toBeUndefined()
    expect(input.connection.credentialRef).toBe('MEDIA_API_KEY')
    expect(input.connection.settings.imageModel).toBeUndefined()
    f.cards.dispose()
  })

  it('does not persist cancellation and clears a key when selecting another Provider', async () => {
    const f = fixture()
    await f.open()
    f.cards.newConnection(nodeId, providerId)
    f.cards.connectionField(nodeId, 'apiKey', 'discarded')
    f.cards.dismissConnection(nodeId)
    expect(f.state()).toMatchObject({ choosing: true, connectionDraft: undefined })
    expect(JSON.stringify(f.state())).not.toContain('discarded')
    f.cards.newConnection(nodeId, providerId)
    f.cards.connectionField(nodeId, 'apiKey', 'discarded-again')
    f.cards.newConnection(nodeId, providerId)
    expect(f.state().connectionDraft?.apiKey).toBe('')
    f.cards.close(nodeId)
    expect(f.remote.connectAndApply).not.toHaveBeenCalled()
    expect(f.remote.saveConnection).not.toHaveBeenCalled()
    f.cards.dispose()
  })

  it('refreshes a conflicting workbench while retaining connection input and the latest existing routes', async () => {
    const f = fixture()
    await f.open()
    f.cards.newConnection(nodeId, providerId)
    f.cards.connectionField(nodeId, 'apiKey', 'retained-secret')
    f.cards.connectionSetting(nodeId, 'imageModel', 'image-v1')
    f.remote.connectAndApply.mockResolvedValueOnce({ ok: false, code: 'conflict', message: 'Changed', workspace: f.graph })
    await f.cards.saveConnection(nodeId)
    const previousOperation = f.remote.connectAndApply.mock.calls[0][0].operationId
    f.view.canvasRevision = 5
    f.view.data.routes.audio = { connectionId: 'other-account' as ConnectionId }
    await f.cards.refreshForRetry(nodeId)
    expect(f.state()).toMatchObject({ error: null, connectionDraft: { apiKey: 'retained-secret' }, view: { canvasRevision: 5 } })
    await f.cards.saveConnection(nodeId)
    const retry = f.remote.connectAndApply.mock.calls[1][0]
    expect(retry.expectedRevision).toBe(5)
    expect(retry.operationId).not.toBe(previousOperation)
    expect(retry.data?.routes.audio).toEqual({ connectionId: 'other-account' })
    f.cards.dispose()
  })

  it('requires an environment variable name instead of silently retaining an existing key', async () => {
    const f = fixture()
    await f.open()
    f.cards.editConnection(nodeId, connectionId)
    f.cards.credentialSource(nodeId, 'environment')
    await f.cards.saveConnection(nodeId)
    expect(f.state()).toMatchObject({ open: true, error: 'credentialRequired' })
    expect(f.remote.connectAndApply).not.toHaveBeenCalled()
    f.cards.dispose()
  })

  it('keeps pending CLI discovery valid while the approval ceiling and model fields are edited', async () => {
    const f = fixture(true)
    await f.open()
    const check = pending<ProviderPreparation>()
    f.remote.prepareConnection.mockReturnValueOnce(check.promise)
    f.cards.newConnection(nodeId, providerId)
    expect(f.state().preparing).toBe(true)
    f.cards.connectionSetting(nodeId, 'creditCeiling', '25')
    f.cards.connectionSetting(nodeId, 'imageModel', 'my-model')
    check.resolve({ state: 'ready', models: [{ id: 'my-model', label: 'My model', kind: 'image' }] })
    await vi.waitFor(() => { expect(f.state().preparing).toBe(false) })
    expect(f.state().preparation?.state).toBe('ready')
    expect(f.state().connectionDraft?.settings).toMatchObject({ creditCeiling: 25, imageModel: 'my-model' })
    f.cards.dispose()
  })

  it('cannot save a complete form while a connection check is still in progress', async () => {
    const f = fixture()
    await f.open()
    f.cards.newConnection(nodeId, providerId)
    f.cards.connectionSetting(nodeId, 'imageModel', 'image-v1')
    f.cards.connectionField(nodeId, 'apiKey', 'ready-key')
    const check = pending<ProviderPreparation>()
    f.remote.prepareConnection.mockReturnValueOnce(check.promise)
    const checking = f.cards.prepare(nodeId)
    await f.cards.saveConnection(nodeId)
    expect(f.remote.connectAndApply).not.toHaveBeenCalled()
    expect(f.state().preparing).toBe(true)
    check.resolve({ state: 'ready', models: [] })
    await checking
    expect(f.remote.connectAndApply).not.toHaveBeenCalled()
    await f.cards.saveConnection(nodeId)
    expect(f.remote.connectAndApply).toHaveBeenCalledOnce()
    f.cards.dispose()
  })

  it('ignores a stale CLI check after changing executable or credentials', async () => {
    const f = fixture(true)
    await f.open()
    const check = pending<ProviderPreparation>()
    f.remote.prepareConnection.mockReturnValueOnce(check.promise)
    f.cards.newConnection(nodeId, providerId)
    f.cards.connectionSetting(nodeId, 'executable', '/different/cli')
    expect(f.state().preparing).toBe(false)
    check.resolve({ state: 'unavailable', reason: 'not-installed', message: 'Missing old CLI' })
    await check.promise
    await Promise.resolve()
    expect(f.state().preparation).toBeUndefined()
    const again = pending<ProviderPreparation>()
    f.remote.prepareConnection.mockReturnValueOnce(again.promise)
    const inspection = f.cards.prepare(nodeId)
    f.cards.credentialSource(nodeId, 'environment')
    expect(f.state().preparing).toBe(false)
    again.resolve({ state: 'ready', models: [] })
    await inspection
    expect(f.state().preparation).toBeUndefined()
    f.cards.dispose()
  })

  it('reuses the existing account with a single application request and no key input', async () => {
    const f = fixture()
    await f.open()
    await f.cards.useConnection(nodeId, connectionId)
    expect(f.remote.connectAndApply).toHaveBeenCalledOnce()
    expect(f.remote.connectAndApply.mock.calls[0][0].connection).toMatchObject({ id: connectionId, settings: { imageModel: 'image-v1' } })
    expect(f.remote.connectAndApply.mock.calls[0][0].apiKey).toBeUndefined()
    expect(f.state().open).toBe(false)
    f.cards.dispose()
  })

  it('ignores earlier loads and removed nodes after asynchronous completion', async () => {
    const f = fixture()
    await f.open()
    const first = pending<WorkbenchView>()
    f.remote.describeWorkbench.mockReturnValueOnce(first.promise)
    f.cards.open(nodeId)
    f.cards.close(nodeId)
    first.resolve({ ...f.view, data: { title: 'Stale', routes: {} } })
    await first.promise
    await Promise.resolve()
    expect(f.state().view?.data.title).toBe('Studio')
    const removed = pending<WorkbenchView>()
    f.remote.describeWorkbench.mockReturnValueOnce(removed.promise)
    f.cards.open(nodeId)
    f.cards.observe({ ...f.graph, canvases: [] })
    removed.resolve(f.view)
    await removed.promise
    expect(f.cards.state(nodeId)).toBeUndefined()
    f.cards.dispose()
    f.cards.observe(f.graph)
    expect(f.cards.state(nodeId)).toBeUndefined()
  })

  it('checks an installable CLI automatically but installs only from the explicit action', async () => {
    const f = fixture(true, true)
    await f.open()
    f.remote.prepareConnection.mockResolvedValue({ state: 'unavailable', reason: 'not-installed', message: 'CLI missing' })
    f.cards.newConnection(nodeId, providerId)
    await vi.waitFor(() => { expect(f.state().preparation?.state).toBe('unavailable') })
    expect(f.remote.installationStatus).toHaveBeenCalledWith(ref, providerId)
    expect(f.remote.installProvider).not.toHaveBeenCalled()
    await f.cards.installProvider(nodeId)
    expect(f.remote.installProvider).toHaveBeenCalledOnce()
    expect(f.state().installation?.status?.state).toBe('checking')
    await f.cards.saveConnection(nodeId)
    expect(f.remote.connectAndApply).not.toHaveBeenCalled()
    await f.cards.installProvider(nodeId)
    expect(f.remote.installProvider).toHaveBeenCalledOnce()
    f.cards.dispose()
  })

  it('cannot save while the installation status is unknown', async () => {
    const f = fixture(true, true)
    await f.open()
    f.remote.installationStatus.mockRejectedValueOnce(new Error('Status unavailable'))
    f.cards.newConnection(nodeId, providerId)
    await vi.waitFor(() => { expect(f.state().installation?.statusUnavailable).toBe(true) })
    f.cards.connectionSetting(nodeId, 'imageModel', 'image-v1')
    await f.cards.saveConnection(nodeId)
    expect(f.remote.connectAndApply).not.toHaveBeenCalled()
    f.cards.dispose()
  })

  it('reopens an active installation, observes its completion, and checks login separately', async () => {
    const f = fixture(true, true)
    await f.open()
    f.remote.prepareConnection.mockResolvedValue({ state: 'unavailable', reason: 'not-installed', message: 'CLI missing' })
    f.cards.newConnection(nodeId, providerId)
    await vi.waitFor(() => { expect(f.state().preparing).toBe(false); expect(f.state().preparation).toBeDefined() })
    await f.cards.installProvider(nodeId)
    f.cards.close(nodeId)
    expect(f.state().open).toBe(false)
    f.remote.installationStatus.mockResolvedValue({ state: 'ready', executable: '/managed/creation-cli' })
    f.remote.prepareConnection.mockResolvedValue({ state: 'unavailable', reason: 'not-authorized', message: 'Sign in to the CLI' })
    await f.open()
    await vi.waitFor(() => { expect(f.state().preparation).toMatchObject({ state: 'unavailable', reason: 'not-authorized' }) })
    expect(f.state().installation?.status?.state).toBe('ready')
    expect(f.state().connectionDraft?.settings.executable).toBe('/managed/creation-cli')
    expect(f.remote.installProvider).toHaveBeenCalledOnce()
    expect(f.remote.connectAndApply).not.toHaveBeenCalled()
    f.cards.dispose()
  })

  it('never applies an old installer result after leaving the selected service', async () => {
    const f = fixture(true, true)
    const otherProvider = 'api-provider' as ProviderId
    f.remote.listProviders.mockResolvedValue([
      ...await f.remote.listProviders(), { id: otherProvider, title: 'Other API', connectionKind: 'api', supportedKinds: ['image'] },
    ])
    await f.open()
    const check = pending<Awaited<ReturnType<CreationRemote['installationStatus']>>>()
    f.remote.installationStatus.mockReturnValueOnce(check.promise)
    f.cards.newConnection(nodeId, providerId)
    f.cards.choose(nodeId, true)
    f.cards.newConnection(nodeId, otherProvider)
    check.resolve({ state: 'ready', executable: '/old/cli' })
    await check.promise
    await Promise.resolve()
    expect(f.state().connectionDraft?.providerId).toBe(otherProvider)
    expect(f.state().installation).toBeUndefined()
    expect(f.remote.prepareConnection).not.toHaveBeenCalled()
    f.cards.dispose()
  })
})
