/** Field-level graph history preserves edits outside the original operation. */
import { isDeepStrictEqual } from 'node:util'
import type { CanvasConnection, CanvasData, CanvasDocument, CanvasNode, CanvasNodeId, CanvasNodeTypeId, CanvasPoint, CanvasTitleFormat, CanvasGroup, CanvasGroupId, CanvasGroupColor } from './types.ts'

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
    groupId?: CanvasFieldChange<CanvasGroupId | null>
  }

/** Structural group records have no provider payload or window geometry. */
export type CanvasGroupDelta =
  | { kind: 'added' | 'removed'; group: CanvasGroup; index: number }
  | { kind: 'updated'; groupId: CanvasGroupId; title?: CanvasFieldChange<string>; color?: CanvasFieldChange<CanvasGroupColor | null> }

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
  groups?: CanvasGroupDelta[]
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
    const groupId = original.groupId === node.groupId ? undefined : { before: original.groupId ?? null, after: node.groupId ?? null }
    if (position !== undefined || data !== undefined || groupId !== undefined) delta.nodes.push({ kind: 'updated', nodeId: node.id, typeId: node.typeId,
      ...(position === undefined ? {} : { position }), ...(data === undefined ? {} : { data }),
      ...(groupId === undefined ? {} : { groupId }) })
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
  const groups: CanvasGroupDelta[] = []
  const previousGroups = new Map((before.groups ?? []).map(group => [group.id, group]))
  const nextGroups = new Map((after.groups ?? []).map(group => [group.id, group]))
  for (const [index, group] of (before.groups ?? []).entries()) {
    if (!nextGroups.has(group.id)) groups.push({ kind: 'removed', group: structuredClone(group), index })
  }
  for (const [index, group] of (after.groups ?? []).entries()) {
    const original = previousGroups.get(group.id)
    if (original === undefined) groups.push({ kind: 'added', group: structuredClone(group), index })
    else {
      const title = original.title === group.title ? undefined : { before: original.title, after: group.title }
      const color = original.color === group.color ? undefined : { before: original.color ?? null, after: group.color ?? null }
      if (title !== undefined || color !== undefined) groups.push({ kind: 'updated', groupId: group.id,
        ...(title === undefined ? {} : { title }), ...(color === undefined ? {} : { color }),
      })
    }
  }
  if (groups.length > 0) delta.groups = groups
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
      if (change.groupId !== undefined && (node.groupId ?? null) !== change.groupId[from]) {
        return { ok: false, message: 'An edited node changed groups after this edit' }
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
  for (const change of delta.groups ?? []) {
    const group = current.groups?.find(group => group.id === (change.kind === 'updated' ? change.groupId : change.group.id))
    if (change.kind === 'updated') {
      if (group === undefined || change.title !== undefined && group.title !== change.title[from]
        || change.color !== undefined && (group.color ?? null) !== change.color[from]) {
        return { ok: false, message: 'An edited group changed after this edit' }
      }
    } else if (change.kind === removingKind) {
      if (!isDeepStrictEqual(group, change.group)) return { ok: false, message: 'A removed group changed after this edit' }
    } else if (group !== undefined) return { ok: false, message: 'A restored group identity already exists' }
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
    if (change.groupId !== undefined) {
      const groupId = change.groupId[to]
      if (groupId === null) delete node.groupId
      else node.groupId = groupId
    }
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
  if (delta.groups !== undefined) {
    const removingGroups = new Set(delta.groups.flatMap(change => change.kind === removingKind ? [change.group.id] : []))
    const groups = (canvas.groups ?? []).filter(group => !removingGroups.has(group.id))
    for (const change of delta.groups) {
      if (change.kind !== 'updated') continue
      const group = groups.find(group => group.id === change.groupId)
      if (group !== undefined) {
        if (change.title !== undefined) group.title = change.title[to]
        if (change.color !== undefined) {
          const color = change.color[to]
          if (color === null) delete group.color
          else group.color = color
        }
      }
    }
    const restoring = delta.groups.filter((change): change is Extract<CanvasGroupDelta, { group: CanvasGroup }> =>
      change.kind !== 'updated' && change.kind !== removingKind).sort((left, right) => left.index - right.index)
    for (const change of restoring) groups.splice(change.index, 0, structuredClone(change.group))
    if (groups.length === 0) delete canvas.groups
    else canvas.groups = groups
  }
  const groupIds = new Set((canvas.groups ?? []).map(group => group.id))
  if (canvas.nodes.some(node => node.groupId !== undefined && !groupIds.has(node.groupId))
    || (canvas.groups ?? []).some(group => !canvas.nodes.some(node => node.groupId === group.id))) {
    return { ok: false, message: 'Group membership changed after this edit' }
  }
  return { ok: true, canvas }
}
