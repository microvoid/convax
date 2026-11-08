/** Local history preserves resource viewing state without capturing remote edits. */
import { describe, expect, it } from 'vitest'
import type { CanvasCommand, CanvasDocument, CanvasGroupId, CanvasId, CanvasNodeId, CanvasNodeTypeId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { recordsCanvasHistory, removedResourceViews, restoredResourceViews } from '../src/client/canvas-history.ts'

function canvas(ids: string[]): CanvasDocument {
  return { id: 'canvas' as CanvasId, title: 'Board', revision: 1, connections: [], nodes: ids.map(id => ({
    id: id as CanvasNodeId, typeId: 'convax.file' as CanvasNodeTypeId, dataVersion: 1, data: { path: `/${id}` },
    position: { x: 0, y: 0 }, revision: 1,
  })) }
}

describe('Canvas local history metadata', () => {
  it('records graph mutations while excluding canvas lifecycle and title changes', () => {
    expect(recordsCanvasHistory({ kind: 'create', title: 'Board' })).toBe(false)
    expect(recordsCanvasHistory({ kind: 'delete' })).toBe(false)
    expect(recordsCanvasHistory({ kind: 'rename', title: 'Renamed' })).toBe(false)
    expect(recordsCanvasHistory({ kind: 'set-archived', archived: true })).toBe(false)
    expect(recordsCanvasHistory({ kind: 'duplicate', newCanvasId: 'copy' as CanvasId, title: 'Copy' })).toBe(false)
    expect(recordsCanvasHistory({ kind: 'purge' })).toBe(false)
    expect(recordsCanvasHistory({ kind: 'move-nodes', nodes: [] })).toBe(true)
    expect(recordsCanvasHistory({ kind: 'remove-nodes', nodeIds: [] })).toBe(true)
    expect(recordsCanvasHistory({ kind: 'add-subgraph', nodes: [], connections: [] })).toBe(true)
    expect(recordsCanvasHistory({ kind: 'batch', ops: [{ op: 'canvas.set', title: 'Renamed' }] })).toBe(false)
    expect(recordsCanvasHistory({ kind: 'batch', ops: [{ op: 'node.set', id: 'node' as CanvasNodeId, position: { x: 20, y: 0 } }] })).toBe(true)
  })

  it('records group membership, title and selection changes as graph history', () => {
    const groupId = 'references' as CanvasGroupId
    const nodeId = 'node' as CanvasNodeId
    const commands: CanvasCommand[] = [
      { kind: 'group-nodes', group: { id: groupId, title: 'References' }, nodeIds: [nodeId] },
      { kind: 'rename-group', groupId, title: 'Sources' },
      { kind: 'ungroup', groupIds: [groupId] },
      { kind: 'set-node-group', nodeIds: [nodeId], groupId: null },
      { kind: 'move-selection', nodeIds: [], groupIds: [groupId], delta: { x: 10, y: 20 } },
      { kind: 'remove-selection', nodeIds: [], groupIds: [groupId] },
      { kind: 'batch', ops: [{ op: 'group.set', id: groupId, title: 'Sources' }] },
    ]
    for (const command of commands) expect(recordsCanvasHistory(command), command.kind).toBe(true)
  })

  it('captures only removed views and restores reintroduced or missing views after a late receipt', () => {
    const expanded = { expanded: true, width: 520, height: 340 }
    const collapsed = { expanded: false }
    expect(removedResourceViews(canvas(['a', 'b']), canvas(['b']), { a: expanded, b: collapsed })).toEqual({ a: expanded })
    expect(restoredResourceViews(canvas(['b']), canvas(['a', 'b']), { a: expanded, b: expanded }, { b: collapsed })).toEqual({ a: expanded })
    expect(restoredResourceViews(canvas(['a', 'b']), canvas(['a', 'b']), { a: expanded, b: expanded }, { b: collapsed })).toEqual({ a: expanded })
    expect(restoredResourceViews(canvas([]), canvas(['a']), {}, {})).toEqual({})
  })
})
