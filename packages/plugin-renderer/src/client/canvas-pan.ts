/** Forced viewport dragging takes priority over card controls without changing ordinary pointer gestures. */
import type { Viewport } from '@xyflow/react'

interface CanvasPanActions {
  readonly getViewport: () => Viewport
  readonly setViewport: (viewport: Viewport) => void
  readonly onStart?: () => void
  readonly onEnd?: () => void
}

interface PanGesture {
  readonly pointerId: number
  readonly startX: number
  readonly startY: number
  readonly viewport: Viewport
  x: number
  y: number
}

function editing(target: EventTarget | null): boolean {
  return target instanceof Element
    && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]') !== null
}

/**
 * Install Space+primary-button and middle-button viewport dragging above nested card controls.
 * @param root - Connected canvas element; owns pointer capture and temporary cursor attributes.
 * @param actions - Current viewport access, screen-CSS-pixel updates, and optional gesture-lifetime callbacks.
 * @returns Release listeners, pointer capture, and cursor attributes. Cancellation keeps the latest viewport position.
 */
export function installCanvasPan(root: HTMLElement, actions: CanvasPanActions): () => void {
  const document = root.ownerDocument
  const window = document.defaultView
  let space = false
  let spacePanned = false
  let gesture: PanGesture | null = null
  let suppressMouse = false
  const ready = (value: boolean): void => {
    space = value
    root.toggleAttribute('data-canvas-pan-ready', value)
  }
  const finish = (): void => {
    const active = gesture
    gesture = null
    root.removeAttribute('data-canvas-panning')
    if (active !== null && root.hasPointerCapture(active.pointerId)) root.releasePointerCapture(active.pointerId)
    if (active !== null) actions.onEnd?.()
  }
  const cancel = (): void => { ready(false); finish() }
  const move = (event: PointerEvent): void => {
    const active = gesture
    if (active === null || event.pointerId !== active.pointerId) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (active.x === event.clientX && active.y === event.clientY) return
    active.x = event.clientX
    active.y = event.clientY
    actions.setViewport({
      x: active.viewport.x + event.clientX - active.startX,
      y: active.viewport.y + event.clientY - active.startY,
      zoom: active.viewport.zoom,
    })
  }
  const down = (event: PointerEvent): void => {
    if (gesture !== null) return
    suppressMouse = false
    if (event.pointerType === 'touch' || event.button !== 1 && (event.button !== 0 || !space)) return
    if (event.button === 0 && (editing(event.target) || editing(document.activeElement))) { ready(false); return }
    event.preventDefault()
    event.stopImmediatePropagation()
    root.setPointerCapture(event.pointerId)
    gesture = {
      pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      x: event.clientX, y: event.clientY, viewport: actions.getViewport(),
    }
    suppressMouse = true
    if (space) spacePanned = true
    root.setAttribute('data-canvas-panning', '')
    actions.onStart?.()
  }
  const up = (event: PointerEvent): void => {
    if (gesture?.pointerId !== event.pointerId) return
    move(event)
    finish()
  }
  const lost = (event: PointerEvent): void => {
    if (gesture?.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopImmediatePropagation()
    finish()
  }
  const mouse = (event: MouseEvent): void => {
    if (!suppressMouse) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  const click = (event: MouseEvent): void => {
    if (!suppressMouse || event.detail === 0) return
    mouse(event)
    suppressMouse = false
  }
  const keyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && gesture !== null) {
      event.preventDefault()
      event.stopImmediatePropagation()
      cancel()
      return
    }
    if (event.code !== 'Space' && event.key !== ' ' || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return
    if (!event.repeat) spacePanned = false
    if (editing(event.target) || editing(document.activeElement)) { ready(false); return }
    const button = event.target instanceof Element ? event.target.closest('button, [role="button"]') : null
    if (button !== null && !(button instanceof HTMLButtonElement)) { ready(false); return }
    ready(true)
    if (!(button instanceof HTMLButtonElement) && event.target instanceof Node && root.contains(event.target)) event.preventDefault()
  }
  const keyUp = (event: KeyboardEvent): void => {
    if (event.code !== 'Space' && event.key !== ' ') return
    if (spacePanned) {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    spacePanned = false
    ready(false)
  }
  root.addEventListener('pointerdown', down, true)
  root.addEventListener('pointermove', move, true)
  root.addEventListener('pointerup', up, true)
  root.addEventListener('pointercancel', lost, true)
  root.addEventListener('lostpointercapture', lost, true)
  root.addEventListener('mousedown', mouse, true)
  root.addEventListener('mouseup', mouse, true)
  root.addEventListener('click', click, true)
  root.addEventListener('auxclick', click, true)
  document.addEventListener('keydown', keyDown, true)
  document.addEventListener('keyup', keyUp, true)
  window?.addEventListener('blur', cancel)
  window?.addEventListener('resize', cancel)
  return () => {
    cancel()
    root.removeEventListener('pointerdown', down, true)
    root.removeEventListener('pointermove', move, true)
    root.removeEventListener('pointerup', up, true)
    root.removeEventListener('pointercancel', lost, true)
    root.removeEventListener('lostpointercapture', lost, true)
    root.removeEventListener('mousedown', mouse, true)
    root.removeEventListener('mouseup', mouse, true)
    root.removeEventListener('click', click, true)
    root.removeEventListener('auxclick', click, true)
    document.removeEventListener('keydown', keyDown, true)
    document.removeEventListener('keyup', keyUp, true)
    window?.removeEventListener('blur', cancel)
    window?.removeEventListener('resize', cancel)
  }
}
