import { getBezierPath, getViewportForBounds, type FitViewOptions, type Node, type Viewport } from '@xyflow/react'
import type { GraphEdge } from './CanvasEdge.tsx'
import { readCanvasHandleEndpoint, type CanvasHandleCallbacks, type CanvasHandleEndpoint, type NativeCanvasRenderPrimitives } from './canvas-render-primitives.tsx'

type NodeSize = { width: number; height: number }
type NodeMeasure = { id: string; dimensions: NodeSize }
type HandleType = 'source' | 'target'

const RASTER_MARGIN = 128

export interface NativeCanvasCurve {
  readonly edge: GraphEdge
  readonly source: CanvasHandleEndpoint
  readonly target: CanvasHandleEndpoint
  readonly path: string
  readonly x: number
  readonly y: number
}

/** Own the native camera and measured card geometry for one mounted surface. */
export class NativeCanvasScene<N extends Node> implements NativeCanvasRenderPrimitives {
  private root: HTMLElement | null = null
  private world: HTMLElement | null = null
  private raster: HTMLCanvasElement | null = null
  private grid: HTMLElement | null = null
  worldOverlay: HTMLElement | null = null
  screenOverlay: HTMLElement | null = null
  private nodes = new Map<string, N>()
  private elements = new Map<string, HTMLElement>()
  private handleCallbacks = new WeakMap<HTMLElement, CanvasHandleCallbacks>()
  private sizes = new Map<string, NodeSize>()
  private ports = new Map<string, Map<string, CanvasHandleEndpoint>>()
  private resize: ResizeObserver | null = null
  private mutations: MutationObserver | null = null
  private theme: MutationObserver | null = null
  private width = 0
  private height = 0
  private version = 0
  private geometryVersion = 0
  private selectedCount = 0
  private paths: Path2D | null = null
  private frame: number | null = null
  private animationFrame: number | null = null
  private finishAnimation: ((done: boolean) => void) | null = null
  private ink = '#999'
  private paintedViewport: Viewport | null = null
  private gridZoom: number | null = null
  private ready = false
  private listeners = new Set<() => void>()
  private geometryListeners = new Set<() => void>()

  constructor(private viewport: Viewport, private readonly actions: {
    move: (viewport: Viewport) => void
    end: (viewport: Viewport) => void
    measure: (changes: NodeMeasure[]) => void
    ready: () => void
  }) {}

  connect(root: HTMLElement, world: HTMLElement, worldOverlay: HTMLElement, screenOverlay: HTMLElement,
    raster: HTMLCanvasElement, grid: HTMLElement): () => void {
    this.root = root
    this.world = world
    this.raster = raster
    this.grid = grid
    this.theme = new MutationObserver(this.updateInk)
    const { body, documentElement } = root.ownerDocument
    this.theme.observe(body, { attributes: true })
    this.theme.observe(documentElement, { attributes: true })
    this.updateInk()
    this.worldOverlay = worldOverlay
    this.screenOverlay = screenOverlay
    this.resize = new ResizeObserver((entries) => {
      const ids = new Set<string>()
      for (const { target } of entries) {
        if (target === root) this.updateSize()
        else if (target instanceof HTMLElement && target.dataset.id !== undefined) ids.add(target.dataset.id)
      }
      this.measure(ids)
      if (this.width > 0 && this.height > 0 && !this.ready) {
        this.ready = true
        this.actions.ready()
      }
    })
    this.mutations = new MutationObserver((entries) => {
      const ids = new Set<string>()
      for (const { target, addedNodes, removedNodes, type } of entries) {
        if (target instanceof Element && (target.matches('.react-flow__handle') || type === 'childList'
          && [...addedNodes, ...removedNodes].some(node => node instanceof Element
            && (node.matches('.react-flow__handle') || node.querySelector('.react-flow__handle') !== null)))) {
          const id = target.closest<HTMLElement>('.react-flow__node')?.dataset.id
          if (id !== undefined) ids.add(id)
        }
      }
      if (ids.size > 0) this.measure(ids)
    })
    this.mutations.observe(world, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'data-handleid', 'data-handlepos'] })
    this.resize.observe(root)
    for (const element of this.elements.values()) this.resize.observe(element)
    this.applyTransform()
    this.updateSize()
    return () => {
      const view = root.ownerDocument.defaultView
      if (this.frame !== null) view?.cancelAnimationFrame(this.frame)
      this.frame = null
      this.stopAnimation()
      this.resize?.disconnect()
      this.mutations?.disconnect()
      this.theme?.disconnect()
      this.resize = null
      this.mutations = null
      this.theme = null
      this.root = null
      this.world = null
      this.worldOverlay = null
      this.screenOverlay = null
      this.raster = null
      this.grid = null
      this.ready = false
      this.paintedViewport = null
      this.gridZoom = null
    }
  }

  registerNode(id: string, element: HTMLElement | null): void {
    const previous = this.elements.get(id)
    if (previous !== undefined) this.resize?.unobserve(previous)
    if (element === null) {
      this.elements.delete(id)
      this.sizes.delete(id)
      this.ports.delete(id)
    } else {
      this.elements.set(id, element)
      this.resize?.observe(element)
    }
  }

  syncNodes(nodes: readonly N[]): void {
    if (nodes.length === this.nodes.size && nodes.every(node => this.nodes.get(node.id) === node)) return
    this.nodes = new Map(nodes.map(node => [node.id, node]))
    this.selectedCount = nodes.filter(node => node.selected).length
    this.notify()
  }

  setCurves(curves: readonly NativeCanvasCurve[]): void {
    const paths = new Path2D()
    for (const { edge, path } of curves) {
      if (!edge.selected && !edge.data?.hovered && !edge.data?.endpointSelected) paths.addPath(new Path2D(path))
    }
    this.paths = paths
    this.paintSoon()
  }

  getCurves(edges: readonly GraphEdge[], nodes: readonly N[]): NativeCanvasCurve[] {
    const positions = new Map(nodes.map(node => [node.id, node.position]))
    return edges.flatMap((edge) => {
      const source = this.resolvePort(edge.source, edge.sourceHandle ?? null, 'source', positions.get(edge.source))
      const target = this.resolvePort(edge.target, edge.targetHandle ?? null, 'target', positions.get(edge.target))
      if (source === undefined || target === undefined) return []
      const [path, x, y] = getBezierPath({ sourceX: source.x, sourceY: source.y, sourcePosition: source.position,
        targetX: target.x, targetY: target.y, targetPosition: target.position })
      return [{ edge, source, target, path, x, y }]
    })
  }

  getViewport = (): Viewport => this.viewport
  getVersion = (): number => this.version
  getGeometryVersion = (): number => this.geometryVersion
  getSelectedNodeCount = (): number => this.selectedCount
  getSize = (): NodeSize => ({ width: this.width, height: this.height })

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  subscribeGeometry = (listener: () => void): (() => void) => {
    this.geometryListeners.add(listener)
    return () => { this.geometryListeners.delete(listener) }
  }

  getNode = (id: string): N | undefined => {
    const node = this.nodes.get(id)
    const measured = this.sizes.get(id)
    return node === undefined || measured === undefined ? node : { ...node, measured }
  }

  getNodeBounds = (id: string) => {
    const node = this.nodes.get(id)
    const size = this.sizes.get(id)
    return node === undefined || size === undefined ? undefined : { ...node.position, ...size, selected: node.selected === true }
  }

  registerHandleCallbacks = (handle: HTMLElement, callbacks: CanvasHandleCallbacks): (() => void) => {
    this.handleCallbacks.set(handle, callbacks)
    return () => { this.handleCallbacks.delete(handle) }
  }

  getHandleCallbacks = (handle: HTMLElement): CanvasHandleCallbacks | undefined => this.handleCallbacks.get(handle)

  updateNodeLayout = (id: string): void => { this.measure([id]) }

  getHandleEndpoint = (id: string, handleId: string | null, type: HandleType): CanvasHandleEndpoint | undefined =>
    this.resolvePort(id, handleId, type, this.nodes.get(id)?.position)

  private resolvePort(id: string, handleId: string | null, type: HandleType, position: N['position'] | undefined) {
    const offset = this.ports.get(id)?.get(handleId === null ? type : `${type}:${handleId}`)
    return offset === undefined || position === undefined ? undefined : { ...offset, x: offset.x + position.x, y: offset.y + position.y }
  }

  screenToFlowPosition = ({ x, y }: { x: number; y: number }): { x: number; y: number } => {
    const rect = this.root?.getBoundingClientRect()
    return { x: (x - (rect?.left ?? 0) - this.viewport.x) / this.viewport.zoom,
      y: (y - (rect?.top ?? 0) - this.viewport.y) / this.viewport.zoom }
  }

  move(next: Viewport): void {
    if (next.x === this.viewport.x && next.y === this.viewport.y && next.zoom === this.viewport.zoom) return
    this.viewport = next
    this.applyTransform()
    this.actions.move(next)
    this.notify()
  }

  end = (): void => { this.actions.end(this.viewport) }

  setViewport(next: Viewport, duration = 0): Promise<boolean> {
    this.stopAnimation()
    const view = this.root?.ownerDocument.defaultView
    if (view === undefined || view === null) return Promise.resolve(false)
    if (duration === 0) {
      this.move(next)
      this.end()
      return Promise.resolve(true)
    }
    const start = this.viewport
    const started = view.performance.now()
    return new Promise((resolve) => {
      this.finishAnimation = resolve
      const animate = (time: number): void => {
        const fraction = Math.min(1, (time - started) / duration)
        const ease = 1 - (1 - fraction) ** 3
        this.move({ x: start.x + (next.x - start.x) * ease, y: start.y + (next.y - start.y) * ease,
          zoom: start.zoom + (next.zoom - start.zoom) * ease })
        if (fraction < 1) this.animationFrame = view.requestAnimationFrame(animate)
        else {
          this.animationFrame = null
          this.finishAnimation = null
          this.end()
          resolve(true)
        }
      }
      this.animationFrame = view.requestAnimationFrame(animate)
    })
  }

  stopAnimation(): void {
    if (this.animationFrame !== null) this.root?.ownerDocument.defaultView?.cancelAnimationFrame(this.animationFrame)
    this.animationFrame = null
    this.finishAnimation?.(false)
    this.finishAnimation = null
  }

  fit(options: FitViewOptions | undefined, minZoom: number, maxZoom: number): Promise<boolean> {
    if (this.width === 0 || this.height === 0) return Promise.resolve(false)
    const ids = options?.nodes?.map(({ id }) => id) ?? [...this.nodes.keys()]
    let left = Infinity; let top = Infinity; let right = -Infinity; let bottom = -Infinity
    for (const id of ids) {
      const bounds = this.getNodeBounds(id)
      if (bounds === undefined) continue
      left = Math.min(left, bounds.x)
      top = Math.min(top, bounds.y)
      right = Math.max(right, bounds.x + bounds.width)
      bottom = Math.max(bottom, bounds.y + bounds.height)
    }
    if (left === Infinity) return Promise.resolve(false)
    return this.setViewport(getViewportForBounds({ x: left, y: top, width: right - left, height: bottom - top },
      this.width, this.height, options?.minZoom ?? minZoom, options?.maxZoom ?? maxZoom, options?.padding ?? 0.1), options?.duration)
  }

  zoomTo(zoom: number, duration?: number): Promise<boolean> {
    const { width, height } = this.getSize()
    const ratio = zoom / this.viewport.zoom
    return this.setViewport({ zoom, x: width / 2 - (width / 2 - this.viewport.x) * ratio,
      y: height / 2 - (height / 2 - this.viewport.y) * ratio }, duration)
  }

  private measure(ids: Iterable<string>): void {
    const root = this.root
    if (root === null || this.width === 0 || this.height === 0) return
    const changes: NodeMeasure[] = []
    let portsChanged = false
    const rect = root.getBoundingClientRect()
    for (const id of ids) {
      const element = this.elements.get(id)
      if (element === undefined) continue
      const width = element.offsetWidth
      const height = element.offsetHeight
      if (width === 0 || height === 0) continue
      const old = this.sizes.get(id)
      if (old?.width !== width || old.height !== height) {
        const dimensions = { width, height }
        this.sizes.set(id, dimensions)
        changes.push({ id, dimensions })
      }
      const nodeRect = element.getBoundingClientRect()
      const previous = this.ports.get(id)
      const next = new Map<string, CanvasHandleEndpoint>()
      for (const handle of element.querySelectorAll<HTMLElement>('.react-flow__handle')) {
        const point = readCanvasHandleEndpoint(handle, root, this.viewport)
        if (point === undefined) continue
        const offset = { x: point.x - (nodeRect.left - rect.left - this.viewport.x) / this.viewport.zoom,
          y: point.y - (nodeRect.top - rect.top - this.viewport.y) / this.viewport.zoom, position: point.position }
        const type = handle.classList.contains('target') ? 'target' : 'source'
        const key = `${type}:${handle.dataset.handleid ?? ''}`
        next.set(key, offset)
        if (!next.has(type)) next.set(type, offset)
        const oldPort = previous?.get(key)
        if (oldPort?.position !== offset.position || Math.abs(oldPort.x - offset.x) > 0.01
          || Math.abs(oldPort.y - offset.y) > 0.01) portsChanged = true
      }
      if (previous?.size !== next.size) portsChanged = true
      this.ports.set(id, next)
    }
    if (changes.length > 0) this.actions.measure(changes)
    if (changes.length > 0 || portsChanged) this.notifyGeometry()
  }

  private updateSize(): void {
    const root = this.root
    if (root === null) return
    const oldWidth = this.width
    const oldHeight = this.height
    this.width = root.clientWidth
    this.height = root.clientHeight
    if (oldWidth === 0 && this.width > 0 && this.height > 0) this.measure(this.elements.keys())
    if (oldWidth !== this.width || oldHeight !== this.height) {
      this.notify()
      this.paintSoon()
    }
  }

  private notify(): void {
    this.version++
    for (const listener of this.listeners) listener()
  }

  private notifyGeometry(): void {
    this.geometryVersion++
    for (const listener of this.geometryListeners) listener()
    this.notify()
  }

  private applyTransform(): void {
    const { x, y, zoom } = this.viewport
    if (this.world !== null) this.world.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`
    if (this.grid !== null) {
      const step = 24 * zoom
      if (zoom !== this.gridZoom) {
        this.grid.style.setProperty('--canvas-grid-step', `${step}px`)
        this.grid.style.setProperty('--canvas-grid-dot', `${zoom / 2}px`)
        this.gridZoom = zoom
      }
      // Reuse the grid tile during pan; the extra tiles around the viewport hide its seams.
      this.grid.style.transform = `translate(${x % step}px, ${y % step}px)`
    }
    this.moveRaster()
  }

  private updateInk = (): void => {
    if (this.root === null) return
    const ink = this.root.ownerDocument.defaultView?.getComputedStyle(this.root)
      .getPropertyValue('--dsw-alias-label-tertiary').trim()
    if (ink !== undefined && ink !== '' && ink !== this.ink) {
      this.ink = ink
      this.paintSoon()
    }
  }

  private moveRaster(): void {
    const painted = this.paintedViewport
    if (painted === null || this.raster === null) { this.paintSoon(); return }
    const { x, y, zoom } = this.viewport
    const scale = zoom / painted.zoom
    const dx = x - painted.x * scale + RASTER_MARGIN * (1 - scale)
    const dy = y - painted.y * scale + RASTER_MARGIN * (1 - scale)
    this.raster.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`
    if (scale !== 1 || Math.abs(dx) > RASTER_MARGIN - 24 || Math.abs(dy) > RASTER_MARGIN - 24) this.paintSoon()
  }

  private paintSoon(): void {
    const view = this.root?.ownerDocument.defaultView
    if (this.frame !== null || view === undefined || view === null) return
    this.frame = view.requestAnimationFrame(() => {
      this.frame = null
      const root = this.root
      const raster = this.raster
      const context = raster?.getContext('2d')
      if (root === null || raster === null || context === null || context === undefined) return
      const ratio = Math.min(view.devicePixelRatio, 2)
      const width = Math.round((this.width + 2 * RASTER_MARGIN) * ratio)
      const height = Math.round((this.height + 2 * RASTER_MARGIN) * ratio)
      if (raster.width !== width) raster.width = width
      if (raster.height !== height) raster.height = height
      context.resetTransform()
      context.clearRect(0, 0, width, height)
      const { x, y, zoom } = this.viewport
      if (this.paths !== null) {
        context.setTransform(ratio * zoom, 0, 0, ratio * zoom, ratio * (x + RASTER_MARGIN), ratio * (y + RASTER_MARGIN))
        context.strokeStyle = this.ink
        context.lineWidth = 1 / zoom
        context.stroke(this.paths)
      }
      this.paintedViewport = this.viewport
      raster.style.transform = ''
    })
  }
}
