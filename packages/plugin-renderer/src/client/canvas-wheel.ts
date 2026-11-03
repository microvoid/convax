/** Wheel gestures retain their initial canvas or content owner through momentum. */
import type { Viewport } from '@xyflow/react'
import type { CanvasInputMode } from './input-mode.ts'

interface CanvasWheelOptions {
  readonly mode: CanvasInputMode
  readonly minZoom: number
  readonly maxZoom: number
  readonly getViewport: () => Viewport
  readonly setViewport: (viewport: Viewport) => void
  readonly onStart?: () => void
  readonly onEnd?: () => void
}

type WheelOwner =
  | { readonly kind: 'canvas'; readonly action: 'pan' | 'zoom'; readonly pinch: boolean }
  | { readonly kind: 'content'; readonly element: Element; readonly pinch: false }

const GESTURE_IDLE_MS = 180
const NATIVE_CONTENT = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .react-flow__panel'

function wheelAxes(event: WheelEvent): readonly [number, number] {
  return event.shiftKey && event.deltaX === 0 ? [event.deltaY, 0] : [event.deltaX, event.deltaY]
}

function scrolls(element: HTMLElement, event: WheelEvent, view: Window): boolean {
  const [dx, dy] = wheelAxes(event)
  const horizontal = Math.abs(dx) > Math.abs(dy)
  const delta = horizontal ? dx : dy
  const style = view.getComputedStyle(element)
  const overflow = horizontal ? style.overflowX || style.overflow : style.overflowY || style.overflow
  if (overflow !== 'auto' && overflow !== 'scroll') return false
  const position = horizontal ? element.scrollLeft : element.scrollTop
  const maximum = horizontal ? element.scrollWidth - element.clientWidth : element.scrollHeight - element.clientHeight
  return maximum > 1 && (delta < 0 ? position > 0 : position < maximum - 1)
}

function findOwner(root: HTMLElement, event: WheelEvent, mode: CanvasInputMode, view: Window): WheelOwner {
  const canvas = (): WheelOwner => ({
    kind: 'canvas', action: event.ctrlKey || mode === 'mouse' ? 'zoom' : 'pan', pinch: event.ctrlKey,
  })
  if (event.ctrlKey) return canvas()
  const path = event.composedPath()
  const elements = path.slice(0, path.indexOf(root)).filter((entry): entry is Element => entry instanceof Element)
  for (const element of elements) {
    const surface = element.getAttribute('data-gesture-surface')
    if (surface === 'container') return canvas()
    if (surface === 'content' || element.matches(NATIVE_CONTENT)) return { kind: 'content', element, pinch: false }
    if (element instanceof HTMLElement && scrolls(element, event, view)) return { kind: 'content', element, pinch: false }
  }
  return canvas()
}

/**
 * Route wheel input before embedded controls or the graph library handle it.
 * @param root - One mounted canvas surface; its controls and cards share this capture listener.
 * @param options - Current navigation mode and live viewport access, with gesture completion callbacks.
 * @returns Disposer that releases listeners, the gesture timer, and its presentation marker.
 */
export function installCanvasWheel(root: HTMLElement, options: CanvasWheelOptions): () => void {
  const view = root.ownerDocument.defaultView
  if (view === null) throw new Error('Canvas gestures require a window')
  let owner: WheelOwner | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const finish = (): void => {
    clearTimeout(timer)
    timer = undefined
    const previous = owner
    owner = undefined
    root.removeAttribute('data-canvas-wheel-owner')
    if (previous?.kind === 'canvas') options.onEnd?.()
  }
  const consume = (event: WheelEvent): void => {
    if (event.cancelable) event.preventDefault()
    event.stopImmediatePropagation()
  }
  const wheel = (event: WheelEvent): void => {
    if (root.hasAttribute('data-canvas-panning')) { consume(event); return }
    if (event.deltaX === 0 && event.deltaY === 0) return
    if (owner !== undefined && owner.pinch !== event.ctrlKey) finish()
    if (owner === undefined) {
      owner = findOwner(root, event, options.mode, view)
      root.setAttribute('data-canvas-wheel-owner', owner.kind)
      if (owner.kind === 'canvas') options.onStart?.()
    }
    clearTimeout(timer)
    timer = setTimeout(finish, GESTURE_IDLE_MS)
    if (owner.kind === 'content') {
      // Native scrolling and custom editors keep their own wheel and boundary behavior.
      if (!(event.target instanceof Node) || !owner.element.contains(event.target)) consume(event)
      return
    }
    consume(event)
    const viewport = options.getViewport()
    if (owner.action === 'pan') {
      const [dx, dy] = wheelAxes(event)
      const unitX = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? root.clientWidth : 1
      const unitY = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? root.clientHeight : 1
      options.setViewport({ ...viewport, x: viewport.x - dx * unitX * 0.5, y: viewport.y - dy * unitY * 0.5 })
      return
    }
    const unit = event.deltaMode === 1 ? 0.05 : event.deltaMode === 2 ? 1 : 0.002
    const zoom = Math.max(options.minZoom, Math.min(options.maxZoom,
      viewport.zoom * 2 ** (-event.deltaY * unit * (owner.pinch ? 10 : 1))))
    const bounds = root.getBoundingClientRect()
    const x = event.clientX - bounds.left
    const y = event.clientY - bounds.top
    const ratio = zoom / viewport.zoom
    options.setViewport({ x: x - (x - viewport.x) * ratio, y: y - (y - viewport.y) * ratio, zoom })
  }
  root.addEventListener('wheel', wheel, { capture: true, passive: false })
  root.addEventListener('pointerdown', finish, true)
  view.addEventListener('blur', finish)
  view.addEventListener('resize', finish)
  return () => {
    root.removeEventListener('wheel', wheel, true)
    root.removeEventListener('pointerdown', finish, true)
    view.removeEventListener('blur', finish)
    view.removeEventListener('resize', finish)
    finish()
  }
}
