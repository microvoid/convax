/** Composable graph reads and ordered atomic writes exposed through the native DSH tool registry. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ConvaxHost } from './index.ts'
import type { CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasConnectionId, CanvasGroupId } from './types.ts'
import { canvasCommitRequestSchema } from './schema.ts'
import { projectCanvasGraph } from './graph-query.ts'

const STRING = { type: 'string', required: true } as const
const INTEGER = { type: 'integer', required: true } as const
const DATA = { type: 'json', required: true } as const
const POSITION = { type: 'object', additionalProperties: false,
  properties: { x: { type: 'number', required: true }, y: { type: 'number', required: true } } } as const
const identityList = { type: 'array', items: { type: 'string' } } as const
const branch = <const O extends string, const P extends object>(op: O, properties: P) => ({
  type: 'object', additionalProperties: false, properties: { op: { type: 'string', enum: [op], required: true }, ...properties },
}) as const
const OPERATIONS = [
  branch('canvas.add', { title: STRING }), branch('canvas.set', { title: STRING }), branch('canvas.remove', {}),
  branch('node.add', { id: STRING, typeId: STRING, dataVersion: INTEGER, data: DATA, position: { ...POSITION, required: true }, groupId: { type: 'string' } }),
  branch('node.set', { id: STRING, ifRevision: { type: 'integer' }, dataVersion: { type: 'integer' }, data: { type: 'json' }, position: POSITION,
    groupId: { type: 'json', description: 'Group identity, or null to remove membership.' } }),
  branch('node.remove', { id: STRING }),
  branch('group.add', { id: STRING, title: STRING }), branch('group.set', { id: STRING, title: STRING }),
  branch('group.remove', { id: STRING }), branch('group.move', { id: STRING, delta: { ...POSITION, required: true } }),
  branch('edge.add', { id: STRING, source: STRING, sourcePort: STRING, target: STRING, targetPort: STRING,
    purpose: { type: 'string', enum: ['input', 'delivery'], required: true } }),
  branch('edge.remove', { id: STRING }),
  branch('history', { targetOperationId: STRING, direction: { type: 'string', enum: ['undo', 'redo'], required: true } }),
] as const

function canvasTarget(host: ConvaxHost, exec: ToolRunContext, explicit?: string): CanvasId | null {
  const binding = exec.agent === undefined ? undefined : host.repository.bindingOf(exec.agent.id)
  if (explicit === undefined && binding !== undefined && (host.repository.isDeleting(binding.canvasId, binding.nodeId)
    || host.repository.getChat(binding.canvasId, binding.nodeId) === undefined)) throw new Error('This Session Chat is deleting or removed; name another canvasId explicitly')
  const id = explicit ?? binding?.canvasId
  if (id === undefined) return null
  const canvas = host.workspace().canvases.find(canvas => canvas.id === id)
  if (canvas === undefined) throw new Error('Canvas is unavailable; use convax_graph without a target from an unbound Session to list canvases')
  return canvas.id
}

/**
 * Publish graph discovery and commits alongside temporary legacy adapters.
 * @param ctx - Tool registry owner; registrations are disposed with this plugin.
 * @param host - Convax graph, provider and lifecycle owner.
 */
export function registerGraphTools(ctx: Context, host: ConvaxHost): void {
  ctx.tools.register(defineTool({
    name: 'convax_graph', presentCall: () => ({ card: 'generic', title: 'Read canvas graph' }),
    description: 'Read saved Convax state, independent of open views. By default return canvas summaries and the bound Chat canvas identity/revision. '
      + 'Request include collections explicitly: nodes, connections, groups, nodeTypes or issues. Groups organize nodes through groupId; all node positions are world coordinates. nodeTypes describes provider dataSchema, dataVersion and ports; null schema means an older provider supplies no declarative schema. '
      + 'Select nodes by IDs/types, connections by IDs, or incidentTo nodes and their one-hop endpoints. Node/type filters intersect; connections form an induced subgraph. '
      + 'Field projection always retains object IDs. Omitted collections are not empty collections. File records contain paths, not file contents.',
    parameters: {
      canvasId: { type: 'string', description: 'Omit for this Session Chat canvas. Unbound Sessions receive workspace summaries.' },
      include: { type: 'array', items: { type: 'string', enum: ['canvases', 'nodes', 'connections', 'groups', 'nodeTypes', 'issues'] } },
      selection: { type: 'object', additionalProperties: false, properties: {
        nodeIds: identityList, typeIds: identityList, connectionIds: identityList, incidentTo: identityList, groupIds: identityList,
      } },
      fields: { type: 'object', additionalProperties: false, properties: {
        nodes: { type: 'array', items: { type: 'string', enum: ['id', 'typeId', 'dataVersion', 'data', 'position', 'revision', 'groupId'] } },
        connections: { type: 'array', items: { type: 'string', enum: ['id', 'source', 'sourcePort', 'target', 'targetPort', 'purpose'] } },
      } },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute(args, exec) {
      exec.signal.throwIfAborted()
      const canvasId = canvasTarget(host, exec, args.canvasId)
      if (canvasId === null && args.include?.some(collection => collection === 'nodes' || collection === 'connections' || collection === 'groups')) {
        throw new Error('An explicit canvasId is required to read nodes, connections or groups from an unbound Session')
      }
      const selection = args.selection
      const graph = projectCanvasGraph(host.workspace(), canvasId, {
        ...(args.include === undefined ? {} : { include: args.include }),
        ...(args.fields === undefined ? {} : { fields: args.fields }),
        ...(selection === undefined ? {} : { selection: {
          ...(selection.nodeIds === undefined ? {} : { nodeIds: selection.nodeIds.map(id => id as CanvasNodeId) }),
          ...(selection.typeIds === undefined ? {} : { typeIds: selection.typeIds.map(id => id as CanvasNodeTypeId) }),
          ...(selection.connectionIds === undefined ? {} : { connectionIds: selection.connectionIds.map(id => id as CanvasConnectionId) }),
          ...(selection.incidentTo === undefined ? {} : { incidentTo: selection.incidentTo.map(id => id as CanvasNodeId) }),
          ...(selection.groupIds === undefined ? {} : { groupIds: selection.groupIds.map(id => id as CanvasGroupId) }),
        } }),
      })
      const binding = exec.agent === undefined ? undefined : host.repository.bindingOf(exec.agent.id)
      return Promise.resolve({ ...graph, chatNodeId: binding?.canvasId === canvasId ? binding.nodeId : null })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'convax_commit', presentCall: () => ({ card: 'generic', title: 'Commit canvas edits' }),
    description: 'Apply ordered semantic graph operations to one canvas. Later operations see earlier temporary results. '
      + 'One successful graph commit advances the canvas once and records one retry receipt and history entry. '
      + 'Use the revision read by convax_graph or a successful commit; conflicts never overwrite newer edits. Retain operationId and the identical complete request for retries. '
      + 'node.set replaces data completely and requires dataVersion when replacing data; ifRevision checks the node at that operation. '
      + 'canvas.add requires an explicit new canvasId and revision zero. history must appear alone. '
      + 'Removing nodes removes their incident connections but preserves source files. Edges never send prompts or insert composer references. '
      + 'group.add followed by node.set groupId creates a logical group in the same batch; group.remove only ungroups members. group.move translates every member once in world coordinates. Empty groups are removed at commit. '
      + 'Chat removal uses recoverable stop/archive coordination; confirmed grants consent. Pending external work is reported rather than described as rolled back.',
    parameters: {
      canvasId: { type: 'string', description: 'Omit to edit this Session Chat canvas. Creation and unbound Sessions require an explicit identity.' },
      expectedRevision: INTEGER, operationId: STRING, confirmed: { type: 'boolean' },
      ops: { type: 'array', required: true, items: { oneOf: OPERATIONS } },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const creating = args.ops.some(op => op.op === 'canvas.add')
      const canvasId = args.canvasId ?? canvasTarget(host, exec)
      if (canvasId === null || creating && args.canvasId === undefined) throw new Error('An explicit canvasId is required for creation or an unbound Session')
      const request = canvasCommitRequestSchema.parse({ ...args, canvasId })
      const result = await host.commit(request, exec.signal)
      return { ok: result.ok, canvasId: request.canvasId, operationId: request.operationId,
        revision: host.repository.revision(request.canvasId),
        error: result.ok ? null : { code: result.code, message: result.message, opIndex: result.opIndex ?? null } }
    },
  }))
}
