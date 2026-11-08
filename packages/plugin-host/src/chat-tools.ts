/** Model-facing Chat operations delegate to the native Session coordinators without sending input. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ConvaxHost } from './index.ts'
import { threadRequestSchema } from './schema.ts'
import type { CanvasId, CanvasNodeId, CanvasOpenSessionRequest } from './types.ts'

type ChatToolHost = Pick<ConvaxHost, 'createThread' | 'openSession'> & {
  readonly repository: Pick<ConvaxHost['repository'], 'bindingOf'>
}

function identity(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0 || value !== value.trim()) throw new Error(`${name} must be a non-empty identity without surrounding whitespace`)
  return value
}

function target(host: ChatToolHost, exec: ToolRunContext, canvasId: string | undefined, nodeId: string | undefined) {
  const binding = exec.agent === undefined ? undefined : host.repository.bindingOf(exec.agent.id)
  const canvas = canvasId ?? binding?.canvasId
  if (canvas === undefined) throw new Error('canvasId is required for an unbound Session; use convax_graph to choose a canvas')
  const node = nodeId ?? (canvas === binding?.canvasId ? binding.nodeId : undefined)
  return { canvasId: identity(canvas, 'canvasId') as CanvasId, nodeId: node }
}

function rejectFields(args: object, fields: string[], action: string): void {
  for (const field of fields) if (field in args) throw new Error(`${field} is not used by ${action}; omit it`)
}

/**
 * Register cold thread creation, forking and existing Session placement with this Host's lifetime.
 * @param ctx - Tool registry owner; disposal removes the registration.
 * @param host - Existing Chat and Session coordinators, including their durable retry records.
 */
export function registerChatTools(ctx: Context, host: ChatToolHost): void {
  ctx.tools.register(defineTool({
    name: 'convax_chat',
    presentCall: args => ({ card: 'generic', title: args.action === 'open-session' ? 'Place existing Session' : args.action === 'fork-thread' ? 'Fork Chat thread' : 'Create Chat thread' }),
    description: 'Create or fork one native DSH Session thread inside an existing Chat container, or place an existing Session on a canvas. '
      + 'Read chats with convax_graph before choosing targets. Omitted canvasId uses this Session\'s Chat canvas; omitted nodeId for create-thread or fork-thread uses this Session\'s Chat only on that same canvas. '
      + 'Creating a Chat node does not create a thread. These actions never send prompts, start an Agent, select a visible thread, or add composer references. '
      + 'create-thread uses the Chat directory unless cwd is explicit; agentPreset is optional. fork-thread inherits the source directory, preset and event prefix; cwd and agentPreset overrides are not accepted. '
      + 'For create-thread and fork-thread retain operationId and the identical complete request, including expectedRevision, when retrying an uncertain result. '
      + 'open-session requires sessionId, a retained new nodeId and position; it returns the Session\'s existing Chat if already bound, even on another canvas. It accepts no operationId: retain the same placement request for retries. '
      + 'An accepted native operation may finish after cancellation; inspect state or retry the same request rather than allocating another identity.',
    parameters: {
      action: { type: 'string', required: true, enum: ['create-thread', 'fork-thread', 'open-session'] },
      canvasId: { type: 'string', description: 'Target canvas; omit for this Session\'s bound canvas.' },
      nodeId: { type: 'string', description: 'Existing Chat for create-thread/fork-thread, or retained new Chat identity for open-session.' },
      expectedRevision: { type: 'integer', required: true, description: 'Canvas revision returned by convax_graph. Preserve it on an identical retry.' },
      operationId: { type: 'string', description: 'Required unique retry identity for create-thread/fork-thread; omit for open-session.' },
      cwd: { type: 'string', description: 'create-thread only: existing project directory. Omit to use the Chat directory; this does not extend filesystem permissions.' },
      agentPreset: { type: 'string', description: 'create-thread only: installed DSH agent preset. Omit to resolve the configured default once.' },
      sourceSessionId: { type: 'string', description: 'fork-thread only: source DSH Session identity.' },
      atSeq: { type: 'integer', description: 'fork-thread only: inclusive source event sequence; omit for the latest completed-turn prefix.' },
      sessionId: { type: 'string', description: 'open-session only: original DSH Session to place without copying its history.' },
      position: { type: 'object', additionalProperties: false, properties: {
        x: { type: 'number', required: true }, y: { type: 'number', required: true },
      }, description: 'open-session only: position of a new Chat; ignored when the original Session already has a binding.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        ok: { type: 'boolean', required: true },
        action: { type: 'string', required: true, enum: ['create-thread', 'fork-thread', 'open-session'] },
        canvasId: { type: 'string', required: true }, nodeId: { type: 'string', required: true },
        sessionId: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
        operationId: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
        revision: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
        error: { required: true, oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, properties: {
          code: { type: 'string', required: true }, message: { type: 'string', required: true },
        } }] },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const selected = target(host, exec, args.canvasId, args.nodeId)
      if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0) throw new Error('expectedRevision must be a nonnegative safe integer')
      if (args.action === 'open-session') {
        rejectFields(args, ['operationId', 'cwd', 'agentPreset', 'sourceSessionId', 'atSeq'], args.action)
        if (args.position === undefined) throw new Error('position is required for open-session')
        const request: CanvasOpenSessionRequest = {
          canvasId: selected.canvasId, nodeId: identity(args.nodeId, 'nodeId') as CanvasNodeId,
          sessionId: identity(args.sessionId, 'sessionId') as SessionId,
          expectedRevision: args.expectedRevision, position: args.position,
        }
        const result = await host.openSession(request)
        const canvasId = result.ok ? result.canvasId : request.canvasId
        return { ok: result.ok, action: args.action, canvasId, nodeId: result.ok ? result.nodeId : request.nodeId,
          sessionId: result.ok ? result.sessionId : null, operationId: null,
          revision: result.workspace.canvases.find(canvas => canvas.id === canvasId)?.revision ?? null,
          error: result.ok ? null : { code: result.code, message: result.message } }
      }
      rejectFields(args, ['sessionId', 'position', ...(args.action === 'create-thread' ? ['sourceSessionId', 'atSeq'] : ['cwd', 'agentPreset'])], args.action)
      const request = threadRequestSchema.parse({
        canvasId: selected.canvasId, nodeId: identity(selected.nodeId, 'nodeId'), expectedRevision: args.expectedRevision,
        operationId: identity(args.operationId, 'operationId'),
        ...(args.action === 'create-thread'
          ? { kind: 'create', ...(args.cwd === undefined ? {} : { cwd: args.cwd }), ...(args.agentPreset === undefined ? {} : { agentPreset: args.agentPreset }) }
          : { kind: 'fork', sourceSessionId: identity(args.sourceSessionId, 'sourceSessionId'), ...(args.atSeq === undefined ? {} : { atSeq: args.atSeq }) }),
      })
      const result = await host.createThread(request)
      return { ok: result.ok, action: args.action, canvasId: request.canvasId, nodeId: request.nodeId,
        sessionId: result.ok ? result.sessionId : null, operationId: request.operationId,
        revision: result.workspace.canvases.find(canvas => canvas.id === request.canvasId)?.revision ?? null,
        error: result.ok ? null : { code: result.code, message: result.message } }
    },
  }))
}
