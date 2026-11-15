/** Delivery positions reserve expanded native cards across independent Session events. */
import { describe, expect, it } from 'vitest'
import type { CanvasConnectionId, CanvasDocument, CanvasId, CanvasNode, CanvasNodeId, CanvasNodeTypeId } from '@deepseek-ai/dsh-convax-plugin-host'
import { createFileDeliveryOutput } from '../src/file-delivery.ts'

function node(id: string, type: string, x: number, y: number): CanvasNode {
  return { id: id as CanvasNodeId, typeId: type as CanvasNodeTypeId, dataVersion: 1, data: {}, position: { x, y }, revision: 1 }
}

function canvas(nodes: CanvasNode[]): CanvasDocument {
  return { id: 'canvas' as CanvasId, title: 'Deliveries', revision: 1, nodes, connections: [] }
}

function deliver(document: CanvasDocument, source: CanvasNode, index: number) {
  const output = createFileDeliveryOutput({ canvas: document, source, file: { path: '/fixture/output.png', description: 'Generated image' },
    index, nodeId: `output-${document.nodes.length}` as CanvasNodeId, connectionId: `edge-${document.nodes.length}` as CanvasConnectionId })
  document.nodes.push(output.node)
  document.connections.push(output.connection)
  return output.node
}

describe('Native file delivery placement', () => {
  it('reserves expanded preview space when each independent event starts at index zero', () => {
    const source = node('chat', 'convax.chat', 100, 100), document = canvas([source])
    const files = Array.from({ length: 3 }, () => deliver(document, source, 0))
    expect(files.map(file => file.position.x)).toEqual([860, 860, 860])
    for (let index = 1; index < files.length; index++) {
      // Native image/video defaults need a 240px body, 40px header, borders and spacing.
      expect(files[index]!.position.y - files[index - 1]!.position.y).toBeGreaterThanOrEqual(320)
    }
    expect(files[0]!.data).toEqual({ path: '/fixture/output.png', description: 'Generated image' })
    expect(document.connections.map(edge => ({ source: edge.source, purpose: edge.purpose })))
      .toEqual(files.map(() => ({ source: source.id, purpose: 'delivery' })))
    expect(source.position).toEqual({ x: 100, y: 100 })
  })

  it('uses the same available slots for a batch and for separately committed events', () => {
    const source = node('chat', 'convax.chat', 0, 0)
    const batch = canvas([source]), separate = canvas([source])
    expect([0, 1, 2].map(index => deliver(batch, source, index).position))
      .toEqual([0, 0, 0].map(index => deliver(separate, source, index).position))
  })

  it('avoids existing files and other native cards without moving user nodes', () => {
    const source = node('chat', 'convax.chat', 100, 100)
    const existing = [source, node('browser', 'convax.browser', 800, 0), node('other-output', 'convax.file', 850, 700),
      node('other-chat', 'convax.chat', 850, 1100), node('unrelated', 'convax.file', 4000, 5000)]
    const original = structuredClone(existing), document = canvas([...existing])
    const file = deliver(document, source, 0)
    expect(file.position).toEqual({ x: 860, y: 1812 })
    expect(document.nodes.slice(0, existing.length)).toEqual(original)
  })

  it('keeps a free slot at negative coordinates instead of counting unrelated files', () => {
    const source = node('chat', 'convax.chat', -1000, -500)
    const document = canvas([source, node('above', 'convax.file', -240, -1000), node('below', 'convax.file', -240, 1000),
      node('other-lane', 'convax.file', 1000, -500)])
    expect(deliver(document, source, 0).position).toEqual({ x: -240, y: -500 })
  })
})
