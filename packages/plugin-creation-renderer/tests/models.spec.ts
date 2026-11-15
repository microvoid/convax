/** Direct model choices preserve all other routes and never mutate a saved provider connection. */
import { expect, it, onTestFinished, vi } from 'vitest'
import type { CanvasId, CanvasNodeId, CanvasWorkspace } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { ConnectionId, CreationRemote, ProviderDescriptor, ProviderId, ProviderPreparation, WorkbenchView } from '@deepseek-ai/dsh-convax-plugin-creation-host/types'
import { CreationModelSelection, type ModelSelectionState } from '../src/client/models.ts'

const ref = { canvasId: 'board' as CanvasId, nodeId: 'workbench' as CanvasNodeId }
const connectionId = 'jimeng' as ConnectionId
function fixture() {
  const view: WorkbenchView = { ref, canvasRevision: 4, data: { title: 'Studio', routes: {
    image: { connectionId, defaults: { ratio: '1:1' } }, video: { connectionId, modelId: 'video-v1', defaults: { duration: 5 } },
  } }, connections: [{ connection: { id: connectionId, providerId: 'jimeng' as ProviderId, label: 'Local account', revision: 1,
    settings: { imageModel: 'image-v1', videoModel: 'video-v1' }, credentialConfigured: false }, inspection: {
    state: 'ready', cancellation: 'unsupported', submissionRecovery: 'unsupported', capabilities: [
      { kind: 'image', modelId: 'image-v1', modelLabel: 'Image One', parameterSchema: {}, inputs: [], maxOutputs: 1 },
      { kind: 'video', modelId: 'video-v1', modelLabel: 'Video One', parameterSchema: {}, inputs: [], maxOutputs: 1 },
    ],
  } }] }
  const workspace: CanvasWorkspace = { revision: 1, nodeTypes: [], nodeIssues: [], chats: [], canvases: [] }
  const remote = {
    prepareConnection: vi.fn<CreationRemote['prepareConnection']>().mockResolvedValue({ state: 'ready', models: [
      { kind: 'image', id: 'image-v1', label: 'Image One' }, { kind: 'image', id: 'image-v2', label: 'Image Two' },
      { kind: 'video', id: 'video-v2', label: 'Video Two' },
    ] }),
    configureWorkbench: vi.fn<CreationRemote['configureWorkbench']>().mockResolvedValue({ ok: true, workspace }),
  }
  const providers: ProviderDescriptor[] = [
    { id: 'jimeng' as ProviderId, title: 'Jimeng CLI', supportedKinds: ['image', 'video', 'audio'] },
  ]
  let state: ModelSelectionState | undefined
  const publish = vi.fn((next: ModelSelectionState) => { state = next })
  const accept = vi.fn()
  const models = new CreationModelSelection(remote, ref, () => view, () => providers, publish, accept, vi.fn())
  onTestFinished(() => { models.dispose() })
  return { view, workspace, remote, publish, accept, models, providers, state: () => state! }
}

it('selects one readable model, immediately commits only that route, and keeps the connection immutable', async () => {
  const f = fixture()
  await f.models.open('image')
  expect(f.state().options.map(item => item.label)).toEqual(['Image One', 'Image Two'])
  await f.models.select(f.state().options[1].id)
  expect(f.remote.configureWorkbench).toHaveBeenCalledOnce()
  expect(f.remote.configureWorkbench.mock.calls[0]?.[0]).toMatchObject({ expectedRevision: 4, data: {
    title: 'Studio', routes: { image: { connectionId, modelId: 'image-v2' },
      video: { connectionId, modelId: 'video-v1', defaults: { duration: 5 } } },
  } })
  expect(f.remote.configureWorkbench.mock.calls[0]?.[0].data.routes.image?.defaults).toBeUndefined()
  expect(f.view.connections[0]?.connection.settings.imageModel).toBe('image-v1')
  expect(f.view.data.routes.image?.modelId).toBeUndefined()
  expect(f.accept).toHaveBeenCalledExactlyOnceWith(f.workspace)
  expect(f.state()).toMatchObject({ kind: undefined, saving: false })
})

it('retains the previous choice on failure and retries an unknown commit with the same operation id', async () => {
  const f = fixture()
  await f.models.open('image')
  f.remote.configureWorkbench.mockRejectedValueOnce(new Error('Reply lost'))
  const selected = f.state().options[1].id
  await f.models.select(selected)
  expect(f.state()).toMatchObject({ kind: 'image', error: 'modelChangeFailed', saving: false })
  expect(f.accept).not.toHaveBeenCalled()
  expect(f.view.data.routes.image?.modelId).toBeUndefined()
  await f.models.select(selected)
  expect(f.remote.configureWorkbench.mock.calls[1]?.[0].operationId).toBe(f.remote.configureWorkbench.mock.calls[0]?.[0].operationId)
  expect(f.state().kind).toBeUndefined()
})

it('adopts a conflicting workspace before retrying the selection against the refreshed revision', async () => {
  const f = fixture()
  await f.models.open('image')
  f.remote.configureWorkbench.mockResolvedValueOnce({ ok: false, code: 'conflict', message: 'Changed', workspace: f.workspace })
  f.accept.mockImplementation(() => { f.view.canvasRevision = 5 })
  const selected = f.state().options[1].id
  await f.models.select(selected)
  expect(f.state()).toMatchObject({ kind: 'image', error: 'changed' })
  expect(f.accept).toHaveBeenCalledExactlyOnceWith(f.workspace)
  await f.models.select(selected)
  expect(f.remote.configureWorkbench.mock.calls[1]?.[0].expectedRevision).toBe(5)
  expect(f.remote.configureWorkbench.mock.calls[1]?.[0].operationId).not.toBe(f.remote.configureWorkbench.mock.calls[0]?.[0].operationId)
})

it('ignores an old media catalogue and suppresses late reads after disposal', async () => {
  const f = fixture()
  let resolve!: (value: ProviderPreparation) => void
  const pending = new Promise<ProviderPreparation>((done) => { resolve = done })
  f.remote.prepareConnection.mockReturnValueOnce(pending)
  const old = f.models.open('image')
  await f.models.open('video')
  resolve({ state: 'ready', models: [{ kind: 'image', id: 'late', label: 'Late image' }] })
  await old
  expect(f.state().kind).toBe('video')
  expect(f.state().options[0]?.label).toBe('Video Two')
  let finish!: (value: ProviderPreparation) => void
  const outstanding = new Promise<ProviderPreparation>((done) => { finish = done })
  f.remote.prepareConnection.mockReturnValueOnce(outstanding)
  const reading = f.models.open('image')
  f.models.dispose()
  const count = f.publish.mock.calls.length
  finish({ state: 'ready', models: [{ kind: 'image', id: 'disposed', label: 'Disposed result' }] })
  await reading
  expect(f.publish).toHaveBeenCalledTimes(count)
})

it('groups all applicable Providers and can enable an unselected kind on another saved connection', async () => {
  const f = fixture(), libtvId = 'libtv' as ProviderId, libtvConnection = 'libtv-account' as ConnectionId
  f.providers.push({ id: libtvId, title: 'LibTV CLI', supportedKinds: ['image', 'video'] },
    { id: 'openai' as ProviderId, title: 'OpenAI', supportedKinds: ['image'] },
    { id: 'video-only' as ProviderId, title: 'Video only', supportedKinds: ['video'] })
  f.view.connections = [...f.view.connections, { connection: { id: libtvConnection, providerId: libtvId,
    label: 'Production account', revision: 1, settings: { videoModel: 'libtv-video' }, credentialConfigured: false },
  inspection: { state: 'ready', capabilities: [{ kind: 'video', modelId: 'libtv-video', inputs: [], parameterSchema: {}, maxOutputs: 1 }],
    cancellation: 'unsupported', submissionRecovery: 'unsupported' } }]
  f.remote.prepareConnection.mockImplementation(async input => ({ state: 'ready', models: input.connection.providerId === libtvId
    ? [{ kind: 'image', id: 'libtv-image', label: 'LibTV Image' }] : [{ kind: 'image', id: 'image-v1', label: 'Image One' }] }))
  await f.models.open('image')
  expect(f.state().providers.map(provider => provider.title)).toEqual(['Jimeng CLI', 'LibTV CLI', 'OpenAI'])
  expect(f.state().providers.find(provider => provider.id === 'openai')?.connectionIds).toEqual([])
  const libtv = f.state().providers.find(provider => provider.id === libtvId)!
  expect(libtv.options.map(option => option.label)).toEqual(['LibTV Image'])
  expect(f.remote.configureWorkbench).not.toHaveBeenCalled()
  await f.models.select(libtv.options[0].id)
  const data = f.remote.configureWorkbench.mock.calls[0]?.[0].data
  expect(data?.routes.image).toEqual({ connectionId: libtvConnection, modelId: 'libtv-image' })
  expect(data?.routes.video).toEqual({ connectionId, modelId: 'video-v1', defaults: { duration: 5 } })
  expect(f.view.connections[1]?.connection.settings).toEqual({ videoModel: 'libtv-video' })
})
