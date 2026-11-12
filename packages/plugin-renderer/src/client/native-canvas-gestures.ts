import type { Connection, Position, Viewport, XYPosition } from '@xyflow/react'
import type { CanvasHandleCallbacks } from './canvas-render-primitives.tsx'

export interface NativeGestureHandle {
  readonly element: HTMLElement
  readonly nodeId: string
  readonly portId: string
  readonly type: 'source' | 'target'
  readonly position: Position
  readonly point: XYPosition
}

interface GestureNode {
  readonly id: string
  readonly position: XYPosition
  readonly measured?: { readonly width?: number; readonly height?: number }
  readonly selected?: boolean
  readonly dragHandle?: string
}

interface MarqueeRect extends XYPosition {
  readonly width: number
  readonly height: number
}

export interface NativeCanvasGestureActions {
  readonly active: boolean
  readonly nodesDraggable: boolean
  readonly nodesConnectable: boolean
  readonly dragSelects: boolean
  readonly minZoom: number
  readonly maxZoom: number
  readonly nodes: readonly GestureNode[]
  getHandleCallbacks?(handle: HTMLElement): CanvasHandleCallbacks | undefined
  getViewport(): Viewport
  setViewport(next: Viewport): void
  endViewport(): void
  changeSelection(ids: readonly string[]): void
  changeMarqueeSelection?(ids: readonly string[]): void
  finishMarquee?(ids: readonly string[], cancelled: boolean): void
  clearPane(): void
  clickNode(extend: boolean): void
  startDrag(id: string, movedIds: readonly string[], event: PointerEvent): void
  moveDrag(positions: ReadonlyMap<string, XYPosition>): void
  endDrag(positions: ReadonlyMap<string, XYPosition>, cancelled: boolean, event: PointerEvent): void
  showMarquee(rect: MarqueeRect | null): void
  startConnection(handle: NativeGestureHandle, event: MouseEvent): void
  moveConnection(handle: NativeGestureHandle, to: XYPosition): void
  endConnection(event: PointerEvent, from: NativeGestureHandle, to: NativeGestureHandle | null, cancelled: boolean): void
}

const NODE = '.react-flow__node[data-id]'
const HANDLE = '.react-flow__handle[data-nodeid][data-handleid][data-handlepos]'
const NATIVE_CONTROL = 'button, a, input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="textbox"], [role="slider"], [role="menu"], [role="dialog"], .xterm'
const OTHER_SURFACE = '.react-flow__panel, .react-flow__edge, [data-convax-group-header]'
const DRAG_THRESHOLD = 1
const CONNECTION_RADIUS = 20
const AUTO_PAN_INSET = 40
const AUTO_PAN_SPEED = 15

interface PointerGesture {
  readonly pointerId: number
  readonly bounds: DOMRect
  readonly start: XYPosition
  readonly startViewport: Viewport
  readonly startWorld: XYPosition
  readonly extend: boolean
  latest: PointerEvent
  started: boolean
  viewportMoved: boolean
}

type Gesture = PointerGesture & (
  | { readonly kind: 'node'; readonly nodeId: string; readonly canDrag: boolean; readonly fromSelection?: boolean; origins: ReadonlyMap<string, XYPosition>; positions: ReadonlyMap<string, XYPosition> }
  | { readonly kind: 'connection'; readonly from: NativeGestureHandle }
  | { readonly kind: 'marquee'; selected: readonly string[] }
  | { readonly kind: 'pan'; readonly afterPinch?: boolean }
)

interface Pinch {
  readonly bounds: DOMRect
  readonly startViewport: Viewport
  readonly startWorld: XYPosition
  readonly distance: number
  moved: boolean
}

function eventElement(event: PointerEvent): Element | null {
  const target = event.target
  return target !== null && 'nodeType' in target && target.nodeType === 1 ? target as Element : null
}

function point(event: PointerEvent): XYPosition {
  return { x: event.clientX, y: event.clientY }
}

function toWorld(screen: XYPosition, viewport: Viewport): XYPosition {
  return { x: (screen.x - viewport.x) / viewport.zoom, y: (screen.y - viewport.y) / viewport.zoom }
}

function toScreen(world: XYPosition, viewport: Viewport): XYPosition {
  return { x: world.x * viewport.zoom + viewport.x, y: world.y * viewport.zoom + viewport.y }
}

function rect(a: XYPosition, b: XYPosition): MarqueeRect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
}

function distance(a: XYPosition, b: XYPosition): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function midpoint(a: XYPosition, b: XYPosition): XYPosition {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

function readHandle(element: HTMLElement, rootBounds: DOMRect, viewport: Viewport): NativeGestureHandle | null {
  const nodeId = element.getAttribute('data-nodeid')
  const portId = element.getAttribute('data-handleid')
  const position = element.getAttribute('data-handlepos')
  if (nodeId === null || portId === null
    || position !== 'left' && position !== 'right' && position !== 'top' && position !== 'bottom') return null
  const bounds = element.getBoundingClientRect()
  return { element, nodeId, portId, position: position as Position, type: element.classList.contains('target') ? 'target' : 'source',
    point: toWorld({ x: bounds.left - rootBounds.left + bounds.width / 2, y: bounds.top - rootBounds.top + bounds.height / 2 }, viewport) }
}

/** Convert a drag started at either end into the document's source-to-target orientation. */
export function nativeHandleConnection(from: NativeGestureHandle, to: NativeGestureHandle): Connection {
  const [source, target] = from.type === 'source' ? [from, to] : [to, from]
  return { source: source.nodeId, sourceHandle: source.portId, target: target.nodeId, targetHandle: target.portId }
}

function canStartConnection(from: NativeGestureHandle): boolean {
  return from.element.classList.contains('connectable') && from.element.classList.contains('connectablestart')
}

function canConnect(
  from: NativeGestureHandle, to: NativeGestureHandle, check: NativeGestureHandle, actions: NativeCanvasGestureActions,
): boolean {
  if (!from.element.isConnected || !to.element.classList.contains('connectable')
    || !to.element.classList.contains('connectableend') || from.type === to.type) return false
  return actions.getHandleCallbacks?.(check.element)?.isValidConnection?.(nativeHandleConnection(from, to)) ?? true
}

function inside(node: GestureNode, area: MarqueeRect): boolean {
  const { x, y } = node.position
  const width = node.measured?.width
  const height = node.measured?.height
  return width !== undefined && height !== undefined && x >= area.x && y >= area.y
    && x + width <= area.x + area.width && y + height <= area.y + area.height
}

function selectMarquee(actions: NativeCanvasGestureActions, ids: readonly string[]): void {
  if (actions.changeMarqueeSelection === undefined) actions.changeSelection(ids)
  else actions.changeMarqueeSelection(ids)
}

function panStep(value: number, size: number): number {
  if (value < AUTO_PAN_INSET) return AUTO_PAN_SPEED * Math.min(1, (AUTO_PAN_INSET - value) / AUTO_PAN_INSET)
  if (value > size - AUTO_PAN_INSET) return -AUTO_PAN_SPEED * Math.min(1, (value - size + AUTO_PAN_INSET) / AUTO_PAN_INSET)
  return 0
}

/** Owns transient pointer state while the graph supplies selection, viewport and durable edit callbacks. */
class NativeCanvasGestures {
  private readonly document: Document
  private readonly window: Window | null
  private readonly touches = new Map<number, PointerEvent>()
  private gesture: Gesture | null = null
  private pinch: Pinch | null = null
  private clickHandle: NativeGestureHandle | null = null
  private autoPanFrame: number | undefined
  private suppressClick = false

  constructor(private readonly root: HTMLElement, private readonly get: () => NativeCanvasGestureActions) {
    this.document = root.ownerDocument
    this.window = this.document.defaultView
  }

  install(): void {
    this.root.addEventListener('pointerdown', this.down)
    this.root.addEventListener('click', this.click, true)
    this.document.addEventListener('pointermove', this.move, true)
    this.document.addEventListener('pointerup', this.up, true)
    this.document.addEventListener('pointercancel', this.cancelPointer, true)
    this.root.addEventListener('lostpointercapture', this.lostCapture)
    this.window?.addEventListener('blur', this.cancelGesture)
    this.window?.addEventListener('resize', this.cancelGesture)
  }

  dispose = (): void => {
    this.root.removeEventListener('pointerdown', this.down)
    this.root.removeEventListener('click', this.click, true)
    this.document.removeEventListener('pointermove', this.move, true)
    this.document.removeEventListener('pointerup', this.up, true)
    this.document.removeEventListener('pointercancel', this.cancelPointer, true)
    this.root.removeEventListener('lostpointercapture', this.lostCapture)
    this.window?.removeEventListener('blur', this.cancelGesture)
    this.window?.removeEventListener('resize', this.cancelGesture)
    this.cancelGesture()
  }

  cancelGesture = (): void => {
    this.clickHandle = null
    this.finish(true)
    const pinch = this.pinch
    this.pinch = null
    for (const id of this.touches.keys()) this.release(id)
    this.touches.clear()
    if (pinch?.moved) this.get().endViewport()
  }

  cancelConnection = (): void => {
    this.clickHandle = null
    if (this.gesture?.kind === 'connection') this.cancelGesture()
  }

  private capture(id: number): void {
    this.root.setPointerCapture(id)
  }

  private release(id: number): void {
    if (this.root.hasPointerCapture(id)) this.root.releasePointerCapture(id)
  }

  private pointer(event: PointerEvent, bounds: DOMRect): XYPosition {
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
  }

  private start(event: PointerEvent, bounds: DOMRect, viewport: Viewport): PointerGesture {
    const start = this.pointer(event, bounds)
    return { pointerId: event.pointerId, bounds, start, startViewport: viewport, startWorld: toWorld(start, viewport),
      extend: event.shiftKey || event.metaKey || event.ctrlKey, latest: event, started: false, viewportMoved: false }
  }

  private down = (event: PointerEvent): void => {
    const actions = this.get()
    if (!actions.active || event.defaultPrevented || event.button !== 0 || this.root.hasAttribute('data-canvas-panning')) return
    if (this.gesture === null && this.pinch === null) this.suppressClick = false
    const target = eventElement(event)
    if (target === null || target.closest(OTHER_SURFACE) !== null) return
    const handle = target.closest<HTMLElement>(HANDLE)
    const nodeElement = target.closest(NODE)
    const selection = target.closest('[data-native-canvas-selection]')
    const inPane = target.closest('.react-flow__pane') !== null
    if (nodeElement === null && !inPane && handle === null && selection === null) return
    if (handle === null && (target.closest(NATIVE_CONTROL) !== null
      || target.closest('[data-convax-input-owner]') !== null && target.closest('[data-convax-node-drag]') === null)) return
    if (nodeElement === null && handle === null && selection === null && target.closest('.nopan') !== null) return
    const bounds = this.root.getBoundingClientRect()
    const viewport = actions.getViewport()
    if (event.pointerType === 'touch') {
      if (this.touches.size === 2 || this.gesture !== null && this.touches.size === 0) return
      this.touches.set(event.pointerId, event)
      if (this.touches.size === 2) {
        this.beginPinch(bounds, viewport)
        event.preventDefault()
        return
      }
    } else if (this.gesture !== null || this.pinch !== null) return
    const start = this.start(event, bounds, viewport)
    if (handle !== null) {
      if (!actions.nodesConnectable) return
      const from = readHandle(handle, bounds, viewport)
      if (from !== null) this.gesture = { ...start, kind: 'connection', from }
      return
    }
    if (selection !== null) {
      const node = actions.nodes.find(entry => entry.selected)
      if (node !== undefined) this.gesture = { ...start, kind: 'node', nodeId: node.id, canDrag: actions.nodesDraggable,
        fromSelection: true, origins: new Map(), positions: new Map() }
      return
    }
    if (nodeElement !== null) {
      const node = actions.nodes.find(entry => entry.id === nodeElement.getAttribute('data-id'))
      if (node === undefined) return
      const dragHandle = node.dragHandle === undefined ? nodeElement : target.closest(node.dragHandle)
      const canDrag = actions.nodesDraggable && target.closest('.nodrag') === null
        && dragHandle !== null && nodeElement.contains(dragHandle)
      this.gesture = { ...start, kind: 'node', nodeId: node.id, canDrag, origins: new Map(), positions: new Map() }
      return
    }
    this.gesture = event.pointerType !== 'touch' && (actions.dragSelects || event.shiftKey)
      ? { ...start, kind: 'marquee', selected: [] }
      : { ...start, kind: 'pan' }
  }

  private beginPinch(bounds: DOMRect, viewport: Viewport): void {
    const [first, second] = [...this.touches.values()].map(event => this.pointer(event, bounds))
    if (first === undefined || second === undefined) return
    this.finish(true)
    this.clickHandle = null
    this.pinch = { bounds, startViewport: viewport, startWorld: toWorld(midpoint(first, second), viewport),
      distance: Math.max(1, distance(first, second)), moved: false }
    for (const id of this.touches.keys()) this.capture(id)
    this.suppressClick = true
  }

  private movePinch(event: PointerEvent, pinch: Pinch): void {
    this.touches.set(event.pointerId, event)
    const [first, second] = [...this.touches.values()].map(pointer => this.pointer(pointer, pinch.bounds))
    if (first === undefined || second === undefined) return
    const center = midpoint(first, second)
    const actions = this.get()
    const zoom = Math.min(actions.maxZoom, Math.max(actions.minZoom, pinch.startViewport.zoom * distance(first, second) / pinch.distance))
    pinch.moved = true
    actions.setViewport({ x: center.x - pinch.startWorld.x * zoom, y: center.y - pinch.startWorld.y * zoom, zoom })
  }

  private move = (event: PointerEvent): void => {
    const touch = this.touches.has(event.pointerId)
    const gesture = this.gesture
    if (!touch && gesture?.pointerId !== event.pointerId) return
    const actions = this.get()
    if (!actions.active) { this.cancelGesture(); return }
    if (this.pinch !== null && touch) {
      event.preventDefault()
      this.movePinch(event, this.pinch)
      return
    }
    if (touch) this.touches.set(event.pointerId, event)
    if (gesture === null || gesture.pointerId !== event.pointerId) return
    gesture.latest = event
    if (gesture.started && (gesture.kind === 'node' && !actions.nodesDraggable
      || gesture.kind === 'connection' && !actions.nodesConnectable)) {
      this.cancelGesture()
      return
    }
    const current = this.pointer(event, gesture.bounds)
    if (!gesture.started) {
      if (distance(current, gesture.start) <= DRAG_THRESHOLD || gesture.kind === 'node' && !gesture.canDrag) return
      if (!this.begin(gesture, actions)) return
    }
    event.preventDefault()
    this.update(gesture, actions, current)
    this.scheduleAutoPan()
  }

  private begin(gesture: Gesture, actions: NativeCanvasGestureActions): boolean {
    this.clickHandle = null
    if (gesture.kind === 'node') {
      const anchor = actions.nodes.find(node => node.id === gesture.nodeId)
      if (anchor === undefined || !actions.nodesDraggable || gesture.fromSelection === true && !anchor.selected) return false
      const moving = actions.nodes.filter(node => node.id === anchor.id || node.selected && (anchor.selected || gesture.extend))
      gesture.origins = new Map(moving.map(node => [node.id, node.position]))
      gesture.positions = gesture.origins
      const ids = [...gesture.origins.keys()]
      if (!anchor.selected) actions.changeSelection(ids)
      actions.startDrag(anchor.id, ids, gesture.latest)
    } else if (gesture.kind === 'connection') {
      if (!actions.nodesConnectable || !canStartConnection(gesture.from)) return false
      actions.startConnection(gesture.from, gesture.latest)
    } else if (gesture.kind === 'marquee') {
      actions.clearPane()
      selectMarquee(actions, [])
    } else {
      this.root.setAttribute('data-native-canvas-panning', '')
    }
    gesture.started = true
    if (gesture.latest.type === 'pointermove') this.capture(gesture.pointerId)
    return true
  }

  private update(gesture: Gesture, actions: NativeCanvasGestureActions, current: XYPosition): void {
    const viewport = actions.getViewport()
    const world = toWorld(current, viewport)
    switch (gesture.kind) {
      case 'node': {
        const x = world.x - gesture.startWorld.x
        const y = world.y - gesture.startWorld.y
        gesture.positions = new Map([...gesture.origins].map(([id, p]) => [id, { x: p.x + x, y: p.y + y }]))
        actions.moveDrag(gesture.positions)
        break
      }
      case 'connection': actions.moveConnection(gesture.from, world); break
      case 'marquee': {
        actions.showMarquee(rect(toScreen(gesture.startWorld, viewport), current))
        const area = rect(gesture.startWorld, world)
        const selected = actions.nodes.filter(node => inside(node, area)).map(node => node.id)
        if (selected.length !== gesture.selected.length || selected.some((id, index) => id !== gesture.selected[index])) {
          gesture.selected = selected
          selectMarquee(actions, selected)
        }
        break
      }
      case 'pan':
        gesture.viewportMoved = true
        actions.setViewport({ ...gesture.startViewport,
          x: gesture.startViewport.x + current.x - gesture.start.x, y: gesture.startViewport.y + current.y - gesture.start.y })
        break
    }
  }

  private scheduleAutoPan(): void {
    const gesture = this.gesture
    if (this.autoPanFrame !== undefined || gesture === null || !gesture.started || gesture.kind === 'pan') return
    const bounds = gesture.bounds
    const current = this.pointer(gesture.latest, bounds)
    const x = panStep(current.x, bounds.width)
    const y = panStep(current.y, bounds.height)
    if (x === 0 && y === 0) return
    this.autoPanFrame = this.window?.requestAnimationFrame(() => {
      this.autoPanFrame = undefined
      const actions = this.get()
      if (this.gesture !== gesture || !actions.active) return
      const latest = this.pointer(gesture.latest, bounds)
      const x = panStep(latest.x, bounds.width)
      const y = panStep(latest.y, bounds.height)
      if (x === 0 && y === 0) return
      const viewport = actions.getViewport()
      actions.setViewport({ ...viewport, x: viewport.x + x, y: viewport.y + y })
      gesture.viewportMoved = true
      this.update(gesture, actions, latest)
      this.scheduleAutoPan()
    })
  }

  private up = (event: PointerEvent): void => {
    if (this.pinch !== null && this.touches.has(event.pointerId)) {
      const pinch = this.pinch
      this.pinch = null
      this.touches.delete(event.pointerId)
      this.release(event.pointerId)
      if (pinch.moved) this.get().endViewport()
      const remaining = this.touches.values().next().value
      if (remaining !== undefined) this.gesture = {
        ...this.start(remaining, this.root.getBoundingClientRect(), this.get().getViewport()), kind: 'pan', afterPinch: true,
      }
      event.preventDefault()
      return
    }
    this.touches.delete(event.pointerId)
    const gesture = this.gesture
    if (gesture === null || gesture.pointerId !== event.pointerId) return
    if (!this.get().active) { this.finish(true); return }
    if (event.clientX !== gesture.latest.clientX || event.clientY !== gesture.latest.clientY) this.move(event)
    gesture.latest = event
    this.finish(false)
  }

  private cancelPointer = (event: PointerEvent): void => {
    if (this.gesture?.pointerId === event.pointerId || this.touches.has(event.pointerId)) this.cancelGesture()
  }

  private lostCapture = (event: PointerEvent): void => {
    if (event.target === this.root) this.cancelPointer(event)
  }

  private finish(cancelled: boolean): void {
    const gesture = this.gesture
    this.gesture = null
    if (this.autoPanFrame !== undefined) this.window?.cancelAnimationFrame(this.autoPanFrame)
    this.autoPanFrame = undefined
    if (gesture === null) return
    this.release(gesture.pointerId)
    this.root.removeAttribute('data-native-canvas-panning')
    const actions = this.get()
    if (!gesture.started) {
      if (!cancelled) this.finishClick(gesture, actions)
      return
    }
    this.suppressClick = true
    switch (gesture.kind) {
      case 'node': actions.endDrag(gesture.positions, cancelled || !actions.nodesDraggable, gesture.latest); break
      case 'connection': {
        const stopped = cancelled || !actions.nodesConnectable || !gesture.from.element.isConnected || !canStartConnection(gesture.from)
        const to = stopped ? null : this.connectionTarget(gesture, actions)
        const abort = stopped || to !== null && !canConnect(gesture.from, to, gesture.from, actions)
        actions.endConnection(gesture.latest, gesture.from, abort ? null : to, abort)
        break
      }
      case 'marquee':
        actions.showMarquee(null)
        actions.finishMarquee?.(gesture.selected, cancelled)
        break
      case 'pan': break
    }
    if (gesture.viewportMoved) actions.endViewport()
  }

  private finishClick(gesture: Gesture, actions: NativeCanvasGestureActions): void {
    if (distance(this.pointer(gesture.latest, gesture.bounds), gesture.start) > DRAG_THRESHOLD) return
    const from = this.clickHandle
    this.clickHandle = null
    if (gesture.kind === 'connection' && actions.nodesConnectable) {
      if (from === null && canStartConnection(gesture.from)) this.clickHandle = gesture.from
      else if (from !== null && canConnect(from, gesture.from, gesture.from, actions)) {
        actions.startConnection(from, gesture.latest)
        actions.endConnection(gesture.latest, from, gesture.from, false)
      }
      return
    }
    if (gesture.kind === 'node') {
      if (gesture.fromSelection === true) return
      const node = actions.nodes.find(entry => entry.id === gesture.nodeId)
      if (node === undefined) return
      const selected = actions.nodes.filter(entry => entry.selected).map(entry => entry.id)
      if (gesture.extend) actions.changeSelection(node.selected ? selected.filter(id => id !== node.id) : [...selected, node.id])
      else if (!node.selected) actions.changeSelection([node.id])
      actions.clickNode(gesture.extend)
    } else if (gesture.kind === 'marquee' || gesture.kind === 'pan' && !gesture.afterPinch) {
      actions.changeSelection([])
      actions.clearPane()
    }
  }

  private connectionTarget(gesture: Gesture & { readonly kind: 'connection' }, actions: NativeCanvasGestureActions): NativeGestureHandle | null {
    const screen = point(gesture.latest)
    const bounds = this.root.getBoundingClientRect()
    if (screen.x < bounds.left || screen.x > bounds.right || screen.y < bounds.top || screen.y > bounds.bottom) return null
    const hit = this.document.elementFromPoint(screen.x, screen.y)
    if (hit === null || !this.root.contains(hit) || hit.closest(NATIVE_CONTROL) !== null || hit.closest(OTHER_SURFACE) !== null) return null
    const viewport = actions.getViewport()
    const direct = hit.closest<HTMLElement>(HANDLE)
    if (direct !== null) return readHandle(direct, bounds, viewport)
    const world = toWorld(this.pointer(gesture.latest, bounds), viewport)
    let closest: NativeGestureHandle | null = null
    let best = CONNECTION_RADIUS
    for (const element of this.root.querySelectorAll<HTMLElement>(HANDLE)) {
      const handle = readHandle(element, bounds, viewport)
      if (handle === null || handle.element === gesture.from.element) continue
      const offset = distance(handle.point, world)
      if (offset > best) continue
      const center = toScreen(handle.point, viewport)
      if (!element.contains(this.document.elementFromPoint(bounds.left + center.x, bounds.top + center.y))) continue
      closest = handle
      best = offset
    }
    return closest
  }

  private click = (event: MouseEvent): void => {
    if (!this.suppressClick || event.detail === 0) return
    this.suppressClick = false
    event.preventDefault()
    event.stopImmediatePropagation()
  }
}

/** Install the native renderer's pointer interactions for one mounted graph. */
export function installNativeCanvasGestures(root: HTMLElement, get: () => NativeCanvasGestureActions) {
  const gestures = new NativeCanvasGestures(root, get)
  gestures.install()
  return { dispose: gestures.dispose, cancelGesture: gestures.cancelGesture, cancelConnection: gestures.cancelConnection }
}
