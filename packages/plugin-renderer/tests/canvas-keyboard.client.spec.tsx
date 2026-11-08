import { defaultNodeCreations, defaultNodePresentation } from '@deepseek-ai/dsh-convax-plugin-inernal-nodes-renderer/client'
// @vitest-environment jsdom
/** Keyboard edits go through Host commands while embedded editors keep native keys. */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CanvasGroupId, CanvasId, CanvasNodeId, CanvasNodeTypeId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { CanvasGraph, type CanvasGraphProps } from '../src/client/CanvasGraph.tsx'
import { resolveCanvasKeyboardAction } from '../src/client/canvas-keyboard.ts'
import { en, type ConvaxKey } from '../src/client/locales.ts'

const FIRST = 'first' as CanvasNodeId
const SECOND = 'second' as CanvasNodeId
const TYPE = 'fixture.file' as CanvasNodeTypeId

const observers: ControlledResizeObserver[] = []
class ControlledResizeObserver implements ResizeObserver {
  readonly targets = new Set<Element>()
  constructor(private readonly callback: ResizeObserverCallback) { observers.push(this) }
  observe(target: Element): void { this.targets.add(target) }
  unobserve(target: Element): void { this.targets.delete(target) }
  disconnect(): void { this.targets.clear() }
  deliver(target: Element): void {
    const contentRect = target.getBoundingClientRect()
    const size = { inlineSize: contentRect.width, blockSize: contentRect.height }
    this.callback([{ target, contentRect, borderBoxSize: [size], contentBoxSize: [size], devicePixelContentBoxSize: [size] }], this)
  }
}

beforeEach(() => {
  observers.length = 0
  vi.stubGlobal('ResizeObserver', ControlledResizeObserver)
  vi.stubGlobal('DOMMatrixReadOnly', class { readonly m22 = 1 })
  const sizeOf = (element: HTMLElement) => element.classList.contains('react-flow__node')
    ? { width: 160, height: 80 } : { width: 900, height: 700 }
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) { return sizeOf(this).width })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return sizeOf(this).height })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(700)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const size = sizeOf(this)
    return new DOMRect(0, 0, size.width, size.height)
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function fixture(grouped = false) {
  const command = vi.fn<CanvasGraphProps['command']>(async () => true)
  const props: CanvasGraphProps = {
    document: {
      id: 'keyboard-canvas' as CanvasId, title: 'Board', revision: 1, connections: [],
      ...(grouped ? { groups: [{ id: 'group' as CanvasGroupId, title: 'References' }] } : {}),
      nodes: [FIRST, SECOND].map((id, index) => ({
        id, typeId: TYPE, dataVersion: 1, data: {}, ...(grouped ? { groupId: 'group' as CanvasGroupId } : {}), position: { x: 40 + index * 300, y: 40 }, revision: 1,
      })),
    },
    chats: [], nodeTypes: [{ id: TYPE, dataVersion: 1, ports: [] }], nodeIssues: [],
    renderSlot: () => <article>Reference<input className="nodrag nopan nowheel" aria-label="File notes" /></article>,
    history: { canUndo: false, canRedo: false, pending: false }, replayHistory: vi.fn(),
    chatPresentations: {}, applyChatPresentation: vi.fn(), applyResourceView: vi.fn(),
    resourceViews: {}, setResourceExpanded: vi.fn(), setResourcePreviewSize: vi.fn(),
    createChat: vi.fn(), captureConnectionTarget: origin => origin, reportClipboard: vi.fn(), addProject: vi.fn(),
    threadFocus: undefined, consumeThreadFocus: vi.fn(),
    t: ((key: ConvaxKey) => en[key]) as CanvasGraphProps['t'],
    busy: false, viewport: { x: 0, y: 0, zoom: 1 }, setViewport: vi.fn(),
    command, openResource: vi.fn(), openSource: vi.fn(), resolveFilePath: vi.fn(), addResources: vi.fn(),
    inputMode: 'mouse', setInputMode: vi.fn(),
  }
  const view = render(<CanvasGraph {...props} creations={defaultNodeCreations(props.t)} rendererDefinitions={defaultNodePresentation} />)
  const wrappers = [...view.container.querySelectorAll<HTMLElement>('.react-flow__node')]
  await waitFor(() => { expect(wrappers.every(node => observers.some(observer => observer.targets.has(node)))).toBe(true) })
  act(() => { for (const node of wrappers) observers.find(observer => observer.targets.has(node))!.deliver(node) })
  const node = (id = FIRST) => view.container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!
  const graph = view.container.querySelector<HTMLElement>('[data-convax-graph]')!
  const press = (key: string, options: KeyboardEventInit = {}, target: Element = document.body) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...options })
    fireEvent(target, event)
    return event
  }
  const pointer = (target: Element | Window, type: string, x: number, y: number): void => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === 'mouseup' ? 0 : 1, clientX: x, clientY: y })
    // Vitest's jsdom Window proxy cannot pass jsdom 29's UIEvent constructor conversion.
    Object.defineProperty(event, 'view', { value: graph.ownerDocument.defaultView })
    fireEvent(target, event)
  }
  return { view, props, command, node, graph, press, pointer }
}

describe('Canvas keyboard actions', () => {
  it('commits arrow-key moves once through the Host instead of React Flow local state', async () => {
    const b = await fixture()
    fireEvent.click(b.node())
    b.node().focus()
    expect(b.press('ArrowRight', {}, b.node()).defaultPrevented).toBe(true)
    expect(b.command).toHaveBeenCalledExactlyOnceWith({ kind: 'move-nodes', nodes: [{ id: FIRST, position: { x: 45, y: 40 } }] })
    await act(async () => {})
    b.view.rerender(<CanvasGraph {...b.props} document={{ ...b.props.document, revision: 2, nodes: b.props.document.nodes.map(node =>
      node.id === FIRST ? { ...node, position: { x: 45, y: 40 }, revision: 2 } : node) }} />)
    expect(b.node().style.transform).toBe('translate(45px,40px)')
    b.press('ArrowDown', { shiftKey: true }, b.node())
    expect(b.command).toHaveBeenLastCalledWith({ kind: 'move-nodes', nodes: [{ id: FIRST, position: { x: 45, y: 45 } }] })
  })

  it('selects the whole graph, moves selected nodes together, and clears it with Escape', async () => {
    const b = await fixture()
    expect(b.press('a', { metaKey: true }).defaultPrevented).toBe(true)
    expect(b.view.container.querySelectorAll('.react-flow__node.selected')).toHaveLength(2)
    b.press('ArrowLeft')
    expect(b.command).toHaveBeenCalledExactlyOnceWith({ kind: 'move-nodes', nodes: [
      { id: FIRST, position: { x: 35, y: 40 } }, { id: SECOND, position: { x: 335, y: 40 } },
    ] })
    await act(async () => {})
    b.press('Escape')
    expect(b.view.container.querySelectorAll('.react-flow__node.selected')).toHaveLength(0)
    expect(b.press('Delete').defaultPrevented).toBe(false)
    expect(b.command).toHaveBeenCalledOnce()
  })

  it('deletes the selected nodes through the existing command and retains rejected selection', async () => {
    const b = await fixture()
    b.command.mockResolvedValueOnce(false)
    b.press('a', { ctrlKey: true })
    b.press('Backspace')
    expect(b.command).toHaveBeenCalledExactlyOnceWith({ kind: 'remove-nodes', nodeIds: [FIRST, SECOND] })
    await act(async () => {})
    expect(b.view.container.querySelectorAll('.react-flow__node.selected')).toHaveLength(2)
    b.press('Delete')
    await act(async () => {})
    expect(b.view.container.querySelectorAll('.react-flow__node.selected')).toHaveLength(0)
  })

  it('restores a rejected keyboard move and blocks overlapping keyboard mutations', async () => {
    const b = await fixture()
    let finish: (saved: boolean) => void = () => { throw new Error('Mutation not started') }
    const pending = new Promise<boolean>((resolve) => { finish = resolve })
    b.command.mockReturnValueOnce(pending)
    fireEvent.click(b.node())
    b.node().focus()
    b.press('ArrowRight', {}, b.node())
    b.press('ArrowRight', { repeat: true }, b.node())
    b.press('Delete', {}, b.node())
    expect(b.command).toHaveBeenCalledOnce()
    expect(b.node().style.transform).toBe('translate(45px,40px)')
    await act(async () => { finish(false); await pending })
    expect(b.node().style.transform).toBe('translate(40px,40px)')
    b.press('ArrowUp', {}, b.node())
    expect(b.command).toHaveBeenLastCalledWith({ kind: 'move-nodes', nodes: [{ id: FIRST, position: { x: 40, y: 35 } }] })
  })

  it('leaves native editing, IME composition, dialog and outside focus to their owners', async () => {
    const b = await fixture()
    fireEvent.click(b.node())
    const input = b.view.getAllByRole('textbox', { name: 'File notes' })[0]!
    input.focus()
    for (const key of ['ArrowRight', 'Backspace', 'Escape']) expect(b.press(key, {}, input).defaultPrevented).toBe(false)
    expect(b.press('a', { metaKey: true }, input).defaultPrevented).toBe(false)
    for (const key of ['c', 'v', 'd']) expect(b.press(key, { metaKey: true }, input).defaultPrevented).toBe(false)
    input.blur()
    for (const options of [{ isComposing: true }, { keyCode: 229 }]) {
      expect(b.press('Delete', options).defaultPrevented).toBe(false)
      expect(b.press('a', { ...options, metaKey: true }).defaultPrevented).toBe(false)
    }
    const dialog = document.createElement('div')
    dialog.role = 'dialog'
    dialog.tabIndex = 0
    b.graph.append(dialog)
    dialog.focus()
    expect(b.press('Delete', {}, dialog).defaultPrevented).toBe(false)
    expect(b.press('a', { ctrlKey: true }).defaultPrevented).toBe(false)
    const outside = document.createElement('button')
    b.view.container.append(outside)
    outside.focus()
    expect(b.press('Delete').defaultPrevented).toBe(false)
    expect(b.command).not.toHaveBeenCalled()
  })

  it('yields BODY-focused Escape and Delete to an active modal without changing canvas selection', async () => {
    const b = await fixture()
    fireEvent.click(b.node())
    b.node().focus()
    const close = vi.fn()
    const overlay = render(<Modal open title="Activity" closeLabel="Close activity" onClose={close}>
      <button type="button">Mark all as read</button>
    </Modal>)
    const focused = document.activeElement
    if (!(focused instanceof HTMLElement)) throw new Error('The Activity dialog did not take focus')
    focused.blur()
    expect(document.activeElement).toBe(document.body)
    expect(b.press('Delete').defaultPrevented).toBe(false)
    expect(b.node().classList.contains('selected')).toBe(true)
    expect(b.node().style.transform).toBe('translate(40px,40px)')
    expect(b.command).not.toHaveBeenCalled()
    expect(b.press('Escape').defaultPrevented).toBe(true)
    expect(close).toHaveBeenCalledOnce()
    expect(b.node().classList.contains('selected')).toBe(true)
    overlay.unmount()
    expect(b.press('Escape', {}, b.node()).defaultPrevented).toBe(true)
    expect(b.node().classList.contains('selected')).toBe(false)
    expect(b.command).not.toHaveBeenCalled()
  })

  it('keeps Copy native when preview text has a DOM selection', async () => {
    const b = await fixture()
    fireEvent.click(b.node())
    const article = b.node().querySelector('article')!
    const range = document.createRange()
    range.selectNodeContents(article)
    document.getSelection()?.removeAllRanges()
    document.getSelection()?.addRange(range)
    expect(document.getSelection()?.isCollapsed).toBe(false)
    expect(b.press('c', { metaKey: true }).defaultPrevented).toBe(false)
    expect(b.props.reportClipboard).not.toHaveBeenCalled()
    expect(b.command).not.toHaveBeenCalled()
    document.getSelection()?.removeAllRanges()
  })

  it('resolves zoom and clipboard shortcuts without intercepting unavailable history', async () => {
    const b = await fixture()
    for (const [key, kind] of [['+', 'zoom-in'], ['-', 'zoom-out'], ['0', 'fit']] as const) {
      expect(resolveCanvasKeyboardAction(new KeyboardEvent('keydown', { key, metaKey: true }), b.graph)).toEqual({ kind })
    }
    expect(resolveCanvasKeyboardAction(new KeyboardEvent('keydown', { key: '+', ctrlKey: true, shiftKey: true }), b.graph)).toEqual({ kind: 'zoom-in' })
    for (const [key, kind] of [['c', 'copy'], ['v', 'paste'], ['d', 'duplicate']] as const) {
      expect(resolveCanvasKeyboardAction(new KeyboardEvent('keydown', { key, metaKey: true }), b.graph)).toEqual({ kind })
    }
    expect(b.press('z', { metaKey: true }).defaultPrevented).toBe(false)
  })
})

describe('Canvas drag alignment', () => {
  it('shows a measured guide and persists the snapped position once after pointer release', async () => {
    const b = await fixture()
    const node = b.node()
    const view = node.ownerDocument.defaultView!
    fireEvent.click(node)
    b.pointer(node, 'mousedown', 40, 40)
    b.pointer(view, 'mousemove', 42, 40)
    b.pointer(view, 'mousemove', 337, 133)
    await waitFor(() => { expect(b.view.container.querySelector('[data-convax-snap-guide="x"]')?.getAttribute('data-coordinate')).toBe('340') })
    expect(node.style.transform).toBe('translate(340px,133px)')
    expect(b.command).not.toHaveBeenCalled()
    b.pointer(view, 'mouseup', 337, 133)
    expect(b.command).toHaveBeenCalledExactlyOnceWith({ kind: 'move-nodes', nodes: [{ id: FIRST, position: { x: 340, y: 133 } }] })
    expect(b.view.container.querySelector('[data-convax-snap-guide]')).toBeNull()
  })

  it('clears alignment and restores the original position when Escape cancels a drag', async () => {
    const b = await fixture()
    const node = b.node()
    const view = node.ownerDocument.defaultView!
    fireEvent.click(node)
    node.focus()
    b.pointer(node, 'mousedown', 40, 40)
    b.pointer(view, 'mousemove', 42, 40)
    b.pointer(view, 'mousemove', 337, 133)
    await waitFor(() => { expect(b.view.container.querySelector('[data-convax-snap-guide]')).not.toBeNull() })
    b.press('Escape', {}, node)
    expect(b.view.container.querySelector('[data-convax-snap-guide]')).toBeNull()
    expect(node.style.transform).toBe('translate(40px,40px)')
    b.pointer(view, 'mouseup', 337, 133)
    expect(b.command).not.toHaveBeenCalled()
  })
})

describe('Canvas context actions through the graph', () => {
  it('lets Escape close the menu before clearing selection even when focus is still on the canvas', async () => {
    const b = await fixture()
    fireEvent.click(b.node())
    b.node().focus()
    fireEvent.contextMenu(b.node(), { clientX: 50, clientY: 50 })
    expect(b.view.getByRole('menu')).toBeDefined()
    expect(b.node().classList.contains('selected')).toBe(true)
    b.node().focus()
    expect(b.node().classList.contains('selected')).toBe(true)
    b.press('ArrowRight', {}, b.node())
    expect(b.command).not.toHaveBeenCalled()
    expect(b.node().style.transform).toBe('translate(40px,40px)')
    expect(b.node().classList.contains('selected')).toBe(true)
    expect(b.press('Escape', {}, b.node()).defaultPrevented).toBe(true)
    expect(b.view.queryByRole('menu')).toBeNull()
    expect(b.node().classList.contains('selected')).toBe(true)
    b.press('Escape', {}, b.node())
    expect(b.node().classList.contains('selected')).toBe(false)
    expect(b.command).not.toHaveBeenCalled()
  })

  it('leaves graph edits suspended while a context menu is open without a focused row', async () => {
    const b = await fixture()
    fireEvent.click(b.node())
    const pane = b.view.container.querySelector<HTMLElement>('.react-flow__pane')!
    fireEvent.contextMenu(pane, { clientX: 700, clientY: 500 })
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    b.press('a', { metaKey: true })
    b.press('Delete')
    expect(b.view.container.querySelectorAll('.react-flow__node.selected')).toHaveLength(1)
    expect(b.command).not.toHaveBeenCalled()
    b.press('Escape')
    expect(b.view.queryByRole('menu')).toBeNull()
    expect(b.node().classList.contains('selected')).toBe(true)
  })

  it('targets an unselected node without replacing the existing selection', async () => {
    const b = await fixture()
    fireEvent.click(b.node())
    fireEvent.contextMenu(b.node(SECOND), { clientX: 350, clientY: 50 })
    expect(b.node().classList.contains('selected')).toBe(true)
    expect(b.node(SECOND).classList.contains('selected')).toBe(false)
    expect(b.graph.querySelector('[data-convax-context-menu]')?.getAttribute('data-target-count')).toBe('1')
    fireEvent.click(b.view.getByRole('menuitem', { name: 'Remove selected references' }))
    expect(b.command).toHaveBeenCalledExactlyOnceWith({ kind: 'remove-nodes', nodeIds: [SECOND] })
    await act(async () => {})
    expect(b.node().classList.contains('selected')).toBe(true)
  })

  it('creates at the blank right-click position and shares the existing native file picker', async () => {
    const b = await fixture()
    vi.mocked(b.props.resolveFilePath).mockImplementation(file => `/host/${file.name}`)
    const pane = b.view.container.querySelector<HTMLElement>('.react-flow__pane')!
    fireEvent.contextMenu(pane, { clientX: 700, clientY: 500 })
    fireEvent.click(b.view.getByRole('menuitem', { name: 'Add folder' }))
    expect(b.props.addProject).toHaveBeenCalledExactlyOnceWith({ x: 700, y: 500 })
    fireEvent.contextMenu(pane, { clientX: 650, clientY: 450 })
    fireEvent.click(b.view.getByRole('menuitem', { name: 'Add files' }))
    const pickers = b.view.container.querySelectorAll<HTMLInputElement>('input[type="file"]')
    expect(pickers).toHaveLength(1)
    fireEvent.change(pickers[0]!, { target: { files: [new File(['notes'], 'notes.txt')] } })
    expect(b.props.addResources).toHaveBeenCalledExactlyOnceWith([{ name: 'notes.txt', path: '/host/notes.txt' }], { x: 650, y: 450 })
  })

  it('uses the whole selection on blank space within its bounds and preserves native Chat context menus', async () => {
    const b = await fixture()
    b.press('a', { metaKey: true })
    const pane = b.view.container.querySelector<HTMLElement>('.react-flow__pane')!
    fireEvent.contextMenu(pane, { clientX: 250, clientY: 70 })
    expect(b.graph.querySelector('[data-convax-context-menu]')?.getAttribute('data-target-count')).toBe('2')
    fireEvent.keyDown(b.view.getByRole('menuitem', { name: 'Focus selection' }), { key: 'Escape' })
    expect(b.view.queryByRole('menu')).toBeNull()
    expect(b.view.container.querySelectorAll('.react-flow__node.selected')).toHaveLength(2)
    const body = document.createElement('article')
    body.dataset.convaxInputOwner = 'chat'
    b.node().append(body)
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 70 })
    fireEvent(body, event)
    expect(event.defaultPrevented).toBe(false)
    expect(b.view.queryByRole('menu')).toBeNull()
  })
})


describe('Canvas history controls', () => {
  it('routes history shortcuts and toolbar actions while preserving native editor undo', async () => {
    const b = await fixture()
    const props = { ...b.props, history: { canUndo: true, canRedo: true, pending: false } }
    b.view.rerender(<CanvasGraph {...props} />)
    expect(b.press('z', { metaKey: true }).defaultPrevented).toBe(true)
    expect(b.props.replayHistory).toHaveBeenLastCalledWith('undo')
    expect(b.press('z', { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true)
    expect(b.props.replayHistory).toHaveBeenLastCalledWith('redo')
    expect(b.press('y', { ctrlKey: true }).defaultPrevented).toBe(true)
    fireEvent.click(b.view.getByRole('button', { name: 'Undo' }))
    expect(b.props.replayHistory).toHaveBeenLastCalledWith('undo')
    const input = b.view.getAllByRole('textbox')[0]!
    input.focus()
    const calls = vi.mocked(b.props.replayHistory).mock.calls.length
    expect(b.press('z', { metaKey: true }, input).defaultPrevented).toBe(false)
    expect(b.press('z', { ctrlKey: true, shiftKey: true }, input).defaultPrevented).toBe(false)
    expect(b.props.replayHistory).toHaveBeenCalledTimes(calls)
    input.blur()
    b.view.rerender(<CanvasGraph {...props} history={{ ...props.history, pending: true }} />)
    expect(b.graph.getAttribute('data-convax-history-pending')).toBe('true')
    expect(b.view.getByRole('button', { name: 'Undo' }).hasAttribute('disabled')).toBe(true)
    expect(b.press('z', { metaKey: true }).defaultPrevented).toBe(false)
    expect(b.props.replayHistory).toHaveBeenCalledTimes(calls)
  })
})


describe('Canvas group interactions', () => {
  it('dismisses a preview before the same group title stops outside-pointer propagation', async () => {
    const b = await fixture(true)
    b.press('a', { metaKey: true })
    fireEvent.click(b.view.getByRole('button', { name: 'Group color' }))
    const panel = b.view.getByRole('dialog', { name: 'Group color' })
    fireEvent.pointerEnter(b.view.getByRole('radio', { name: 'Blue' }), { pointerType: 'mouse' })
    fireEvent.wheel(panel)
    expect(b.view.queryByRole('dialog', { name: 'Group color' })).toBe(panel)
    const title = b.view.container.querySelector<HTMLElement>('[data-convax-group-header="group"]')!
    Object.assign(title, { setPointerCapture: vi.fn(), hasPointerCapture: () => false, releasePointerCapture: vi.fn() })
    const down = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })
    Object.defineProperty(down, 'pointerId', { value: 1 })
    fireEvent(title, down)
    expect(b.view.queryByRole('dialog', { name: 'Group color' })).toBeNull()
    expect(b.view.container.querySelector('[data-convax-group="group"]')?.getAttribute('data-color')).toBe('default')
    expect(b.command).not.toHaveBeenCalled()
  })

  it('previews group color locally and cancels it when the canvas pans', async () => {
    const b = await fixture(true)
    b.press('a', { metaKey: true })
    fireEvent.click(b.view.getByRole('button', { name: 'Group color' }))
    fireEvent.pointerEnter(b.view.getByRole('radio', { name: 'Blue' }), { pointerType: 'mouse' })
    expect(b.view.container.querySelector('[data-convax-group="group"]')?.getAttribute('data-color')).toBe('blue')
    expect(b.command).not.toHaveBeenCalled()
    fireEvent.wheel(b.graph)
    expect(b.view.queryByRole('dialog', { name: 'Group color' })).toBeNull()
    expect(b.view.container.querySelector('[data-convax-group="group"]')?.getAttribute('data-color')).toBe('default')
    expect(b.command).not.toHaveBeenCalled()
  })

  it('closes an unchanged color without history and restores a failed color submission', async () => {
    const b = await fixture(true)
    b.press('a', { metaKey: true })
    fireEvent.click(b.view.getByRole('button', { name: 'Group color' }))
    fireEvent.click(b.view.getByRole('radio', { name: 'Default' }))
    await waitFor(() => { expect(b.view.queryByRole('dialog', { name: 'Group color' })).toBeNull() })
    expect(b.command).not.toHaveBeenCalled()
    const pending = Promise.withResolvers<boolean>()
    b.command.mockReturnValueOnce(pending.promise)
    fireEvent.click(b.view.getByRole('button', { name: 'Group color' }))
    fireEvent.click(b.view.getByRole('radio', { name: 'Pink' }))
    expect(b.command).toHaveBeenCalledExactlyOnceWith({ kind: 'set-group-color', groupIds: ['group'], color: 'pink' })
    expect(b.view.getAllByRole('radio').every(radio => radio.hasAttribute('disabled'))).toBe(true)
    await act(async () => { pending.resolve(false) })
    expect(b.view.queryByRole('dialog', { name: 'Group color' })).toBeNull()
    expect(b.view.container.querySelector('[data-convax-group="group"]')?.getAttribute('data-color')).toBe('default')
    expect(document.activeElement).toBe(b.view.container.querySelector('[data-convax-group-header="group"]'))
  })

  it.each(['revision', 'canvas', 'inactive'] as const)('cancels a grouped member drag when its %s changes', async (change) => {
    const b = await fixture(true)
    b.press('a', { metaKey: true })
    const node = b.node()
    const ownerWindow = node.ownerDocument.defaultView!
    fireEvent.click(node, { ctrlKey: true })
    b.pointer(node, 'mousedown', 40, 40)
    b.pointer(ownerWindow, 'mousemove', 42, 40)
    b.pointer(ownerWindow, 'mousemove', 140, 140)
    await waitFor(() => { expect(node.style.transform).not.toBe('translate(40px,40px)') })
    expect(b.command).not.toHaveBeenCalled()
    const added = { ...b.props.document.nodes[0]!, id: 'third' as CanvasNodeId, position: { x: 650, y: 40 } }
    const next = { ...b.props, active: change !== 'inactive', document: {
      ...b.props.document,
      ...(change === 'canvas' ? { id: 'other-canvas' as CanvasId } : {}),
      ...(change === 'revision' ? { revision: 2, nodes: [...b.props.document.nodes, added] } : {}),
    } }
    b.view.rerender(<CanvasGraph {...next} />)
    expect(node.style.transform).toBe('translate(40px,40px)')
    b.pointer(ownerWindow, 'mousemove', 170, 180)
    expect(node.style.transform).toBe('translate(40px,40px)')
    expect(b.view.container.querySelector('[data-convax-snap-guide]')).toBeNull()
    b.pointer(ownerWindow, 'mouseup', 170, 180)
    expect(b.command).not.toHaveBeenCalled()
  })

  it('groups a node selection with the shortcut and leaves native text inputs in control', async () => {
    const b = await fixture()
    b.press('a', { metaKey: true })
    expect(b.press('g', { metaKey: true }).defaultPrevented).toBe(true)
    expect(b.command.mock.calls[0]?.[0]).toMatchObject({ kind: 'group-nodes', group: { title: 'Group' }, nodeIds: [FIRST, SECOND] })
    await act(async () => {})
    const input = b.view.getAllByRole('textbox')[0]!
    input.focus()
    const calls = b.command.mock.calls.length
    expect(b.press('g', { metaKey: true }, input).defaultPrevented).toBe(false)
    expect(b.command).toHaveBeenCalledTimes(calls)
    input.blur()
    for (const kind of ['chat', 'terminal']) {
      const native = document.createElement('div')
      native.tabIndex = 0
      if (kind === 'chat') native.dataset.convaxInputOwner = 'chat'
      else native.className = 'xterm'
      b.graph.append(native); native.focus()
      expect(b.press('g', { metaKey: true }, native).defaultPrevented).toBe(false)
      expect(b.press('g', { ctrlKey: true, shiftKey: true }, native).defaultPrevented).toBe(false)
      expect(b.command).toHaveBeenCalledTimes(calls)
      native.remove()
    }
  })

  it('recognizes a full member selection as a group and submits one deduplicated move and ungroup', async () => {
    const b = await fixture(true)
    b.press('a', { metaKey: true })
    expect(b.view.container.querySelector('[data-convax-group="group"]')?.hasAttribute('data-selected')).toBe(true)
    expect(b.view.queryByRole('button', { name: 'Group selection' })).toBeNull()
    b.press('ArrowRight')
    expect(b.command).toHaveBeenCalledExactlyOnceWith({ kind: 'move-selection', nodeIds: [], groupIds: ['group'], delta: { x: 5, y: 0 } })
    await act(async () => {})
    b.press('g', { ctrlKey: true, shiftKey: true })
    expect(b.command).toHaveBeenLastCalledWith({ kind: 'ungroup', groupIds: ['group'] })
  })

  it('renames from the title and exposes explicit member removal without changing positions', async () => {
    const b = await fixture(true)
    const header = b.view.container.querySelector<HTMLElement>('[data-convax-group-header="group"]')!
    fireEvent.doubleClick(header)
    fireEvent.change(b.view.getByRole('textbox', { name: 'Group name' }), { target: { value: '  Research  ' } })
    fireEvent.click(b.view.getByRole('button', { name: 'Save' }))
    expect(b.command).toHaveBeenCalledExactlyOnceWith({ kind: 'rename-group', groupId: 'group', title: 'Research' })
    await act(async () => {})
    fireEvent.contextMenu(b.node(), { clientX: 50, clientY: 50 })
    fireEvent.click(b.view.getByRole('menuitem', { name: 'Remove from group' }))
    expect(b.command).toHaveBeenLastCalledWith({ kind: 'set-node-group', nodeIds: [FIRST], groupId: null })
    expect(b.node().style.transform).toBe('translate(40px,40px)')
  })
})
