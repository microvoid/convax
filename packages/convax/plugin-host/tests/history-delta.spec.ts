/** Graph history guards affected fields and retains independent edits. */
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { applyCanvasDelta, buildCanvasDelta } from '../src/history-delta.ts'
import type { CanvasConnection, CanvasConnectionId, CanvasDocument, CanvasId, CanvasNode, CanvasNodeId, CanvasNodeTypeId } from '../src/types.ts'

function node(id: string, x = 0): CanvasNode {
  return { id: brandString<CanvasNodeId>(id), typeId: brandString<CanvasNodeTypeId>('test.resource'),
    dataVersion: 1, data: { path: `/${id}.txt` }, position: { x, y: 0 }, revision: 3 }
}
function edge(id: string, source: CanvasNode, target: CanvasNode): CanvasConnection {
  return { id: brandString<CanvasConnectionId>(id), source: source.id, target: target.id,
    sourcePort: 'output', targetPort: 'input', purpose: 'input' }
}
function document(nodes: CanvasNode[], connections: CanvasConnection[] = []): CanvasDocument {
  return { id: brandString<CanvasId>('canvas'), title: 'Files', revision: 10, nodes, connections }
}
function accepted(result: ReturnType<typeof applyCanvasDelta>): CanvasDocument {
  if (!result.ok) throw new Error(result.message)
  return result.canvas
}

describe('canvas history deltas', () => {
  it('captures changed fields and original drawing positions without retaining mutable graph objects or revisions', () => {
    const a = node('a')
    const b = node('b')
    const c = node('c')
    const before = document([a, b], [edge('ab', a, b)])
    const after = document([{ ...a, position: { x: 5, y: 0 }, revision: 9 }, c], [edge('ac', a, c)])
    const delta = buildCanvasDelta(before, after)
    expect(delta).toEqual({ nodes: [
      { kind: 'removed', node: b, index: 1 },
      { kind: 'updated', nodeId: a.id, typeId: a.typeId, position: { before: { x: 0, y: 0 }, after: { x: 5, y: 0 } } },
      { kind: 'added', node: c, index: 1 },
    ], connections: [
      { kind: 'removed', connection: before.connections[0], index: 0 },
      { kind: 'added', connection: after.connections[0], index: 0 },
    ] })
    b.data.path = '/changed.txt'
    c.position.x = 99
    before.connections[0]!.sourcePort = 'changed'
    expect(delta.nodes[0]).toMatchObject({ node: { data: { path: '/b.txt' } } })
    expect(delta.nodes[2]).toMatchObject({ node: { position: { x: 0, y: 0 } } })
    expect(delta.connections[0]!.connection.sourcePort).toBe('output')
    expect(buildCanvasDelta(document([a]), document([{ ...a, revision: 99 }]))).toEqual({ nodes: [], connections: [] })
  })

  it('undoes and redoes a move while retaining later provider data and increasing the node revision', () => {
    const a = node('a')
    const before = document([a])
    const after = document([{ ...a, position: { x: 5, y: 10 }, revision: 4 }])
    const delta = buildCanvasDelta(before, after)
    const current = document([{ ...after.nodes[0]!, data: { path: '/agent-edited.txt' }, revision: 8 }])
    const snapshot = structuredClone(current)
    const undone = accepted(applyCanvasDelta(current, delta, 'undo', new Map()))
    expect(undone.nodes[0]).toEqual({ ...snapshot.nodes[0]!, position: a.position, revision: 9 })
    expect(undone.revision).toBe(10)
    expect(current).toEqual(snapshot)
    const redone = accepted(applyCanvasDelta(undone, delta, 'redo', new Map()))
    expect(redone.nodes[0]).toEqual({ ...snapshot.nodes[0]!, revision: 10 })
    const conflict = structuredClone(current)
    conflict.nodes[0]!.position.x = 6
    expect(applyCanvasDelta(conflict, delta, 'undo', new Map())).toMatchObject({ ok: false })
  })

  it('undoes provider payload edits without undoing a later move, and refuses a migrated payload', () => {
    const a = node('a')
    const before = document([a])
    const after = document([{ ...a, data: { path: '/renamed.txt' } }])
    const delta = buildCanvasDelta(before, after)
    const current = document([{ ...after.nodes[0]!, position: { x: 100, y: 50 }, revision: 8 }])
    const undone = accepted(applyCanvasDelta(current, delta, 'undo', new Map()))
    expect(undone.nodes[0]).toMatchObject({ data: a.data, position: { x: 100, y: 50 }, revision: 9 })
    current.nodes[0]!.dataVersion = 2
    expect(applyCanvasDelta(current, delta, 'undo', new Map())).toMatchObject({ ok: false })
  })

  it('treats a copied subgraph as one edit and refuses to discard connections created later', () => {
    const a = node('a')
    const b = node('b')
    const c = node('c')
    const before = document([a])
    const after = document([a, b, c], [edge('bc', b, c)])
    const delta = buildCanvasDelta(before, after)
    const withAgentEdge = document(after.nodes, [...after.connections, edge('ab', a, b)])
    const retained = structuredClone(withAgentEdge)
    expect(applyCanvasDelta(withAgentEdge, delta, 'undo', new Map())).toMatchObject({ ok: false })
    expect(withAgentEdge).toEqual(retained)
    const undone = accepted(applyCanvasDelta(after, delta, 'undo', new Map()))
    expect(undone).toEqual(before)
    expect(accepted(applyCanvasDelta(undone, delta, 'redo', new Map())).nodes).toEqual([a, { ...b, revision: 4 }, { ...c, revision: 4 }])
    const redone = accepted(applyCanvasDelta(undone, delta, 'redo', new Map([[b.id, 20], [c.id, 30]])))
    expect(redone.nodes).toEqual([a, { ...b, revision: 21 }, { ...c, revision: 31 }])
    expect(redone.connections).toEqual(after.connections)
  })

  it('restores deleted nodes and incident edges in their original order with monotonically increasing revisions', () => {
    const a = node('a')
    const b = node('b')
    const c = node('c')
    const before = document([a, b, c], [edge('ab', a, b), edge('ac', a, c), edge('bc', b, c)])
    const after = document([a, c], [before.connections[1]!])
    const delta = buildCanvasDelta(before, after)
    const counters = new Map([[b.id, 12]])
    const restored = accepted(applyCanvasDelta(after, delta, 'undo', counters))
    expect(restored.nodes).toEqual([a, { ...b, revision: 13 }, c])
    expect(restored.connections).toEqual(before.connections)
    const removedAgain = accepted(applyCanvasDelta(restored, delta, 'redo', counters))
    counters.set(b.id, 13)
    const restoredAgain = accepted(applyCanvasDelta(removedAgain, delta, 'undo', counters))
    expect(restoredAgain.nodes[1]!.revision).toBe(14)
    expect(restoredAgain.connections).toEqual(before.connections)
  })

  it('checks all affected fields before returning a changed canvas', () => {
    const a = node('a')
    const b = node('b')
    const before = document([a, b])
    const after = document([{ ...a, position: { x: 5, y: 0 } }, { ...b, data: { path: '/changed.txt' } }])
    const delta = buildCanvasDelta(before, after)
    const current = structuredClone(after)
    current.nodes[1]!.data.path = '/independent.txt'
    const snapshot = structuredClone(current)
    expect(applyCanvasDelta(current, delta, 'undo', new Map())).toMatchObject({ ok: false })
    expect(current).toEqual(snapshot)
  })

  it('rejects missing or replaced nodes, occupied restoration identities, and changed connection payloads', () => {
    const a = node('a')
    const b = node('b')
    const before = document([a])
    const after = document([a, b], [edge('ab', a, b)])
    const added = buildCanvasDelta(before, after)
    expect(applyCanvasDelta(before, added, 'undo', new Map()).ok).toBe(false)
    expect(applyCanvasDelta(after, added, 'redo', new Map()).ok).toBe(false)
    expect(applyCanvasDelta(document([a, { ...b, data: { path: '/changed.txt' } }], after.connections), added, 'undo', new Map()).ok).toBe(false)
    expect(applyCanvasDelta(document(after.nodes, [{ ...after.connections[0]!, purpose: 'delivery' }]), added, 'undo', new Map()).ok).toBe(false)
    const moved = buildCanvasDelta(before, document([{ ...a, position: { x: 5, y: 0 } }]))
    expect(applyCanvasDelta(document([]), moved, 'undo', new Map()).ok).toBe(false)
    expect(applyCanvasDelta(document([{ ...a, typeId: brandString<CanvasNodeTypeId>('replacement') }]), moved, 'undo', new Map()).ok).toBe(false)
  })

  it('refuses restored edges with missing endpoints and preserves independent connections', () => {
    const a = node('a')
    const b = node('b')
    const c = node('c')
    const before = document([a, b, c], [edge('ab', a, b)])
    const after = document(before.nodes)
    const delta = buildCanvasDelta(before, after)
    expect(applyCanvasDelta(document([a, c]), delta, 'undo', new Map()).ok).toBe(false)
    const current = document(before.nodes, [edge('ac', a, c)])
    expect(accepted(applyCanvasDelta(current, delta, 'undo', new Map())).connections).toEqual([before.connections[0], current.connections[0]])
    expect(applyCanvasDelta(before, delta, 'undo', new Map()).ok).toBe(false)
    expect(applyCanvasDelta(after, delta, 'redo', new Map()).ok).toBe(false)
  })

  it('guards canvas title edits and returns detached values in both directions', () => {
    const before = document([node('a')])
    const after = { ...before, title: 'Renamed' }
    const delta = buildCanvasDelta(before, after)
    expect(accepted(applyCanvasDelta(after, delta, 'undo', new Map()))).toEqual(before)
    expect(accepted(applyCanvasDelta(before, delta, 'redo', new Map()))).toEqual(after)
    expect(applyCanvasDelta({ ...after, title: 'Changed elsewhere' }, delta, 'undo', new Map()).ok).toBe(false)
  })

  it('rejects identity replacement that cannot be represented as a field edit', () => {
    const a = node('a')
    const b = node('b')
    const before = document([a, b], [edge('ab', a, b)])
    expect(() => buildCanvasDelta(before, document([{ ...a, typeId: brandString<CanvasNodeTypeId>('replacement') }, b], before.connections)))
      .toThrow('History cannot replace an existing node type')
    expect(() => buildCanvasDelta(before, document(before.nodes, [{ ...before.connections[0]!, targetPort: 'other' }])))
      .toThrow('History cannot replace an existing connection')
  })
})
