// @vitest-environment jsdom
/** Wheel ownership survives targets moving beneath a gesture and preserves native content controls. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Viewport } from '@xyflow/react'
import { installCanvasWheel } from '../src/client/canvas-wheel.ts'

const cleanups: Array<() => void> = []

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => { callback(performance.now()) }, 16))
  vi.stubGlobal('cancelAnimationFrame', (handle: ReturnType<typeof setTimeout>) => { clearTimeout(handle) })
})
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function fixture(mode: 'touchpad' | 'mouse' = 'touchpad', initial: Viewport = { x: 10, y: 20, zoom: 1 }) {
  const root = document.createElement('div')
  Object.defineProperties(root, {
    clientWidth: { value: 800 }, clientHeight: { value: 600 },
    getBoundingClientRect: { value: () => new DOMRect(100, 60, 800, 600) },
  })
  document.body.append(root)
  let current = { ...initial }
  const setViewport = vi.fn((next: Viewport) => { current = { ...next } })
  const onStart = vi.fn()
  const onEnd = vi.fn()
  const dispose = installCanvasWheel(root, {
    mode, minZoom: 0.15, maxZoom: 2,
    getViewport: () => current, setViewport, onStart, onEnd,
  })
  cleanups.push(() => { dispose(); root.remove() })
  return { root, setViewport, onStart, onEnd, dispose, viewport: () => current }
}

function child(parent: HTMLElement, attributes: Record<string, string> = {}) {
  const element = document.createElement('div')
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value)
  parent.append(element)
  return element
}

function scrollport(parent: HTMLElement, axis: 'x' | 'y' = 'y') {
  const element = child(parent)
  element.style.overflowX = axis === 'x' ? 'auto' : 'hidden'
  element.style.overflowY = axis === 'y' ? 'auto' : 'hidden'
  Object.defineProperties(element, {
    clientWidth: { value: 100 }, clientHeight: { value: 100 },
    scrollWidth: { value: axis === 'x' ? 1000 : 100 }, scrollHeight: { value: axis === 'y' ? 1000 : 100 },
  })
  return element
}

function wheel(target: HTMLElement, options: WheelEventInit = {}) {
  const event = new WheelEvent('wheel', {
    bubbles: true, cancelable: true, deltaY: 20, clientX: 500, clientY: 360, ...options,
  })
  target.dispatchEvent(event)
  return event
}

function frame() { vi.advanceTimersByTime(20) }
function endGesture() { vi.advanceTimersByTime(250) }

describe('canvas wheel ownership', () => {
  it('keeps a canvas pan when a scrollable nowheel card moves under the pointer', () => {
    const b = fixture()
    const card = scrollport(b.root)
    card.classList.add('nowheel', 'nopan')
    const native = vi.fn()
    card.addEventListener('wheel', native)
    const beginning = wheel(b.root, { deltaY: 40 })
    const crossing = wheel(card, { deltaY: 40 })
    frame()
    expect(b.viewport()).toEqual({ x: 10, y: -20, zoom: 1 })
    expect(beginning.defaultPrevented).toBe(true)
    expect(crossing.defaultPrevented).toBe(true)
    expect(native).not.toHaveBeenCalled()
    expect(b.onStart).toHaveBeenCalledOnce()
    expect(b.root.hasAttribute('data-canvas-wheel-owner')).toBe(true)
    endGesture()
    expect(b.onEnd).toHaveBeenCalledOnce()
    expect(b.root.hasAttribute('data-canvas-wheel-owner')).toBe(false)
  })

  it('leaves a scrollable body native until the gesture ends, even after reaching its edge', () => {
    const b = fixture()
    const body = scrollport(b.root)
    const native = vi.fn()
    body.addEventListener('wheel', native)
    const beginning = wheel(body)
    // Native scrolling is not executed by jsdom; expose the position reached by that same browser gesture.
    body.scrollTop = 900
    const boundary = wheel(body)
    frame()
    expect(beginning.defaultPrevented).toBe(false)
    expect(boundary.defaultPrevented).toBe(false)
    expect(native).toHaveBeenCalledTimes(2)
    expect(b.setViewport).not.toHaveBeenCalled()
    expect(b.onStart).not.toHaveBeenCalled()
    endGesture()
    const next = wheel(body)
    frame()
    expect(next.defaultPrevented).toBe(true)
    expect(native).toHaveBeenCalledTimes(2)
    expect(b.viewport()).toEqual({ x: 10, y: 10, zoom: 1 })
    expect(b.onStart).toHaveBeenCalledOnce()
  })

  it('absorbs the remaining content gesture outside its locked subtree instead of panning another target', () => {
    const b = fixture()
    const body = scrollport(b.root)
    const text = child(body)
    const other = child(b.root)
    const native = vi.fn()
    const unrelated = vi.fn()
    body.addEventListener('wheel', native)
    other.addEventListener('wheel', unrelated)
    expect(wheel(text).defaultPrevented).toBe(false)
    expect(wheel(other).defaultPrevented).toBe(true)
    frame()
    expect(native).toHaveBeenCalledOnce()
    expect(unrelated).not.toHaveBeenCalled()
    expect(b.setViewport).not.toHaveBeenCalled()
    endGesture()
    wheel(other)
    frame()
    expect(b.viewport()).toEqual({ x: 10, y: 10, zoom: 1 })
  })

  it.each(['content', 'container'] as const)('uses the nearest declared %s gesture surface', (surface) => {
    const b = fixture()
    const outer = child(b.root, { 'data-gesture-surface': surface === 'content' ? 'container' : 'content' })
    const inner = child(outer, { 'data-gesture-surface': surface })
    const target = child(inner)
    const native = vi.fn()
    target.addEventListener('wheel', native)
    const event = wheel(target)
    frame()
    expect(event.defaultPrevented).toBe(surface === 'container')
    expect(native).toHaveBeenCalledTimes(surface === 'container' ? 0 : 1)
    expect(b.setViewport).toHaveBeenCalledTimes(surface === 'container' ? 1 : 0)
  })

  it.each(['textarea', 'input', 'select', 'rich-text', 'panel'] as const)('preserves native wheel handling in %s controls', (kind) => {
    const b = fixture('mouse')
    let target: HTMLElement
    if (kind === 'rich-text') {
      target = child(child(b.root, { contenteditable: 'true' }))
    } else if (kind === 'panel') {
      target = child(child(b.root, { class: 'react-flow__panel' }))
    } else {
      target = document.createElement(kind)
      b.root.append(target)
    }
    const native = vi.fn()
    target.addEventListener('wheel', native)
    expect(wheel(target).defaultPrevented).toBe(false)
    frame()
    expect(native).toHaveBeenCalledOnce()
    expect(b.setViewport).not.toHaveBeenCalled()
  })

  it('checks the scroll direction and current position before assigning a new gesture', () => {
    const b = fixture()
    const body = scrollport(b.root, 'x')
    expect(wheel(body, { deltaX: 0, deltaY: 30 }).defaultPrevented).toBe(true)
    frame()
    expect(b.viewport()).toEqual({ x: 10, y: 5, zoom: 1 })
    endGesture()
    expect(wheel(body, { deltaX: 30, deltaY: 0 }).defaultPrevented).toBe(false)
    endGesture()
    body.scrollLeft = 900
    expect(wheel(body, { deltaX: 30, deltaY: 0 }).defaultPrevented).toBe(true)
    frame()
    expect(b.viewport()).toEqual({ x: -5, y: 5, zoom: 1 })
    endGesture()
    expect(wheel(body, { deltaX: -30, deltaY: 0 }).defaultPrevented).toBe(false)
  })

  it('does not mistake overflow styling without overflow for a scrollable body', () => {
    const b = fixture()
    const body = child(b.root)
    body.style.overflowY = 'auto'
    Object.defineProperties(body, { clientHeight: { value: 100 }, scrollHeight: { value: 100 } })
    expect(wheel(body).defaultPrevented).toBe(true)
    frame()
    expect(b.viewport()).toEqual({ x: 10, y: 10, zoom: 1 })
  })

  it('pans horizontally for Shift with a vertical wheel and retains browser-provided horizontal deltas', () => {
    const b = fixture()
    wheel(b.root, { shiftKey: true, deltaX: 0, deltaY: 40 })
    frame()
    expect(b.viewport()).toEqual({ x: -10, y: 20, zoom: 1 })
    endGesture()
    wheel(b.root, { shiftKey: true, deltaX: 20, deltaY: 30 })
    frame()
    expect(b.viewport()).toEqual({ x: -20, y: 5, zoom: 1 })
  })

  it('assigns Shift-wheel to a horizontal scrollport using the same axis as canvas panning', () => {
    const b = fixture()
    const body = scrollport(b.root, 'x')
    const native = vi.fn()
    body.addEventListener('wheel', native)
    expect(wheel(body, { deltaY: 40 }).defaultPrevented).toBe(true)
    frame()
    expect(b.viewport()).toEqual({ x: 10, y: 0, zoom: 1 })
    endGesture()
    expect(wheel(body, { shiftKey: true, deltaY: 40 }).defaultPrevented).toBe(false)
    frame()
    expect(b.viewport()).toEqual({ x: 10, y: 0, zoom: 1 })
    endGesture()
    expect(wheel(body, { shiftKey: true, deltaX: 40, deltaY: 0 }).defaultPrevented).toBe(false)
    expect(native).toHaveBeenCalledTimes(2)
    expect(b.viewport()).toEqual({ x: 10, y: 0, zoom: 1 })
  })

  it('starts a canvas pinch immediately over native content and blocks descendant zoom handlers', () => {
    const b = fixture()
    const body = scrollport(b.root)
    const image = child(body)
    const localZoom = vi.fn()
    image.addEventListener('wheel', localZoom)
    wheel(image)
    expect(localZoom).toHaveBeenCalledOnce()
    const pinch = wheel(image, { ctrlKey: true, deltaY: -100 })
    frame()
    expect(pinch.defaultPrevented).toBe(true)
    expect(localZoom).toHaveBeenCalledOnce()
    expect(b.viewport()).toEqual({ x: -380, y: -260, zoom: 2 })
    expect(b.onStart).toHaveBeenCalledOnce()
    const afterPinch = wheel(image, { ctrlKey: false })
    expect(afterPinch.defaultPrevented).toBe(false)
    expect(localZoom).toHaveBeenCalledTimes(2)
    expect(b.onEnd).toHaveBeenCalledOnce()
  })

  it.each([
    { mode: 0, deltaY: -100, exponent: 0.2 },
    { mode: 1, deltaY: -1, exponent: 0.05 },
    { mode: 2, deltaY: -0.1, exponent: 0.1 },
  ])('normalizes mouse zoom delta mode $mode and preserves its pointer anchor', ({ mode, deltaY, exponent }) => {
    const b = fixture('mouse')
    wheel(b.root, { deltaMode: mode, deltaY })
    frame()
    const factor = 2 ** exponent
    expect(b.viewport().zoom).toBeCloseTo(factor)
    expect(b.viewport().x).toBeCloseTo(400 - 390 * factor)
    expect(b.viewport().y).toBeCloseTo(300 - 280 * factor)
  })

  it('keeps zoom clamped at both limits while anchoring the actual clamped scale', () => {
    const b = fixture('mouse')
    wheel(b.root, { deltaY: -10_000 })
    frame()
    expect(b.viewport()).toEqual({ x: -380, y: -260, zoom: 2 })
    wheel(b.root, { deltaY: 10_000 })
    frame()
    expect(b.viewport().zoom).toBe(0.15)
    expect(b.viewport().x).toBeCloseTo(341.5)
    expect(b.viewport().y).toBeCloseTo(258)
  })

  it.each([
    { mode: 0, dx: 40, dy: 60, x: -10, y: -10 },
    { mode: 1, dx: 1, dy: 2, x: 0, y: 0 },
    { mode: 2, dx: 1, dy: 1, x: -390, y: -280 },
  ])('normalizes touchpad pan delta mode $mode', ({ mode, dx, dy, x, y }) => {
    const b = fixture()
    wheel(b.root, { deltaMode: mode, deltaX: dx, deltaY: dy })
    frame()
    expect(b.viewport()).toEqual({ x, y, zoom: 1 })
  })

  it('accumulates multiple events in one frame instead of replacing earlier displacement', () => {
    const b = fixture()
    wheel(b.root, { deltaX: 20, deltaY: 10 })
    wheel(b.root, { deltaX: 20, deltaY: 30 })
    frame()
    expect(b.viewport()).toEqual({ x: -10, y: 0, zoom: 1 })
    expect(b.onStart).toHaveBeenCalledOnce()
  })

  it('does not apply wheel movement while a pointer gesture owns canvas panning', () => {
    const b = fixture()
    b.root.setAttribute('data-canvas-panning', '')
    const local = child(b.root)
    const handler = vi.fn()
    local.addEventListener('wheel', handler)
    expect(wheel(local, { ctrlKey: true }).defaultPrevented).toBe(true)
    frame()
    expect(handler).not.toHaveBeenCalled()
    expect(b.setViewport).not.toHaveBeenCalled()
    expect(b.onStart).not.toHaveBeenCalled()
  })

  it.each(['pointerdown', 'blur', 'resize', 'dispose'] as const)('ends the active wheel once on %s and releases its ownership', (ending) => {
    const b = fixture()
    wheel(b.root)
    frame()
    expect(b.onStart).toHaveBeenCalledOnce()
    expect(b.root.hasAttribute('data-canvas-wheel-owner')).toBe(true)
    if (ending === 'dispose') b.dispose()
    else if (ending === 'pointerdown') b.root.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    else window.dispatchEvent(new Event(ending))
    expect(b.onEnd).toHaveBeenCalledOnce()
    expect(b.root.hasAttribute('data-canvas-wheel-owner')).toBe(false)
    endGesture()
    b.dispose()
    expect(b.onEnd).toHaveBeenCalledOnce()
    const written = b.setViewport.mock.calls.length
    expect(wheel(b.root).defaultPrevented).toBe(false)
    endGesture()
    expect(b.setViewport).toHaveBeenCalledTimes(written)
  })
})
