/** Place independent graph copies near the intended point while preserving their relative coordinates. */
import type { CanvasCommand, CanvasData, CanvasNode, CanvasConnectionId, CanvasNodeId, CanvasPoint } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { clipboardNodeData, type CanvasClipboardPayload, type ClipboardNodeSize } from './canvas-clipboard.ts'
import { RESOURCE_CARD_GAP } from './placement.ts'

/** A measured graph rectangle that a pasted selection should avoid. */
export interface ClipboardObstacle extends CanvasPoint, ClipboardNodeSize {}

function nodeSize(payload: CanvasClipboardPayload, nodeId: CanvasNodeId): ClipboardNodeSize {
  const size = payload.dimensions[nodeId]
  if (size === undefined) throw new Error('Clipboard node dimensions are missing')
  return size
}

/**
 * Measure the copied selection using the geometry captured with its nodes.
 * @param payload - Validated graph clipboard contents.
 * @returns The copied selection's outer rectangle.
 */
export function canvasClipboardBounds(payload: CanvasClipboardPayload): ClipboardObstacle {
  let x = Number.POSITIVE_INFINITY
  let y = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const node of payload.nodes) {
    const size = nodeSize(payload, node.id)
    x = Math.min(x, node.position.x)
    y = Math.min(y, node.position.y)
    right = Math.max(right, node.position.x + size.width)
    bottom = Math.max(bottom, node.position.y + size.height)
  }
  return { x, y, width: right - x, height: bottom - y }
}

function collides(a: ClipboardObstacle, b: ClipboardObstacle): boolean {
  return a.x < b.x + b.width + RESOURCE_CARD_GAP && a.x + a.width + RESOURCE_CARD_GAP > b.x
    && a.y < b.y + b.height + RESOURCE_CARD_GAP && a.y + a.height + RESOURCE_CARD_GAP > b.y
}

function freeOrigin(payload: CanvasClipboardPayload, desired: CanvasPoint, obstacles: readonly ClipboardObstacle[]): CanvasPoint {
  const bounds = canvasClipboardBounds(payload)
  const relative = payload.nodes.map(node => ({
    x: node.position.x - bounds.x, y: node.position.y - bounds.y, ...nodeSize(payload, node.id),
  }))
  const candidates: CanvasPoint[] = [desired]
  const seen = new Set([`${desired.x}:${desired.y}`])
  const distance = (point: CanvasPoint): number => (point.x - desired.x) ** 2 + (point.y - desired.y) ** 2
  const nextCandidate = (): CanvasPoint | undefined => {
    candidates.sort((a, b) => distance(b) - distance(a))
    return candidates.pop()
  }
  for (let point = nextCandidate(); point !== undefined; point = nextCandidate()) {
    let collision: { moving: ClipboardObstacle; obstacle: ClipboardObstacle } | undefined
    for (const moving of relative) {
      const obstacle = obstacles.find(item => collides({ ...moving, x: moving.x + point.x, y: moving.y + point.y }, item))
      if (obstacle !== undefined) { collision = { moving, obstacle }; break }
    }
    if (collision === undefined) return point
    const { moving, obstacle } = collision
    for (const next of [
      { x: obstacle.x + obstacle.width + RESOURCE_CARD_GAP - moving.x, y: point.y },
      { x: obstacle.x - moving.width - RESOURCE_CARD_GAP - moving.x, y: point.y },
      { x: point.x, y: obstacle.y + obstacle.height + RESOURCE_CARD_GAP - moving.y },
      { x: point.x, y: obstacle.y - moving.height - RESOURCE_CARD_GAP - moving.y },
    ]) {
      if (!Number.isFinite(next.x) || !Number.isFinite(next.y)) continue
      const key = `${next.x}:${next.y}`
      if (!seen.has(key)) { seen.add(key); candidates.push(next) }
    }
  }
  throw new RangeError('Copied nodes cannot be placed at finite coordinates')
}

/**
 * Allocate fresh identities and atomically remap all internal copied connections.
 * @param payload - Validated clipboard nodes, edges and geometry.
 * @param desired - Intended top-left selection position in world coordinates.
 * @param obstacles - Current measured cards to avoid.
 * @param allocate - Fresh opaque identity allocator for this copy operation.
 * @returns One Host command containing independent nodes and remapped internal edges.
 */
export function createClipboardSubgraph(
  payload: CanvasClipboardPayload, desired: CanvasPoint, obstacles: readonly ClipboardObstacle[], allocate: () => string,
  copyData: (node: CanvasNode) => CanvasData = clipboardNodeData,
): Extract<CanvasCommand, { kind: 'add-subgraph' }> {
  const source = canvasClipboardBounds(payload)
  if (![source.x, source.y, source.width, source.height, desired.x, desired.y].every(Number.isFinite)) {
    throw new RangeError('Clipboard selection geometry is not finite')
  }
  const origin = freeOrigin(payload, desired, obstacles)
  const ids = new Map<CanvasNodeId, CanvasNodeId>()
  const nodes = payload.nodes.map((node) => {
    const id = allocate() as CanvasNodeId
    ids.set(node.id, id)
    const position = { x: origin.x + (node.position.x - source.x), y: origin.y + (node.position.y - source.y) }
    const size = nodeSize(payload, node.id)
    if (![position.x, position.y, position.x + size.width, position.y + size.height].every(Number.isFinite)) {
      throw new RangeError('Copied node coordinates are not finite')
    }
    return { ...node, id, revision: 1, data: copyData(node), position }
  })
  return { kind: 'add-subgraph', nodes, connections: payload.connections.map((edge) => {
    const source = ids.get(edge.source)
    const target = ids.get(edge.target)
    if (source === undefined || target === undefined) throw new Error('Clipboard connection leaves its selection')
    return { ...edge, id: allocate() as CanvasConnectionId, source, target }
  }) }
}
