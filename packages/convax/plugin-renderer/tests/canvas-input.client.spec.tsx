// @vitest-environment jsdom
/** Canvas gestures through React Flow's real wheel handlers and viewport rendering. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { CanvasId, CanvasNodeId, CanvasNodeTypeId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { CanvasGraph, type CanvasGraphProps } from '../src/client/CanvasGraph.tsx'
import type { CanvasInputMode } from '../src/client/input-mode.ts'
import { en, type ConvaxKey } from '../src/client/locales.ts'
import { RESOURCE_CARD_WIDTH } from '../src/client/placement.ts'

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

function renderFixture(mode: CanvasInputMode, overrides: Partial<CanvasGraphProps> = {}) {
  const setViewport = vi.fn<CanvasGraphProps['setViewport']>()
  const setInputMode = vi.fn<CanvasGraphProps['setInputMode']>()
  const props: CanvasGraphProps = {
    document: { id: 'canvas' as CanvasId, title: 'Board', revision: 0, nodes: [], connections: [] },
    chats: [], nodeTypes: [], nodeIssues: [], renderSlot: () => null,
    history: { canUndo: false, canRedo: false, pending: false }, replayHistory: vi.fn(),
    chatPresentations: {}, applyChatPresentation: vi.fn(), applyResourceView: vi.fn(),
    resourceViews: {}, setResourceExpanded: vi.fn(), setResourcePreviewSize: vi.fn(),
    createChat: vi.fn(), captureConnectionTarget: origin => origin, reportClipboard: vi.fn(), addProject: vi.fn(),
    threadFocus: undefined, consumeThreadFocus: vi.fn(),
    t: ((key: ConvaxKey) => en[key]) as CanvasGraphProps['t'],
    busy: false, viewport: { x: 0, y: 0, zoom: 1 }, setViewport,
    command: vi.fn(async () => true), openResource: vi.fn(), openSource: vi.fn(), resolveFilePath: vi.fn(), addResources: vi.fn(),
    inputMode: mode, setInputMode, ...overrides,
  }
  const view = render(<CanvasGraph {...props} />)
  const graph = view.container.querySelector<HTMLElement>('[data-convax-graph]')!
  const pane = view.container.querySelector<HTMLElement>('.react-flow__pane')!
  const viewport = view.container.querySelector<HTMLElement>('.react-flow__viewport')!
  const read = () => {
    const match = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([-\d.]+)\)/u.exec(viewport.style.transform)
    if (match === null) throw new Error('React Flow viewport has no rendered transform')
    return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) }
  }
  const wheel = (target: Element, options: WheelEventInit = {}) => {
    const event = new WheelEvent('wheel', {
      bubbles: true, cancelable: true, clientX: 400, clientY: 300, deltaMode: 0, deltaY: 80, ...options,
    })
    fireEvent(target, event)
    return event
  }
  return { view, graph, pane, viewport, read, wheel, setViewport, setInputMode, props }
}

async function fixture(mode: CanvasInputMode) {
  const b = renderFixture(mode)
  await waitFor(() => {
    expect(b.graph.hasAttribute('data-canvas-gestures-ready')).toBe(true)
    expect(b.viewport.style.transform).toContain('scale(1)')
  })
  return b
}

function revealFixture(zoom = 1, collapsed = false) {
  vi.useFakeTimers()
  vi.stubGlobal('DOMMatrixReadOnly', class { readonly m22 = 1 })
  const observations = new Map<Element, (entries: ResizeObserverEntry[]) => void>()
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly callback: (entries: ResizeObserverEntry[]) => void) {}
    observe(target: Element): void { observations.set(target, this.callback) }
    unobserve(target: Element): void { observations.delete(target) }
    disconnect(): void {}
  })
  const nodeId = 'automation-chat' as CanvasNodeId
  const typeId = 'convax.chat' as CanvasNodeTypeId
  const b = renderFixture('touchpad', {
    document: { id: 'canvas' as CanvasId, title: 'Saved automation board', revision: 2, connections: [], nodes: [{
      id: nodeId, typeId, dataVersion: 1, revision: 1,
      data: { title: 'Automation conversation', cwd: '/project' }, position: { x: 1200, y: 800 },
    }] },
    nodeTypes: [{ id: typeId, dataVersion: 1, ports: [] }],
    chatPresentations: { [nodeId]: { collapsed } },
    viewport: { x: 0, y: 0, zoom },
    threadFocus: { nodeId, sessionId: 'original-automation-thread' as SessionId },
    renderSlot: () => <div>Automation conversation</div>,
  })
  const node = b.view.container.querySelector<HTMLElement>(`.react-flow__node[data-id="${nodeId}"]`)!
  const measure = (width: number, height: number): void => {
    const notify = observations.get(node)
    if (notify === undefined) throw new Error('The real graph did not observe the conversation node')
    Object.defineProperty(node, 'offsetWidth', { configurable: true, get: () => width })
    Object.defineProperty(node, 'offsetHeight', { configurable: true, get: () => height })
    act(() => {
      notify([{ target: node, contentRect: new DOMRect(0, 0, width, height),
        borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }])
    })
  }
  return { ...b, nodeId, node, measure }
}

describe('Canvas input gestures', () => {
  it('reveals a conversation after its focus request is consumed before the real viewport finishes initializing', async () => {
    const b = revealFixture()
    expect(b.graph.hasAttribute('data-canvas-gestures-ready')).toBe(false)
    b.measure(800, 600)
    b.view.rerender(<CanvasGraph {...b.props} threadFocus={undefined} />)
    expect(b.graph.hasAttribute('data-canvas-gestures-ready')).toBe(false)
    expect(b.read()).toEqual({ x: 0, y: 0, zoom: 1 })
    // React Flow publishes onInit on its own timer; measurement and focus consumption precede that publication.
    await act(async () => { vi.advanceTimersByTime(1) })
    expect(b.graph.hasAttribute('data-canvas-gestures-ready')).toBe(true)
    await act(async () => { vi.advanceTimersToNextFrame() })
    const viewport = b.read()
    expect(viewport.zoom).toBeLessThan(1)
    expect((1200 + 800 / 2) * viewport.zoom + viewport.x).toBeCloseTo(400)
    expect((800 + 600 / 2) * viewport.zoom + viewport.y).toBeCloseTo(300)
    expect(b.node.getAttribute('data-convax-activity-highlight')).toBe('true')
    await act(async () => { vi.advanceTimersByTime(1500) })
    expect(b.node.hasAttribute('data-convax-activity-highlight')).toBe(false)
  })

  it('preserves the current zoom when the revealed conversation already fits', async () => {
    const b = revealFixture(0.5)
    b.measure(320, 240)
    b.view.rerender(<CanvasGraph {...b.props} threadFocus={undefined} />)
    await act(async () => { vi.advanceTimersByTime(1); vi.advanceTimersToNextFrame() })
    const viewport = b.read()
    expect(viewport.zoom).toBe(0.5)
    expect((1200 + 320 / 2) * viewport.zoom + viewport.x).toBeCloseTo(400)
    expect((800 + 240 / 2) * viewport.zoom + viewport.y).toBeCloseTo(300)
  })

  it('waits for expanded conversation dimensions before revealing a collapsed Chat', async () => {
    const b = revealFixture(0.5, true)
    b.measure(320, 60)
    b.view.rerender(<CanvasGraph {...b.props} threadFocus={undefined} chatPresentations={{ [b.nodeId]: { collapsed: false } }} />)
    await act(async () => { vi.advanceTimersByTime(1); vi.advanceTimersToNextFrame() })
    expect(b.read()).toEqual({ x: 0, y: 0, zoom: 0.5 })
    b.measure(320, 360)
    await act(async () => { vi.advanceTimersToNextFrame() })
    const viewport = b.read()
    expect(viewport.zoom).toBe(0.5)
    expect((1200 + 320 / 2) * viewport.zoom + viewport.x).toBeCloseTo(400)
    expect((800 + 360 / 2) * viewport.zoom + viewport.y).toBeCloseTo(300)
    expect(b.node.getAttribute('data-convax-activity-highlight')).toBe('true')
  })

  it('cancels a delayed activity reveal when the user interacts with the canvas', async () => {
    const b = revealFixture()
    b.view.rerender(<CanvasGraph {...b.props} threadFocus={undefined} />)
    fireEvent.pointerDown(b.graph, { button: 0, pointerId: 1 })
    b.measure(800, 600)
    await act(async () => { vi.advanceTimersByTime(1); vi.advanceTimersToNextFrame() })
    expect(b.read()).toEqual({ x: 0, y: 0, zoom: 1 })
    expect(b.node.hasAttribute('data-convax-activity-highlight')).toBe(false)
  })

  it('drops a delayed activity target when another canvas replaces its document', async () => {
    const b = revealFixture()
    b.measure(800, 600)
    b.view.rerender(<CanvasGraph {...b.props} threadFocus={undefined}
      document={{ id: 'another-canvas' as CanvasId, title: 'Other canvas', revision: 1, nodes: [], connections: [] }} />)
    await act(async () => { vi.advanceTimersByTime(1); vi.advanceTimersToNextFrame() })
    expect(b.read()).toEqual({ x: 0, y: 0, zoom: 1 })
    expect(b.view.container.querySelector('[data-convax-activity-highlight]')).toBeNull()
  })

  it('creates from the bottom dock inside a panned viewport while the dock stays outside its transform', async () => {
    const b = await fixture('touchpad')
    const dock = b.view.getByRole('button', { name: 'Add project' }).parentElement!
    expect(dock.closest('.react-flow__viewport')).toBeNull()
    b.wheel(b.pane, { deltaX: 130, deltaY: 210 })
    await waitFor(() => { expect(b.read().x).toBeLessThan(0) })
    fireEvent.click(b.view.getByRole('button', { name: 'Add project' }))
    const project = vi.mocked(b.props.addProject).mock.calls[0]![0]
    const transform = b.read()
    expect(project.x * transform.zoom + transform.x).toBeGreaterThanOrEqual(0)
    expect((project.x + RESOURCE_CARD_WIDTH) * transform.zoom + transform.x).toBeLessThanOrEqual(800)
    expect(project.y * transform.zoom + transform.y).toBeGreaterThanOrEqual(0)
    expect((project.y + 140) * transform.zoom + transform.y).toBeLessThan(488)
    fireEvent.click(b.view.getByRole('button', { name: 'New chat' }))
    expect(b.props.createChat).toHaveBeenCalledOnce()
    const chatPosition = vi.mocked(b.props.createChat).mock.calls[0]![2]!
    expect(Number.isFinite(chatPosition.x) && Number.isFinite(chatPosition.y)).toBe(true)
    expect(b.view.getByRole('button', { name: 'Add project' }).parentElement).toBe(dock)
  })

  it('passes selected native files to canvas intake without touching a conversation, including repeated selection', async () => {
    const b = await fixture('mouse')
    const files = [new File(['one'], 'one.txt'), new File(['two'], 'two.md')]
    vi.mocked(b.props.resolveFilePath).mockImplementation(file => `/host/${file.name}`)
    const picker = b.view.container.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.click(b.view.getByRole('button', { name: 'Add files' }))
    fireEvent.change(picker, { target: { files } })
    const [references, point] = vi.mocked(b.props.addResources).mock.calls[0]!
    expect(references).toEqual([
      { name: 'one.txt', path: '/host/one.txt' }, { name: 'two.md', path: '/host/two.md' },
    ])
    expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true)
    fireEvent.change(picker, { target: { files } })
    expect(b.props.addResources).toHaveBeenCalledTimes(2)
    expect(picker.value).toBe('')
  })

  it('moves both viewport axes without zooming for a two-finger scroll in Touchpad mode', async () => {
    const b = await fixture('touchpad')
    b.wheel(b.pane, { deltaX: 60, deltaY: 80 })
    await waitFor(() => {
      expect(b.read().x).toBeLessThan(0)
      expect(b.read().y).toBeLessThan(0)
      expect(b.read().zoom).toBe(1)
    })
    await waitFor(() => { expect(b.setViewport).toHaveBeenCalledWith(b.read()) })
  })

  it('keeps wheel scrolling as zoom in Mouse mode', async () => {
    const b = await fixture('mouse')
    b.wheel(b.pane)
    await waitFor(() => { expect(b.read().zoom).toBeLessThan(1) })
    await waitFor(() => { expect(b.setViewport).toHaveBeenCalled() })
  })

  it('keeps pinch-style Ctrl-wheel zooming in Touchpad mode', async () => {
    const b = await fixture('touchpad')
    b.wheel(b.pane, { ctrlKey: true, deltaY: -20 })
    await waitFor(() => { expect(b.read().zoom).toBeGreaterThan(1) })
    await waitFor(() => { expect(b.setViewport).toHaveBeenCalled() })
  })

  it('continues a real viewport pan across a nowheel card and saves once after the whole gesture', async () => {
    const b = await fixture('touchpad')
    vi.useFakeTimers()
    const card = document.createElement('section')
    card.className = 'nowheel nopan'
    card.style.overflowY = 'auto'
    Object.defineProperties(card, {
      clientHeight: { value: 100 }, scrollHeight: { value: 800 },
    })
    const native = vi.fn()
    card.addEventListener('wheel', native)
    b.pane.append(card)
    expect(b.wheel(b.pane, { deltaX: 20, deltaY: 40 }).defaultPrevented).toBe(true)
    expect(b.wheel(card, { deltaX: 20, deltaY: 40 }).defaultPrevented).toBe(true)
    expect(b.read()).toEqual({ x: -20, y: -40, zoom: 1 })
    expect(native).not.toHaveBeenCalled()
    expect(b.setViewport).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(250) })
    expect(b.setViewport).toHaveBeenCalledExactlyOnceWith(b.read())
    expect(b.view.container.querySelector('[data-convax-graph]')?.hasAttribute('data-canvas-wheel-owner')).toBe(false)
  })

  it('keeps native body scrolling and its edge in one gesture before a new pane pan', async () => {
    const b = await fixture('touchpad')
    vi.useFakeTimers()
    const body = document.createElement('div')
    body.style.overflowY = 'auto'
    Object.defineProperties(body, {
      clientHeight: { value: 100 }, scrollHeight: { value: 400 },
    })
    const native = vi.fn()
    body.addEventListener('wheel', native)
    b.pane.append(body)
    expect(b.wheel(body).defaultPrevented).toBe(false)
    body.scrollTop = 300
    expect(b.wheel(body).defaultPrevented).toBe(false)
    expect(b.wheel(b.pane).defaultPrevented).toBe(true)
    expect(b.read()).toEqual({ x: 0, y: 0, zoom: 1 })
    expect(body.scrollTop).toBe(300)
    expect(native).toHaveBeenCalledTimes(2)
    expect(b.setViewport).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(250) })
    b.wheel(b.pane)
    expect(b.read()).toEqual({ x: 0, y: -40, zoom: 1 })
    act(() => { vi.advanceTimersByTime(250) })
    expect(b.setViewport).toHaveBeenCalledExactlyOnceWith(b.read())
  })

  it('zooms the real viewport over embedded content without invoking its local zoom listener', async () => {
    const b = await fixture('touchpad')
    vi.useFakeTimers()
    const card = document.createElement('div')
    card.className = 'nowheel nopan'
    card.setAttribute('data-gesture-surface', 'content')
    const localZoom = vi.fn((event: WheelEvent) => { event.preventDefault() })
    card.addEventListener('wheel', localZoom)
    b.pane.append(card)
    expect(b.wheel(card, { ctrlKey: true, deltaY: -20 }).defaultPrevented).toBe(true)
    expect(localZoom).not.toHaveBeenCalled()
    const expected = 2 ** 0.4
    expect(b.read().zoom).toBeCloseTo(expected)
    expect(b.read().x).toBeCloseTo(400 * (1 - expected))
    expect(b.read().y).toBeCloseTo(300 * (1 - expected))
    act(() => { vi.advanceTimersByTime(250) })
    expect(b.setViewport).toHaveBeenCalledExactlyOnceWith(b.read())
  })

  it('retains the held Space gesture when a parent replaces the viewport persistence callback', async () => {
    const b = await fixture('touchpad')
    vi.useFakeTimers()
    const graph = b.view.container.querySelector('[data-convax-graph]')!
    fireEvent.keyDown(b.pane, { key: ' ', code: 'Space' })
    expect(graph.hasAttribute('data-canvas-pan-ready')).toBe(true)
    const persist = vi.fn<CanvasGraphProps['setViewport']>()
    b.view.rerender(<CanvasGraph {...b.props} setViewport={persist} />)
    expect(b.view.container.querySelector('[data-convax-graph]')).toBe(graph)
    expect(graph.hasAttribute('data-canvas-pan-ready')).toBe(true)
    fireEvent.keyUp(b.pane, { key: ' ', code: 'Space' })
    expect(graph.hasAttribute('data-canvas-pan-ready')).toBe(false)
    b.wheel(b.pane)
    act(() => { vi.advanceTimersByTime(250) })
    expect(b.setViewport).not.toHaveBeenCalled()
    expect(persist).toHaveBeenCalledExactlyOnceWith(b.read())
  })

  it('records the rendered viewport while navigating across a document and then scrolling and pinching it', async () => {
    const b = await fixture('touchpad')
    vi.useFakeTimers()
    const documentBody = document.createElement('section')
    documentBody.className = 'nowheel nopan'
    documentBody.style.overflowY = 'auto'
    Object.defineProperties(documentBody, {
      clientHeight: { value: 100 }, scrollHeight: { value: 800 },
    })
    const contentWheel = vi.fn()
    documentBody.addEventListener('wheel', contentWheel)
    b.pane.append(documentBody)
    const observe = (action: string, event: WheelEvent) => ({
      action, wheelConsumed: event.defaultPrevented,
      transform: b.viewport.style.transform,
      displayedZoom: b.view.getByRole('button', { name: 'Reset zoom to 100%' }).textContent,
      contentWheelCount: contentWheel.mock.calls.length,
    })
    const steps = [observe('Pan the canvas', b.wheel(b.pane, { deltaX: 40, deltaY: 60 })),
      observe('Continue over the document', b.wheel(documentBody, { deltaX: 20, deltaY: 40 }))]
    act(() => { vi.advanceTimersByTime(250) })
    steps.push(observe('Start scrolling the document', b.wheel(documentBody)))
    steps.push(observe('Pinch over the document', b.wheel(documentBody, { ctrlKey: true, deltaY: -20 })))
    act(() => { vi.advanceTimersByTime(250) })
    expect({ steps, savedViewportCount: b.setViewport.mock.calls.length }).toMatchSnapshot()
  })

  it('switches modes without replacing the viewport or an embedded editor, and leaves its wheel events local', async () => {
    const b = await fixture('touchpad')
    const chat = document.createElement('article')
    chat.dataset.convaxChat = 'chat'
    chat.className = 'nowheel'
    const editor = document.createElement('textarea')
    editor.value = 'Unsent thread draft'
    chat.append(editor)
    b.pane.append(chat)
    const original = b.read()
    b.wheel(editor, { deltaX: 30, deltaY: 50 })
    expect(b.read()).toEqual(original)
    expect(b.setViewport).not.toHaveBeenCalled()
    fireEvent.change(b.view.getByRole('combobox', { name: 'Canvas input mode' }), { target: { value: 'mouse' } })
    expect(b.setInputMode).toHaveBeenCalledExactlyOnceWith('mouse')
    b.view.rerender(<CanvasGraph {...b.props} inputMode="mouse" />)
    expect(b.view.container.querySelector('.react-flow__viewport')).toBe(b.viewport)
    expect(editor.isConnected).toBe(true)
    expect(editor.value).toBe('Unsent thread draft')
    b.wheel(editor)
    expect(b.read()).toEqual(original)
    expect(b.setViewport).not.toHaveBeenCalled()
    b.wheel(b.pane)
    expect(b.read()).toEqual(original)
    expect(b.setViewport).not.toHaveBeenCalled()
    fireEvent.pointerDown(b.pane, { button: 0 })
    b.wheel(b.pane)
    await waitFor(() => { expect(b.read().zoom).toBeLessThan(1) })
    await waitFor(() => { expect(b.setViewport).toHaveBeenCalled() })
  })
})
