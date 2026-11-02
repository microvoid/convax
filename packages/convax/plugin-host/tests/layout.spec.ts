/** Explicit dimensions determine spacing without requiring a Host or renderer. */
import { expect, it } from 'vitest'
import { layoutGrid } from '../src/layout.ts'
import type { CanvasNodeId } from '../src/types.ts'

it('uses the widest column and tallest row while retaining caller order and inputs', () => {
  const nodes = [
    { id: 'a' as CanvasNodeId, width: 100, height: 80 }, { id: 'b' as CanvasNodeId, width: 400, height: 50 },
    { id: 'c' as CanvasNodeId, width: 200, height: 60 }, { id: 'd' as CanvasNodeId, width: 10, height: 10 },
  ]
  const original = structuredClone(nodes)
  expect(layoutGrid(nodes, { origin: { x: -50, y: 20 }, columns: 2, columnGap: 30, rowGap: 40 })).toEqual([
    { id: 'a', position: { x: -50, y: 20 } }, { id: 'b', position: { x: 180, y: 20 } },
    { id: 'c', position: { x: -50, y: 140 } }, { id: 'd', position: { x: 180, y: 140 } },
  ])
  expect(nodes).toEqual(original)
})
