/** Model-facing graph edits over the same revisioned commands used by the canvas interface. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ConvaxHost } from './index.ts'
import type {
  CanvasCommandRequest, CanvasCommandResult, CanvasConnectionId, CanvasDocument,
  CanvasId, CanvasNodeId, CanvasOperationId,
} from './types.ts'

type CanvasToolHost = Pick<ConvaxHost, 'workspace' | 'execute' | 'describe'> & {
  readonly repository: Pick<ConvaxHost['repository'], 'bindingOf' | 'isDeleting'>
}

const POINT = {
  type: 'object', additionalProperties: false,
  properties: { x: { type: 'number', required: true }, y: { type: 'number', required: true } },
} as const
const CANVAS = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string', required: true }, title: { type: 'string', required: true },
    revision: { type: 'integer', required: true },
    archived: { type: 'boolean' },
    titleFormat: { type: 'json' },
    nodes: {
      type: 'array', required: true,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string', required: true }, typeId: { type: 'string', required: true },
          dataVersion: { type: 'integer', required: true }, revision: { type: 'integer', required: true },
          data: { type: 'json', required: true }, position: { ...POINT, required: true }, groupId: { type: 'string' },
        },
      },
    },
    groups: {
      type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true }, title: { type: 'string', required: true },
        color: { type: 'string', enum: ['blue', 'green', 'yellow', 'orange', 'purple', 'pink'] },
      } },
    },
    connections: {
      type: 'array', required: true,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string', required: true }, source: { type: 'string', required: true },
          sourcePort: { type: 'string', required: true }, target: { type: 'string', required: true },
          targetPort: { type: 'string', required: true },
          purpose: { type: 'string', enum: ['input', 'delivery'], required: true },
        },
      },
    },
  },
} as const
const NULLABLE_CANVAS = { oneOf: [CANVAS, { type: 'null' }] } as const
const TARGET = {
  type: 'string',
  description: 'Canvas identity. Omit to use the canvas containing this Session’s Chat; unbound Sessions must name a canvas explicitly.',
} as const
const MUTATION = {
  canvasId: TARGET,
  expectedRevision: { type: 'integer', required: true, description: 'Current canvas revision returned by convax_query_canvases or a preceding successful edit.' },
  operationId: { type: 'string', required: true, description: 'Unique mutation identity. Reuse it only for an identical retry, including the same expected revision.' },
} as const
const MUTATION_OUTPUT = {
  schema: {
    type: 'object', additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      canvasId: { type: 'string', required: true }, operationId: { type: 'string', required: true },
      canvas: { ...NULLABLE_CANVAS, required: true },
      error: {
        required: true,
        oneOf: [
          { type: 'null' },
          { type: 'object', additionalProperties: false, properties: {
            code: { type: 'string', required: true }, message: { type: 'string', required: true },
          } },
        ],
      },
    },
  },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const

function identity(value: string, name: string): string {
  if (value.length === 0 || value !== value.trim()) throw new Error(`${name} must be a non-empty identity without surrounding whitespace`)
  return value
}

function targetCanvas(host: CanvasToolHost, exec: ToolRunContext, explicit: string | undefined): CanvasDocument {
  const binding = exec.agent === undefined ? undefined : host.repository.bindingOf(exec.agent.id)
  const canvasId = explicit === undefined ? binding?.canvasId : identity(explicit, 'canvasId')
  if (canvasId === undefined) throw new Error('canvasId is required for an unbound Session. Use convax_query_canvases to list saved canvases.')
  const canvas = host.workspace().canvases.find(value => value.id === canvasId)
  if (canvas === undefined) throw new Error(`Canvas ${canvasId} is unavailable. Use convax_query_canvases to choose an existing canvas.`)
  if (explicit === undefined && binding !== undefined
    && (!canvas.nodes.some(node => node.id === binding.nodeId) || host.repository.isDeleting(binding.canvasId, binding.nodeId))) {
    throw new Error('This Session’s Chat is being deleted or has been removed. Name another canvasId explicitly to edit a different canvas.')
  }
  return canvas
}

function mutationRequest(
  canvasId: CanvasId, args: { expectedRevision: number; operationId: string }, command: CanvasCommandRequest['command'],
): CanvasCommandRequest {
  if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 1) throw new Error('expectedRevision must be a positive safe integer')
  return { canvasId, expectedRevision: args.expectedRevision, operationId: identity(args.operationId, 'operationId') as CanvasOperationId, command }
}

function mutationValue(result: CanvasCommandResult, request: CanvasCommandRequest) {
  return {
    ok: result.ok, canvasId: request.canvasId, operationId: request.operationId,
    canvas: result.workspace.canvases.find(canvas => canvas.id === request.canvasId) ?? null,
    error: result.ok ? null : { code: result.code, message: result.message },
  }
}

/**
 * Register effect-owned graph tools without depending on a mounted canvas view.
 * Mutations use real Session bindings, revision checks and durable retry identities.
 * @param ctx - Host context with the generic tool registry.
 * @param host - Authoritative graph and filesystem command service.
 */
export function registerCanvasTools(ctx: Context, host: CanvasToolHost): void {
  const commit = async (request: CanvasCommandRequest, signal: AbortSignal) => {
    signal.throwIfAborted()
    return mutationValue(await host.execute(request, signal), request)
  }
  ctx.tools.register(defineTool({
    name: 'convax_query_canvases',
    presentCall: () => ({ card: 'generic', title: 'Query canvases' }),
    description: 'List saved canvases and inspect one graph, its revision, node identities, connection ports and provider issues. '
      + 'Without canvasId, inspect the canvas containing this Session’s Chat; an unbound Session receives the canvas list. '
      + 'These are saved canvas records, independent of which canvas view is open.',
    parameters: { canvasId: TARGET },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          canvasId: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          chatNodeId: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          canvases: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
            id: { type: 'string', required: true }, title: { type: 'string', required: true }, revision: { type: 'integer', required: true },
            archived: { type: 'boolean' },
          } } },
          canvas: { ...NULLABLE_CANVAS, required: true },
          nodeTypes: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
            id: { type: 'string', required: true }, dataVersion: { type: 'integer', required: true },
            description: { type: 'string' }, dataSchema: { type: 'json' }, capabilities: { type: 'json' },
            ports: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
              id: { type: 'string', required: true }, direction: { type: 'string', enum: ['input', 'output'], required: true },
              valueKind: { type: 'string', required: true },
            } } },
          } } },
          nodeIssues: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
            canvasId: { type: 'string', required: true }, nodeId: { type: 'string', required: true },
            kind: { type: 'string', enum: ['migrating', 'incompatible'], required: true }, message: { type: 'string', required: true },
          } } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute(args, exec) {
      exec.signal.throwIfAborted()
      const binding = exec.agent === undefined ? undefined : host.repository.bindingOf(exec.agent.id)
      const selected = args.canvasId === undefined && binding === undefined ? null : targetCanvas(host, exec, args.canvasId)
      const workspace = host.workspace()
      return Promise.resolve({
        canvasId: selected?.id ?? null,
        chatNodeId: binding?.canvasId === selected?.id ? binding?.nodeId ?? null : null,
        canvases: workspace.canvases.map(({ id, title, revision, archived }) => ({
          id, title, revision, ...(archived === undefined ? {} : { archived }),
        })),
        canvas: selected, nodeTypes: workspace.nodeTypes,
        nodeIssues: workspace.nodeIssues.filter(issue => selected === null || issue.canvasId === selected.id),
      })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'convax_add_file',
    presentCall: args => ({ card: 'generic', title: 'Add canvas reference', locations: [{ path: args.path }] }),
    description: 'Add one existing file or folder reference to a canvas at an explicit position. '
      + 'The original resource is not copied or changed. On conflict, inspect the returned graph before deciding the next edit.',
    parameters: {
      ...MUTATION,
      nodeId: { type: 'string', required: true, description: 'New node identity, unique across saved canvases.' },
      path: { type: 'string', required: true, description: 'Absolute path to an existing regular file or folder.' },
      position: { ...POINT, required: true, description: 'Position in canvas coordinates.' },
    },
    output: MUTATION_OUTPUT,
    async execute(args, exec) {
      const canvas = targetCanvas(host, exec, args.canvasId)
      const resource = await host.describe(args.path, exec.signal)
      if (resource.kind !== 'file' && resource.kind !== 'folder') throw new Error('Only regular files and folders can be added as canvas references')
      const provider = host.workspace().nodeTypes.find(value => value.capabilities?.resourceKind === resource.kind)
      if (provider === undefined) throw new Error(`Node provider for ${resource.kind} references is unavailable. Enable its provider before adding a reference.`)
      return commit(mutationRequest(canvas.id, args, { kind: 'add-node', node: {
        id: identity(args.nodeId, 'nodeId') as CanvasNodeId, typeId: provider.id, dataVersion: provider.dataVersion,
        revision: 0, data: { path: resource.path }, position: args.position,
      } }), exec.signal)
    },
  }))
  ctx.tools.register(defineTool({
    name: 'convax_connect',
    presentCall: () => ({ card: 'generic', title: 'Connect canvas nodes' }),
    description: 'Create a directed input connection from a source output port to a target input port on one canvas. '
      + 'Read compatible named ports with convax_query_canvases. Connecting nodes does not send input or start a conversation.',
    parameters: {
      ...MUTATION,
      connectionId: { type: 'string', required: true, description: 'New connection identity, unique across saved canvases.' },
      source: { type: 'string', required: true, description: 'Source node identity.' },
      sourcePort: { type: 'string', required: true, description: 'Source output port identity.' },
      target: { type: 'string', required: true, description: 'Target node identity.' },
      targetPort: { type: 'string', required: true, description: 'Target input port identity.' },
    },
    output: MUTATION_OUTPUT,
    async execute(args, exec) {
      const canvas = targetCanvas(host, exec, args.canvasId)
      return commit(mutationRequest(canvas.id, args, { kind: 'add-connection', connection: {
        id: identity(args.connectionId, 'connectionId') as CanvasConnectionId,
        source: identity(args.source, 'source') as CanvasNodeId, sourcePort: args.sourcePort,
        target: identity(args.target, 'target') as CanvasNodeId, targetPort: args.targetPort, purpose: 'input',
      } }), exec.signal)
    },
  }))
  ctx.tools.register(defineTool({
    name: 'convax_move_nodes',
    presentCall: () => ({ card: 'generic', title: 'Move canvas nodes' }),
    description: 'Move explicitly named nodes to exact canvas coordinates in one atomic edit. Other node positions stay unchanged.',
    parameters: {
      ...MUTATION,
      nodes: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true }, position: { ...POINT, required: true },
      } } },
    },
    output: MUTATION_OUTPUT,
    async execute(args, exec) {
      const canvas = targetCanvas(host, exec, args.canvasId)
      return commit(mutationRequest(canvas.id, args, {
        kind: 'move-nodes', nodes: args.nodes.map(node => ({ id: identity(node.id, 'node id') as CanvasNodeId, position: node.position })),
      }), exec.signal)
    },
  }))
  ctx.tools.register(defineTool({
    name: 'convax_arrange_nodes',
    presentCall: () => ({ card: 'generic', title: 'Arrange canvas nodes' }),
    description: 'Arrange explicitly named nodes in array order across a requested number of columns, in one atomic edit. '
      + 'origin is the first position; columnGap and rowGap are coordinate deltas between positions, not node widths or heights. '
      + 'Choose geometry for the requested layout. Other nodes remain in place.',
    parameters: {
      ...MUTATION,
      nodeIds: { type: 'array', required: true, items: { type: 'string' }, description: 'Ordered node identities to arrange.' },
      origin: { ...POINT, required: true, description: 'First position in canvas coordinates.' },
      columns: { type: 'integer', required: true, description: 'Positive number of columns.' },
      columnGap: { type: 'number', required: true, description: 'Positive horizontal coordinate delta between columns.' },
      rowGap: { type: 'number', required: true, description: 'Positive vertical coordinate delta between rows.' },
    },
    output: MUTATION_OUTPUT,
    async execute(args, exec) {
      const canvas = targetCanvas(host, exec, args.canvasId)
      return commit(mutationRequest(canvas.id, args, {
        kind: 'arrange-nodes', nodeIds: args.nodeIds.map(id => identity(id, 'node id') as CanvasNodeId),
        origin: args.origin, columns: args.columns, columnGap: args.columnGap, rowGap: args.rowGap,
      }), exec.signal)
    },
  }))
}
