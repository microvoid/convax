/** Clipboard parsing and clone placement preserve graph semantics without sharing Chat history. */
import { describe, expect, it } from 'vitest'
import type { CanvasConnectionId, CanvasDocument, CanvasId, CanvasNodeId, CanvasNodeTypeId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { copyCanvasSelection, parseCanvasClipboard, type CanvasClipboardView } from '../src/client/canvas-clipboard.ts'
import { canvasClipboardBounds, createClipboardSubgraph } from '../src/client/clipboard-placement.ts'

const FIRST = 'file' as CanvasNodeId
const SECOND = 'chat' as CanvasNodeId
const EXTERNAL = 'outside' as CanvasNodeId
const document: CanvasDocument = {
  id: 'source-canvas' as CanvasId, title: 'Board', revision: 7,
  nodes: [
    { id: FIRST, typeId: 'convax.file' as CanvasNodeTypeId, dataVersion: 1, revision: 2, position: { x: 10, y: 20 }, data: { path: '/project/notes.txt' } },
    { id: SECOND, typeId: 'convax.chat' as CanvasNodeTypeId, dataVersion: 1, revision: 4, position: { x: 250, y: 80 },
      data: { title: 'Project discussion', cwd: '/project', sessionId: 'old-session', draft: 'private draft', threads: ['old-thread'] } },
    { id: EXTERNAL, typeId: 'convax.file' as CanvasNodeTypeId, dataVersion: 1, revision: 1, position: { x: 600, y: 80 }, data: { path: '/project/other.txt' } },
  ],
  connections: [
    { id: 'inside' as CanvasConnectionId, source: FIRST, sourcePort: 'output', target: SECOND, targetPort: 'input', purpose: 'input' },
    { id: 'outside-edge' as CanvasConnectionId, source: EXTERNAL, sourcePort: 'output', target: SECOND, targetPort: 'input', purpose: 'input' },
  ],
}
const dimensions = { [FIRST]: { width: 160, height: 80 }, [SECOND]: { width: 300, height: 240 } }
const views: Record<string, CanvasClipboardView> = {
  [FIRST]: { kind: 'resource', presentation: { expanded: false } },
  [SECOND]: { kind: 'chat', presentation: { collapsed: false } },
}
const payload = () => copyCanvasSelection(document, [FIRST, SECOND], dimensions, views)!

describe('Canvas clipboard protocol', () => {
  it('copies only selected graph data and internal edges, with independent JSON fields', () => {
    const copied = payload()
    expect(copied.kind).toBe('convax.canvas.nodes')
    expect(copied.nodes.map(node => node.id)).toEqual([FIRST, SECOND])
    expect(copied.connections.map(edge => edge.id)).toEqual(['inside'])
    expect(copied.nodes[1]?.data).toEqual({ title: 'Project discussion', cwd: '/project' })
    expect(copied.nodes[0]?.data).not.toBe(document.nodes[0]?.data)
    expect(parseCanvasClipboard(JSON.stringify(copied))).toEqual(copied)
    expect(copyCanvasSelection(document, [], {}, {})).toBeNull()
  })

  it('rejects ordinary text, unsupported versions, duplicate identities and connections outside the copied selection', () => {
    const copied = payload()
    for (const invalid of [
      'ordinary text', '{}', JSON.stringify({ ...copied, version: 2 }), JSON.stringify({ ...copied, nodes: [] }),
      JSON.stringify({ ...copied, nodes: [copied.nodes[0], copied.nodes[0]] }),
      JSON.stringify({ ...copied, connections: document.connections }),
      JSON.stringify({ ...copied, dimensions: {} }),
      JSON.stringify({ ...copied, views: {} }),
      JSON.stringify({ ...copied, views: { ...copied.views, [SECOND]: { kind: 'chat', presentation: { collapsed: false, selectedThreads: ['private'] } } } }),
      JSON.stringify({ ...copied, nodes: [{ ...copied.nodes[0], id: 'constructor' }], connections: [], dimensions: {} }),
    ]) expect(parseCanvasClipboard(invalid), invalid).toBeNull()
  })

  it('rejects arithmetic overflow in individual nodes and in the combined selection without imposing coordinate limits', () => {
    const copied = payload()
    const nodes = copied.nodes.map((node, index) => ({ ...node, position: { x: index === 0 ? -9e307 : 9e307, y: 0 } }))
    expect(parseCanvasClipboard(JSON.stringify({ ...copied, nodes }))).toBeNull()
    expect(parseCanvasClipboard(JSON.stringify({ ...copied, nodes: [{ ...copied.nodes[0], position: { x: 1e308, y: 0 } }],
      connections: [], dimensions: { [FIRST]: { width: 1e308, height: 80 } } }))).toBeNull()
    expect(parseCanvasClipboard(JSON.stringify({ ...copied, nodes: [{ ...copied.nodes[0], position: { x: 1e200, y: 0 } }],
      connections: [], dimensions: { [FIRST]: dimensions[FIRST] } }))).not.toBeNull()
  })
})

describe('Copied graph placement', () => {
  it('maps new IDs and preserves relative coordinates while removing Chat bindings again at paste', () => {
    const copied = payload()
    const hostile = { ...copied, nodes: copied.nodes.map(node => node.id === SECOND ? { ...node, data: { ...node.data, sessionId: 'injected', draft: 'injected' } } : node) }
    let next = 0
    const command = createClipboardSubgraph(hostile, { x: 800, y: 500 }, [], () => `new-${next++}`)
    expect(command.nodes.map(node => node.id)).toEqual(['new-0', 'new-1'])
    expect(command.nodes.map(node => node.position)).toEqual([{ x: 800, y: 500 }, { x: 1040, y: 560 }])
    expect(command.nodes.map(node => node.revision)).toEqual([1, 1])
    expect(command.connections).toEqual([{ id: 'new-2', source: 'new-0', sourcePort: 'output', target: 'new-1', targetPort: 'input', purpose: 'input' }])
    expect(command.nodes[1]?.data).toEqual({ title: 'Project discussion', cwd: '/project' })
    expect(command.nodes[0]?.data).toEqual({ path: '/project/notes.txt' })
  })

  it('finds an unoccupied nearby position using actual sizes and moves the entire selection together', () => {
    const copied = payload()
    const obstacles = [
      { x: 10, y: 20, ...dimensions[FIRST]! }, { x: 250, y: 80, ...dimensions[SECOND]! },
      { x: 600, y: 80, width: 800, height: 500 },
    ]
    let next = 0
    const command = createClipboardSubgraph(copied, { x: 42, y: 52 }, obstacles, () => `copy-${next++}`)
    const first = command.nodes[0]!.position
    const second = command.nodes[1]!.position
    expect({ x: second.x - first.x, y: second.y - first.y }).toEqual({ x: 240, y: 60 })
    for (const [index, node] of command.nodes.entries()) {
      const size = copied.dimensions[copied.nodes[index]!.id]!
      for (const other of obstacles) expect(node.position.x < other.x + other.width && node.position.x + size.width > other.x
        && node.position.y < other.y + other.height && node.position.y + size.height > other.y).toBe(false)
    }
    expect(canvasClipboardBounds(copied)).toEqual({ x: 10, y: 20, width: 540, height: 300 })
  })

  it('refuses a finite-origin translation whose final node coordinates would overflow', () => {
    const copied = payload()
    const enormous = { ...copied, nodes: copied.nodes.map((node, index) => ({ ...node, position: { x: index * 9e307, y: 0 } })) }
    let next = 0
    expect(() => createClipboardSubgraph(enormous, { x: 1e308, y: 0 }, [], () => `new-${next++}`)).toThrow('Copied node coordinates are not finite')
  })
})
