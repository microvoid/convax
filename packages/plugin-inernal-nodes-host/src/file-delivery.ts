/** Default file output layout; receipts and publication remain with the canvas transaction. */
import type { CanvasDeliveryOutputFactory, CanvasNode, CanvasNodeTypeId, CanvasPoint } from '@deepseek-ai/dsh-convax-plugin-host'

// Host delivery also runs without a window. Reserve the native defaults rather than
// persisting window-local preview sizes or mistaking a file's collapsed row for its body.
const FILE_RESERVATION = { width: 320, height: 320 }
const GAP = 32
const NATIVE_RESERVATIONS: Readonly<Record<string, { width: number; height: number }>> = {
  'convax.file': FILE_RESERVATION, 'convax.folder': FILE_RESERVATION,
  'convax.chat': { width: 620, height: 680 }, 'convax.terminal': { width: 640, height: 400 },
  'convax.browser': { width: 640, height: 480 }, 'convax.window': { width: 480, height: 310 },
}

/** Find a free output slot using committed positions and conservative native dimensions. */
function nextDeliveryPosition(nodes: readonly CanvasNode[], source: CanvasNode): CanvasPoint {
  const reservation = (node: CanvasNode) => NATIVE_RESERVATIONS[node.typeId] ?? { width: 640, height: 680 }
  const x = source.position.x + Math.max(760, reservation(source).width + GAP)
  let y = source.position.y
  const obstacles = nodes.map(node => ({ ...node.position, ...reservation(node) }))
    .filter(node => x < node.x + node.width + GAP && x + FILE_RESERVATION.width + GAP > node.x)
    .sort((left, right) => left.y - right.y)
  for (const node of obstacles) {
    if (y < node.y + node.height + GAP && y + FILE_RESERVATION.height + GAP > node.y) y = node.y + node.height + GAP
  }
  return { x, y }
}

/** Create one file reference for an explicitly presented native delivery. */
export const createFileDeliveryOutput: CanvasDeliveryOutputFactory = ({ canvas, source, file, nodeId, connectionId }) => ({
  node: {
    id: nodeId, typeId: 'convax.file' as CanvasNodeTypeId, dataVersion: 1,
    data: { path: file.path, ...(file.description === undefined ? {} : { description: file.description }) },
    position: nextDeliveryPosition(canvas.nodes, source), revision: 1,
  },
  connection: { id: connectionId, source: source.id, sourcePort: 'output', target: nodeId, targetPort: 'input', purpose: 'delivery' },
})
