/** Nearest node edges and center lines snap a drag without changing a selected group's spacing. */
import type { CanvasNodeId, CanvasPoint } from '@deepseek-ai/dsh-convax-plugin-host/types'

/** Measured node geometry in canvas coordinates at the start of a drag. */
export interface SnapNodeBounds extends CanvasPoint {
  readonly id: CanvasNodeId
  readonly width: number
  readonly height: number
}

interface SnapCoordinate {
  readonly coordinate: number
  readonly source: SnapNodeBounds
  readonly order: number
}

/** Drag-local sorted candidates exclude all nodes participating in that drag. */
export interface CanvasSnapGesture {
  readonly moving: readonly SnapNodeBounds[]
  readonly x: readonly SnapCoordinate[]
  readonly y: readonly SnapCoordinate[]
}

/** One world-coordinate line connecting a dragged node and the alignment target. */
export interface CanvasSnapGuide {
  readonly axis: 'x' | 'y'
  readonly coordinate: number
  readonly from: number
  readonly to: number
}

function axisIndex(nodes: readonly SnapNodeBounds[], axis: 'x' | 'y'): SnapCoordinate[] {
  const coordinates = new Map<number, SnapCoordinate>()
  let order = 0
  for (const node of nodes) {
    const size = axis === 'x' ? node.width : node.height
    for (const coordinate of [node[axis], node[axis] + size / 2, node[axis] + size]) {
      if (!coordinates.has(coordinate)) coordinates.set(coordinate, { coordinate, source: node, order })
      order++
    }
  }
  return [...coordinates.values()].sort((a, b) => a.coordinate - b.coordinate)
}

/**
 * Build sorted edge and center candidates once when a drag begins.
 * @param nodes - All measured nodes, in document order.
 * @param movingIds - Every node moved by this pointer gesture.
 * @returns Drag-local movers and candidate indexes.
 */
export function createCanvasSnapGesture(nodes: readonly SnapNodeBounds[], movingIds: ReadonlySet<CanvasNodeId>): CanvasSnapGesture {
  const candidates = nodes.filter(node => !movingIds.has(node.id))
  return { moving: nodes.filter(node => movingIds.has(node.id)), x: axisIndex(candidates, 'x'), y: axisIndex(candidates, 'y') }
}

function nearest(index: readonly SnapCoordinate[], value: number, tolerance: number): SnapCoordinate | undefined {
  let low = 0
  let high = index.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = index[middle]
    if (candidate === undefined) throw new RangeError('Snap index is missing its binary-search midpoint')
    if (candidate.coordinate < value) low = middle + 1
    else high = middle
  }
  let best: SnapCoordinate | undefined
  for (const candidate of [index[low - 1], index[low]]) {
    if (candidate === undefined) continue
    const distance = Math.abs(candidate.coordinate - value)
    if (distance > tolerance) continue
    if (best === undefined || distance < Math.abs(best.coordinate - value)
      || (distance === Math.abs(best.coordinate - value) && candidate.order < best.order)) best = candidate
  }
  return best
}

interface AxisSnap {
  readonly offset: number
  readonly target: SnapCoordinate
}

function snapAxis(gesture: CanvasSnapGesture, delta: CanvasPoint, axis: 'x' | 'y', tolerance: number): AxisSnap | undefined {
  let best: AxisSnap | undefined
  for (const node of gesture.moving) {
    const size = axis === 'x' ? node.width : node.height
    for (const value of [node[axis], node[axis] + size / 2, node[axis] + size]) {
      const moved = value + delta[axis]
      const target = nearest(gesture[axis], moved, tolerance)
      if (target === undefined) continue
      const offset = target.coordinate - moved
      if (best === undefined || Math.abs(offset) < Math.abs(best.offset)) best = { offset, target }
    }
  }
  return best
}

/**
 * Resolve the nearest alignment using a six-CSS-pixel threshold at every zoom.
 * @param gesture - Measured movers and stable candidate indexes captured at drag start.
 * @param delta - Raw pointer displacement in canvas coordinates.
 * @param zoom - Current positive canvas zoom.
 * @returns Corrected positions and the matching horizontal or vertical guides.
 */
export function snapCanvasDrag(gesture: CanvasSnapGesture, delta: CanvasPoint, zoom: number): {
  readonly positions: ReadonlyMap<CanvasNodeId, CanvasPoint>
  readonly guides: readonly CanvasSnapGuide[]
} {
  const x = snapAxis(gesture, delta, 'x', 6 / zoom)
  const y = snapAxis(gesture, delta, 'y', 6 / zoom)
  const corrected = { x: delta.x + (x?.offset ?? 0), y: delta.y + (y?.offset ?? 0) }
  const positions = new Map(gesture.moving.map(node => [node.id, { x: node.x + corrected.x, y: node.y + corrected.y }]))
  const guides: CanvasSnapGuide[] = []
  if (x !== undefined) {
    const top = Math.min(x.target.source.y, ...gesture.moving.map(node => node.y + corrected.y))
    const bottom = Math.max(x.target.source.y + x.target.source.height, ...gesture.moving.map(node => node.y + corrected.y + node.height))
    guides.push({ axis: 'x', coordinate: x.target.coordinate, from: top - 12 / zoom, to: bottom + 12 / zoom })
  }
  if (y !== undefined) {
    const left = Math.min(y.target.source.x, ...gesture.moving.map(node => node.x + corrected.x))
    const right = Math.max(y.target.source.x + y.target.source.width, ...gesture.moving.map(node => node.x + corrected.x + node.width))
    guides.push({ axis: 'y', coordinate: y.target.coordinate, from: left - 12 / zoom, to: right + 12 / zoom })
  }
  return { positions, guides }
}
