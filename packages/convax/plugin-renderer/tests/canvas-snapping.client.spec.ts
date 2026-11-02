/** Node snapping uses measured geometry and a constant screen-distance threshold. */
import { describe, expect, it } from 'vitest'
import type { CanvasNodeId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { createCanvasSnapGesture, snapCanvasDrag, type SnapNodeBounds } from '../src/client/canvas-snapping.ts'

const FIRST = 'first' as CanvasNodeId
const SECOND = 'second' as CanvasNodeId
const TARGET = 'target' as CanvasNodeId
const bounds = (id: CanvasNodeId, x: number, y: number, width = 80, height = 60): SnapNodeBounds => ({ id, x, y, width, height })

describe('Canvas node snapping', () => {
  it('aligns measured horizontal and vertical centers and extends guides across both nodes', () => {
    const gesture = createCanvasSnapGesture([bounds(FIRST, 0, 0), bounds(TARGET, 500, 300, 200, 120)], new Set([FIRST]))
    const result = snapCanvasDrag(gesture, { x: 557, y: 327 }, 1)
    expect(result.positions.get(FIRST)).toEqual({ x: 560, y: 330 })
    expect(result.guides).toEqual([
      { axis: 'x', coordinate: 600, from: 288, to: 432 },
      { axis: 'y', coordinate: 360, from: 488, to: 712 },
    ])
  })

  it('aligns a trailing edge with the target leading edge at the inclusive threshold', () => {
    const gesture = createCanvasSnapGesture([bounds(FIRST, 40, 0, 160, 80), bounds(TARGET, 400, 200, 160, 80)], new Set([FIRST]))
    const result = snapCanvasDrag(gesture, { x: 194, y: 0 }, 1)
    expect(result.positions.get(FIRST)).toEqual({ x: 240, y: 0 })
    expect(result.guides.map(guide => [guide.axis, guide.coordinate])).toEqual([['x', 400]])
  })

  it('keeps a selected group rigid and excludes its members as snap targets', () => {
    const gesture = createCanvasSnapGesture([
      bounds(FIRST, 0, 0), bounds(SECOND, 103, 97), bounds(TARGET, 500, 400),
    ], new Set([FIRST, SECOND]))
    const result = snapCanvasDrag(gesture, { x: 395, y: 301 }, 1)
    const first = result.positions.get(FIRST)!
    const second = result.positions.get(SECOND)!
    expect(second).toEqual({ x: 500, y: 400 })
    expect({ x: second.x - first.x, y: second.y - first.y }).toEqual({ x: 103, y: 97 })
    const isolated = createCanvasSnapGesture([bounds(FIRST, 0, 0), bounds(SECOND, 103, 97)], new Set([FIRST, SECOND]))
    expect(snapCanvasDrag(isolated, { x: 1, y: 1 }, 1).guides).toEqual([])
  })

  it('uses six screen pixels at both low and high zoom instead of a fixed world threshold', () => {
    const gesture = createCanvasSnapGesture([bounds(FIRST, 0, 0), bounds(TARGET, 500, 400)], new Set([FIRST]))
    expect(snapCanvasDrag(gesture, { x: 490, y: 0 }, 0.5).positions.get(FIRST)?.x).toBe(500)
    expect(snapCanvasDrag(gesture, { x: 496, y: 0 }, 2).guides).toEqual([])
    expect(snapCanvasDrag(gesture, { x: 497, y: 0 }, 2).positions.get(FIRST)?.x).toBe(500)
  })

  it('releases alignment outside the threshold and resolves equal-distance targets in document order', () => {
    const another = 'another' as CanvasNodeId
    const gesture = createCanvasSnapGesture([
      bounds(FIRST, 0, 0), bounds(TARGET, 506, 400), bounds(another, 494, 700),
    ], new Set([FIRST]))
    expect(snapCanvasDrag(gesture, { x: 500, y: 0 }, 1).positions.get(FIRST)?.x).toBe(506)
    const released = snapCanvasDrag(gesture, { x: 480, y: 0 }, 1)
    expect(released.positions.get(FIRST)).toEqual({ x: 480, y: 0 })
    expect(released.guides).toEqual([])
  })
})
