// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CanvasChat, CanvasId, CanvasNodeId, CanvasThreadRequest, CanvasThreadResult } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ChatCard, ChatThread } from '../src/client/ChatCard.tsx'
import { createChatViewStore } from '@deepseek-ai/dsh-convax-plugin-renderer/client'
import type { CanvasChatThreadOwner, ChatProps, ChatThreadProps } from '@deepseek-ai/dsh-convax-plugin-renderer/client'
import { en, type ConvaxKey } from '@deepseek-ai/dsh-convax-plugin-renderer/client'
import css from '../src/client/ChatCard.module.css'

vi.mock('@xyflow/react', () => ({ NodeToolbar: ({ children, role, 'aria-label': label }: { children: ReactNode; role?: 'toolbar'; 'aria-label'?: string }) => <div role={role} aria-label={label}>{children}</div>, Handle: () => null, Position: { Left: 'left', Right: 'right', Top: 'top' }, useUpdateNodeInternals: () => () => {} }))
afterEach(() => { cleanup(); localStorage.clear() })

const first = 'first-thread' as SessionId
const second = 'second-thread' as SessionId
const chat: CanvasChat = {
  canvasId: 'canvas' as CanvasId, nodeId: 'chat' as CanvasNodeId,
  title: 'Project chat', cwd: '/project', threads: [], deleting: false, issue: null,
}

function fixture(owner: CanvasChat = chat, store = createChatViewStore().create()) {
  const workspace = { revision: 2, canvases: [], nodeTypes: [], nodeIssues: [], chats: [owner] }
  const createThread = vi.fn<(request: CanvasThreadRequest) => Promise<CanvasThreadResult>>()
  const ensureInitialThread = vi.fn<ChatProps['ensureInitialThread']>((request, stage) => {
    stage(request)
    return createThread(request)
  })
  const bindInput = vi.fn<ChatProps['bindInput']>(() => () => {})
  const renderFactorySlot = vi.fn<(name: string, owner: object) => ReactNode>(() => null)
  const props = {
    chat: owner, focusNode: vi.fn(),
    renderFactorySlot,
    canvasRevision: 2, createThread, ensureInitialThread, remove: vi.fn(), consumeFocus: vi.fn(),
    acknowledgeCompletion: vi.fn(), actions: store.actions,
    focusSession: vi.fn(), bindInput,
    useStore: (selector: (state: ReturnType<typeof store.getSnapshot>) => unknown) => selector(store.getSnapshot()),
    t: ((key: ConvaxKey, values?: Record<string, string | number>) =>
      en[key].replace(/\{(\w+)\}/g, (_match, name: string) => String(values?.[name] ?? ''))) as ChatProps['t'],
    useSessions: (selector: (value: object) => unknown) => selector({ byId: {} }),
    useWorkspaces: (selector: (value: object) => unknown) => selector({ items: [], archivedSessionIds: [] }),
    useSessionStatus: (selector: (value: object) => unknown) => selector(new Map()),
    useResource: () => ({ status: 'none', value: undefined, failure: undefined }),
  } as ChatProps
  return { props, createThread, ensureInitialThread, workspace, store, bindInput, renderFactorySlot }
}

describe('Convax Chat thread controls', () => {
  it('keeps an in-flight first-thread attempt out of every committed initialization notice', async () => {
    const b = fixture()
    const pending = Promise.withResolvers<CanvasThreadResult>()
    b.createThread.mockReturnValue(pending.promise)
    const notices: (string | null)[] = []
    function Observed() {
      const snapshot = useSyncExternalStore(subscriber => b.store.subscribe(subscriber), () => b.store.getSnapshot())
      const root = useRef<HTMLDivElement>(null)
      useLayoutEffect(() => { notices.push(root.current?.querySelector('[role="status"], [role="alert"]')?.textContent ?? null) })
      return <div ref={root}><ChatCard {...b.props} useStore={selector => selector(snapshot)} /></div>
    }
    render(<Observed />)
    expect(b.ensureInitialThread).toHaveBeenCalledOnce()
    expect(notices.length).toBeGreaterThan(0)
    expect(notices).toEqual(notices.map(() => null))
    await act(async () => { pending.resolve({ ok: false, code: 'operation-pending', message: 'pending', workspace: b.workspace }) })
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined()
  })

  it('retains resize controls while the first thread is creating and after its creation fails', async () => {
    const b = fixture()
    const pending = Promise.withResolvers<CanvasThreadResult>()
    b.createThread.mockReturnValue(pending.promise)
    const view = render(<ChatCard {...b.props} />)
    const grip = view.container.querySelector<HTMLButtonElement>('[data-convax-chat-resize]')!
    const body = grip.closest<HTMLElement>(`.${css.chatPendingBody}`)!
    Object.defineProperties(body, {
      offsetWidth: { configurable: true, value: 620 }, offsetHeight: { configurable: true, value: 240 },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect(0, 0, 620, 240) },
    })
    fireEvent.keyDown(grip, { key: 'ArrowRight' })
    expect(b.store.getSnapshot().sizes?.[chat.nodeId]).toEqual({ width: 630, height: 240 })
    await act(async () => { pending.resolve({ ok: false, code: 'operation-pending', message: 'pending', workspace: b.workspace }) })
    view.rerender(<ChatCard {...b.props} />)
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined()
    expect(view.container.querySelector<HTMLButtonElement>('[data-convax-chat-resize]')!).toBe(grip)
    Object.defineProperty(body, 'offsetWidth', { configurable: true, value: 630 })
    fireEvent.keyDown(grip, { key: 'ArrowDown' })
    expect(b.store.getSnapshot().sizes?.[chat.nodeId]).toEqual({ width: 630, height: 250 })
  })

  it.each(['loading', 'failed'] as const)('keeps the %s thread placeholder resizable', (status) => {
    const b = fixture()
    const resize = { preview: vi.fn(), commit: vi.fn(), label: 'Resize chat', help: 'Drag to resize' }
    const inputs = {
      sessionId: first, active: true, collapsed: false, resize,
      useResource: () => ({ status, value: undefined, failure: undefined }),
      layoutChanged: vi.fn(), t: b.props.t,
    } as ChatThreadProps
    const view = render(<ChatThread {...inputs} />)
    const grip = view.container.querySelector<HTMLButtonElement>('[data-convax-chat-resize]')!
    const body = grip.closest<HTMLElement>(`.${css.chatPendingBody}`)!
    Object.defineProperties(body, {
      offsetWidth: { configurable: true, value: 620 }, offsetHeight: { configurable: true, value: 240 },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect(0, 0, 620, 240) },
    })
    fireEvent.keyDown(grip, { key: 'ArrowDown' })
    expect(resize.commit).toHaveBeenCalledExactlyOnceWith({ width: 620, height: 250 })
    view.rerender(<ChatThread {...inputs} active={false} />)
    expect(view.container.querySelector('[data-convax-chat-resize]')).toBeNull()
  })

  it('resizes a collapsed Chat width while retaining its saved expanded height', () => {
    const owner: CanvasChat = { ...chat, threads: [{ sessionId: first, parentSessionId: null, inheritedEventCount: 0 }] }
    const b = fixture(owner)
    b.store.actions.setSize(chat.nodeId, { width: 620, height: 480 })
    const view = render(<ChatCard {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse chat' }))
    view.rerender(<ChatCard {...b.props} />)
    const grip = view.container.querySelector<HTMLButtonElement>('[data-convax-chat-resize]')!
    const header = view.container.querySelector<HTMLElement>('[data-convax-chat-header]')!
    Object.defineProperties(header, {
      offsetWidth: { configurable: true, value: 620 }, offsetHeight: { configurable: true, value: 40 },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect(0, 0, 620, 40) },
    })
    fireEvent.keyDown(grip, { key: 'ArrowRight' })
    expect(b.store.getSnapshot().sizes?.[chat.nodeId]).toEqual({ width: 630, height: 480 })
    fireEvent.keyDown(grip, { key: 'ArrowDown' })
    expect(b.store.getSnapshot().sizes?.[chat.nodeId]).toEqual({ width: 630, height: 480 })
    fireEvent.click(screen.getByRole('button', { name: 'Expand chat' }))
    view.rerender(<ChatCard {...b.props} />)
    expect(view.container.querySelector<HTMLElement>('[data-convax-chat]')?.style.getPropertyValue('--dsh-convax-chat-view-height')).toBe('480px')
  })

  it('keeps the initially selected Host thread when an unsaved tab selection is reordered', () => {
    const owner: CanvasChat = {
      ...chat, threads: [first, second].map(sessionId => ({ sessionId, parentSessionId: null, inheritedEventCount: 0 })),
    }
    const b = fixture(owner)
    const view = render(<ChatCard {...b.props} />)
    expect(b.store.getSnapshot().selectedThreads[chat.nodeId]).toBeUndefined()
    expect(screen.getByRole('tab', { name: 'Thread 1' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Thread 2' }), { key: 'ArrowLeft', altKey: true })
    view.rerender(<ChatCard {...b.props} />)
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Thread 2', 'Thread 1'])
    expect(screen.getByRole('tab', { name: 'Thread 1' }).getAttribute('aria-selected')).toBe('true')
    expect(b.bindInput).toHaveBeenCalledOnce()
    expect(b.bindInput).toHaveBeenLastCalledWith(chat.nodeId, first)
    expect(b.props.acknowledgeCompletion).not.toHaveBeenCalled()
  })

  it('retains visited editors and their draft values when tabs are reordered without switching the current thread', () => {
    const owner: CanvasChat = {
      ...chat, threads: [first, second].map(sessionId => ({ sessionId, parentSessionId: null, inheritedEventCount: 0 })),
    }
    const b = fixture(owner)
    b.store.actions.selectThread(chat.nodeId, first)
    b.store.actions.selectThread(chat.nodeId, second)
    b.renderFactorySlot.mockImplementation((name, value) => {
      if (name !== 'convax.chat.thread') return null
      const thread = value as CanvasChatThreadOwner
      return <div hidden={!thread.active}><textarea aria-label={thread.sessionId} defaultValue="" /></div>
    })
    const view = render(<ChatCard {...b.props} />)
    const currentEditor = screen.getByRole('textbox', { name: second })
    const earlierEditor = screen.getByRole('textbox', { name: first, hidden: true })
    fireEvent.change(currentEditor, { target: { value: 'Draft remains in the second thread' } })
    fireEvent.change(earlierEditor, { target: { value: 'First thread draft' } })
    currentEditor.focus()
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Thread 2' }), { key: 'ArrowLeft', altKey: true })
    view.rerender(<ChatCard {...b.props} />)
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Thread 2', 'Thread 1'])
    expect(screen.getByRole('textbox', { name: second })).toBe(currentEditor)
    expect(screen.getByRole('textbox', { name: first, hidden: true })).toBe(earlierEditor)
    expect((currentEditor as HTMLTextAreaElement).value).toBe('Draft remains in the second thread')
    expect((earlierEditor as HTMLTextAreaElement).value).toBe('First thread draft')
    expect(b.store.getSnapshot().selectedThreads[chat.nodeId]).toBe(second)
    expect(b.props.acknowledgeCompletion).not.toHaveBeenCalled()
    expect(b.bindInput).toHaveBeenCalledOnce()
    expect(b.createThread).not.toHaveBeenCalled()
  })

  it('opens the first thread without a start button and does not duplicate initialization during Strict Mode or snapshot updates', async () => {
    const b = fixture()
    const pending = Promise.withResolvers<CanvasThreadResult>()
    b.createThread.mockReturnValue(pending.promise)
    const view = render(<StrictMode><ChatCard {...b.props} /></StrictMode>)
    await waitFor(() => { expect(b.ensureInitialThread).toHaveBeenCalledOnce() })
    expect(screen.queryByText('Create a thread to start a conversation')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'New thread' })).toHaveLength(1)
    view.rerender(<StrictMode><ChatCard {...b.props} canvasRevision={3} /></StrictMode>)
    expect(b.createThread).toHaveBeenCalledOnce()
    await act(async () => { pending.resolve({ ok: true, sessionId: first, workspace: b.workspace }) })
    expect(b.store.getSnapshot().threadAttempts[chat.nodeId]).toBeUndefined()
    const bound = { ...chat, threads: [{ sessionId: first, parentSessionId: null, inheritedEventCount: 0 }] }
    view.rerender(<StrictMode><ChatCard {...b.props} chat={bound} /></StrictMode>)
    expect(b.bindInput).toHaveBeenLastCalledWith(chat.nodeId, first)
    expect(b.renderFactorySlot).toHaveBeenCalledWith('convax.chat.thread', expect.objectContaining({ sessionId: first, active: true }))
    expect(b.ensureInitialThread).toHaveBeenCalledOnce()
  })

  it('keeps initialization notices hidden when the Host publishes the first thread before creation settles', async () => {
    const b = fixture()
    const pending = Promise.withResolvers<CanvasThreadResult>()
    b.createThread.mockReturnValue(pending.promise)
    const view = render(<ChatCard {...b.props} />)
    await waitFor(() => { expect(b.ensureInitialThread).toHaveBeenCalledOnce() })
    expect(b.store.getSnapshot().threadAttempts[chat.nodeId]).toBeDefined()
    const bound = { ...chat, threads: [{ sessionId: first, parentSessionId: null, inheritedEventCount: 0 }] }
    // Host notifications can expose the durable thread before the request's
    // Session-catalog refresh finishes.
    view.rerender(<ChatCard {...b.props} chat={bound} />)
    expect(screen.getByRole('tab', { name: 'Thread 1' })).toBeDefined()
    expect(screen.queryByText(en['chat.creating'])).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    await act(async () => { pending.resolve({ ok: true, sessionId: first, workspace: b.workspace }) })
    expect(b.store.getSnapshot().threadAttempts[chat.nodeId]).toBeUndefined()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('hides archived tabs and selects a remaining thread without altering Host bindings', () => {
    const owner: CanvasChat = {
      ...chat, threads: [first, second].map(sessionId => ({ sessionId, parentSessionId: null, inheritedEventCount: 0 })),
    }
    const b = fixture(owner)
    b.store.actions.selectThread(chat.nodeId, first)
    b.props.useWorkspaces = selector => selector({ phase: 'ready', state: 'idle', error: null, items: [], pinnedSessionIds: [], archivedSessionIds: [first] })
    render(<ChatCard {...b.props} />)
    expect(screen.getAllByRole('tab')).toHaveLength(1)
    expect(screen.getByRole('tab').getAttribute('aria-selected')).toBe('true')
    expect(b.bindInput).toHaveBeenLastCalledWith(chat.nodeId, second)
    expect(b.ensureInitialThread).not.toHaveBeenCalled()
    expect(owner.threads.map(thread => thread.sessionId)).toEqual([first, second])
    const mounted = b.renderFactorySlot.mock.calls.filter(([name]) => name === 'convax.chat.thread')
    expect(mounted.map(([, value]) => (value as CanvasChatThreadOwner).sessionId)).toEqual([second])
  })

  it('prepares a shared replacement when the last thread is archived and shows restored threads again', async () => {
    const owner: CanvasChat = { ...chat, threads: [{ sessionId: first, parentSessionId: null, inheritedEventCount: 0 }] }
    const b = fixture(owner)
    const view = render(<ChatCard {...b.props} />)
    expect(b.ensureInitialThread).not.toHaveBeenCalled()
    const pending = Promise.withResolvers<CanvasThreadResult>()
    b.createThread.mockReturnValue(pending.promise)
    b.props.useWorkspaces = selector => selector({ phase: 'ready', state: 'idle', error: null, items: [], pinnedSessionIds: [], archivedSessionIds: [first] })
    view.rerender(<ChatCard {...b.props} />)
    await waitFor(() => { expect(b.ensureInitialThread).toHaveBeenCalledOnce() })
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    await act(async () => { pending.resolve({ ok: true, sessionId: second, workspace: b.workspace }) })
    const updated = { ...owner, threads: [...owner.threads, { sessionId: second, parentSessionId: null, inheritedEventCount: 0 }] }
    view.rerender(<ChatCard {...b.props} chat={updated} />)
    expect(b.bindInput).toHaveBeenLastCalledWith(chat.nodeId, second)
    b.props.useWorkspaces = selector => selector({ phase: 'ready', state: 'idle', error: null, items: [], pinnedSessionIds: [], archivedSessionIds: [] })
    view.rerender(<ChatCard {...b.props} chat={updated} />)
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    expect(b.bindInput).toHaveBeenLastCalledWith(chat.nodeId, second)
    expect(b.ensureInitialThread).toHaveBeenCalledOnce()
  })

  it('passes remembered normal and expanded tool widths through the retained thread owner', () => {
    const owner: CanvasChat = { ...chat, threads: [{ sessionId: first, parentSessionId: null, inheritedEventCount: 0 }] }
    const b = fixture(owner)
    const view = render(<ChatCard {...b.props} />)
    expect(b.ensureInitialThread).not.toHaveBeenCalled()
    const thread = (): CanvasChatThreadOwner => b.renderFactorySlot.mock.calls.filter(([name]) => name === 'convax.chat.thread').at(-1)![1] as CanvasChatThreadOwner
    expect(thread().tools).toMatchObject({ width: 480, fullscreenWidth: 960 })
    thread().tools.resize.onCommit(700, false)
    view.rerender(<ChatCard {...b.props} />)
    expect(thread().tools).toMatchObject({ width: 700, fullscreenWidth: 960 })
    thread().tools.resize.onCommit(1040, true)
    view.rerender(<ChatCard {...b.props} />)
    expect(thread().tools).toMatchObject({ width: 700, fullscreenWidth: 1040 })
    expect(b.store.getSnapshot().toolWidths?.[chat.nodeId]).toEqual({ normal: 700, fullscreen: 1040 })
    expect(b.store.getSnapshot().sizes).toBeUndefined()
  })

  it('persists an unconfirmed creation and retries the original request after remounting', async () => {
    const b = fixture()
    b.createThread.mockResolvedValue({ ok: false, code: 'operation-pending', message: 'pending', workspace: b.workspace })
    const firstView = render(<ChatCard {...b.props} />)
    await waitFor(() => { expect(b.store.getSnapshot().threadAttempts[chat.nodeId]).toBeDefined() })
    const request = b.store.getSnapshot().threadAttempts[chat.nodeId]!
    expect(request).toMatchObject({ kind: 'create', canvasId: chat.canvasId, nodeId: chat.nodeId, expectedRevision: 2 })
    await waitFor(() => { expect(screen.getAllByRole('button', { name: 'New thread' })[0]!.hasAttribute('disabled')).toBe(true) })
    firstView.unmount()
    const restored = fixture()
    expect(restored.store.getSnapshot().threadAttempts[chat.nodeId]).toEqual(request)
    restored.createThread.mockResolvedValue({ ok: true, sessionId: first, workspace: restored.workspace })
    render(<ChatCard {...restored.props} />)
    expect(restored.ensureInitialThread).not.toHaveBeenCalled()
    expect(restored.createThread).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => { expect(restored.createThread).toHaveBeenCalledWith(request) })
    await waitFor(() => { expect(restored.store.getSnapshot().threadAttempts[chat.nodeId]).toBeUndefined() })
    expect(restored.store.getSnapshot().selectedThreads[chat.nodeId]).toBe(first)
  })

  it('selects threads locally and forks the selected actual Session identity', async () => {
    const owner: CanvasChat = {
      ...chat, threads: [first, second].map(sessionId => ({ sessionId, parentSessionId: null, inheritedEventCount: 0 })),
    }
    const b = fixture(owner)
    b.createThread.mockResolvedValue({ ok: false, code: 'operation-pending', message: 'pending', workspace: b.workspace })
    const releaseInput = vi.fn()
    b.bindInput.mockReturnValue(releaseInput)
    const view = render(<ChatCard {...b.props} />)
    expect(b.bindInput).toHaveBeenLastCalledWith(chat.nodeId, first)
    fireEvent.click(screen.getByRole('tab', { name: 'Thread 2' }))
    expect(b.store.getSnapshot().selectedThreads[chat.nodeId]).toBe(second)
    view.rerender(<ChatCard {...b.props} />)
    expect(screen.getByRole('tab', { name: 'Thread 2' }).getAttribute('aria-selected')).toBe('true')
    expect(releaseInput).toHaveBeenCalledOnce()
    expect(b.bindInput).toHaveBeenLastCalledWith(chat.nodeId, second)
    fireEvent.click(screen.getByRole('button', { name: 'Current thread actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fork thread' }))
    await waitFor(() => { expect(b.createThread).toHaveBeenCalledOnce() })
    expect(b.createThread.mock.calls[0]?.[0]).toMatchObject({ kind: 'fork', sourceSessionId: second })
  })

  it('creates a separate preset-selected thread in the owning Chat and retains its failed request for retry', async () => {
    const owner: CanvasChat = { ...chat, threads: [{ sessionId: first, parentSessionId: null, inheritedEventCount: 0 }] }
    const b = fixture(owner)
    b.props.useSessions = selector => selector({ phase: 'ready', projectionsBySession: {}, ids: [first], byId: {
      [first]: { id: first, displayTitle: 'Current thread', running: false, blank: false, updatedAt: 1,
        retainedBy: {}, cwd: '/project/current', projectionValues: { agentPreset: 'standard' } },
    } })
    b.createThread.mockResolvedValue({ ok: false, code: 'operation-pending', message: 'pending', workspace: b.workspace })
    const view = render(<ChatCard {...b.props} />)
    const thread = b.renderFactorySlot.mock.calls.find(([name]) => name === 'convax.chat.thread')![1] as CanvasChatThreadOwner
    await act(async () => {
      await expect(thread.onNewSessionWithPreset('ptc')).rejects.toThrow('Could not create the thread')
    })
    const request = b.store.getSnapshot().threadAttempts[chat.nodeId]!
    expect(request).toMatchObject({ kind: 'create', agentPreset: 'ptc', cwd: '/project/current', nodeId: chat.nodeId })
    expect(request).not.toHaveProperty('sourceSessionId')
    expect(b.props.focusSession).not.toHaveBeenCalled()
    expect(owner.threads.map(item => item.sessionId)).toEqual([first])
    view.unmount()

    const restored = fixture(owner)
    restored.createThread.mockResolvedValue({ ok: true, sessionId: second, workspace: restored.workspace })
    render(<ChatCard {...restored.props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => { expect(restored.createThread).toHaveBeenCalledExactlyOnceWith(request) })
    await waitFor(() => { expect(restored.store.getSnapshot().selectedThreads[chat.nodeId]).toBe(second) })
    expect(restored.store.getSnapshot().threadAttempts[chat.nodeId]).toBeUndefined()
  })

  it('keeps thread navigation in the header and card actions in the toolbar when the Chat collapses', () => {
    const owner: CanvasChat = {
      ...chat, threads: [first, second].map(sessionId => ({ sessionId, parentSessionId: null, inheritedEventCount: 0 })),
    }
    const b = fixture(owner)
    const view = render(<ChatCard {...b.props} />)
    const row = view.container.querySelector('[data-convax-chat-drag]')!
    expect(view.container.querySelectorAll('header')).toHaveLength(1)
    expect(screen.queryByText('Project chat')).toBeNull()
    for (const label of ['Collapse chat', 'New thread']) {
      expect(row.contains(screen.getByRole('button', { name: label }))).toBe(true)
    }
    const toolbar = screen.getByRole('toolbar', { name: 'Actions for Project chat' })
    for (const label of ['Focus this chat', 'Delete chat']) {
      expect(row.contains(screen.getByRole('button', { name: label }))).toBe(false)
      expect(within(toolbar).getByRole('button', { name: label })).toBeDefined()
    }
    expect(within(toolbar).queryByRole('button', { name: 'Conversation actions' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Chat actions' })).toBeNull()
    expect(row.contains(screen.getByRole('tab', { name: 'Thread 1' }))).toBe(true)
    expect(row.contains(screen.getByRole('tab', { name: 'Thread 2' }))).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse chat' }))
    view.rerender(<ChatCard {...b.props} />)
    expect(view.container.querySelector('[data-convax-chat-drag]')).toBe(row)
    expect(screen.getByRole('button', { name: 'Expand chat' }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('tab', { name: 'Thread 1' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New thread' })).toBeTruthy()
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Focus this chat' }))
    expect(b.props.focusNode).toHaveBeenCalledOnce()
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Delete chat' }))
    expect(b.props.remove).toHaveBeenCalledOnce()
  })

})


it.each(['deleting', 'not-found'] as const)('clears the old attempt after a late %s reply across Chat deletion and restoration', async (code) => {
  const owner: CanvasChat = { ...chat, threads: [{ sessionId: first, parentSessionId: null, inheritedEventCount: 0 }] }
  const b = fixture(owner)
  const pending = Promise.withResolvers<CanvasThreadResult>()
  b.createThread.mockReturnValueOnce(pending.promise)
  b.store.actions.selectThread(chat.nodeId, first)
  const original = render(<ChatCard {...b.props} />)
  fireEvent.click(screen.getByRole('button', { name: 'New thread' }))
  await waitFor(() => { expect(b.store.getSnapshot().threadAttempts[chat.nodeId]).toBeDefined() })
  original.unmount()
  const restored = fixture(owner, b.store)
  const view = render(<ChatCard {...restored.props} />)
  expect(screen.getByRole('button', { name: 'New thread' }).hasAttribute('disabled')).toBe(true)
  await act(async () => { pending.resolve({ ok: false, code, message: 'Original Chat was deleted', workspace: b.workspace }) })
  view.rerender(<ChatCard {...restored.props} />)
  expect(b.store.getSnapshot().threadAttempts[chat.nodeId]).toBeUndefined()
  expect(b.store.getSnapshot().selectedThreads[chat.nodeId]).toBe(first)
  expect(screen.getByRole('button', { name: 'New thread' }).hasAttribute('disabled')).toBe(false)
  expect(restored.ensureInitialThread).not.toHaveBeenCalled()
  expect(restored.createThread).not.toHaveBeenCalled()
})
