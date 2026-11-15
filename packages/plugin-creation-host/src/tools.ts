/** Native DSH tools delegate to the Host using their real invocation identity. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import type { ConvaxCreationHost } from './service.ts'
import { generateInput, jsonObject } from './schema.ts'
import type { CreationInvocation, JobId } from './types.ts'

const output = {
  schema: { type: 'object', additionalProperties: true } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

/** Standard DSH tools use the existing Chat tool renderer. */
export function registerCreationTools(ctx: Context, service: ConvaxCreationHost): void {
  const caller = (exec: ToolRunContext): CreationInvocation => {
    if (exec.agent === undefined) throw new Error('Creation requires a conversation')
    const turn = ctx.agents.turnBoundaryOf(exec.agent.session)
    if (turn.openTurnStartSeq === null) throw new Error('Creation requires an active conversation turn')
    return { sessionId: exec.agent.session.id, turn: turn.lastTurn, callId: exec.callId }
  }
  const when = ({ agent }: { agent?: ToolRunContext['agent'] }) => agent !== undefined && service.resolveWorkbench(agent.session.id) !== undefined
  ctx.tools.register(defineTool({ name: 'creation_describe',
    description: 'Read the connected workbench media capabilities, exact generation parameter schemas, reference roles and configured defaults.',
    parameters: {}, output,
    async execute(_args, exec) { return jsonObject.parse({ capabilities: await service.describe(caller(exec)) }) },
  }), { when })
  ctx.tools.register(defineTool({ name: 'creation_generate',
    description: 'Generate an image, video or audio using the connected Creation workbench. Returns a durable task ID; completed media is automatically delivered. creation_status returns generated assetIds and file paths. An awaiting-approval task requires workbench credit consent before paid execution; a new request or retry does not grant consent. Outputs do not require present. Parameters must match the current creation_describe schema.',
    parameters: {
      kind: { type: 'string', enum: ['image', 'video', 'audio'], required: true },
      prompt: { type: 'string', required: true },
      references: { type: 'json', description: 'Array of {source:{assetId} or {path},role}. Use an existing media file; e.g. role first-frame or reference, as supported by the configured Provider.' },
      parameters: { type: 'json', description: 'Generation settings matching the parameterSchema returned by creation_describe. Overrides the workbench defaults.' },
    }, output,
    async execute(args, exec) { return service.generate(generateInput.parse(args), caller(exec)) },
  }), { when })
  for (const operation of ['status', 'retry', 'cancel'] as const) {
    ctx.tools.register(defineTool({ name: `creation_${operation}`,
      description: operation === 'status' ? 'Read a creation task and its completed media files.' : operation === 'retry'
        ? 'Recover an existing creation task after a query, download or delivery failure. Does not start a new paid generation.'
        : 'Stop automatic delivery of future outputs and attempt to cancel the remote generation. Already delivered files remain.',
      parameters: { jobId: { type: 'string', required: true } }, output,
      async execute(args, exec) {
        const invocation = caller(exec)
        const id = args.jobId as JobId
        if (operation === 'status') return jsonObject.parse(await service.getJob(id, invocation))
        if (operation === 'retry') return jsonObject.parse(await service.retryJob(id, invocation))
        return jsonObject.parse(await service.cancelJob(id, invocation))
      },
    }), { when: ({ agent }) => service.resolveWorkbench(agent.session.id) !== undefined || service.hasJobs(agent.session.id) })
  }
}
