// @vitest-environment jsdom
import { createRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatResizeHandle } from '../src/client/ChatResizeHandle.tsx'
import type { ChatResizeControls } from '../src/client/props.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function fixture() {
  const observers: FixtureResizeObserver[] = []
  class FixtureResizeObserver implements ResizeObserver {
    readonly targets = new Set<Element>()
    readonly observe = vi.fn((target: Element) => { this.targets.add(target) })
    readonly unobserve = vi.fn((target: Element) => { this.targets.delete(target) })
    readonly disconnect = vi.fn(() => { this.targets.clear() })
    constructor(private readonly callback: ResizeObserverCallback) { observers.push(this) }
    notify(): void { this.callback([], this) }
  }
  vi.stubGlobal('ResizeObserver', FixtureResizeObserver)
  const container = createRef<HTMLDivElement>()
  const actions = {
    label: 'Resize chat', help: 'Drag to resize or use the arrow keys',
    preview: vi.fn<ChatResizeControls['preview']>(),
    commit: vi.fn<ChatResizeControls['commit']>(),
  }
  const view = render(<div ref={container}>
    <div data-conversation-scroll="" />
    <ChatResizeHandle container={container} actions={actions} label={actions.label} help={actions.help} />
  </div>)
  const root = container.current
  const scroll = root?.querySelector<HTMLElement>('[data-conversation-scroll]')
  if (root === null || scroll == null) throw new Error('Expected the mounted Conversation container and scrollport')
  Object.defineProperties(root, {
    offsetWidth: { configurable: true, value: 620 },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect(100, 200, 310, 400) },
  })
  Object.defineProperties(scroll, {
    offsetHeight: { configurable: true, value: 360 },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect(100, 240, 310, 180) },
  })
  const observer = observers.find(candidate => candidate.targets.has(root))
  if (observer === undefined) throw new Error('Expected the resize grip to observe its own Conversation')
  act(() => { observer.notify() })
  const grip = screen.getByRole('button', { name: actions.label })
  let captured: number | undefined
  const pointerCapture = {
    setPointerCapture: vi.fn((id: number) => { captured = id }),
    hasPointerCapture: vi.fn((id: number) => captured === id),
    releasePointerCapture: vi.fn((id: number) => { if (captured === id) captured = undefined }),
  }
  for (const [name, value] of Object.entries(pointerCapture)) {
    Object.defineProperty(grip, name, { configurable: true, value })
  }
  return { ...view, actions, grip, root, scroll, observer, pointerCapture }
}

function pointer(target: HTMLElement, type: string, x: number, y: number, pointerId = 7): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })
  Object.defineProperties(event, {
    pointerId: { value: pointerId }, pointerType: { value: 'mouse' }, isPrimary: { value: true },
  })
  fireEvent(target, event)
}

describe('Convax Chat resize gestures', () => {
  it('previews at half zoom and commits the pointer-up dimensions once', () => {
    const b = fixture()
    pointer(b.grip, 'pointerdown', 410, 420)
    expect(b.grip.hasAttribute('data-resizing')).toBe(true)
    expect(b.pointerCapture.setPointerCapture).toHaveBeenCalledWith(7)
    pointer(b.grip, 'pointermove', 450, 440)
    expect(b.actions.preview).toHaveBeenLastCalledWith({ width: 700, height: 400 })
    expect(b.actions.commit).not.toHaveBeenCalled()
    pointer(b.grip, 'pointerup', 470, 450)
    expect(b.grip.hasAttribute('data-resizing')).toBe(false)
    expect(b.actions.commit).toHaveBeenCalledExactlyOnceWith({ width: 740, height: 420 })
    expect(b.actions.preview).toHaveBeenLastCalledWith(null)
    expect(b.pointerCapture.releasePointerCapture).toHaveBeenCalledWith(7)
    const previews = b.actions.preview.mock.calls.length
    pointer(b.grip, 'pointermove', 500, 500)
    pointer(b.grip, 'pointerup', 500, 500)
    expect(b.actions.preview).toHaveBeenCalledTimes(previews)
    expect(b.actions.commit).toHaveBeenCalledOnce()
  })

  it('does not save a press and release without pointer displacement', () => {
    const b = fixture()
    pointer(b.grip, 'pointerdown', 100, 100)
    expect(b.actions.commit).not.toHaveBeenCalled()
    pointer(b.grip, 'pointerup', 100, 100)
    expect(b.actions.commit).not.toHaveBeenCalled()
    expect(b.actions.preview).toHaveBeenCalledExactlyOnceWith(null)
    expect(b.pointerCapture.releasePointerCapture).toHaveBeenCalledWith(7)
  })

  it('ignores another pointer without replacing the captured gesture', () => {
    const b = fixture()
    pointer(b.grip, 'pointerdown', 100, 100)
    pointer(b.grip, 'pointerdown', 200, 200, 8)
    pointer(b.grip, 'pointermove', 300, 300, 8)
    pointer(b.grip, 'pointerup', 300, 300, 8)
    expect(b.actions.preview).not.toHaveBeenCalled()
    expect(b.actions.commit).not.toHaveBeenCalled()
    pointer(b.grip, 'pointerup', 110, 120)
    expect(b.actions.commit).toHaveBeenCalledExactlyOnceWith({ width: 640, height: 400 })
    expect(b.pointerCapture.setPointerCapture).toHaveBeenCalledExactlyOnceWith(7)
  })

  it.each(['pointercancel', 'lostpointercapture'])('restores the saved dimensions after %s without committing', (event) => {
    const b = fixture()
    pointer(b.grip, 'pointerdown', 100, 100)
    pointer(b.grip, 'pointermove', 120, 130)
    expect(b.actions.preview).toHaveBeenLastCalledWith({ width: 660, height: 420 })
    pointer(b.grip, event, 120, 130)
    expect(b.grip.hasAttribute('data-resizing')).toBe(false)
    expect(b.actions.preview).toHaveBeenLastCalledWith(null)
    pointer(b.grip, 'pointerup', 120, 130)
    expect(b.actions.commit).not.toHaveBeenCalled()
  })

  it('releases capture and preview on unmount without saving an unfinished gesture', () => {
    const b = fixture()
    expect(b.observer.observe).toHaveBeenCalledWith(b.root)
    expect(b.observer.observe).toHaveBeenCalledWith(b.scroll)
    pointer(b.grip, 'pointerdown', 100, 100)
    pointer(b.grip, 'pointermove', 120, 130)
    b.unmount()
    expect(b.pointerCapture.releasePointerCapture).toHaveBeenCalledWith(7)
    expect(b.observer.disconnect).toHaveBeenCalledOnce()
    expect(b.observer.targets.size).toBe(0)
    expect(b.actions.preview).toHaveBeenLastCalledWith(null)
    expect(b.actions.commit).not.toHaveBeenCalled()
  })

  it.each([
    ['ArrowLeft', false, { width: 610, height: 360 }],
    ['ArrowRight', false, { width: 630, height: 360 }],
    ['ArrowUp', false, { width: 620, height: 350 }],
    ['ArrowDown', false, { width: 620, height: 370 }],
    ['ArrowRight', true, { width: 630, height: 360 }],
  ] as const)('resizes with %s and Shift=%s in canvas pixels', (key, shiftKey, expected) => {
    const b = fixture()
    fireEvent.keyDown(b.grip, { key, shiftKey })
    expect(b.actions.commit).toHaveBeenCalledExactlyOnceWith(expected)
    expect(b.actions.preview).not.toHaveBeenCalled()
    fireEvent.keyDown(b.grip, { key: 'Enter' })
    expect(b.actions.commit).toHaveBeenCalledOnce()
  })
})
