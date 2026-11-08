/** Group ownership preserves world positions and uses window-measured outer bounds. */
import { describe, expect, it, vi } from 'vitest'
import type { CanvasDocument, CanvasGroupId, CanvasId, CanvasNodeId, CanvasNodeTypeId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { CanvasGroupingController, CanvasGroupDrag, canvasGroupBounds, canvasSelectionMembers } from '../src/client/canvas-grouping.ts'

const GROUP = 'first-group' as CanvasGroupId
const OTHER = 'other-group' as CanvasGroupId
const FIRST = 'first' as CanvasNodeId
const SECOND = 'second' as CanvasNodeId
const THIRD = 'third' as CanvasNodeId
const document: CanvasDocument = {
  id: 'canvas' as CanvasId, title: 'Canvas', revision: 1, connections: [], groups: [{ id: GROUP, title: 'References' }],
  nodes: [FIRST, SECOND, THIRD].map((id, index) => ({ id, typeId: 'fixture.file' as CanvasNodeTypeId,
    dataVersion: 1, revision: 1, data: {}, position: { x: index * 200, y: 100 },
    ...(index < 2 ? { groupId: GROUP } : {}),
  })),
}
const geometry = document.nodes.map(node => ({ id: node.id, ...node.position, width: 100, height: 80 }))

describe('Canvas grouping', () => {
  it('keeps a real node with the proxy-like identity available as an outside snap target', () => {
    const collision = { ...document, nodes: document.nodes.map(node => node.id === THIRD
      ? { ...node, id: 'group-selection' as CanvasNodeId } : node) }
    const measured = collision.nodes.map(node => ({ id: node.id, ...node.position, width: 100, height: 80 }))
    const drag = new CanvasGroupDrag(collision, { nodeIds: [], groupIds: [GROUP] }, measured, canvasGroupBounds(collision, measured))
    expect(drag.preview({ x: 72, y: 30 }, 1).positions).toEqual({ first: { x: 76, y: 130 }, second: { x: 276, y: 130 } })
  })

  it('expands mixed selections once and derives each frame from this window’s card measurements', () => {
    expect(canvasSelectionMembers(document, { nodeIds: [FIRST, THIRD], groupIds: [GROUP] })).toEqual([FIRST, SECOND, THIRD])
    expect(canvasGroupBounds(document, geometry)).toEqual([{
      id: GROUP, title: 'References', x: -24, y: 48, width: 348, height: 156, nodeIds: [FIRST, SECOND],
    }])
    const expanded = geometry.map(node => node.id === SECOND ? { ...node, height: 300 } : node)
    expect(canvasGroupBounds(document, expanded)[0]?.height).toBe(376)
    expect(document.nodes[0]?.position).toEqual({ x: 0, y: 100 })
  })

  it('snaps the group frame and translates each member once while preserving its internal spacing', () => {
    const drag = new CanvasGroupDrag(document, { nodeIds: [FIRST], groupIds: [GROUP] }, geometry, canvasGroupBounds(document, geometry))
    // The frame's right edge (324) aligns with the outside card at x=400.
    const preview = drag.preview({ x: 72, y: 30 }, 1)
    expect(preview.positions).toEqual({ first: { x: 76, y: 130 }, second: { x: 276, y: 130 } })
    expect(preview.guides).toEqual([{ axis: 'x', coordinate: 400, from: 66, to: 246 }])
    expect(drag.command()).toEqual({ kind: 'move-selection', nodeIds: [FIRST], groupIds: [GROUP], delta: { x: 76, y: 30 } })
  })

  it('ignores group contents as snap targets and keeps a zero-distance click out of history', () => {
    const isolated = { ...document, nodes: document.nodes.slice(0, 2) }
    const drag = new CanvasGroupDrag(isolated, { nodeIds: [], groupIds: [GROUP] },
      geometry.slice(0, 2), canvasGroupBounds(isolated, geometry))
    expect(drag.command()).toBeNull()
    expect(drag.preview({ x: 3, y: 4 }, 0.5).guides).toEqual([])
    expect(drag.command()).toMatchObject({ delta: { x: 3, y: 4 } })
  })

  it('creates a group from expanded members and keeps the existing selection on rejection', async () => {
    const command = vi.fn(async () => false)
    const controller = new CanvasGroupingController({ document: () => document, command, newId: () => OTHER })
    expect(await controller.group({ nodeIds: [THIRD], groupIds: [] }, 'One')).toBeNull()
    expect(command).not.toHaveBeenCalled()
    expect(controller.canGroup({ nodeIds: [FIRST, SECOND], groupIds: [] })).toBe(false)
    expect(controller.selectedGroups({ nodeIds: [FIRST, SECOND], groupIds: [] })).toEqual([GROUP])
    expect(await controller.group({ nodeIds: [FIRST, THIRD], groupIds: [GROUP] }, 'New group')).toBeNull()
    expect(command).toHaveBeenCalledExactlyOnceWith({ kind: 'group-nodes', group: { id: OTHER, title: 'New group' }, nodeIds: [FIRST, SECOND, THIRD] })
  })

  it('uses Host selection commands for movement and deletion so group members share one transaction', async () => {
    const command = vi.fn(async () => true)
    const controller = new CanvasGroupingController({ document: () => document, command, newId: () => OTHER })
    const selected = { nodeIds: [FIRST], groupIds: [GROUP] }
    await controller.move(selected, { x: 5, y: 0 })
    await controller.remove(selected)
    expect(command.mock.calls).toEqual([
      [{ kind: 'move-selection', ...selected, delta: { x: 5, y: 0 } }],
      [{ kind: 'remove-selection', ...selected }],
    ])
  })
})
