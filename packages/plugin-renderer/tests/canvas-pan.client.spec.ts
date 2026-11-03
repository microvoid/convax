// @vitest-environment jsdom
/** Forced viewport dragging owns its pointer sequence without consuming ordinary card gestures. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installCanvasPan } from '../src/client/canvas-pan.ts'

const disposers: Array<() => void> = []
afterEach(() => { disposers.splice(0).forEach((dispose) => { dispose() }); document.body.replaceChildren() })

function fixture(zoom = 0.5) {
  const root = document.createElement('div')
  const button = document.createElement('button')
  button.className = 'nodrag nopan nowheel'
  root.append(button)
  document.body.append(root)
  let viewport = { x: 10, y: 20, zoom }
  const setViewport = vi.fn((next: typeof viewport) => { viewport = next })
  let captured: number | undefined
  const capture = vi.fn((id: number) => { captured = id })
  const release = vi.fn((id: number) => { if (captured === id) captured = undefined })
  Object.defineProperties(root, {
    setPointerCapture: { value: capture },
    hasPointerCapture: { value: (id: number) => captured === id },
    releasePointerCapture: { value: release },
  })
  const onStart = vi.fn(() => { expect(root.hasAttribute('data-canvas-panning')).toBe(true) })
  const onEnd = vi.fn(() => {
    expect(root.hasAttribute('data-canvas-panning')).toBe(false)
    expect(captured).toBeUndefined()
  })
  const dispose = installCanvasPan(root, { getViewport: () => viewport, setViewport, onStart, onEnd })
  disposers.push(dispose)
  return { root, button, setViewport, capture, release, dispose, onStart, onEnd, viewport: () => viewport }
}

function pointer(target: Element, type: string, x = 100, y = 200, button = 0, pointerId = 7, pointerType = 'mouse'): Event {
  const event = new MouseEvent(type, { clientX: x, clientY: y, button, bubbles: true, cancelable: true })
  Object.defineProperties(event, { pointerId: { value: pointerId }, pointerType: { value: pointerType } })
  target.dispatchEvent(event)
  return event
}

function key(target: EventTarget, type: 'keydown' | 'keyup', key = ' ', options: KeyboardEventInit = {}): Event {
  const event = new KeyboardEvent(type, { key, code: key === ' ' ? 'Space' : key, bubbles: true, cancelable: true, ...options })
  target.dispatchEvent(event)
  return event
}

describe('Canvas forced viewport dragging', () => {
  it('moves in screen pixels across a nested card and suppresses its pointer, mouse, and click sequence', () => {
    const b = fixture()
    const cardPointer = vi.fn()
    const cardMouse = vi.fn()
    const cardClick = vi.fn()
    b.button.addEventListener('pointerdown', cardPointer)
    b.button.addEventListener('mousedown', cardMouse)
    b.button.addEventListener('click', cardClick)
    expect(key(b.button, 'keydown').defaultPrevented).toBe(false)
    expect(b.root.hasAttribute('data-canvas-pan-ready')).toBe(true)
    expect(pointer(b.button, 'pointerdown').defaultPrevented).toBe(true)
    expect(b.capture).toHaveBeenCalledExactlyOnceWith(7)
    expect(b.onStart).toHaveBeenCalledOnce()
    expect(b.root.hasAttribute('data-canvas-panning')).toBe(true)
    const mouse = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    b.button.dispatchEvent(mouse)
    expect(mouse.defaultPrevented).toBe(true)
    expect(cardPointer).not.toHaveBeenCalled()
    expect(cardMouse).not.toHaveBeenCalled()
    pointer(b.root, 'pointermove', 150, 230)
    expect(b.setViewport).toHaveBeenLastCalledWith({ x: 60, y: 50, zoom: 0.5 })
    pointer(b.root, 'pointerup', 160, 240)
    expect(b.setViewport).toHaveBeenLastCalledWith({ x: 70, y: 60, zoom: 0.5 })
    expect(b.root.hasAttribute('data-canvas-panning')).toBe(false)
    expect(b.release).toHaveBeenCalledExactlyOnceWith(7)
    expect(b.onEnd).toHaveBeenCalledOnce()
    const click = new MouseEvent('click', { detail: 1, bubbles: true, cancelable: true })
    b.button.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    expect(cardClick).not.toHaveBeenCalled()
    key(document, 'keyup')
    expect(b.root.hasAttribute('data-canvas-pan-ready')).toBe(false)
  })

  it('leaves a focused native button’s Space activation intact when no pointer drag starts', () => {
    const b = fixture()
    const click = vi.fn()
    b.button.addEventListener('click', click)
    b.button.focus()
    expect(key(b.button, 'keydown').defaultPrevented).toBe(false)
    expect(b.root.hasAttribute('data-canvas-pan-ready')).toBe(true)
    expect(key(b.button, 'keyup').defaultPrevented).toBe(false)
    b.button.dispatchEvent(new MouseEvent('click', { detail: 0, bubbles: true, cancelable: true }))
    expect(click).toHaveBeenCalledOnce()
    expect(b.capture).not.toHaveBeenCalled()
  })

  it('prevents Space keyup activation after panning even when the pointer click has already been suppressed', () => {
    const b = fixture()
    const click = vi.fn()
    const releaseKey = vi.fn()
    b.button.addEventListener('click', click)
    b.button.addEventListener('keyup', releaseKey)
    b.button.focus()
    expect(key(b.button, 'keydown').defaultPrevented).toBe(false)
    pointer(b.button, 'pointerdown')
    pointer(b.root, 'pointermove', 120, 230)
    pointer(b.root, 'pointerup', 120, 230)
    const pointerClick = new MouseEvent('click', { detail: 1, bubbles: true, cancelable: true })
    b.button.dispatchEvent(pointerClick)
    expect(pointerClick.defaultPrevented).toBe(true)
    expect(key(b.button, 'keyup').defaultPrevented).toBe(true)
    expect(click).not.toHaveBeenCalled()
    expect(releaseKey).not.toHaveBeenCalled()
    expect(b.root.hasAttribute('data-canvas-pan-ready')).toBe(false)
  })

  it('leaves a custom button’s keyboard activation with its own handler', () => {
    const b = fixture()
    const custom = document.createElement('div')
    custom.setAttribute('role', 'button')
    custom.tabIndex = 0
    b.root.append(custom)
    const activate = vi.fn()
    custom.addEventListener('keydown', activate)
    custom.focus()
    expect(key(custom, 'keydown').defaultPrevented).toBe(false)
    expect(activate).toHaveBeenCalledOnce()
    expect(b.root.hasAttribute('data-canvas-pan-ready')).toBe(false)
    expect(pointer(custom, 'pointerdown').defaultPrevented).toBe(false)
    expect(b.capture).not.toHaveBeenCalled()
  })

  it('allows middle-button panning from an editor and prevents the resulting auxiliary click', () => {
    const b = fixture(2)
    const input = document.createElement('textarea')
    b.root.append(input)
    input.focus()
    expect(pointer(input, 'pointerdown', 100, 200, 1).defaultPrevented).toBe(true)
    pointer(b.root, 'pointermove', 120, 250, 1)
    expect(b.setViewport).toHaveBeenCalledExactlyOnceWith({ x: 30, y: 70, zoom: 2 })
    pointer(b.root, 'pointerup', 120, 250, 1)
    expect(b.setViewport).toHaveBeenCalledOnce()
    const aux = new MouseEvent('auxclick', { button: 1, detail: 1, bubbles: true, cancelable: true })
    input.dispatchEvent(aux)
    expect(aux.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(input)
  })

  it.each([
    ['left', 0, 'mouse'], ['right', 2, 'mouse'], ['touch', 0, 'touch'],
  ] as const)('leaves an ordinary %s gesture with the card', (_name, button, pointerType) => {
    const b = fixture()
    const native = vi.fn()
    b.button.addEventListener('pointerdown', native)
    const down = pointer(b.button, 'pointerdown', 100, 200, button, 7, pointerType)
    pointer(b.button, 'pointermove', 200, 300, button, 7, pointerType)
    pointer(b.button, 'pointerup', 200, 300, button, 7, pointerType)
    expect(native).toHaveBeenCalledOnce()
    expect(down.defaultPrevented).toBe(false)
    expect(b.capture).not.toHaveBeenCalled()
    expect(b.setViewport).not.toHaveBeenCalled()
    expect(b.onStart).not.toHaveBeenCalled()
    expect(b.onEnd).not.toHaveBeenCalled()
  })

  it.each(['input', 'textarea', 'select', 'contenteditable', 'textbox'])('preserves Space editing inside %s', (kind) => {
    const b = fixture()
    const editor = document.createElement(['input', 'textarea', 'select'].includes(kind) ? kind : 'div')
    editor.tabIndex = 0
    if (kind === 'contenteditable') editor.setAttribute('contenteditable', 'true')
    if (kind === 'textbox') editor.setAttribute('role', 'textbox')
    b.root.append(editor)
    editor.focus()
    expect(key(editor, 'keydown').defaultPrevented).toBe(false)
    expect(b.root.hasAttribute('data-canvas-pan-ready')).toBe(false)
    expect(pointer(editor, 'pointerdown').defaultPrevented).toBe(false)
    expect(pointer(b.button, 'pointerdown').defaultPrevented).toBe(false)
    expect(b.capture).not.toHaveBeenCalled()
  })

  it('does not enter the Space shortcut during composition or modified key presses', () => {
    const b = fixture()
    for (const options of [{ isComposing: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
      expect(key(b.button, 'keydown', ' ', options).defaultPrevented).toBe(false)
      expect(b.root.hasAttribute('data-canvas-pan-ready')).toBe(false)
      pointer(b.button, 'pointerdown')
    }
    expect(b.capture).not.toHaveBeenCalled()
  })

  it('keeps the started drag after Space release, then returns ordinary clicks to the card', () => {
    const b = fixture()
    key(document, 'keydown')
    pointer(b.button, 'pointerdown')
    key(document, 'keyup')
    pointer(b.root, 'pointermove', 120, 230)
    expect(b.setViewport).toHaveBeenLastCalledWith({ x: 30, y: 50, zoom: 0.5 })
    pointer(b.root, 'pointerup', 120, 230)
    expect(pointer(b.button, 'pointerdown').defaultPrevented).toBe(false)
    const click = new MouseEvent('click', { detail: 1, bubbles: true, cancelable: true })
    b.button.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(false)
  })

  it.each(['pointercancel', 'lostpointercapture', 'blur', 'resize', 'Escape', 'dispose'])('ends capture on %s without reverting the camera', (kind) => {
    const b = fixture()
    key(document, 'keydown')
    pointer(b.button, 'pointerdown')
    pointer(b.root, 'pointermove', 120, 230)
    if (kind === 'pointercancel' || kind === 'lostpointercapture') pointer(b.root, kind)
    else if (kind === 'Escape') key(document, 'keydown', 'Escape')
    else if (kind === 'dispose') b.dispose()
    else window.dispatchEvent(new Event(kind))
    expect(b.release).toHaveBeenCalledExactlyOnceWith(7)
    expect(b.onStart).toHaveBeenCalledOnce()
    expect(b.onEnd).toHaveBeenCalledOnce()
    expect(b.root.hasAttribute('data-canvas-panning')).toBe(false)
    pointer(b.root, 'pointermove', 300, 500)
    pointer(b.root, 'pointerup', 300, 500)
    expect(b.setViewport).toHaveBeenCalledExactlyOnceWith({ x: 30, y: 50, zoom: 0.5 })
  })

  it('ignores a second pointer without replacing the active viewport origin', () => {
    const b = fixture()
    key(document, 'keydown')
    pointer(b.button, 'pointerdown')
    pointer(b.button, 'pointerdown', 300, 400, 1, 8)
    pointer(b.root, 'pointermove', 300, 400, 1, 8)
    pointer(b.root, 'pointerup', 300, 400, 1, 8)
    expect(b.setViewport).not.toHaveBeenCalled()
    expect(b.release).not.toHaveBeenCalled()
    pointer(b.root, 'pointerup', 120, 230)
    expect(b.setViewport).toHaveBeenCalledExactlyOnceWith({ x: 30, y: 50, zoom: 0.5 })
    expect(b.capture).toHaveBeenCalledExactlyOnceWith(7)
  })

  it('releases keyboard and pointer listeners on disposal', () => {
    const b = fixture()
    key(document, 'keydown')
    expect(b.root.hasAttribute('data-canvas-pan-ready')).toBe(true)
    b.dispose()
    expect(b.root.hasAttribute('data-canvas-pan-ready')).toBe(false)
    key(document, 'keydown')
    expect(pointer(b.button, 'pointerdown', 100, 200, 1).defaultPrevented).toBe(false)
    expect(b.root.hasAttribute('data-canvas-pan-ready')).toBe(false)
    expect(b.capture).not.toHaveBeenCalled()
  })
})
