/** Field-level graph history preserves edits outside the original operation. */
import { isDeepStrictEqual } from 'node:util'
import type { CanvasConnection, CanvasData, CanvasDocument, CanvasNode, CanvasNodeId, CanvasNodeTypeId, CanvasPoint, CanvasTitleFormat } from './types.ts'

/** Values inspected and replaced by one reversible edit. */
export interface CanvasFieldChange<T> {
  before: T
  after: T
}

/** Provider payload and its interpretation version change together. */
export interface CanvasHistoryData {
  dataVersion: number
  data: CanvasData
}

/** Node history distinguishes identity changes from edits to existing fields. */
export type CanvasNodeDelta =
  | { kind: 'added' | 'removed'; node: CanvasNode; index: number }
  | {
    kind: 'updated'
    nodeId: CanvasNodeId
    typeId: CanvasNodeTypeId
    position?: CanvasFieldChange<CanvasPoint>
    data?: CanvasFieldChange<CanvasHistoryData>
  }

/** Connections keep their immutable identities and original drawing order. */
export interface CanvasConnectionDelta {
  kind: 'added' | 'removed'
  connection: CanvasConnection
  index: number
}

/** Durable effects of one graph operation, excluding revisions and conversation state. */
export interface CanvasDelta {
  title?: CanvasFieldChange<string>
  titleFormat?: CanvasFieldChange<CanvasTitleFormat | null>
  nodes: CanvasNodeDelta[]
  connections: CanvasConnectionDelta[]
}

function nodeContent(node: CanvasNode): Omit<CanvasNode, 'revision'> {
  const { revision: _revision, ...content } = node
  return content
}

/**
 * Capture changed fields between committed versions of one canvas.
 * @param before - Canvas immediately before an operation; node types and connection identities are immutable.
 * @param after - Canvas immediately after the same operation.
 * @returns A detached delta with the original array positions of added or removed entries.
 */
export function buildCanvasDelta(before: CanvasDocument, after: CanvasDocument): CanvasDelta {
  const delta: CanvasDelta = { nodes: [], connections: [] }
  if (before.title !== after.title) delta.title = { before: before.title, after: after.title }
  if (!isDeepStrictEqual(before.titleFormat, after.titleFormat)) {
    delta.titleFormat = { before: structuredClone(before.titleFormat ?? null), after: structuredClone(after.titleFormat ?? null) }
  }
  const previous = new Map(before.nodes.map(node => [node.id, node]))
  const next = new Map(after.nodes.map(node => [node.id, node]))
  before.nodes.forEach((node, index) => {
    if (!next.has(node.id)) delta.nodes.push({ kind: 'removed', node: structuredClone(node), index })
  })
  after.nodes.forEach((node, index) => {
    const original = previous.get(node.id)
    if (original === undefined) { delta.nodes.push({ kind: 'added', node: structuredClone(node), index }); return }
    if (original.typeId !== node.typeId) throw new TypeError('History cannot replace an existing node type')
    const position = isDeepStrictEqual(original.position, node.position) ? undefined
      : { before: structuredClone(original.position), after: structuredClone(node.position) }
    const data = original.dataVersion === node.dataVersion && isDeepStrictEqual(original.data, node.data) ? undefined
      : { before: { dataVersion: original.dataVersion, data: structuredClone(original.data) },
        after: { dataVersion: node.dataVersion, data: structuredClone(node.data) } }
    if (position !== undefined || data !== undefined) delta.nodes.push({ kind: 'updated', nodeId: node.id, typeId: node.typeId,
      ...(position === undefined ? {} : { position }), ...(data === undefined ? {} : { data }) })
  })
  const oldEdges = new Map(before.connections.map(edge => [edge.id, edge]))
  const newEdges = new Map(after.connections.map(edge => [edge.id, edge]))
  before.connections.forEach((connection, index) => {
    if (!newEdges.has(connection.id)) delta.connections.push({ kind: 'removed', connection: structuredClone(connection), index })
  })
  after.connections.forEach((connection, index) => {
    const original = oldEdges.get(connection.id)
    if (original === undefined) delta.connections.push({ kind: 'added', connection: structuredClone(connection), index })
    else if (!isDeepStrictEqual(original, connection)) throw new TypeError('History cannot replace an existing connection')
  })
  return delta
}

/**
 * Guard every affected field before applying a complete inverse or replay.
 * @param current - Latest committed canvas; unrelated fields and entries are retained.
 * @param delta - Original durable operation effects.
 * @param direction - Undo replaces after values with before values; redo does the reverse.
 * @param revisionCounters - Highest removed revision for each node identity.
 * @returns A detached canvas without changing its canvas revision, or a conflict without any mutation.
 */
export function applyCanvasDelta(
  current: CanvasDocument, delta: CanvasDelta, direction: 'undo' | 'redo', revisionCounters: ReadonlyMap<CanvasNodeId, number>,
): { ok: true; canvas: CanvasDocument } | { ok: false; message: string } {
  const from = direction === 'undo' ? 'after' : 'before'
  const to = direction === 'undo' ? 'before' : 'after'
  const removingKind = direction === 'undo' ? 'added' : 'removed'
  const removingNodes = new Set(delta.nodes.flatMap(change => change.kind === removingKind ? [change.node.id] : []))
  const removingEdges = new Set(delta.connections.filter(change => change.kind === removingKind).map(change => change.connection.id))
  if (delta.title !== undefined && current.title !== delta.title[from]) return { ok: false, message: 'Canvas title changed after this edit' }
  if (delta.titleFormat !== undefined && !isDeepStrictEqual(current.titleFormat ?? null, delta.titleFormat[from])) {
    return { ok: false, message: 'Canvas naming changed after this edit' }
  }
  for (const change of delta.nodes) {
    if (change.kind === 'updated') {
      const node = current.nodes.find(node => node.id === change.nodeId)
      if (node === undefined || node.typeId !== change.typeId) return { ok: false, message: 'An edited node is no longer available' }
      if (change.position !== undefined && !isDeepStrictEqual(node.position, change.position[from])) {
        return { ok: false, message: 'An edited node moved after this edit' }
      }
      if (change.data !== undefined && !isDeepStrictEqual({ dataVersion: node.dataVersion, data: node.data }, change.data[from])) {
        return { ok: false, message: 'An edited node payload changed after this edit' }
      }
    } else {
      const node = current.nodes.find(node => node.id === change.node.id)
      if (change.kind === removingKind) {
        if (node === undefined || !isDeepStrictEqual(nodeContent(node), nodeContent(change.node))) {
          return { ok: false, message: 'A removed node changed after this edit' }
        }
      } else if (node !== undefined) return { ok: false, message: 'A restored node identity already exists' }
    }
  }
  for (const change of delta.connections) {
    const edge = current.connections.find(edge => edge.id === change.connection.id)
    if (change.kind === removingKind) {
      if (!isDeepStrictEqual(edge, change.connection)) return { ok: false, message: 'A removed connection changed after this edit' }
    } else if (edge !== undefined) return { ok: false, message: 'A restored connection identity already exists' }
  }
  if (current.connections.some(edge => (removingNodes.has(edge.source) || removingNodes.has(edge.target)) && !removingEdges.has(edge.id))) {
    return { ok: false, message: 'A removed node has connections created after this edit' }
  }

  const canvas = structuredClone(current)
  if (delta.title !== undefined) canvas.title = delta.title[to]
  if (delta.titleFormat !== undefined) {
    const format = delta.titleFormat[to]
    if (format === null) delete canvas.titleFormat
    else canvas.titleFormat = structuredClone(format)
  }
  canvas.connections = canvas.connections.filter(edge => !removingEdges.has(edge.id))
  canvas.nodes = canvas.nodes.filter(node => !removingNodes.has(node.id))
  const updates = new Map(delta.nodes.flatMap(change => change.kind === 'updated' ? [[change.nodeId, change] as const] : []))
  for (const node of canvas.nodes) {
    const change = updates.get(node.id)
    if (change === undefined) continue
    if (change.position !== undefined) node.position = structuredClone(change.position[to])
    if (change.data !== undefined) Object.assign(node, structuredClone(change.data[to]))
    node.revision = Math.max(node.revision, revisionCounters.get(node.id) ?? 0) + 1
  }
  const restoring = delta.nodes.filter((change): change is Extract<CanvasNodeDelta, { node: CanvasNode }> =>
    change.kind !== 'updated' && change.kind !== removingKind).sort((left, right) => left.index - right.index)
  for (const change of restoring) {
    const node = structuredClone(change.node)
    node.revision = Math.max(node.revision, revisionCounters.get(node.id) ?? 0) + 1
    canvas.nodes.splice(change.index, 0, node)
  }
  for (const change of delta.connections.filter(change => change.kind !== removingKind).sort((left, right) => left.index - right.index)) {
    if (!canvas.nodes.some(node => node.id === change.connection.source)
      || !canvas.nodes.some(node => node.id === change.connection.target)) {
      return { ok: false, message: 'A restored connection endpoint no longer exists' }
    }
    canvas.connections.splice(change.index, 0, structuredClone(change.connection))
  }
  return { ok: true, canvas }
}
