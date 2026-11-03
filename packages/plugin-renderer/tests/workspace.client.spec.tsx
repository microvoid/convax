// @vitest-environment jsdom
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type {
  CanvasCommandRequest, CanvasConnectionId, CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId, CanvasWorkspace,
} from '@deepseek-ai/dsh-convax-plugin-host/types'
import { ConvaxWorkspace } from '../src/client/Workspace.tsx'
import { CanvasActivity } from '../src/client/activity.ts'
import type { CanvasGraphProps } from '../src/client/CanvasGraph.tsx'
import type { CanvasGraphOwner, CanvasGraphSurfaceProps, WorkspaceProps } from '../src/client/props.ts'
import { CanvasGraphSurface } from '../src/client/CanvasGraphSurface.tsx'
import { createCanvasViewStore, createChatViewStore } from '../src/client/store.ts'
import { en, type ConvaxKey } from '../src/client/locales.ts'
import { RESOURCE_CARD_WIDTH } from '../src/client/placement.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { CanvasConnectionOrigin } from '../src/client/props.ts'
import type { SlotFactoryMap } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-schedule/client'
import type { DesktopWindowSourceId } from '@deepseek-ai/dsh-util-desktop-capture'

const graphProbe = vi.hoisted(() => ({ current: undefined as CanvasGraphProps | undefined }))

vi.mock('../src/client/CanvasGraph.tsx', () => ({
  CanvasGraph: (props: CanvasGraphProps) => {
    graphProbe.current = props
    const { document, addResources, addProject, createChat, command, openResource, openSource } = props
    return <>
      <button type="button" onClick={() => { createChat(undefined, undefined, { x: 240, y: 180 }) }}>New chat</button>
      <button type="button" onClick={() => { addProject({ x: 240, y: 180 }) }}>Add project</button>
      <button type="button" onClick={() => { openResource({ kind: 'folder', path: '/project/folder', name: 'folder', size: null }) }}>Open folder</button>
      <button type="button" onClick={() => { openSource('/project/clip.mp4') }}>Show source</button>
      <div data-testid="canvas">{document.title}</div>
      <output data-testid="connection-count">{document.connections.length}</output>
      <button type="button" onClick={() => { void command({ kind: 'add-connection', connection: {
        id: 'input-edge' as CanvasConnectionId, source: 'folder-node' as CanvasNodeId, sourcePort: 'output',
        target: 'target-chat' as CanvasNodeId, targetPort: 'input', purpose: 'input',
      } }) }}>Connect input</button>
      <button type="button" onClick={() => { addResources([{ name: 'drop.txt', path: '/project/drop.txt' }], { x: 37, y: -21 }) }}>Drop resource</button>
      <button type="button" onClick={() => { addResources([
        { name: 'folder', path: '/project/folder' }, { name: 'file.txt', path: '/project/file.txt' },
        { name: 'last.txt', path: '/project/last.txt' },
      ], { x: 37, y: -21 }) }}>Drop multiple resources</button>
      <button type="button" onClick={() => { addResources([
        { name: 'virtual.txt', path: null }, { name: 'missing.txt', path: '/project/missing.txt' },
        { name: 'last.txt', path: '/project/last.txt' },
      ], { x: 37, y: -21 }) }}>Drop unreadable resources</button>
      <button type="button" onClick={() => { createChat('/project/folder', 'folder-node' as CanvasNodeId) }}>Create linked chat</button>
      <button type="button" onClick={() => { void command({
        kind: 'add-node', node: {
          id: 'batch-chat' as CanvasNodeId, typeId: 'convax.chat' as CanvasNodeTypeId,
          dataVersion: 1, data: { title: 'Batch chat', cwd: '/project/folder' }, position: { x: 600, y: 0 }, revision: 0,
        },
        initialConnections: ['folder-node', 'file-node'].map((source, index) => ({
          id: `batch-edge-${index}` as CanvasConnectionId, source: source as CanvasNodeId, sourcePort: 'output',
          target: 'batch-chat' as CanvasNodeId, targetPort: 'input', purpose: 'input' as const,
        })),
      }) }}>Create multi-input chat</button>
    </>
  },
}))

afterEach(() => { cleanup(); localStorage.clear(); graphProbe.current = undefined })

function currentGraph(): CanvasGraphProps {
  if (graphProbe.current === undefined) throw new Error('Canvas graph was not rendered')
  return graphProbe.current
}

it('projects saved Chat preferences through its public graph Factory without selecting a copied thread', () => {
  const workspace = inputWorkspace()
  const b = fixture(workspace)
  const source = 'target-chat' as CanvasNodeId
  b.store.actions.open(workspace.canvases[0]!.id)
  const view = render(<ConvaxWorkspace {...b.props} />)
  expect(currentGraph().chatPresentations).toEqual({ [source]: { collapsed: false } })
  b.chatStore.actions.setSize(source, { width: 420, height: 320 })
  b.chatStore.actions.setCollapsed(source, true)
  b.chatStore.actions.setToolWidth(source, 540, false)
  view.rerender(<ConvaxWorkspace {...b.props} />)
  expect(currentGraph().chatPresentations).toEqual({ [source]: {
    collapsed: true, size: { width: 420, height: 320 }, toolWidths: { normal: 540 },
  } })
  const copy = 'copied-chat' as CanvasNodeId
  currentGraph().applyChatPresentation(copy, currentGraph().chatPresentations[source]!)
  expect(b.chatStore.getSnapshot()).toMatchObject({
    collapsedChats: { [copy]: true }, sizes: { [copy]: { width: 420, height: 320 } },
    toolWidths: { [copy]: { normal: 540 } }, selectedThreads: {}, threadAttempts: {},
  })
  currentGraph().applyResourceView('copied-file' as CanvasNodeId, { expanded: true, width: 520 })
  expect(b.store.getSnapshot().resourceViews?.['copied-file']).toEqual({ expanded: true, width: 520 })
})

function fixture(workspace: CanvasWorkspace, readWorkspace: () => CanvasWorkspace = () => workspace) {
  const activity = new CanvasActivity()
  const store = createCanvasViewStore().create()
  const chatStore = createChatViewStore().create()
  const execute = vi.fn<WorkspaceProps['execute']>(async _request => ({ ok: true, workspace }))
  const captureInput = vi.fn<WorkspaceProps['captureInput']>(() => undefined)
  const insertInputs = vi.fn<WorkspaceProps['insertInputs']>(async () => true)
  const picker: { path: string; owner?: DirectoryFlowOwnerProps } = { path: '/selected/project' }
  const renderFactorySlot = vi.fn<WorkspaceProps['renderFactorySlot']>((name, owner) => {
    if (name === 'convax.graph') {
      const surfaceProps: CanvasGraphSurfaceProps = {
        ...props, ...owner as CanvasGraphOwner,
        useStore: selector => selector(chatStore.getSnapshot()), actions: chatStore.actions,
        renderSlot: () => null,
        useFactorySlot: () => { throw new Error('The graph probe does not render nested Factories') },
      }
      return <CanvasGraphSurface {...surfaceProps} />
    }
    if (name !== 'workspace.directoryPicker') return null
    const flow = owner as DirectoryFlowOwnerProps
    picker.owner = flow
    return <div role="dialog" aria-label="Directory interaction">
      <button onClick={() => { flow.onPicked(picker.path) }}>Pick directory</button>
      <button onClick={flow.onCancel}>Cancel directory</button>
      <button onClick={() => { flow.onError('Directory interaction failed') }}>Fail directory</button>
    </div>
  })
  const t = ((key: ConvaxKey, values?: Record<string, string | number>) =>
    en[key].replace(/\{(\w+)\}/g, (_match, name: string) => String(values?.[name] ?? ''))) as WorkspaceProps['t']
  const props = {
    t,
    defaultInputMode: 'mouse',
    useStore: (selector: (state: ReturnType<typeof store.getSnapshot>) => unknown) => selector(store.getSnapshot()),
    actions: store.actions,
    useResource: ((address: string) => ({
      status: address.startsWith('dsh-resource://convax-workspace') ? 'live' : 'none',
      value: address.startsWith('dsh-resource://convax-workspace') ? readWorkspace() : undefined,
      failure: undefined,
    })) as WorkspaceProps['useResource'],
    execute, captureInput, insertInputs,
    ensureCanvasDirectory: vi.fn<WorkspaceProps['ensureCanvasDirectory']>(async id => `/documents/convax/${id}`),
    describe: vi.fn(),
    resolveFilePath: vi.fn(),
    openFolder: vi.fn(async () => {}), revealSource: vi.fn(async () => {}),
    refresh: vi.fn(), openSettings: vi.fn(), openPlugins: vi.fn(),
    initializeAutomation: vi.fn(async () => ({ ok: true as const, sessionId: 'automation-thread' as SessionId, workspace: readWorkspace() })),
    openSession: vi.fn(),
    renderFactorySlot,
    markActivityRead: vi.fn((ids: readonly SessionId[]) => { activity.markRead(ids) }),
    useCanvasActivity: selector => selector(activity.getSnapshot()),
    useSessions: (selector: (value: object) => unknown) => selector({ byId: {} }),
    useSessionStatus: (selector: (value: object) => unknown) => selector(new Map()),
  } as WorkspaceProps
  return { activity, store, chatStore, props, execute, captureInput, insertInputs, picker, renderFactorySlot }
}

function inputWorkspace(): CanvasWorkspace {
  const canvasId = 'canvas' as CanvasId
  const target = 'target-chat' as CanvasNodeId
  return {
    revision: 70, nodeTypes: [], nodeIssues: [],
    canvases: [{
      id: canvasId, title: 'Board', revision: 4, connections: [],
      nodes: [{
        id: 'folder-node' as CanvasNodeId, typeId: 'convax.folder' as CanvasNodeTypeId,
        dataVersion: 1, data: { path: '/project/folder' }, position: { x: 0, y: 0 }, revision: 1,
      }, {
        id: target, typeId: 'convax.chat' as CanvasNodeTypeId,
        dataVersion: 1, data: { cwd: '/project/folder', title: 'Project chat' }, position: { x: 300, y: 0 }, revision: 1,
      }, {
        id: 'file-node' as CanvasNodeId, typeId: 'convax.file' as CanvasNodeTypeId,
        dataVersion: 1, data: { path: '/project/file.ts' }, position: { x: 0, y: 200 }, revision: 1,
      }],
    }],
    chats: [{
      canvasId, nodeId: target, title: 'Project chat', cwd: '/project/folder', deleting: false, issue: null,
      threads: [{ sessionId: 'initial-thread' as SessionId, parentSessionId: null, inheritedEventCount: 0 }],
    }],
  }
}

it('creates a window node only after explicit capture and stores no native source id', async () => {
  const workspace = inputWorkspace()
  const b = fixture(workspace)
  b.store.actions.open(workspace.canvases[0]!.id)
  b.props.windowsAvailable = true
  b.props.listWindows = vi.fn(async () => [{ id: 'window:77:0' as DesktopWindowSourceId, name: 'Test document' }])
  b.props.bindWindow = vi.fn(async () => 'Test document')
  b.props.releaseWindow = vi.fn(async () => {})
  render(<ConvaxWorkspace {...b.props} />)
  act(() => { currentGraph().addWindow?.({ x: 30, y: 40 }) })
  fireEvent.click(await screen.findByRole('button', { name: 'Test document' }))
  await waitFor(() => { expect(b.execute).toHaveBeenCalledOnce() })
  const request = b.execute.mock.calls[0]![0]
  expect(request.command).toMatchObject({ kind: 'add-node', node: {
    typeId: 'convax.window', dataVersion: 1, data: { name: 'Test document' }, position: { x: 30, y: 40 },
  } })
  if (request.command.kind !== 'add-node') throw new Error('Expected a window-node creation')
  expect(typeof request.command.node.data.bindingId).toBe('string')
  expect(JSON.stringify(request.command)).not.toContain('window:77:0')
  expect(b.props.releaseWindow).not.toHaveBeenCalled()
})

function commitConnection(workspace: CanvasWorkspace, request: CanvasCommandRequest): CanvasWorkspace {
  const command = request.command
  if (command.kind !== 'add-connection') throw new Error('Expected an input connection')
  return {
    ...workspace, revision: workspace.revision + 1,
    canvases: workspace.canvases.map(canvas => canvas.id === request.canvasId
      ? { ...canvas, revision: canvas.revision + 1, connections: [...canvas.connections, command.connection] }
      : canvas),
  }
}

function commitReference(workspace: CanvasWorkspace, request: CanvasCommandRequest): CanvasWorkspace {
  const command = request.command
  if (command.kind !== 'add-node') throw new Error('Expected reference addition')
  return {
    ...workspace, revision: workspace.revision + 1,
    canvases: workspace.canvases.map(canvas => canvas.id === request.canvasId
      ? { ...canvas, revision: canvas.revision + 1, nodes: [...canvas.nodes, command.node],
        connections: [...canvas.connections, ...(command.initialConnections ?? [])] }
      : canvas),
    chats: command.node.typeId !== 'convax.chat' ? workspace.chats : [...workspace.chats, {
      canvasId: request.canvasId, nodeId: command.node.id, title: command.node.data.title as string,
      cwd: command.node.data.cwd as string, deleting: false, issue: null, threads: [],
    }],
  }
}

function tabWorkspace(): CanvasWorkspace {
  return {
    revision: 0, nodeTypes: [], nodeIssues: [], chats: [],
    canvases: ['Alpha', 'Beta', 'Gamma'].map(title => ({
      id: title.toLowerCase() as CanvasId, title, revision: 0, nodes: [], connections: [],
    })),
  }
}

function openCanvasManager(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Workspace actions' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'All canvases' }))
}

function canvasAction(title: string, action: string): void {
  openCanvasManager()
  const manager = screen.getByRole('dialog', { name: 'All canvases' })
  fireEvent.click(within(manager).getByRole('button', { name: `Actions for ${title}` }))
  fireEvent.click(screen.getByRole('menuitem', { name: action }))
}

function pointerTab(type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel', target: HTMLElement, clientX: number): void {
  const event = new MouseEvent(type, {
    bubbles: true, cancelable: true, clientX, clientY: 15, button: 0,
    buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
  })
  Object.defineProperties(event, {
    pointerId: { value: 7 }, pointerType: { value: 'mouse' }, isPrimary: { value: true },
  })
  fireEvent(target, event)
}

function prepareTabPointer(target: HTMLElement) {
  let captured: number | undefined
  const methods = {
    setPointerCapture: vi.fn((id: number) => { captured = id }),
    releasePointerCapture: vi.fn((id: number) => { if (captured === id) captured = undefined }),
    hasPointerCapture: vi.fn((id: number) => captured === id),
  }
  for (const [name, value] of Object.entries(methods)) {
    const previous = Object.getOwnPropertyDescriptor(target, name)
    Object.defineProperty(target, name, { configurable: true, value })
    onTestFinished(() => {
      if (previous === undefined) Reflect.deleteProperty(target, name)
      else Object.defineProperty(target, name, previous)
    })
  }
  return methods
}

function measureTabStrip(): void {
  const strip = screen.getByRole('tablist', { name: 'All canvases' })
  const stripRect = vi.spyOn(strip, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 30))
  onTestFinished(() => { stripRect.mockRestore() })
  for (const tab of strip.querySelectorAll<HTMLElement>('[data-canvas-tab]')) {
    const rect = vi.spyOn(tab, 'getBoundingClientRect').mockImplementation(() => {
      const index = [...strip.querySelectorAll('[data-canvas-tab]')].indexOf(tab)
      return new DOMRect(index * 100, 0, 100, 30)
    })
    onTestFinished(() => { rect.mockRestore() })
  }
}

describe('Convax workspace presentation', () => {
  it('opens canvas management from the compact global menu and restores focus to its stable titlebar anchor', async () => {
    const b = fixture(tabWorkspace())
    render(<ConvaxWorkspace {...b.props} />)
    expect(screen.queryByRole('button', { name: 'Open canvas' })).toBeNull()
    const anchor = screen.getByRole('button', { name: 'Workspace actions' })
    anchor.focus()
    fireEvent.click(anchor)
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['All canvases', 'Settings', 'Plugins'])
    const entry = screen.getByRole('menuitem', { name: 'All canvases' })
    entry.focus()
    fireEvent.click(entry)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'All canvases' })).toBeDefined()
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search canvases' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await waitFor(() => { expect(document.activeElement).toBe(anchor) })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(b.execute).not.toHaveBeenCalled()
  })

  it('keeps the titlebar after canvas content in DOM order and its controls inside the drag row', () => {
    const workspace = inputWorkspace()
    const { props, store } = fixture(workspace)
    store.actions.open(workspace.canvases[0]!.id)
    render(<ConvaxWorkspace {...props} />)
    const navigation = screen.getByRole('navigation', { name: 'All canvases' })
    const canvas = screen.getByTestId('canvas')
    // Electron composes full app-region rectangles in DOM order, including clipped canvas content.
    expect(canvas.compareDocumentPosition(navigation) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(navigation.getAttribute('data-window-drag')).toBe('')
    expect(screen.queryByRole('button', { name: 'Canvas actions' })).toBeNull()
    for (const control of [
      screen.getByRole('tab', { name: 'Board' }),
      screen.getByRole('button', { name: 'Close Board' }),
      screen.getByRole('button', { name: 'New canvas' }),
      screen.getByRole('button', { name: 'Workspace actions' }),
    ]) {
      expect(control.closest('[data-window-drag]')).toBe(navigation)
    }
  })

  it('moves canvas tabs in either direction on release and retains the selected canvas', () => {
    const workspace = tabWorkspace()
    const b = fixture(workspace)
    workspace.canvases.forEach((canvas) => { b.store.actions.open(canvas.id) })
    const view = render(<ConvaxWorkspace {...b.props} />)
    const alpha = screen.getByRole('tab', { name: 'Alpha' })
    expect(alpha.draggable).toBe(false)
    const capture = prepareTabPointer(alpha)
    measureTabStrip()
    pointerTab('pointerdown', alpha, 25)
    pointerTab('pointermove', alpha, 275)
    expect(b.store.getSnapshot().tabs).toEqual(['alpha', 'beta', 'gamma'])
    pointerTab('pointerup', alpha, 275)
    fireEvent.click(alpha, { detail: 1 })
    expect(b.store.getSnapshot()).toMatchObject({ tabs: ['beta', 'gamma', 'alpha'], activeCanvasId: 'gamma' })
    expect(capture.setPointerCapture).toHaveBeenCalledWith(7)
    expect(capture.releasePointerCapture).toHaveBeenCalledWith(7)
    view.rerender(<ConvaxWorkspace {...b.props} />)
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Beta', 'Gamma', 'Alpha'])
    pointerTab('pointerdown', alpha, 275)
    pointerTab('pointermove', alpha, 25)
    pointerTab('pointerup', alpha, 25)
    expect(b.store.getSnapshot()).toMatchObject({ tabs: ['alpha', 'beta', 'gamma'], activeCanvasId: 'gamma' })
    expect(b.execute).not.toHaveBeenCalled()
  })

  it('keeps canvas order when the pointer drag is cancelled, escaped, or never started', () => {
    const workspace = tabWorkspace()
    const b = fixture(workspace)
    workspace.canvases.forEach((canvas) => { b.store.actions.open(canvas.id) })
    render(<ConvaxWorkspace {...b.props} />)
    const alpha = screen.getByRole('tab', { name: 'Alpha' })
    prepareTabPointer(alpha)
    measureTabStrip()
    pointerTab('pointermove', alpha, 275)
    pointerTab('pointerup', alpha, 275)
    pointerTab('pointerdown', alpha, 25)
    pointerTab('pointermove', alpha, 275)
    pointerTab('pointercancel', alpha, 275)
    pointerTab('pointerup', alpha, 275)
    expect(b.store.getSnapshot()).toMatchObject({ tabs: ['alpha', 'beta', 'gamma'], activeCanvasId: 'gamma' })
    pointerTab('pointerdown', alpha, 25)
    pointerTab('pointermove', alpha, 275)
    fireEvent.keyDown(alpha, { key: 'Escape' })
    pointerTab('pointerup', alpha, 275)
    expect(b.store.getSnapshot()).toMatchObject({ tabs: ['alpha', 'beta', 'gamma'], activeCanvasId: 'gamma' })
    expect(b.execute).not.toHaveBeenCalled()
  })

  it('keeps a short pointer movement as a normal tab selection', () => {
    const workspace = tabWorkspace()
    const b = fixture(workspace)
    workspace.canvases.forEach((canvas) => { b.store.actions.open(canvas.id) })
    render(<ConvaxWorkspace {...b.props} />)
    const alpha = screen.getByRole('tab', { name: 'Alpha' })
    prepareTabPointer(alpha)
    measureTabStrip()
    pointerTab('pointerdown', alpha, 25)
    pointerTab('pointermove', alpha, 28)
    pointerTab('pointerup', alpha, 28)
    fireEvent.click(alpha, { detail: 1 })
    expect(b.store.getSnapshot()).toMatchObject({ tabs: ['alpha', 'beta', 'gamma'], activeCanvasId: 'alpha' })
    expect(b.execute).not.toHaveBeenCalled()
  })

  it('keeps keyboard tab activation available after cancelling a drag with Escape', () => {
    const workspace = tabWorkspace()
    const b = fixture(workspace)
    workspace.canvases.forEach((canvas) => { b.store.actions.open(canvas.id) })
    render(<ConvaxWorkspace {...b.props} />)
    const alpha = screen.getByRole('tab', { name: 'Alpha' })
    prepareTabPointer(alpha)
    measureTabStrip()
    pointerTab('pointerdown', alpha, 25)
    pointerTab('pointermove', alpha, 275)
    fireEvent.keyDown(alpha, { key: 'Escape' })
    fireEvent.click(alpha, { detail: 0 })
    expect(b.store.getSnapshot()).toMatchObject({ tabs: ['alpha', 'beta', 'gamma'], activeCanvasId: 'alpha' })
    expect(b.execute).not.toHaveBeenCalled()
  })

  it('moves the focused canvas tab with Alt and the arrow keys without switching the active canvas', () => {
    const workspace = tabWorkspace()
    const b = fixture(workspace)
    workspace.canvases.forEach((canvas) => { b.store.actions.open(canvas.id) })
    const view = render(<ConvaxWorkspace {...b.props} />)
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Beta' }), { key: 'ArrowLeft', altKey: true })
    expect(b.store.getSnapshot()).toMatchObject({ tabs: ['beta', 'alpha', 'gamma'], activeCanvasId: 'gamma' })
    view.rerender(<ConvaxWorkspace {...b.props} />)
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Beta' }), { key: 'ArrowRight', altKey: true })
    expect(b.store.getSnapshot()).toMatchObject({ tabs: ['alpha', 'beta', 'gamma'], activeCanvasId: 'gamma' })
    expect(b.execute).not.toHaveBeenCalled()
  })

  it('creates a canvas through a revisioned Host command before opening its tab', async () => {
    const workspace = { revision: 0, canvases: [], nodeTypes: [], nodeIssues: [], chats: [] }
    const { props, execute, store } = fixture(workspace)
    render(<ConvaxWorkspace {...props} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'New canvas' }).at(-1)!)
    await waitFor(() => { expect(execute).toHaveBeenCalledOnce() })
    const request = execute.mock.calls[0]?.[0]
    expect(request).toMatchObject({ expectedRevision: 0, command: { kind: 'create', title: 'Untitled canvas' } })
    await waitFor(() => { expect(store.getSnapshot().tabs).toHaveLength(1) })
  })

  it('keeps a canvas visible when deletion is rejected', async () => {
    const canvas = { id: 'canvas' as CanvasId, title: 'Board', revision: 4, nodes: [], connections: [] }
    const workspace = { revision: 4, canvases: [canvas], nodeTypes: [], nodeIssues: [], chats: [] }
    const { props, store } = fixture(workspace)
    store.actions.open(canvas.id)
    const execute = vi.fn(async () => ({ ok: false as const, code: 'conflict' as const, message: 'conflict', workspace }))
    render(<ConvaxWorkspace {...props} execute={execute} />)
    canvasAction('Board', 'Permanently delete…')
    expect(execute).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Permanently delete' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('could not be confirmed') })
    expect(screen.getByTestId('canvas').textContent).toBe('Board')
    expect(store.getSnapshot().tabs).toEqual(['canvas'])
    expect(store.getSnapshot().deletionAttempts).toEqual({})
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it.each([
    { title: 'Beta', canvasId: 'beta', tabs: ['alpha', 'gamma'], activeCanvasId: 'gamma' },
    { title: 'Alpha', canvasId: 'alpha', tabs: ['beta', 'gamma'], activeCanvasId: 'beta' },
  ])('archives $title without stopping or removing another open canvas', async ({ title, canvasId, tabs, activeCanvasId }) => {
    let workspace = tabWorkspace()
    const b = fixture(workspace, () => workspace)
    workspace.canvases.forEach((canvas) => { b.store.actions.open(canvas.id) })
    b.store.actions.open('beta' as CanvasId)
    b.execute.mockImplementation(async (request) => {
      if (request.command.kind !== 'set-archived') throw new Error('Expected organizational archive')
      const archived = request.command.archived
      workspace = { ...workspace, revision: 1, canvases: workspace.canvases.map(canvas => canvas.id === request.canvasId
        ? { ...canvas, archived, revision: 1 } : canvas) }
      return { ok: true, workspace }
    })
    render(<ConvaxWorkspace {...b.props} />)
    canvasAction(title, 'Archive')
    await waitFor(() => { expect(b.store.getSnapshot()).toMatchObject({ tabs, activeCanvasId }) })
    expect(b.execute).toHaveBeenCalledOnce()
    expect(b.execute.mock.calls[0]![0]).toMatchObject({
      canvasId, expectedRevision: 0, command: { kind: 'set-archived', archived: true },
    })
    expect(workspace.canvases).toHaveLength(3)
    expect(screen.queryByRole('dialog', { name: /^Permanently delete/ })).toBeNull()
  })

  it('unarchives a canvas without reopening its closed tab', async () => {
    let workspace = tabWorkspace()
    workspace = { ...workspace, canvases: workspace.canvases.map(canvas => canvas.id === 'alpha'
      ? { ...canvas, archived: true } : canvas) }
    const b = fixture(workspace, () => workspace)
    b.store.actions.open('beta' as CanvasId)
    b.execute.mockImplementation(async (request) => {
      if (request.command.kind !== 'set-archived') throw new Error('Expected organizational unarchive')
      workspace = { ...workspace, canvases: workspace.canvases.map(canvas => canvas.id === request.canvasId
        ? { ...canvas, archived: false } : canvas) }
      return { ok: true, workspace }
    })
    render(<ConvaxWorkspace {...b.props} />)
    openCanvasManager()
    fireEvent.click(screen.getByRole('tab', { name: 'Archived 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Unarchive' }))
    await waitFor(() => { expect(b.execute).toHaveBeenCalledOnce() })
    expect(b.execute.mock.calls[0]![0]).toMatchObject({ canvasId: 'alpha', command: { kind: 'set-archived', archived: false } })
    expect(b.store.getSnapshot()).toMatchObject({ tabs: ['beta'], activeCanvasId: 'beta' })
    expect(screen.getByRole('dialog', { name: 'All canvases' })).toBeDefined()
  })

  it.each([false, true])('renames an inactive canvas through its existing form while preserving archived=%s', async (archived) => {
    let workspace = tabWorkspace()
    workspace = { ...workspace, canvases: workspace.canvases.map(canvas => canvas.id === 'beta'
      ? { ...canvas, archived } : canvas) }
    const b = fixture(workspace, () => workspace)
    b.store.actions.open('alpha' as CanvasId)
    b.execute.mockImplementation(async (request) => {
      if (request.command.kind !== 'rename') throw new Error('Expected canvas rename')
      const title = request.command.title
      workspace = { ...workspace, canvases: workspace.canvases.map(canvas => canvas.id === request.canvasId
        ? { ...canvas, title, revision: canvas.revision + 1 } : canvas) }
      return { ok: true, workspace }
    })
    render(<ConvaxWorkspace {...b.props} />)
    openCanvasManager()
    if (archived) fireEvent.click(screen.getByRole('tab', { name: 'Archived 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Beta' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename canvas' }))
    expect(screen.queryByRole('dialog', { name: 'All canvases' })).toBeNull()
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Canvas name' })
    expect(input.value).toBe('Beta')
    expect(b.execute).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '   ' } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true)
    fireEvent.change(input, { target: { value: '  Renamed Beta  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Rename canvas' })).toBeNull() })
    expect(b.execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      canvasId: 'beta', expectedRevision: 0, command: { kind: 'rename', title: 'Renamed Beta' },
    }))
    expect(workspace.canvases.find(canvas => canvas.id === 'beta')).toMatchObject({ title: 'Renamed Beta', archived })
    expect(b.store.getSnapshot()).toMatchObject({ tabs: ['alpha'], activeCanvasId: 'alpha' })
  })

  it('opens a successfully duplicated canvas with a new identity and copied viewport but no local undo history', async () => {
    let workspace = tabWorkspace()
    const source = workspace.canvases[0]!
    const b = fixture(workspace, () => workspace)
    b.store.actions.open(source.id)
    b.store.actions.setViewport(source.id, { x: 120, y: -80, zoom: 0.5 })
    b.store.actions.recordHistory(source.id, 'source-operation' as CanvasOperationId, {})
    b.execute.mockImplementation(async (request) => {
      const command = request.command
      if (command.kind !== 'duplicate') throw new Error('Expected canvas duplicate')
      workspace = { ...workspace, revision: 1, canvases: [...workspace.canvases, {
        ...source, id: command.newCanvasId, title: command.title, revision: 0,
      }] }
      return { ok: true, workspace }
    })
    render(<ConvaxWorkspace {...b.props} />)
    canvasAction('Alpha', 'Duplicate canvas')
    await waitFor(() => { expect(b.execute).toHaveBeenCalledOnce() })
    const request = b.execute.mock.calls[0]![0]
    if (request.command.kind !== 'duplicate') throw new Error('Expected canvas duplicate')
    const copiedId = request.command.newCanvasId
    expect(copiedId).not.toBe(source.id)
    expect(request).toMatchObject({ canvasId: source.id, expectedRevision: 0, command: { title: 'Alpha copy' } })
    await waitFor(() => { expect(b.store.getSnapshot()).toMatchObject({ tabs: [source.id, copiedId], activeCanvasId: copiedId }) })
    expect(b.store.getSnapshot().viewports[copiedId]).toEqual({ x: 120, y: -80, zoom: 0.5 })
    expect(b.store.getSnapshot().histories?.[copiedId]).toBeUndefined()
    expect(b.store.getSnapshot().histories?.[source.id]?.undo).toEqual(['source-operation'])
    expect(screen.queryByRole('dialog', { name: 'All canvases' })).toBeNull()
  })

  it('cancels permanent deletion before any Host command or retained attempt is created', () => {
    const workspace = tabWorkspace()
    const b = fixture(workspace)
    b.store.actions.open('alpha' as CanvasId)
    render(<ConvaxWorkspace {...b.props} />)
    canvasAction('Alpha', 'Permanently delete…')
    const confirmation = screen.getByRole('dialog', { name: 'Permanently delete Alpha?' })
    expect(within(confirmation).getByText(/Original files and conversation history are retained/)).toBeDefined()
    fireEvent.click(within(confirmation).getAllByRole('button', { name: 'Cancel' }).at(-1)!)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(b.execute).not.toHaveBeenCalled()
    expect(b.store.getSnapshot()).toMatchObject({ tabs: ['alpha'], activeCanvasId: 'alpha' })
    expect(b.store.getSnapshot().deletionAttempts).toBeUndefined()
  })

  it('does not expose a global chat panel or create conversations', () => {
    const { props } = fixture({ revision: 0, canvases: [], nodeTypes: [], nodeIssues: [], chats: [] })
    render(<ConvaxWorkspace {...props} />)
    expect(screen.queryByRole('button', { name: /chat/i })).toBeNull()
    expect(screen.queryByRole('complementary', { name: /chat/i })).toBeNull()
  })

  it('creates a Chat from a folder with its directory and a direct input connection', async () => {
    const folder = {
      id: 'folder-node' as CanvasNodeId, typeId: 'convax.folder' as CanvasNodeTypeId,
      dataVersion: 1, data: { path: '/project/folder' }, position: { x: 80, y: 80 }, revision: 1,
    }
    const canvas = { id: 'canvas' as CanvasId, title: 'Board', revision: 4, nodes: [folder], connections: [] }
    let current: CanvasWorkspace = { revision: 4, canvases: [canvas], nodeTypes: [], nodeIssues: [], chats: [] }
    const b = fixture(current)
    b.store.actions.open(canvas.id)
    const execute = vi.fn<WorkspaceProps['execute']>(async (request) => {
      const saved = current.canvases[0]!
      current = { ...current, revision: current.revision + 1, canvases: [{
        ...saved, revision: saved.revision + 1,
        nodes: request.command.kind === 'add-node' ? [...saved.nodes, request.command.node] : saved.nodes,
        connections: request.command.kind === 'add-node' ? request.command.initialConnections ?? [] : saved.connections,
      }], chats: request.command.kind === 'add-node' ? [{
        canvasId: canvas.id, nodeId: request.command.node.id, title: 'Folder chat', cwd: '/project/folder',
        threads: [], deleting: false, issue: null,
      }] : [] }
      return { ok: true, workspace: current }
    })
    render(<ConvaxWorkspace {...b.props} execute={execute} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create linked chat' }))
    await waitFor(() => { expect(execute).toHaveBeenCalledOnce() })
    const node = execute.mock.calls[0]?.[0].command
    expect(node).toMatchObject({ kind: 'add-node', node: { typeId: 'convax.chat', data: { cwd: '/project/folder' } } })
    if (node?.kind !== 'add-node') throw new Error('Expected Chat creation')
    expect(node.initialConnections).toEqual([expect.objectContaining({
      source: folder.id, target: node.node.id, sourcePort: 'output', targetPort: 'input', purpose: 'input',
    })])
    expect(b.renderFactorySlot.mock.calls.some(([name]) => name === 'workspace.directoryPicker')).toBe(false)
    await waitFor(() => { expect(b.insertInputs).toHaveBeenCalledOnce() })
    expect(b.captureInput).toHaveBeenCalledWith(node.node.id)
    expect(b.insertInputs).toHaveBeenCalledWith(canvas.id, 5, [{
      nodeId: node.node.id, sourceId: folder.id, sessionId: undefined,
    }])
  })

  it('inserts a committed connection into the thread captured before the Host reply', async () => {
    let current = inputWorkspace()
    const b = fixture(current, () => current)
    const canvas = current.canvases[0]!
    b.store.actions.open(canvas.id)
    let selected = 'initial-thread' as SessionId
    b.captureInput.mockImplementation(() => selected)
    const reply = Promise.withResolvers<Awaited<ReturnType<WorkspaceProps['execute']>>>()
    b.execute.mockImplementation(async () => await reply.promise)
    render(<ConvaxWorkspace {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect input' }))
    expect(b.captureInput).toHaveBeenCalledWith('target-chat')
    expect(b.insertInputs).not.toHaveBeenCalled()
    selected = 'later-thread' as SessionId
    const request = b.execute.mock.calls[0]![0]
    current = commitConnection(current, request)
    await act(async () => { reply.resolve({ ok: true, workspace: current }) })
    await waitFor(() => { expect(b.insertInputs).toHaveBeenCalledOnce() })
    expect(b.insertInputs).toHaveBeenCalledWith(canvas.id, 5, [{
      nodeId: 'target-chat', sourceId: 'folder-node', sessionId: 'initial-thread',
    }])
    expect(screen.getByTestId('connection-count').textContent).toBe('1')
    expect(b.execute).toHaveBeenCalledOnce()
  })

  it('delivers multiple initial connections to the same empty Chat as one captured batch', async () => {
    let current = inputWorkspace()
    const b = fixture(current, () => current)
    const canvas = current.canvases[0]!
    b.store.actions.open(canvas.id)
    b.execute.mockImplementation(async (request) => {
      if (request.command.kind !== 'add-node') throw new Error('Expected Chat creation')
      current = { ...current, revision: current.revision + 1, canvases: [{
        ...canvas, revision: canvas.revision + 1, nodes: [...canvas.nodes, request.command.node],
        connections: request.command.initialConnections ?? [],
      }], chats: [...current.chats, {
        canvasId: canvas.id, nodeId: request.command.node.id, title: 'Batch chat', cwd: '/project/folder',
        threads: [], deleting: false, issue: null,
      }] }
      return { ok: true, workspace: current }
    })
    render(<ConvaxWorkspace {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create multi-input chat' }))
    await waitFor(() => { expect(b.insertInputs).toHaveBeenCalledOnce() })
    expect(b.captureInput.mock.calls).toEqual([['batch-chat'], ['batch-chat']])
    expect(b.insertInputs).toHaveBeenCalledWith(canvas.id, 5, [
      { nodeId: 'batch-chat', sourceId: 'folder-node', sessionId: undefined },
      { nodeId: 'batch-chat', sourceId: 'file-node', sessionId: undefined },
    ])
    expect(b.captureInput.mock.invocationCallOrder[1]).toBeLessThan(b.execute.mock.invocationCallOrder[0]!)
    expect(screen.getByTestId('connection-count').textContent).toBe('2')
  })

  it.each(['rejection', 'transport failure'] as const)('does not insert a reference after a connection %s', async (failure) => {
    const workspace = inputWorkspace()
    const b = fixture(workspace)
    b.store.actions.open(workspace.canvases[0]!.id)
    if (failure === 'rejection') b.execute.mockResolvedValue({ ok: false, code: 'conflict', message: 'conflict', workspace })
    else b.execute.mockRejectedValue(new Error('Disconnected'))
    render(<ConvaxWorkspace {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect input' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('could not be confirmed') })
    expect(b.insertInputs).not.toHaveBeenCalled()
    expect(screen.getByTestId('connection-count').textContent).toBe('0')
  })

  it.each(['refused', 'failed'] as const)('keeps the saved edge when its draft reference is %s', async (failure) => {
    let current = inputWorkspace()
    const b = fixture(current, () => current)
    b.store.actions.open(current.canvases[0]!.id)
    b.captureInput.mockReturnValue('initial-thread' as SessionId)
    b.execute.mockImplementation(async (request) => {
      current = commitConnection(current, request)
      return { ok: true, workspace: current }
    })
    if (failure === 'refused') b.insertInputs.mockResolvedValue(false)
    else b.insertInputs.mockRejectedValue(new Error('Draft unavailable'))
    render(<ConvaxWorkspace {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect input' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('connection was saved, but its reference') })
    expect(screen.getByTestId('connection-count').textContent).toBe('1')
    expect(b.insertInputs).toHaveBeenCalledOnce()
    expect(b.execute).toHaveBeenCalledOnce()
  })

  it.each(['folder', 'file'] as const)('creates a connected Chat from the canonical %s directory in one graph command', async (kind) => {
    let current = inputWorkspace()
    const b = fixture(current, () => current)
    b.store.actions.open(current.canvases[0]!.id)
    const nodeId = `${kind}-node` as CanvasNodeId
    b.props.describe = vi.fn<WorkspaceProps['describe']>(async path => kind === 'file' && path === '/project/file.ts'
      ? { path: '/canonical/project/file.ts', name: 'file.ts', kind: 'file', size: 2 }
      : { path: '/canonical/project', name: 'project', kind: 'folder', size: null })
    b.execute.mockImplementation(async request => ({ ok: true, workspace: current = commitReference(current, request) }))
    render(<ConvaxWorkspace {...b.props} />)
    act(() => { currentGraph().createChat(undefined, undefined, { x: 700, y: 120 }, {
      nodeId, portId: 'output', direction: 'output',
    }) })
    await waitFor(() => { expect(b.execute).toHaveBeenCalledOnce() })
    const request = b.execute.mock.calls[0]![0]
    expect(request).toMatchObject({ expectedRevision: 4, command: {
      kind: 'add-node', node: { typeId: 'convax.chat', data: { cwd: '/canonical/project' }, position: { x: 700, y: 120 } },
      initialConnections: [{ source: nodeId, sourcePort: 'output', targetPort: 'input', purpose: 'input' }],
    } })
    const command = request.command
    if (command.kind !== 'add-node') throw new Error('Expected an atomic node and connection addition')
    expect(command.initialConnections).toHaveLength(1)
    expect(command.initialConnections?.[0]?.target).toBe(command.node.id)
    await waitFor(() => { expect(b.insertInputs).toHaveBeenCalledExactlyOnceWith(request.canvasId, 5, [{
      nodeId: command.node.id, sourceId: nodeId, sessionId: undefined,
    }]) })
    expect(b.picker.owner).toBeUndefined()
    if (kind === 'file') expect(b.props.describe).toHaveBeenNthCalledWith(2, '/canonical/project/')
  })

  it('does not duplicate the folder edge when a legacy folder action also carries its connection origin', async () => {
    let current = inputWorkspace()
    const b = fixture(current, () => current)
    b.store.actions.open(current.canvases[0]!.id)
    b.execute.mockImplementation(async request => ({ ok: true, workspace: current = commitReference(current, request) }))
    render(<ConvaxWorkspace {...b.props} />)
    act(() => { currentGraph().createChat('/project/folder', 'folder-node' as CanvasNodeId, { x: 700, y: 120 }, {
      nodeId: 'folder-node' as CanvasNodeId, portId: 'output', direction: 'output',
    }) })
    await waitFor(() => { expect(b.execute).toHaveBeenCalledOnce() })
    expect(b.execute.mock.calls[0]![0].command).toMatchObject({ initialConnections: [expect.objectContaining({ source: 'folder-node' })] })
    const command = b.execute.mock.calls[0]![0].command
    if (command.kind !== 'add-node') throw new Error('Expected an atomic node addition')
    expect(command.initialConnections).toHaveLength(1)
    await waitFor(() => { expect(b.insertInputs).toHaveBeenCalledOnce() })
    expect(b.insertInputs.mock.calls[0]?.[2]).toHaveLength(1)
  })

  it('connects an imported resource in the originating output direction without inserting a Chat reference', async () => {
    let current = inputWorkspace()
    const b = fixture(current, () => current)
    b.store.actions.open(current.canvases[0]!.id)
    b.props.describe = vi.fn<WorkspaceProps['describe']>(async path => ({ path, name: 'one.txt', kind: 'file', size: 2 }))
    b.execute.mockImplementation(async request => ({ ok: true, workspace: current = commitReference(current, request) }))
    render(<ConvaxWorkspace {...b.props} />)
    act(() => { currentGraph().addResources([{ name: 'one.txt', path: '/project/one.txt' }], { x: 500, y: 80 }, {
      nodeId: 'folder-node' as CanvasNodeId, portId: 'output', direction: 'output',
    }) })
    await waitFor(() => { expect(b.execute).toHaveBeenCalledOnce() })
    const command = b.execute.mock.calls[0]![0].command
    if (command.kind !== 'add-node') throw new Error('Expected an atomic resource addition')
    expect(command.initialConnections).toEqual([expect.objectContaining({
      source: 'folder-node', sourcePort: 'output', target: command.node.id, targetPort: 'input',
    })])
    expect(b.insertInputs).not.toHaveBeenCalled()
  })

  it('discards a source-directory lookup that settles after the workspace unmounts', async () => {
    const current = inputWorkspace()
    const b = fixture(current)
    b.store.actions.open(current.canvases[0]!.id)
    const resource = Promise.withResolvers<Awaited<ReturnType<WorkspaceProps['describe']>>>()
    b.props.describe = vi.fn(() => resource.promise)
    const view = render(<ConvaxWorkspace {...b.props} />)
    act(() => { currentGraph().createChat(undefined, undefined, { x: 700, y: 120 }, {
      nodeId: 'folder-node' as CanvasNodeId, portId: 'output', direction: 'output',
    }) })
    view.unmount()
    await act(async () => { resource.resolve({ path: '/canonical/folder', name: 'folder', kind: 'folder', size: null }) })
    expect(b.execute).not.toHaveBeenCalled()
    expect(b.renderFactorySlot.mock.calls.some(([name]) => name === 'workspace.directoryPicker')).toBe(false)
  })

  it('keeps the connected input thread captured before a directory picker opens', async () => {
    let current = inputWorkspace()
    const b = fixture(current, () => current)
    b.store.actions.open(current.canvases[0]!.id)
    b.captureInput.mockReturnValue('original-thread' as SessionId)
    b.props.describe = vi.fn<WorkspaceProps['describe']>(async path => ({ path, name: 'selected', kind: 'folder', size: null }))
    b.execute.mockImplementation(async request => ({ ok: true, workspace: current = commitReference(current, request) }))
    render(<ConvaxWorkspace {...b.props} />)
    act(() => { currentGraph().addProject({ x: -320, y: 80 }, {
      nodeId: 'target-chat' as CanvasNodeId, portId: 'input', direction: 'input',
    }) })
    expect(b.captureInput).toHaveBeenCalledExactlyOnceWith('target-chat')
    b.captureInput.mockReturnValue('later-thread' as SessionId)
    fireEvent.click(screen.getByRole('button', { name: 'Pick directory' }))
    await waitFor(() => { expect(b.insertInputs).toHaveBeenCalledOnce() })
    const command = b.execute.mock.calls[0]![0].command
    if (command.kind !== 'add-node') throw new Error('Expected a connected directory addition')
    expect(command.node.position).toEqual({ x: -320, y: 80 })
    expect(command.initialConnections).toEqual([expect.objectContaining({
      source: command.node.id, sourcePort: 'output', target: 'target-chat', targetPort: 'input',
    })])
    expect(b.insertInputs).toHaveBeenCalledWith(current.canvases[0]!.id, 5, [{
      nodeId: 'target-chat', sourceId: command.node.id, sessionId: 'original-thread',
    }])
    expect(b.captureInput).toHaveBeenCalledOnce()
  })

  it.each(['original-thread', undefined])('delivers a connected file batch once to the captured target %s', async (captured) => {
    let current = inputWorkspace()
    const b = fixture(current, () => current)
    b.store.actions.open(current.canvases[0]!.id)
    b.captureInput.mockReturnValue(captured as SessionId | undefined)
    b.props.describe = vi.fn<WorkspaceProps['describe']>(async path => ({ path, name: path, kind: 'file', size: 2 }))
    b.execute.mockImplementation(async request => ({ ok: true, workspace: current = commitReference(current, request) }))
    render(<ConvaxWorkspace {...b.props} />)
    const origin = currentGraph().captureConnectionTarget({
      nodeId: 'target-chat' as CanvasNodeId, portId: 'input', direction: 'input',
    })
    expect(origin.targetSession).toEqual({ sessionId: captured })
    b.captureInput.mockReturnValue('later-thread' as SessionId)
    act(() => { currentGraph().addResources([
      { name: 'one.txt', path: '/project/one.txt' }, { name: 'two.txt', path: '/project/two.txt' },
    ], { x: -200, y: -100 }, { ...origin }) })
    await waitFor(() => { expect(b.insertInputs).toHaveBeenCalledOnce() })
    expect(b.execute.mock.calls.map(([request]) => request.expectedRevision)).toEqual([4, 5])
    const added = b.execute.mock.calls.map(([request]) => {
      if (request.command.kind !== 'add-node') throw new Error('Expected atomic node additions')
      expect(request.command.initialConnections).toEqual([expect.objectContaining({
        source: request.command.node.id, target: 'target-chat', targetPort: 'input', sourcePort: 'output',
      })])
      return request.command.node.id
    })
    expect(b.insertInputs).toHaveBeenCalledWith(current.canvases[0]!.id, 6,
      added.map(sourceId => ({ nodeId: 'target-chat', sourceId, sessionId: captured })))
    expect(b.captureInput).toHaveBeenCalledOnce()
    expect(current.canvases[0]?.connections).toHaveLength(2)
  })

  it('keeps connection cancellation and rejected graph additions free of input references', async () => {
    const workspace = inputWorkspace()
    const b = fixture(workspace)
    b.store.actions.open(workspace.canvases[0]!.id)
    b.props.describe = vi.fn<WorkspaceProps['describe']>(async path => ({ path, name: path, kind: 'file', size: 2 }))
    render(<ConvaxWorkspace {...b.props} />)
    const origin: CanvasConnectionOrigin = { nodeId: 'target-chat' as CanvasNodeId, portId: 'input', direction: 'input' }
    act(() => { currentGraph().addProject({ x: -200, y: -100 }, origin) })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel directory' }))
    await act(async () => {})
    expect(b.execute).not.toHaveBeenCalled()
    expect(b.insertInputs).not.toHaveBeenCalled()
    b.execute.mockResolvedValue({ ok: false, code: 'conflict', message: 'Changed', workspace })
    act(() => { currentGraph().addResources([{ name: 'one.txt', path: '/project/one.txt' }], { x: -200, y: -100 }, origin) })
    await waitFor(() => { expect(b.execute).toHaveBeenCalledOnce() })
    expect(b.execute.mock.calls[0]![0].command).toMatchObject({ kind: 'add-node', initialConnections: [expect.anything()] })
    expect(b.insertInputs).not.toHaveBeenCalled()
  })

  it('creates an empty-canvas Chat in the canvas directory without opening a picker', async () => {
    const canvas = { id: 'canvas' as CanvasId, title: 'Board', revision: 4, nodes: [], connections: [] }
    const b = fixture({ revision: 4, canvases: [canvas], nodeTypes: [], nodeIssues: [], chats: [] })
    b.store.actions.open(canvas.id)
    render(<ConvaxWorkspace {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    await waitFor(() => { expect(b.execute).toHaveBeenCalledOnce() })
    expect(b.props.ensureCanvasDirectory).toHaveBeenCalledExactlyOnceWith(canvas.id)
    expect(screen.queryByRole('dialog', { name: 'Directory interaction' })).toBeNull()
    expect(b.execute.mock.calls[0]?.[0].command).toMatchObject({
      kind: 'add-node', node: { typeId: 'convax.chat', data: { cwd: '/documents/convax/canvas' } },
    })
  })

  it('keeps a Chat out of the graph when its canvas directory cannot be prepared', async () => {
    const workspace = inputWorkspace()
    const b = fixture(workspace)
    b.store.actions.open(workspace.canvases[0]!.id)
    b.props.ensureCanvasDirectory = vi.fn(async () => { throw new Error('Permission denied') })
    render(<ConvaxWorkspace {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('canvas working directory') })
    expect(b.execute).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: 'Directory interaction' })).toBeNull()
  })

  it('discards a canvas directory result after the workspace unmounts', async () => {
    const workspace = inputWorkspace()
    const b = fixture(workspace)
    b.store.actions.open(workspace.canvases[0]!.id)
    const directory = Promise.withResolvers<string>()
    b.props.ensureCanvasDirectory = vi.fn(() => directory.promise)
    const view = render(<ConvaxWorkspace {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    await waitFor(() => { expect(b.props.ensureCanvasDirectory).toHaveBeenCalledOnce() })
    view.unmount()
    await act(async () => { directory.resolve('/documents/convax/canvas') })
    expect(b.execute).not.toHaveBeenCalled()
  })

  it('keeps one permanent deletion identity through local confirmation and a pending retry', async () => {
    const canvas = { id: 'canvas' as CanvasId, title: 'Board', revision: 4, nodes: [], connections: [] }
    const workspace = { revision: 4, canvases: [canvas], nodeTypes: [], nodeIssues: [], chats: [] }
    const b = fixture(workspace)
    b.store.actions.open(canvas.id)
    const execute = vi.fn<WorkspaceProps['execute']>()
      .mockResolvedValueOnce({ ok: false, code: 'operation-pending', message: 'pending', workspace })
      .mockResolvedValueOnce({ ok: true, workspace: { ...workspace, canvases: [] } })
    render(<ConvaxWorkspace {...b.props} execute={execute} />)
    canvasAction('Board', 'Permanently delete…')
    expect(execute).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Permanently delete' }))
    await waitFor(() => { expect(execute).toHaveBeenCalledOnce() })
    const original = execute.mock.calls[0]![0]
    expect(original).toMatchObject({ canvasId: canvas.id, expectedRevision: 4, confirmed: true, command: { kind: 'purge' } })
    await waitFor(() => { expect(b.store.getSnapshot().deletionAttempts?.[original.operationId]).toBeDefined() })
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Retry' }).hasAttribute('disabled')).toBe(false) })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => { expect(execute).toHaveBeenCalledTimes(2) })
    expect(execute.mock.calls[1]?.[0]).toEqual(original)
    await waitFor(() => { expect(b.store.getSnapshot().deletionAttempts?.[original.operationId]).toBeUndefined() })
    expect(b.store.getSnapshot().tabs).toEqual([])
    expect(screen.queryByRole('dialog', { name: 'Permanently delete Board?' })).toBeNull()
  })

  it('opens the exact thread from the activity menu for a closed canvas', async () => {
    const canvas = { id: 'closed-canvas' as CanvasId, title: 'Closed board', revision: 4, nodes: [], connections: [] }
    const sessionId = 'finished-thread' as SessionId
    const nodeId = 'chat' as CanvasNodeId
    const b = fixture({ revision: 4, canvases: [canvas], nodeTypes: [], nodeIssues: [], chats: [{
      canvasId: canvas.id, nodeId, title: 'Background chat', cwd: '/project', deleting: false, issue: null,
      threads: [{ sessionId, parentSessionId: null, inheritedEventCount: 0 }],
    }] })
    const statuses: SessionStatusSnapshot = new Map([
      [sessionId, { running: false, completionUnread: true, pendingInteraction: undefined }],
    ])
    b.activity.observe({ revision: 4, canvases: [canvas], nodeTypes: [], nodeIssues: [], chats: [{
      canvasId: canvas.id, nodeId, title: 'Background chat', cwd: '/project', deleting: false, issue: null,
      threads: [{ sessionId, parentSessionId: null, inheritedEventCount: 0 }],
    }] }, statuses, {})
    render(<ConvaxWorkspace {...b.props} />)
    expect(b.store.getSnapshot().tabs).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Activity, 1 unread' }))
    fireEvent.click(screen.getByRole('button', { name: 'Background chat, Finished' }))
    expect(b.store.getSnapshot()).toMatchObject({ tabs: [canvas.id], activeCanvasId: canvas.id, threadFocus: { nodeId, sessionId } })
    await waitFor(() => { expect(b.props.markActivityRead).toHaveBeenCalledWith([sessionId]) })
  })

  it.each([
    { origin: 'completion', ok: true }, { origin: 'completion', ok: false },
    { origin: 'automation', ok: true }, { origin: 'automation', ok: false },
  ])('reveals an archived $origin thread only after unarchiving succeeds: $ok', async ({ origin, ok }) => {
    let workspace = inputWorkspace()
    workspace = { ...workspace, canvases: workspace.canvases.map(canvas => ({ ...canvas, archived: true })) }
    const canvas = workspace.canvases[0]!
    const chat = workspace.chats[0]!
    const thread = chat.threads[0]!
    const b = fixture(workspace, () => workspace)
    const receipt = Promise.withResolvers<Awaited<ReturnType<WorkspaceProps['execute']>>>()
    b.execute.mockImplementation(() => receipt.promise)
    const statuses: SessionStatusSnapshot = new Map([
      [thread.sessionId, { running: false, completionUnread: true, pendingInteraction: undefined }],
    ])
    b.activity.observe(workspace, statuses, {})
    render(<ConvaxWorkspace {...b.props} />)
    if (origin === 'completion') {
      fireEvent.click(screen.getByRole('button', { name: 'Activity, 1 unread' }))
      fireEvent.click(screen.getByRole('button', { name: 'Project chat, Finished' }))
    }
    else {
      fireEvent.click(screen.getByRole('button', { name: 'Automation' }))
      const owner = b.renderFactorySlot.mock.calls.find(([name]) => name === 'schedule.manager')![1] as SlotFactoryMap['schedule.manager']['props']
      act(() => { owner.onOpenSession(thread.sessionId) })
      expect(screen.getByRole('dialog', { name: 'Automation tasks' })).toBeDefined()
    }
    expect(b.execute).toHaveBeenCalledOnce()
    expect(b.execute.mock.calls[0]![0]).toMatchObject({
      canvasId: canvas.id, expectedRevision: canvas.revision, command: { kind: 'set-archived', archived: false },
    })
    expect(b.store.getSnapshot().tabs).toEqual([])
    expect(b.store.getSnapshot().threadFocus).toBeUndefined()
    expect(b.props.markActivityRead).not.toHaveBeenCalled()
    await act(async () => {
      if (ok) {
        workspace = { ...workspace, canvases: [{ ...canvas, archived: false, revision: canvas.revision + 1 }] }
        receipt.resolve({ ok: true, workspace })
      } else receipt.resolve({ ok: false, code: 'conflict', message: 'Changed elsewhere', workspace })
    })
    if (ok) {
      expect(b.store.getSnapshot()).toMatchObject({
        tabs: [canvas.id], activeCanvasId: canvas.id, threadFocus: { nodeId: chat.nodeId, sessionId: thread.sessionId },
      })
      expect(screen.queryByRole('dialog', { name: 'Automation tasks' })).toBeNull()
      if (origin === 'completion') expect(b.props.markActivityRead).toHaveBeenCalledExactlyOnceWith([thread.sessionId])
    } else {
      expect(b.store.getSnapshot().tabs).toEqual([])
      expect(b.store.getSnapshot().threadFocus).toBeUndefined()
      expect(b.props.markActivityRead).not.toHaveBeenCalled()
      if (origin === 'automation') expect(screen.getByRole('dialog', { name: 'Automation tasks' })).toBeDefined()
    }
    expect(b.props.openSession).not.toHaveBeenCalled()
    expect(b.props.initializeAutomation).not.toHaveBeenCalled()
  })

  it('adds a picked project inside the current view and keeps folder opening outside the canvas', async () => {
    const existing = {
      id: 'existing-reference' as CanvasNodeId, typeId: 'convax.file' as CanvasNodeTypeId,
      dataVersion: 1, data: { path: '/project/existing.txt' }, position: { x: 0, y: 0 }, revision: 1,
    }
    const canvas = { id: 'canvas' as CanvasId, title: 'Board', revision: 0, nodes: [existing], connections: [] }
    const workspace: CanvasWorkspace = { revision: 0, canvases: [canvas], nodeTypes: [], nodeIssues: [], chats: [] }
    const b = fixture(workspace)
    b.store.actions.open(canvas.id)
    b.store.actions.setResourceExpanded(existing.id, false)
    b.execute.mockImplementation(async request => ({ ok: true, workspace: commitReference(workspace, request) }))
    b.picker.path = '/picked/project'
    b.props.describe = vi.fn<WorkspaceProps['describe']>(async path => ({ path, name: 'project', kind: 'folder', size: null }))
    render(<ConvaxWorkspace {...b.props} />)
    expect(screen.queryByRole('complementary', { name: 'Project files' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Project folder' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pick directory' }))
    await waitFor(() => { expect(b.execute).toHaveBeenCalledOnce() })
    expect(b.execute.mock.calls[0]?.[0].command).toMatchObject({
      kind: 'add-node', node: { typeId: 'convax.folder', data: { path: '/picked/project' }, position: { x: 240, y: 180 } },
    })
    const command = b.execute.mock.calls[0]![0].command
    if (command.kind !== 'add-node') throw new Error('Expected picked folder addition')
    await waitFor(() => { expect(b.store.getSnapshot().resourceViews).toEqual({
      [existing.id]: { expanded: false }, [command.node.id]: { expanded: true },
    }) })
    fireEvent.click(screen.getByRole('button', { name: 'Open folder' }))
    expect(b.props.openFolder).toHaveBeenCalledExactlyOnceWith('/project/folder')
    expect(b.store.getSnapshot().directory).toBe('')
  })

  it('keeps directory interaction cancellation free of graph mutations', async () => {
    const canvas = { id: 'canvas' as CanvasId, title: 'Board', revision: 0, nodes: [], connections: [] }
    const b = fixture({ revision: 0, canvases: [canvas], nodeTypes: [], nodeIssues: [], chats: [] })
    b.store.actions.open(canvas.id)
    render(<ConvaxWorkspace {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel directory' }))
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Directory interaction' })).toBeNull() })
    expect(b.execute).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('settles directory failures through the existing operation notice', async () => {
    const canvas = { id: 'canvas' as CanvasId, title: 'Board', revision: 0, nodes: [], connections: [] }
    const b = fixture({ revision: 0, canvases: [canvas], nodeTypes: [], nodeIssues: [], chats: [] })
    b.store.actions.open(canvas.id)
    render(<ConvaxWorkspace {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }))
    fireEvent.click(screen.getByRole('button', { name: 'Fail directory' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain(en['operation.failed']) })
    expect(b.execute).not.toHaveBeenCalled()
  })

  it('ignores a late directory outcome after cancellation or workspace unmount', async () => {
    const canvas = { id: 'canvas' as CanvasId, title: 'Board', revision: 0, nodes: [], connections: [] }
    const b = fixture({ revision: 0, canvases: [canvas], nodeTypes: [], nodeIssues: [], chats: [] })
    b.store.actions.open(canvas.id)
    const view = render(<ConvaxWorkspace {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }))
    const cancel = await screen.findByRole('button', { name: 'Cancel directory' })
    const first = b.picker.owner!
    fireEvent.click(cancel)
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }))
    await screen.findByRole('button', { name: 'Cancel directory' })
    await act(async () => { first.onPicked('/old/project') })
    expect(screen.getByRole('dialog', { name: 'Directory interaction' })).toBeDefined()
    expect(b.execute).not.toHaveBeenCalled()
    const second = b.picker.owner!
    view.unmount()
    await act(async () => { second.onPicked('/late/project') })
    expect(b.execute).not.toHaveBeenCalled()
  })

  it('shows a source reveal failure without opening a preview or changing the canvas', async () => {
    const canvas = { id: 'canvas' as CanvasId, title: 'Board', revision: 0, nodes: [], connections: [] }
    const b = fixture({ revision: 0, canvases: [canvas], nodeTypes: [], nodeIssues: [], chats: [] })
    b.store.actions.open(canvas.id)
    b.props.revealSource = vi.fn(async () => { throw new Error('missing file') })
    render(<ConvaxWorkspace {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show source' }))
    await waitFor(() => { expect(screen.getByText(en['files.openFailed'])).toBeDefined() })
    expect(b.props.revealSource).toHaveBeenCalledExactlyOnceWith('/project/clip.mp4')
    expect(b.props.openFolder).not.toHaveBeenCalled()
    expect(b.execute).not.toHaveBeenCalled()
  })

  it('keeps workspace navigation global and canvas actions inside canvas management', async () => {
    const canvas = { id: 'canvas' as CanvasId, title: 'Board', revision: 0, nodes: [], connections: [] }
    const b = fixture({ revision: 0, canvases: [canvas], nodeTypes: [], nodeIssues: [], chats: [] })
    b.store.actions.open(canvas.id)
    render(<ConvaxWorkspace {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Workspace actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }))
    expect(b.props.openSettings).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Workspace actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Plugins' }))
    expect(b.props.openPlugins).toHaveBeenCalledOnce()
    canvasAction('Board', 'Rename canvas')
    fireEvent.change(screen.getByRole('textbox', { name: 'Canvas name' }), { target: { value: 'Research' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => { expect(b.execute).toHaveBeenCalledOnce() })
    expect(b.execute.mock.calls[0]?.[0].command).toEqual({ kind: 'rename', title: 'Research' })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    fireEvent.click(screen.getByRole('button', { name: 'Close Board' }))
    openCanvasManager()
    fireEvent.click(within(screen.getByRole('dialog', { name: 'All canvases' })).getByRole('button', { name: 'Board' }))
    expect(b.store.getSnapshot().activeCanvasId).toBe(canvas.id)
  })

  it('adds a mixed native drop sequentially using each confirmed revision before the watch updates', async () => {
    const canvas = { id: 'canvas' as CanvasId, title: 'Board', revision: 4, nodes: [], connections: [] }
    const initial: CanvasWorkspace = { revision: 4, canvases: [canvas], nodeTypes: [], nodeIssues: [], chats: [] }
    const b = fixture(initial)
    b.store.actions.open(canvas.id)
    let current = initial
    const describe = vi.fn<WorkspaceProps['describe']>(async path => ({
      path, name: path, kind: path.endsWith('/folder') ? 'folder' : 'file', size: null,
    }))
    const execute = vi.fn<WorkspaceProps['execute']>(async (request) => {
      const saved = current.canvases[0]!
      expect(request.expectedRevision).toBe(saved.revision)
      if (request.command.kind !== 'add-node') throw new Error('Expected reference addition')
      current = { ...current, revision: current.revision + 1, canvases: [{
        ...saved, revision: saved.revision + 1, nodes: [...saved.nodes, request.command.node],
      }] }
      return { ok: true, workspace: current }
    })
    render(<ConvaxWorkspace {...b.props} describe={describe} execute={execute} />)
    fireEvent.click(screen.getByRole('button', { name: 'Drop multiple resources' }))
    await waitFor(() => { expect(current.canvases[0]?.nodes).toHaveLength(3) })
    expect(execute.mock.calls.map(([request]) => request.expectedRevision)).toEqual([4, 5, 6])
    expect(current.canvases[0]!.nodes.map(node => node.typeId)).toEqual(['convax.folder', 'convax.file', 'convax.file'])
    const [first, second, third] = current.canvases[0]!.nodes
    expect(first!.position).toEqual({ x: 37, y: -21 })
    expect(second!.position.x).toBeGreaterThan(first!.position.x + RESOURCE_CARD_WIDTH)
    expect(third!.position.x).toBeGreaterThan(second!.position.x + RESOURCE_CARD_WIDTH)
    expect(b.store.getSnapshot().resourceViews).toEqual({
      [first!.id]: { expanded: true }, [second!.id]: { expanded: true }, [third!.id]: { expanded: true },
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reports unavailable paths and unreadable resources while adding the other dropped references', async () => {
    const canvas = { id: 'canvas' as CanvasId, title: 'Board', revision: 4, nodes: [], connections: [] }
    const workspace: CanvasWorkspace = { revision: 4, canvases: [canvas], nodeTypes: [], nodeIssues: [], chats: [] }
    const b = fixture(workspace)
    b.store.actions.open(canvas.id)
    b.execute.mockImplementation(async request => ({ ok: true, workspace: commitReference(workspace, request) }))
    const describe = vi.fn<WorkspaceProps['describe']>(async (path) => {
      if (path.endsWith('missing.txt')) throw new Error('Resource no longer exists')
      return { path, name: path, kind: 'file', size: 4 }
    })
    render(<ConvaxWorkspace {...b.props} describe={describe} />)
    fireEvent.click(screen.getByRole('button', { name: 'Drop unreadable resources' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('Added 1 of 3 references') })
    expect(screen.getByRole('alert').textContent).toContain('original path for virtual.txt is unavailable')
    expect(screen.getByRole('alert').textContent).toContain('Could not read missing.txt')
    expect(describe.mock.calls.map(([path]) => path)).toEqual(['/project/missing.txt', '/project/last.txt'])
    expect(b.execute).toHaveBeenCalledOnce()
    const command = b.execute.mock.calls[0]![0].command
    if (command.kind !== 'add-node') throw new Error('Expected readable reference addition')
    expect(b.store.getSnapshot().resourceViews).toEqual({ [command.node.id]: { expanded: true } })
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('stops the remaining drop after an unconfirmed mutation and reports the committed subset', async () => {
    const canvas = { id: 'canvas' as CanvasId, title: 'Board', revision: 4, nodes: [], connections: [] }
    const workspace: CanvasWorkspace = { revision: 4, canvases: [canvas], nodeTypes: [], nodeIssues: [], chats: [] }
    const b = fixture(workspace)
    b.store.actions.open(canvas.id)
    const describe = vi.fn<WorkspaceProps['describe']>(async path => ({ path, name: path, kind: 'file', size: 4 }))
    const execute = vi.fn<WorkspaceProps['execute']>()
      .mockImplementationOnce(async request => ({ ok: true, workspace: commitReference(workspace, request) }))
      .mockRejectedValueOnce(new Error('Connection closed after submission'))
    render(<ConvaxWorkspace {...b.props} describe={describe} execute={execute} />)
    fireEvent.click(screen.getByRole('button', { name: 'Drop multiple resources' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('Added 1 of 3 references') })
    expect(screen.getByRole('alert').textContent).toContain('Could not confirm adding file.txt; later items were not added')
    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls.map(([request]) => request.expectedRevision)).toEqual([4, 5])
    expect(describe.mock.calls.map(([path]) => path)).toEqual(['/project/folder', '/project/file.txt'])
    const committed = execute.mock.calls[0]![0].command
    const unconfirmed = execute.mock.calls[1]![0].command
    if (committed.kind !== 'add-node' || unconfirmed.kind !== 'add-node') throw new Error('Expected reference additions')
    expect(b.store.getSnapshot().resourceViews).toEqual({ [committed.node.id]: { expanded: true } })
    expect(b.store.getSnapshot().resourceViews?.[unconfirmed.node.id]).toBeUndefined()
  })

  it.each(['rejected', 'missing canvas', 'missing node'] as const)('keeps existing view preferences when addition is %s', async (outcome) => {
    const workspace = inputWorkspace()
    const b = fixture(workspace)
    b.store.actions.open(workspace.canvases[0]!.id)
    b.store.actions.setResourceExpanded('folder-node' as CanvasNodeId, false)
    const previous = b.store.getSnapshot().resourceViews
    b.props.describe = vi.fn<WorkspaceProps['describe']>(async path => ({ path, name: path, kind: 'file', size: 4 }))
    b.execute.mockResolvedValueOnce(outcome === 'rejected'
      ? { ok: false, code: 'conflict', message: 'Conflict', workspace }
      : { ok: true, workspace: outcome === 'missing canvas' ? { ...workspace, canvases: [] } : workspace })
    render(<ConvaxWorkspace {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Drop resource' }))
    await waitFor(() => { expect(b.execute).toHaveBeenCalledOnce() })
    await act(async () => {})
    expect(b.store.getSnapshot().resourceViews).toEqual(previous)
  })
})


describe('Convax local graph history', () => {
  it.each(['deletion', 'undo addition'] as const)('retains removed resource preferences when the watch update precedes a %s receipt', async (operation) => {
    let workspace = inputWorkspace()
    const original = workspace
    const canvas = workspace.canvases[0]!
    const file = canvas.nodes[2]!.id
    const saved = { expanded: true, width: 480, height: 200 }
    const target = 'original-addition' as CanvasOperationId
    const b = fixture(workspace, () => workspace)
    b.store.actions.open(canvas.id)
    b.store.actions.copyResourceView(file, saved)
    if (operation === 'undo addition') b.store.actions.recordHistory(canvas.id, target, {})
    const reply = Promise.withResolvers<Awaited<ReturnType<WorkspaceProps['execute']>>>()
    b.execute.mockImplementationOnce(() => reply.promise)
    const view = render(<ConvaxWorkspace {...b.props} />)
    act(() => {
      if (operation === 'deletion') void currentGraph().command({ kind: 'remove-nodes', nodeIds: [file] })
      else currentGraph().replayHistory('undo')
    })
    const request = b.execute.mock.calls[0]![0]
    workspace = { ...workspace, canvases: [{ ...canvas, revision: 5, nodes: canvas.nodes.filter(node => node.id !== file) }] }
    view.rerender(<ConvaxWorkspace {...b.props} />)
    expect(b.store.getSnapshot().resourceViews?.[file]).toBeUndefined()
    view.rerender(<ConvaxWorkspace {...b.props} />)
    expect(currentGraph().resourceViews[file]).toBeUndefined()
    await act(async () => { reply.resolve({ ok: true, workspace }) })
    const historyId = operation === 'deletion' ? request.operationId : target
    expect(b.store.getSnapshot().histories?.[canvas.id]?.resourceViews[historyId]).toEqual({ [file]: saved })
    b.execute.mockResolvedValueOnce({ ok: true, workspace: original })
    await act(async () => { currentGraph().replayHistory(operation === 'deletion' ? 'undo' : 'redo') })
    expect(b.store.getSnapshot().resourceViews?.[file]).toEqual(saved)
  })

  it('records only successful local edits and replays their identity against the observed revision', async () => {
    let workspace = inputWorkspace()
    const b = fixture(workspace, () => workspace)
    const canvas = workspace.canvases[0]!
    b.store.actions.open(canvas.id)
    const view = render(<ConvaxWorkspace {...b.props} />)
    expect(currentGraph().history.canUndo).toBe(false)
    workspace = { ...workspace, canvases: [{ ...canvas, revision: 5 }] }
    view.rerender(<ConvaxWorkspace {...b.props} />)
    expect(b.store.getSnapshot().histories).toBeUndefined()
    b.execute.mockResolvedValueOnce({ ok: false, code: 'conflict', message: 'Changed', workspace })
    await act(async () => { await currentGraph().command({ kind: 'move-nodes', nodes: [{ id: canvas.nodes[0]!.id, position: { x: 10, y: 0 } }] }) })
    expect(b.store.getSnapshot().histories).toBeUndefined()
    b.execute.mockResolvedValueOnce({ ok: true, workspace })
    await act(async () => { await currentGraph().command({ kind: 'move-nodes', nodes: [{ id: canvas.nodes[0]!.id, position: { x: 10, y: 0 } }] }) })
    const operation = b.execute.mock.calls[1]![0].operationId
    expect(b.store.getSnapshot().histories?.[canvas.id]?.undo).toEqual([operation])
    workspace = { ...workspace, canvases: [{ ...canvas, revision: 9 }] }
    view.rerender(<ConvaxWorkspace {...b.props} />)
    b.execute.mockResolvedValueOnce({ ok: true, workspace })
    await act(async () => { currentGraph().replayHistory('undo') })
    expect(b.execute.mock.calls[2]![0]).toMatchObject({ expectedRevision: 9,
      command: { kind: 'history', targetOperationId: operation, direction: 'undo' } })
    expect(b.store.getSnapshot().histories?.[canvas.id]).toMatchObject({ undo: [], redo: [operation] })
    expect(b.insertInputs).not.toHaveBeenCalled()
  })

  it('restores deleted resource preferences after an ambiguous committed reply and retries the same operation once', async () => {
    const original = inputWorkspace()
    const canvas = original.canvases[0]!
    const file = canvas.nodes[2]!.id
    let workspace: CanvasWorkspace = { ...original, canvases: [{ ...canvas, nodes: canvas.nodes.filter(node => node.id !== file) }] }
    const b = fixture(workspace, () => workspace)
    const target = 'original-delete' as CanvasOperationId
    const saved = { expanded: true, width: 540, height: 420 }
    b.store.actions.open(canvas.id)
    b.store.actions.recordHistory(canvas.id, target, { [file]: saved })
    const view = render(<ConvaxWorkspace {...b.props} />)
    b.execute.mockRejectedValueOnce(new Error('Reply lost'))
    await act(async () => { currentGraph().replayHistory('undo') })
    const attempt = b.execute.mock.calls[0]![0]
    expect(b.store.getSnapshot().deletionAttempts?.[attempt.operationId]).toEqual(attempt)
    expect(b.store.getSnapshot().histories?.[canvas.id]?.undo).toEqual([target])
    expect(currentGraph().history.canUndo).toBe(false)
    workspace = { ...original, canvases: [{ ...canvas, revision: 8 }] }
    view.rerender(<ConvaxWorkspace {...b.props} />)
    expect(b.store.getSnapshot().resourceViews?.[file]).toBeUndefined()
    b.execute.mockResolvedValueOnce({ ok: true, workspace })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => { expect(b.store.getSnapshot().histories?.[canvas.id]?.redo).toEqual([target]) })
    expect(b.execute.mock.calls[1]![0]).toEqual(attempt)
    expect(b.store.getSnapshot().resourceViews?.[file]).toEqual(saved)
    expect(b.store.getSnapshot().deletionAttempts?.[attempt.operationId]).toBeUndefined()
    expect(b.insertInputs).not.toHaveBeenCalled()
  })

  it('releases a rejected uncertain retry without losing the original undo stack', async () => {
    const workspace = inputWorkspace()
    const b = fixture(workspace)
    const canvas = workspace.canvases[0]!
    const target = 'local-operation' as CanvasOperationId
    b.store.actions.open(canvas.id)
    b.store.actions.recordHistory(canvas.id, target, {})
    render(<ConvaxWorkspace {...b.props} />)
    b.execute.mockRejectedValueOnce(new Error('Transport lost'))
    await act(async () => { currentGraph().replayHistory('undo') })
    const attempt = b.execute.mock.calls[0]![0]
    b.execute.mockResolvedValueOnce({ ok: false, code: 'conflict', message: 'Edited elsewhere', workspace })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => { expect(b.store.getSnapshot().deletionAttempts?.[attempt.operationId]).toBeUndefined() })
    expect(b.execute.mock.calls[1]![0]).toEqual(attempt)
    expect(b.store.getSnapshot().histories?.[canvas.id]?.undo).toEqual([target])
    expect(currentGraph().history.canUndo).toBe(true)
  })

  it('retains history confirmation and operation-pending identities until the successful receipt', async () => {
    const workspace = inputWorkspace()
    const b = fixture(workspace)
    const canvas = workspace.canvases[0]!
    const target = 'local-create-chat' as CanvasOperationId
    b.store.actions.open(canvas.id)
    b.store.actions.recordHistory(canvas.id, target, {})
    b.execute.mockResolvedValueOnce({ ok: false, code: 'confirmation-required', message: 'Confirm', workspace })
      .mockResolvedValueOnce({ ok: false, code: 'operation-pending', message: 'Pending', workspace })
      .mockResolvedValueOnce({ ok: true, workspace })
    render(<ConvaxWorkspace {...b.props} />)
    await act(async () => { currentGraph().replayHistory('undo') })
    const attempt = b.execute.mock.calls[0]![0]
    expect(b.store.getSnapshot().histories?.[canvas.id]?.undo).toEqual([target])
    fireEvent.click(screen.getByRole('button', { name: 'Stop and delete' }))
    await waitFor(() => { expect(b.store.getSnapshot().deletionAttempts?.[attempt.operationId]).toBeDefined() })
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Retry' }).hasAttribute('disabled')).toBe(false) })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => { expect(b.store.getSnapshot().histories?.[canvas.id]?.redo).toEqual([target]) })
    expect(b.execute.mock.calls.slice(1).map(call => call[0])).toEqual([{ ...attempt, confirmed: true }, { ...attempt, confirmed: true }])
    expect(b.insertInputs).not.toHaveBeenCalled()
  })
})
