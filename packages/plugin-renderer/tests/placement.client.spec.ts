import { describe, expect, it } from 'vitest'
import { connectedNodePosition, nextResourcePosition, RESOURCE_CARD_WIDTH } from '../src/client/placement.ts'

describe('List-added resource placement', () => {
  it('clears every existing card horizontally, including scattered and negative coordinates', () => {
    const nodes = [
      { position: { x: -200, y: -500 } },
      { position: { x: 300, y: 30 } },
      { position: { x: 50, y: 900 } },
    ]
    const original = structuredClone(nodes)
    const position = nextResourcePosition(nodes)
    for (const node of nodes) expect(position.x).toBeGreaterThan(node.position.x + RESOURCE_CARD_WIDTH)
    expect(nodes).toEqual(original)
  })
})

describe('Connected node placement', () => {
  it('starts beside its source and avoids existing expanded cards in the same lane', () => {
    const source = { x: 40, y: 80, width: 360, height: 360 }
    const size = { width: 620, height: 680 }
    expect(connectedNodePosition(source, size, [])).toEqual({ x: 520, y: 80 })
    const obstacles = [
      { x: 520, y: 80, width: 620, height: 800 },
      { x: 600, y: 950, width: 320, height: 320 },
      { x: 1500, y: 1400, width: 320, height: 320 },
    ]
    expect(connectedNodePosition(source, size, obstacles)).toEqual({ x: 520, y: 1302 })
  })
})
