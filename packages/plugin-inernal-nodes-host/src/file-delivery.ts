/** Default file output layout; receipts and publication remain with the canvas transaction. */
import type { CanvasDeliveryOutputFactory, CanvasNodeTypeId } from '@deepseek-ai/dsh-convax-plugin-host'

/** Create one file reference for an explicitly presented native delivery. */
export const createFileDeliveryOutput: CanvasDeliveryOutputFactory = ({ canvas, source, file, index, nodeId, connectionId }) => ({
  node: {
    id: nodeId, typeId: 'convax.file' as CanvasNodeTypeId, dataVersion: 1,
    data: { path: file.path, ...(file.description === undefined ? {} : { description: file.description }) },
    position: { x: source.position.x + 760,
      y: source.position.y + index * 160 + canvas.nodes.filter(value => value.typeId === 'convax.file').length * 24 }, revision: 1,
  },
  connection: { id: connectionId, source: source.id, sourcePort: 'output', target: nodeId, targetPort: 'input', purpose: 'delivery' },
})
