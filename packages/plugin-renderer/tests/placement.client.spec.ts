import { describe, expect, it } from 'vitest'
import { nextResourcePosition, RESOURCE_CARD_WIDTH } from '../src/client/placement.ts'

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
