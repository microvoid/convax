import { defaultNodeActions, defaultNodeCreations, defaultNodePresentation } from '../src/client/node-presets.ts'
// @vitest-environment jsdom
/** Global automation actions navigate saved canvas bindings and initialize native drafts without submitting them. */
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { SlotFactoryMap } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-schedule/client'
import type { CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasWorkspace } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ConvaxWorkspace } from '@deepseek-ai/dsh-convax-plugin-renderer/client'
import { ChatHeader } from '../src/client/ChatCard.tsx'
import type { CanvasGraphOwner, ChatHeaderProps, WorkspaceProps } from '@deepseek-ai/dsh-convax-plugin-renderer/client'
import { createCanvasViewStore } from '@deepseek-ai/dsh-convax-plugin-renderer/client'
import { en, type ConvaxKey } from '@deepseek-ai/dsh-convax-plugin-renderer/client'

type ManagerOwner = SlotFactoryMap['schedule.manager']['props']

const home = 'home-canvas' as CanvasId
const other = 'other-canvas' as CanvasId
const boundChat = 'bound-chat' as CanvasNodeId
const boundSession = 'bound-session' as SessionId
const unboundSession = 'unbound-session' as SessionId
const newSession = 'automation-session' as SessionId

afterEach(() => { cleanup(); localStorage.clear() })

function initialWorkspace(): CanvasWorkspace {
  return {
    revision: 20, nodeTypes: [], nodeIssues: [],
    canvases: [{ id: home, title: 'Current board', revision: 7, nodes: [], connections: [] }, {
      id: other, title: 'Another board', revision: 3, connections: [], nodes: [{
        id: boundChat, typeId: 'convax.chat' as CanvasNodeTypeId, dataVersion: 1,
        data: { cwd: '/project/other', title: 'Existing automation' }, position: { x: 300, y: 100 }, revision: 1,
      }],
    }],
    chats: [{
      canvasId: other, nodeId: boundChat, title: 'Existing automation', cwd: '/project/other', deleting: false, issue: null,
      threads: [{ sessionId: boundSession, parentSessionId: null, inheritedEventCount: 0 }],
    }],
  }
}

function fixture(openCanvas = true) {
  let workspace = initialWorkspace()
  const store = createCanvasViewStore().create()
  if (openCanvas) store.actions.open(home)
  const execute = vi.fn<WorkspaceProps['execute']>(async (request) => {
    if (request.command.kind !== 'add-node') throw new Error('Automation creates its Chat through one add-node command')
    const node = request.command.node
    workspace = { ...workspace, revision: workspace.revision + 1,
      canvases: workspace.canvases.map(canvas => canvas.id === request.canvasId
        ? { ...canvas, revision: canvas.revision + 1, nodes: [...canvas.nodes, node] } : canvas),
    }
    return { ok: true, workspace }
  })
  const initializeAutomation = vi.fn<WorkspaceProps['initializeAutomation']>(async () => ({
    ok: true, sessionId: newSession, workspace,
  }))
  const ensureCanvasDirectory = vi.fn(async (canvasId: CanvasId) => `/canvas/${canvasId}`)
  const openSession = vi.fn<WorkspaceProps['openSession']>(async request => ({
    ok: true, workspace, canvasId: request.canvasId, nodeId: request.nodeId, sessionId: request.sessionId,
  }))
  const renderFactorySlot = vi.fn<WorkspaceProps['renderFactorySlot']>((name, owner) => {
    if (name === 'convax.graph') return <output aria-label="Active canvas">{(owner as CanvasGraphOwner).document.title}</output>
    if (name === 'schedule.manager') {
      const manager = owner as ManagerOwner
      return <div data-automation-manager>
        <button onClick={manager.onNewTask}>New</button>
        {manager.close !== undefined && <button aria-label={manager.close.label} onClick={manager.close.onClose}>Close</button>}
        <button onClick={() => { manager.onOpenSession(boundSession) }}>Open bound task conversation</button>
        <button onClick={() => { manager.onOpenSession(unboundSession) }}>Open unbound task conversation</button>
      </div>
    }
    return null
  })
  const props = {
    t: ((key: ConvaxKey, values?: Record<string, string | number>) =>
      en[key].replace(/\{(\w+)\}/g, (_match, name: string) => String(values?.[name] ?? ''))) as WorkspaceProps['t'],
    useStore: selector => selector(store.getSnapshot()), actions: store.actions,
    useResource: () => ({ status: 'live', value: workspace, failure: undefined }),
    useSessions: selector => selector({ byId: {}, ids: [], phase: 'ready', projectionsBySession: {} }),
    useSessionStatus: selector => selector(new Map()),
    defaultInputMode: 'touchpad', execute, initializeAutomation, ensureCanvasDirectory, openSession, renderFactorySlot,
    captureInput: vi.fn(), insertInputs: vi.fn(async () => true), describe: vi.fn(), resolveFilePath: vi.fn(),
    refresh: vi.fn(), openSettings: vi.fn(), openPlugins: vi.fn(), openFolder: vi.fn(), revealSource: vi.fn(),
    markActivityRead: vi.fn(), useCanvasActivity: selector => selector([]),
  } as WorkspaceProps
  const nodeSnapshot = { definitions: defaultNodePresentation,
    creations: defaultNodeCreations(props.t), actions: defaultNodeActions(path => props.describe(path)) }
  props.nodePlugins = { getSnapshot: () => nodeSnapshot, subscribe: () => () => {} }
  const view = render(<ConvaxWorkspace {...props} />)
  return {
    view, props, store, execute, initializeAutomation, ensureCanvasDirectory, openSession, renderFactorySlot,
    workspace: () => workspace,
  }
}

function openManager() {
  fireEvent.click(screen.getByRole('button', { name: 'Automation' }))
  return screen.getByRole('dialog', { name: 'Automation tasks' })
}

describe('Convax automation navigation', () => {
  it('renders the native Session reminder action beside the selected thread tools', () => {
    const renderFactorySlot = vi.fn<ChatHeaderProps['renderFactorySlot']>(name => name === 'schedule.session'
      ? <button>Conversation reminders</button> : <button>Conversation tools</button>)
    render(<ChatHeader {...{ renderFactorySlot } as ChatHeaderProps} />)
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['Conversation reminders', 'Conversation tools'])
    expect(renderFactorySlot.mock.calls).toEqual([
      ['schedule.session', {}],
      ['conversation.header.content', { hideChrome: false, presentation: 'toolbar', views: 'hidden', actionsTrigger: 'hidden' }],
    ])
  })

  it('opens the shared global task manager in a modal without changing the canvas', () => {
    const b = fixture()
    const before = b.store.getSnapshot()
    const dialog = openManager()
    const owner = b.renderFactorySlot.mock.calls.find(([name]) => name === 'schedule.manager')?.[1] as ManagerOwner
    expect(owner.presentation).toBe('embedded')
    expect(typeof owner.onNewTask).toBe('function')
    expect(typeof owner.onOpenSession).toBe('function')
    expect(owner.close?.label).toBe('Close automation tasks')
    expect({
      launcher: screen.getByRole('button', { name: 'Automation' }).getAttribute('aria-label'),
      title: dialog.getAttribute('aria-label'),
      portal: dialog.closest('[data-convax-workspace]') === null,
      canvas: screen.getByRole('status', { name: 'Active canvas' }).textContent,
    }).toMatchSnapshot('global manager modal')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close automation tasks' }))
    expect(screen.queryByRole('dialog', { name: 'Automation tasks' })).toBeNull()
    expect(b.store.getSnapshot()).toEqual(before)
    expect(b.execute).not.toHaveBeenCalled()
    expect(b.openSession).not.toHaveBeenCalled()
  })

  it('keeps a failed canvas directory allocation free of Chat and Session creation', async () => {
    const b = fixture()
    b.ensureCanvasDirectory.mockRejectedValueOnce(new Error('Directory is read-only'))
    fireEvent.click(within(openManager()).getByRole('button', { name: 'New' }))
    expect(screen.queryByRole('dialog', { name: 'Automation tasks' })).toBeNull()
    await waitFor(() => { expect(b.ensureCanvasDirectory).toHaveBeenCalledExactlyOnceWith(home) })
    expect((await screen.findByRole('alert')).textContent).toContain(en['chat.directoryFailed'])
    expect(b.execute).not.toHaveBeenCalled()
    expect(b.initializeAutomation).not.toHaveBeenCalled()
    expect(b.store.getSnapshot().threadFocus).toBeUndefined()
    expect(b.renderFactorySlot.mock.calls.some(([name]) => name === 'workspace.directoryPicker')).toBe(false)
  })

  it('creates a Chat in the current canvas before initializing and focusing its native automation draft', async () => {
    const b = fixture()
    fireEvent.click(within(openManager()).getByRole('button', { name: 'New' }))
    await waitFor(() => { expect(b.initializeAutomation).toHaveBeenCalledOnce() })
    expect(b.ensureCanvasDirectory).toHaveBeenCalledExactlyOnceWith(home)
    expect(b.renderFactorySlot.mock.calls.some(([name]) => name === 'workspace.directoryPicker')).toBe(false)
    expect(b.execute).toHaveBeenCalledOnce()
    const command = b.execute.mock.calls[0]![0]
    expect(command).toMatchObject({ canvasId: home, expectedRevision: 7, command: {
      kind: 'add-node', node: { typeId: 'convax.chat', data: { cwd: '/canvas/home-canvas', title: en['chat.untitled'] } },
    } })
    if (command.command.kind !== 'add-node') throw new Error('New automation did not create a Chat')
    const nodeId = command.command.node.id
    const [request, prompt] = b.initializeAutomation.mock.calls[0]!
    expect(request).toMatchObject({ canvasId: home, nodeId, expectedRevision: 8, kind: 'create', cwd: '/canvas/home-canvas' })
    expect(typeof request.operationId).toBe('string')
    expect(prompt).toBe(en['automation.prompt'])
    await waitFor(() => { expect(b.store.getSnapshot().threadFocus).toEqual({
      nodeId, sessionId: newSession,
    }) })
    expect(b.store.getSnapshot().activeCanvasId).toBe(home)
    expect(b.openSession).not.toHaveBeenCalled()
  })

  it('reopens a closed canvas and focuses an existing automation Session without creating another Chat', () => {
    const tabWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.querySelector(':scope > [role="tablist"]') !== null ? 400 : 0
    })
    onTestFinished(() => { tabWidth.mockRestore() })
    const b = fixture()
    b.store.actions.open(other)
    b.store.actions.close(other)
    expect(b.store.getSnapshot().activeCanvasId).toBe(home)
    fireEvent.click(within(openManager()).getByRole('button', { name: 'Open bound task conversation' }))
    expect(b.store.getSnapshot()).toMatchObject({
      activeCanvasId: other, tabs: [home, other], closedTabs: [],
      threadFocus: { nodeId: boundChat, sessionId: boundSession },
    })
    expect(screen.getByRole('status', { name: 'Active canvas' }).textContent).toBe('Another board')
    expect(screen.queryByRole('dialog', { name: 'Automation tasks' })).toBeNull()
    expect({
      canvas: screen.getByRole('status', { name: 'Active canvas' }).textContent,
      tabs: screen.getAllByRole('tab').map(tab => ({ title: tab.textContent, selected: tab.getAttribute('aria-selected') })),
      managerClosed: screen.queryByRole('dialog', { name: 'Automation tasks' }) === null,
    }).toMatchSnapshot('existing task opens its saved canvas')
    expect(b.openSession).not.toHaveBeenCalled()
    expect(b.execute).not.toHaveBeenCalled()
    expect(b.initializeAutomation).not.toHaveBeenCalled()
    expect(b.ensureCanvasDirectory).not.toHaveBeenCalled()
  })

  it('opens an unbound Session through one atomic Host request and preserves its original identity', async () => {
    const b = fixture()
    fireEvent.click(within(openManager()).getByRole('button', { name: 'Open unbound task conversation' }))
    await waitFor(() => { expect(b.store.getSnapshot().threadFocus?.sessionId).toBe(unboundSession) })
    expect(b.openSession).toHaveBeenCalledOnce()
    const request = b.openSession.mock.calls[0]![0]
    expect(request).toMatchObject({ canvasId: home, expectedRevision: 7, sessionId: unboundSession })
    expect(typeof request.nodeId).toBe('string')
    expect(Number.isFinite(request.position.x) && Number.isFinite(request.position.y)).toBe(true)
    expect(b.store.getSnapshot().threadFocus?.nodeId).toBe(request.nodeId)
    expect(screen.queryByRole('dialog', { name: 'Automation tasks' })).toBeNull()
    expect(b.execute).not.toHaveBeenCalled()
    expect(b.initializeAutomation).not.toHaveBeenCalled()
    expect(b.ensureCanvasDirectory).not.toHaveBeenCalled()
  })

  it('keeps the manager available after a failed open and prevents duplicate pending requests', async () => {
    const b = fixture()
    const reply = Promise.withResolvers<Awaited<ReturnType<WorkspaceProps['openSession']>>>()
    b.openSession.mockImplementation(() => reply.promise)
    const dialog = openManager()
    const open = within(dialog).getByRole('button', { name: 'Open unbound task conversation' })
    fireEvent.click(open)
    fireEvent.click(open)
    expect(b.openSession).toHaveBeenCalledOnce()
    await act(async () => { reply.resolve({ ok: false, code: 'conflict', message: 'Canvas changed', workspace: b.workspace() }) })
    expect(screen.getByRole('dialog', { name: 'Automation tasks' })).toBe(dialog)
    expect(await screen.findByText(en['automation.failed'])).toBeDefined()
    expect(b.store.getSnapshot().threadFocus).toBeUndefined()
    expect(b.store.getSnapshot().activeCanvasId).toBe(home)
  })

  it.each(['New', 'Open unbound task conversation'])('requires an active canvas for %s without closing the manager', async (action) => {
    const b = fixture(false)
    const dialog = openManager()
    fireEvent.click(within(dialog).getByRole('button', { name: action }))
    expect(await screen.findByText(en['automation.canvasRequired'])).toBeDefined()
    expect(screen.getByRole('dialog', { name: 'Automation tasks' })).toBe(dialog)
    expect(b.openSession).not.toHaveBeenCalled()
    expect(b.execute).not.toHaveBeenCalled()
    expect(b.initializeAutomation).not.toHaveBeenCalled()
    expect(b.ensureCanvasDirectory).not.toHaveBeenCalled()
  })
})
