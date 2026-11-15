// @vitest-environment jsdom
/** A persisted connection remains unknown until its asynchronous inspection settles. */
import { useSyncExternalStore, type ComponentProps } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import type { CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasWorkspace } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { ConnectionId, CreationRemote, ProviderId, WorkbenchView } from '@deepseek-ai/dsh-convax-plugin-creation-host/types'
import { Workbench } from '../src/client/Workbench.tsx'
import { CreationWorkbenches } from '../src/client/workbenches.ts'
import { en, type CreationKey } from '../src/client/locales.ts'

// The graph owns handles and its selection toolbar; this fixture mounts the real workbench card.
vi.mock('@deepseek-ai/dsh-convax-plugin-renderer/client', () => ({ CardToolbar: () => null, NodePorts: () => null }))
afterEach(cleanup)

function pending<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function fixture() {
  const first = pending<WorkbenchView>(), refresh = pending<WorkbenchView>()
  const nodeId = 'workbench' as CanvasNodeId, canvasId = 'canvas' as CanvasId, connectionId = 'jimeng' as ConnectionId
  const node = { id: nodeId, typeId: 'convax.creation' as CanvasNodeTypeId, dataVersion: 1, revision: 1,
    position: { x: 0, y: 0 }, data: { title: 'Saved studio', routes: { image: { connectionId } } } }
  const graph: CanvasWorkspace = { revision: 1, nodeTypes: [], nodeIssues: [], chats: [], canvases: [
    { id: canvasId, title: 'Canvas', revision: 1, nodes: [node], connections: [] },
  ] }
  const view: WorkbenchView = { ref: { canvasId, nodeId }, canvasRevision: 1, data: node.data, connections: [{
    connection: { id: connectionId, providerId: 'jimeng' as ProviderId, label: 'Saved Jimeng account',
      settings: {}, revision: 1, credentialConfigured: false },
    inspection: { state: 'ready', capabilities: [], cancellation: 'unsupported', submissionRecovery: 'unsupported' },
  }] }
  const remote = {
    describeWorkbench: vi.fn<CreationRemote['describeWorkbench']>().mockReturnValueOnce(first.promise).mockReturnValue(refresh.promise),
    listProviders: vi.fn<CreationRemote['listProviders']>().mockResolvedValue([]),
    listWorkbenchJobs: vi.fn<CreationRemote['listWorkbenchJobs']>().mockResolvedValue([]),
  }
  const cards = new CreationWorkbenches(remote as unknown as CreationRemote, vi.fn(), vi.fn())
  onTestFinished(async () => {
    cards.dispose()
    first.resolve(view); refresh.resolve(view)
    await Promise.allSettled([first.promise, refresh.promise])
  })
  cards.observe(graph)
  const store = cards.state(nodeId)!
  const props = { node, canvasId, ports: [], busy: false, selected: false, remove: vi.fn(), focusNode: vi.fn(),
    openWorkbench: vi.fn(), canvasT: (key: string) => key, t: (key: CreationKey) => en[key],
    useCreationWorkbench: () => useSyncExternalStore(listener => store.subscribe(listener), () => store.getSnapshot()),
  } as ComponentProps<typeof Workbench>
  render(<Workbench {...props} />)
  return { first, refresh, view, refreshCard: () => { cards.observe({ ...graph, revision: 2,
    canvases: [{ ...graph.canvases[0]!, revision: 2, nodes: [{ ...node, revision: 2 }] }] }) } }
}

it('shows loading for a saved workbench and retains its known label during refresh and failure', async () => {
  const f = fixture()
  expect(screen.getByRole('button', { name: 'Loading' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getAllByText('Loading')).toHaveLength(4)
  expect(screen.queryByText('Not configured')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Connect services' })).toBeNull()
  await act(async () => { f.first.resolve(f.view); await f.first.promise })
  expect(screen.getByText('Saved Jimeng account')).toBeDefined()
  expect(screen.getByRole('button', { name: 'Manage' }).hasAttribute('disabled')).toBe(false)
  act(() => { f.refreshCard() })
  expect(screen.getByText('Saved Jimeng account')).toBeDefined()
  expect(screen.queryByText('Loading')).toBeNull()
  await act(async () => { f.refresh.reject(new Error('Inspection unavailable')); await f.refresh.promise.catch(() => {}) })
  expect(screen.getByText('Saved Jimeng account')).toBeDefined()
  expect(screen.getByText(en.loadFailed)).toBeDefined()
})

it('shows needs attention when the first inspection fails instead of claiming a saved route is empty', async () => {
  const f = fixture()
  await act(async () => { f.first.reject(new Error('Inspection unavailable')); await f.first.promise.catch(() => {}) })
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Needs attention' }).hasAttribute('disabled')).toBe(false) })
  expect(screen.getAllByText('Needs attention')).toHaveLength(4)
  expect(screen.queryByText('Not configured')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Connect services' })).toBeNull()
})
