// @vitest-environment jsdom
/** The visible workbench keeps models, creation and generation tasks in their own places. */
import { useSyncExternalStore, type ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import type { CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasWorkspace } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { AssetId, ConnectionId, CreationRemote, JobId, MediaKind, ProviderId, WorkbenchJobView, WorkbenchView } from '@deepseek-ai/dsh-convax-plugin-creation-host/types'
import { Workbench } from '../src/client/Workbench.tsx'
import { CreationWorkbenches } from '../src/client/workbenches.ts'
import { en, type CreationKey } from '../src/client/locales.ts'

vi.mock('@deepseek-ai/dsh-convax-plugin-renderer/client', () => ({ CardToolbar: () => null, NodePorts: () => null }))
afterEach(cleanup)
const kinds: MediaKind[] = ['image', 'video', 'audio']
function fixture(configured = false) {
  const nodeId = 'workbench' as CanvasNodeId, canvasId = 'canvas' as CanvasId, connectionId = 'jimeng' as ConnectionId
  const providerId = 'jimeng' as ProviderId, libtvId = 'libtv' as ProviderId, libtvConnectionId = 'libtv-account' as ConnectionId
  const node = { id: nodeId, typeId: 'convax.creation' as CanvasNodeTypeId, dataVersion: 1, revision: 1,
    position: { x: 0, y: 0 }, data: { title: 'Campaign studio', routes: {} } }
  const graph: CanvasWorkspace = { revision: 1, nodeTypes: [], nodeIssues: [], chats: [], canvases: [
    { id: canvasId, title: 'Canvas', revision: 1, nodes: [node], connections: [] },
  ] }
  const models = kinds.map(kind => ({ kind, id: `${kind}-v1`, label: `${kind} human name` }))
  const connection = { id: connectionId, providerId, label: 'Jimeng CLI', settings: {}, revision: 1, credentialConfigured: false }
  const inspection = { state: 'ready' as const, capabilities: models.map(model => ({ kind: model.kind, modelId: model.id,
    modelLabel: model.label, inputs: [], maxOutputs: 1, parameterSchema: {} })),
  cancellation: 'unsupported' as const, submissionRecovery: 'unsupported' as const }
  const view: WorkbenchView = { ref: { canvasId, nodeId }, canvasRevision: 1,
    data: { ...node.data, routes: configured ? Object.fromEntries(kinds.map(kind => [kind, { connectionId }])) : {} },
    connections: configured ? [{ connection, inspection }] : [] }
  const libtvPrimary = { kind: 'image' as const, id: 'libtv-image-one', label: 'LibTV Image One' }
  const libtvModels = [libtvPrimary,
    { kind: 'image' as const, id: 'libtv-image-two', label: 'LibTV Image Two' }]
  let jobs: readonly WorkbenchJobView[] = []
  const remote = {
    describeWorkbench: vi.fn<CreationRemote['describeWorkbench']>().mockImplementation(async () => structuredClone(view)),
    listProviders: vi.fn<CreationRemote['listProviders']>().mockResolvedValue([{ id: providerId, title: 'Jimeng CLI', connectionKind: 'cli',
      supportedKinds: kinds, configuration: [
        { key: 'projectId', label: 'Canvas name', type: 'text', managed: true },
        ...kinds.map(kind => ({ key: `${kind}Model`, label: `${kind} model`, type: 'text' as const, mediaKind: kind })),
        { key: 'executable', label: 'CLI path', type: 'text', advanced: true },
      ] }, { id: libtvId, title: 'LibTV CLI', connectionKind: 'cli', supportedKinds: kinds,
      configuration: kinds.map(kind => ({ key: `${kind}Model`, label: `${kind} model`, type: 'text', mediaKind: kind })) }]),
    prepareConnection: vi.fn<CreationRemote['prepareConnection']>().mockImplementation(async input => ({ state: 'ready',
      models: input.connection.providerId === libtvId ? libtvModels : models })),
    connectAndApply: vi.fn<CreationRemote['connectAndApply']>().mockImplementation(async (input) => {
      const isLibtv = input.connection.providerId === libtvId
      const saved = isLibtv ? { ...connection, id: libtvConnectionId, providerId: libtvId, label: 'LibTV CLI' } : connection
      const active = isLibtv ? { ...inspection, capabilities: [{ kind: 'image' as const,
        modelId: libtvPrimary.id, modelLabel: libtvPrimary.label, inputs: [], maxOutputs: 1, parameterSchema: {} }] } : inspection
      view.data = structuredClone(input.data!)
      for (const kind of input.targetKind === undefined ? kinds : [input.targetKind]) view.data.routes[kind] = { connectionId: saved.id }
      view.connections = [...view.connections.filter(item => item.connection.id !== saved.id), { connection: saved, inspection: active }]
      return { ok: true, workspace: graph, connection: saved, inspection: active,
        applied: input.targetKind === undefined ? kinds : [input.targetKind] }
    }),
    configureWorkbench: vi.fn<CreationRemote['configureWorkbench']>().mockImplementation(async (input) => {
      view.data = structuredClone(input.data)
      view.connections = view.connections.map(item => ({ ...item, inspection: item.inspection.state !== 'ready' ? item.inspection : {
        ...item.inspection, capabilities: item.inspection.capabilities.map((capability) => {
          const route = input.data.routes[capability.kind]
          const model = [...models, ...libtvModels].find(model => route?.connectionId === item.connection.id && model.id === route.modelId)
          return model === undefined ? capability : { ...capability, modelId: model.id, modelLabel: model.label }
        }),
      } }))
      return { ok: true, workspace: graph }
    }),
    listWorkbenchJobs: vi.fn<CreationRemote['listWorkbenchJobs']>().mockImplementation(async () => jobs),
    approveGeneration: vi.fn<CreationRemote['approveGeneration']>().mockImplementation(async ({ jobId }) => {
      jobs = jobs.map(item => item.jobId === jobId ? { ...item, state: 'running' } : item)
    }),
    rejectGeneration: vi.fn<CreationRemote['rejectGeneration']>().mockResolvedValue(undefined),
  }
  const cards = new CreationWorkbenches(remote as unknown as CreationRemote, vi.fn(), vi.fn())
  onTestFinished(() => { cards.dispose() })
  cards.observe(graph)
  const store = cards.state(nodeId)!
  const createConnectedChat = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const props = { node, canvasId, ports: [], busy: false, selected: false, remove: vi.fn(), focusNode: vi.fn(), createConnectedChat,
    openWorkbench: (id: CanvasNodeId) => { cards.open(id) }, closeWorkbench: (id: CanvasNodeId) => { cards.close(id) },
    newConnection: (id: CanvasNodeId, provider: string) => { cards.newConnection(id, provider) },
    connectionSetting: (id: CanvasNodeId, key: string, value: string | boolean) => { cards.connectionSetting(id, key, value) },
    saveConnection: (id: CanvasNodeId) => cards.saveConnection(id),
    openModels: (id: CanvasNodeId, kind: MediaKind) => cards.openModels(id, kind),
    closeModels: (id: CanvasNodeId) => { cards.closeModels(id) },
    selectModel: (id: CanvasNodeId, option: string) => cards.selectModel(id, option),
    connectProvider: (id: CanvasNodeId, kind: MediaKind, provider: string) => { cards.connectProvider(id, kind, provider) },
    newChat: (id: CanvasNodeId, create: () => Promise<void>) => cards.newChat(id, create),
    openTasks: (id: CanvasNodeId, open: boolean) => { cards.tasks(id, open) },
    approveBatch: (id: CanvasNodeId, quotes: { jobId: JobId; quoteId: string }[]) => cards.approveBatch(id, quotes),
    canvasT: (key: string) => key,
    t: (key: CreationKey, params?: Record<string, string | number>) => Object.entries(params ?? {}).reduce<string>(
      (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), en[key]),
    useCreationWorkbench: () => useSyncExternalStore(listener => store.subscribe(listener), () => store.getSnapshot()),
  } as ComponentProps<typeof Workbench>
  render(<Workbench {...props} />)
  return { cards, nodeId, remote, view, createConnectedChat, setJobs: (value: readonly WorkbenchJobView[]) => { jobs = value } }
}

it('shows all three model choices once, hides managed canvas settings, and applies in one click', async () => {
  const f = fixture()
  fireEvent.click(await screen.findByRole('button', { name: 'Connect services' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Jimeng CLI' }))
  const image = await screen.findByRole('combobox', { name: 'Image model' })
  await waitFor(() => { expect(within(image).getByRole('option', { name: 'image human name' })).toBeDefined() })
  expect(screen.queryByText('Canvas name')).toBeNull()
  expect(screen.queryByText('Choose an existing canvas')).toBeNull()
  expect(screen.queryByRole('checkbox')).toBeNull()
  for (const kind of ['Image', 'Video', 'Audio']) {
    const field = screen.getByRole('combobox', { name: `${kind} model` })
    fireEvent.change(field, { target: { value: `${kind.toLowerCase()}-v1` } })
  }
  fireEvent.click(screen.getByRole('button', { name: 'Connect and apply' }))
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  expect(f.remote.connectAndApply).toHaveBeenCalledOnce()
  expect(f.remote.connectAndApply.mock.calls[0]?.[0].connection.settings).toEqual({
    imageModel: 'image-v1', videoModel: 'video-v1', audioModel: 'audio-v1',
  })
  for (const kind of ['Image', 'Video', 'Audio']) {
    expect(screen.getByRole('button', { name: `${kind} model: ${kind.toLowerCase()} human name` })).toBeDefined()
  }
  expect(screen.getAllByText('Jimeng CLI')).toHaveLength(3)
  fireEvent.click(screen.getByRole('button', { name: 'New Chat' }))
  await waitFor(() => { expect(f.createConnectedChat).toHaveBeenCalledOnce() })
})

it('confirms a displayed batch once and keeps its task rows through generation and completion', async () => {
  const f = fixture()
  const jobs: WorkbenchJobView[] = kinds.map((kind, index) => ({ jobId: kind as JobId, kind, prompt: `Create ${kind}`,
    state: 'awaiting-approval', outputs: [], issues: [], approval: { quoteId: `quote-${kind}`, credits: index + 1, unit: 'credits', message: '' } }))
  await screen.findByRole('button', { name: 'Connect services' })
  f.setJobs(jobs)
  await act(async () => { await f.cards.refreshTasks(f.nodeId) })
  fireEvent.click(screen.getByRole('button', { name: 'Tasks (3)' }))
  const dialog = screen.getByRole('dialog', { name: 'Creation tasks' })
  expect(within(dialog).getByText('Up to 6 credits in total')).toBeDefined()
  expect(within(dialog).queryByRole('button', { name: 'Save changes' })).toBeNull()
  const imageRow = within(dialog).getByText('Create image').closest('article')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm batch and generate' }))
  await waitFor(() => { expect(within(dialog).getAllByText('Generating')).toHaveLength(3) })
  expect(f.remote.approveGeneration).toHaveBeenCalledTimes(3)
  expect(within(dialog).getByText('Create image').closest('article')).toBe(imageRow)
  f.setJobs(jobs.map(item => ({ ...item, state: 'completed', outcome: 'all-succeeded' })))
  await act(async () => { await f.cards.refreshTasks(f.nodeId) })
  expect(within(dialog).getAllByText('Completed')).toHaveLength(3)
  fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' }).at(-1)!)
  fireEvent.click(screen.getByRole('button', { name: 'Tasks (3)' }))
  expect(screen.getAllByText('Completed')).toHaveLength(3)
})


it('reports a failed file delivery as failed and exposes the asset issue without hiding the task', async () => {
  const f = fixture()
  await screen.findByRole('button', { name: 'Connect services' })
  f.setJobs([{ jobId: 'image' as JobId, kind: 'image', prompt: 'Create a cover', state: 'completed',
    outcome: 'none-succeeded', issues: [], outputs: [{ assetId: 'asset' as AssetId, kind: 'image', filename: 'cover.png',
      delivery: 'failed', issues: [{ stage: 'materialization', code: 'download-failed', message: 'Download expired', recovery: 'retry-transfer' }],
    }] }])
  await act(async () => { await f.cards.refreshTasks(f.nodeId) })
  fireEvent.click(screen.getByRole('button', { name: 'Tasks (1)' }))
  const dialog = screen.getByRole('dialog', { name: 'Creation tasks' })
  expect(within(dialog).getByText('Failed')).toBeDefined()
  expect(within(dialog).queryByText('Partially completed')).toBeNull()
  expect(within(dialog).getByText(en.taskNeedsAttention)).toBeDefined()
  fireEvent.click(within(dialog).getByText('Technical details'))
  expect(within(dialog).getByText('Download expired')).toBeDefined()
  expect(within(dialog).getByText('Create a cover')).toBeDefined()
})


it('opens a Provider then its model, and applies a new image service without changing video or audio', async () => {
  const f = fixture(true)
  const imageButton = await screen.findByRole('button', { name: 'Image model: image human name' })
  fireEvent.click(imageButton)
  const libtv = await screen.findByRole('menuitem', { name: 'LibTV CLI' })
  expect(libtv.getAttribute('aria-haspopup')).toBe('menu')
  expect(screen.queryByRole('menuitem', { name: 'LibTV Image One' })).toBeNull()
  fireEvent.click(libtv)
  fireEvent.click(screen.getByRole('menuitem', { name: 'Connect LibTV CLI' }))
  const dialog = screen.getByRole('dialog', { name: 'LibTV CLI' })
  expect(within(dialog).queryByLabelText('Video model')).toBeNull()
  expect(within(dialog).queryByLabelText('Audio model')).toBeNull()
  expect(within(dialog).getByText('Applies only to Image. Other media choices stay unchanged.')).toBeDefined()
  const imageModel = await within(dialog).findByRole('combobox', { name: 'Image model' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Connect and apply' }))
  expect(f.remote.connectAndApply).not.toHaveBeenCalled()
  fireEvent.change(imageModel, { target: { value: 'libtv-image-one' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Connect and apply' }))
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  expect(f.remote.connectAndApply).toHaveBeenCalledOnce()
  expect(f.remote.connectAndApply.mock.calls[0]?.[0]).toMatchObject({ targetKind: 'image',
    connection: { providerId: 'libtv', settings: { imageModel: 'libtv-image-one' } } })
  expect(f.view.data.routes).toEqual({ image: { connectionId: 'libtv-account' }, video: { connectionId: 'jimeng' }, audio: { connectionId: 'jimeng' } })
  fireEvent.click(await screen.findByRole('button', { name: 'Image model: LibTV Image One' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'LibTV CLI' }))
  expect(f.remote.configureWorkbench).not.toHaveBeenCalled()
  fireEvent.click(await screen.findByRole('menuitem', { name: 'LibTV Image Two' }))
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Image model: LibTV Image Two' })).toBeDefined() })
  expect(f.remote.configureWorkbench).toHaveBeenCalledOnce()
  expect(f.view.data.routes).toEqual({ image: { connectionId: 'libtv-account', modelId: 'libtv-image-two' },
    video: { connectionId: 'jimeng' }, audio: { connectionId: 'jimeng' } })
})

it('dismisses a Provider submenu or cancels a target connection without committing any route', async () => {
  const f = fixture(true)
  fireEvent.click(await screen.findByRole('button', { name: 'Image model: image human name' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Jimeng CLI' }))
  await screen.findByRole('menuitem', { name: 'image human name' })
  fireEvent.keyDown(screen.getByRole('menuitem', { name: 'image human name' }), { key: 'Escape' })
  await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
  expect(f.remote.configureWorkbench).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Image model: image human name' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'LibTV CLI' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Connect LibTV CLI' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(f.remote.connectAndApply).not.toHaveBeenCalled()
  expect(f.view.data.routes).toEqual({ image: { connectionId: 'jimeng' }, video: { connectionId: 'jimeng' }, audio: { connectionId: 'jimeng' } })
})
