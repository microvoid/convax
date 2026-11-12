// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installNativeCanvasGestures, type NativeCanvasGestureActions } from '../src/client/native-canvas-gestures.ts'

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

function pointer(target: HTMLElement, type: string, x: number, y: number, pointerId = 1, pointerType = 'mouse'): void {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId, pointerType }))
}

function port(card: HTMLElement, type: 'source' | 'target', x: number, connectable: boolean): HTMLElement {
  const element = document.createElement('div')
  element.className = `react-flow__handle ${type} ${connectable ? 'connectable connectablestart connectableend' : ''}`
  Object.assign(element.dataset, { nodeid: card.dataset.id, handleid: type === 'source' ? 'output' : 'input',
    handlepos: type === 'source' ? 'right' : 'left' })
  card.append(element)
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(x - 4, 136, 8, 8))
  return element
}

function surface() {
  const root = document.createElement('div')
  const pane = document.createElement('div')
  pane.className = 'react-flow__pane'
  const card = document.createElement('div')
  card.className = 'react-flow__node'
  card.dataset.id = 'card'
  root.append(pane, card)
  document.body.append(root)
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600))
  const captured = new Set<number>()
  Object.defineProperties(root, {
    setPointerCapture: { value: (id: number) => { captured.add(id) } },
    hasPointerCapture: { value: (id: number) => captured.has(id) },
    releasePointerCapture: { value: (id: number) => { captured.delete(id) } },
  })
  let viewport = { x: 0, y: 0, zoom: 1 }
  const nodes: NativeCanvasGestureActions['nodes'][number][] = [
    { id: 'card', position: { x: 100, y: 100 }, measured: { width: 100, height: 80 } },
  ]
  const actions = {
    active: true, nodesDraggable: true, nodesConnectable: true, dragSelects: true, minZoom: 0.15, maxZoom: 2,
    nodes,
    getViewport: () => viewport,
    setViewport: (next) => { viewport = next },
    endViewport: vi.fn(), changeSelection: vi.fn(), clearPane: vi.fn(), clickNode: vi.fn(),
    startDrag: vi.fn(), moveDrag: vi.fn(), endDrag: vi.fn(),
    showMarquee: vi.fn(), startConnection: vi.fn(), moveConnection: vi.fn(), endConnection: vi.fn(),
  } satisfies NativeCanvasGestureActions
  const gestures = installNativeCanvasGestures(root, () => actions)
  dispose = gestures.dispose
  return { root, pane, card, gestures, actions, captured }
}

describe('Native canvas pointer gestures', () => {
  it('does not terminate a touch drag when capture moves from a child to the canvas', () => {
    const { card, actions, captured } = surface()
    pointer(card, 'pointerdown', 130, 130, 1, 'touch')
    pointer(card, 'pointermove', 150, 140, 1, 'touch')
    pointer(card, 'lostpointercapture', 150, 140, 1, 'touch')
    pointer(card, 'pointerup', 180, 170, 1, 'touch')
    expect(actions.startDrag).toHaveBeenCalledExactlyOnceWith('card', ['card'], expect.objectContaining({ type: 'pointermove' }))
    expect(actions.endDrag).toHaveBeenCalledExactlyOnceWith(new Map([['card', { x: 150, y: 140 }]]), false,
      expect.objectContaining({ type: 'pointerup' }))
    expect(captured.size).toBe(0)
  })

  it('cancels the pending node move when a second touch starts a pinch', () => {
    const { card, pane, actions, captured } = surface()
    pointer(card, 'pointerdown', 100, 120, 1, 'touch')
    pointer(card, 'pointermove', 120, 120, 1, 'touch')
    pointer(pane, 'pointerdown', 220, 120, 2, 'touch')
    pointer(pane, 'pointermove', 320, 120, 2, 'touch')
    pointer(pane, 'pointerup', 320, 120, 2, 'touch')
    pointer(card, 'pointerup', 120, 120, 1, 'touch')
    expect(actions.endDrag).toHaveBeenCalledExactlyOnceWith(new Map([['card', { x: 120, y: 100 }]]), true, expect.any(PointerEvent))
    expect(actions.getViewport()).toEqual({ x: -120, y: -120, zoom: 2 })
    expect(actions.endViewport).toHaveBeenCalledOnce()
    expect(actions.clearPane).not.toHaveBeenCalled()
    expect(captured.size).toBe(0)
  })

  it('keeps native controls out of selection and requires full bounds for a marquee', () => {
    const { card, pane, actions } = surface()
    const button = document.createElement('button')
    card.append(button)
    pointer(button, 'pointerdown', 120, 120)
    pointer(button, 'pointerup', 120, 120)
    expect(actions.changeSelection).not.toHaveBeenCalled()
    pointer(pane, 'pointerdown', 80, 80)
    pointer(pane, 'pointermove', 180, 190)
    expect(actions.changeSelection).toHaveBeenLastCalledWith([])
    pointer(pane, 'pointermove', 205, 190)
    pointer(pane, 'pointerup', 205, 190)
    expect(actions.changeSelection).toHaveBeenLastCalledWith(['card'])
    expect(actions.showMarquee).toHaveBeenLastCalledWith(null)
  })

  it('drags a settled marquee from the blank area between selected cards', () => {
    const { root, actions } = surface()
    actions.nodes.splice(0, 1,
      { id: 'card', position: { x: 100, y: 100 }, selected: true, dragHandle: '.card-header' },
      { id: 'second', position: { x: 300, y: 100 }, selected: true })
    const selection = document.createElement('div')
    selection.dataset.nativeCanvasSelection = ''
    root.append(selection)
    pointer(selection, 'pointerdown', 240, 140)
    pointer(selection, 'pointerup', 240, 140)
    expect(actions.changeSelection).not.toHaveBeenCalled()
    expect(actions.clickNode).not.toHaveBeenCalled()
    pointer(selection, 'pointerdown', 240, 140)
    pointer(selection, 'pointermove', 255, 170)
    pointer(selection, 'pointerup', 255, 170)
    expect(actions.startDrag).toHaveBeenCalledExactlyOnceWith('card', ['card', 'second'], expect.any(PointerEvent))
    expect(actions.endDrag).toHaveBeenCalledExactlyOnceWith(new Map([
      ['card', { x: 115, y: 130 }], ['second', { x: 315, y: 130 }],
    ]), false, expect.any(PointerEvent))
  })

  it('cancels an active port drag and ignores the remaining pointer events', () => {
    const { card, pane, actions, gestures, captured } = surface()
    const from = port(card, 'source', 200, true)
    pointer(from, 'pointerdown', 200, 140)
    pointer(pane, 'pointermove', 250, 140)
    gestures.cancelConnection()
    pointer(pane, 'pointermove', 300, 140)
    pointer(pane, 'pointerup', 300, 140)
    expect(actions.startConnection).toHaveBeenCalledOnce()
    expect(actions.moveConnection).toHaveBeenCalledOnce()
    expect(actions.endConnection).toHaveBeenCalledExactlyOnceWith(expect.any(PointerEvent),
      expect.objectContaining({ nodeId: 'card', portId: 'output', point: { x: 200, y: 140 } }), null, true)
    expect(captured.size).toBe(0)
  })

  it.each([true, false])('drops on the actual port and honors connectable=%s', (connectable) => {
    const { card, pane, actions, captured } = surface()
    const from = port(card, 'source', 200, true)
    const to = port(card, 'target', 400, connectable)
    const original = Object.getOwnPropertyDescriptor(document, 'elementFromPoint')
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => to })
    try {
      pointer(from, 'pointerdown', 200, 140)
      pointer(pane, 'pointermove', 250, 140)
      pointer(pane, 'pointerup', 400, 140)
      expect(actions.endConnection).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'pointerup' }),
        expect.objectContaining({ element: from }), connectable ? expect.objectContaining({ element: to }) : null, !connectable)
      expect(captured.size).toBe(0)
    } finally {
      if (original === undefined) Reflect.deleteProperty(document, 'elementFromPoint')
      else Object.defineProperty(document, 'elementFromPoint', original)
    }
  })
})
