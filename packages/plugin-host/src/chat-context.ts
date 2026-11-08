/** Session-bound Convax identity and skill routing through DSH runtime context. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { CanvasRepository } from './repository.ts'

type ChatRepository = Pick<CanvasRepository, 'bindingOf' | 'getChat'>

class CanvasChatContext {
  constructor(private readonly repository: ChatRepository) {}

  render(agent: Agent | undefined): string {
    if (agent === undefined) return ''
    const binding = this.repository.bindingOf(agent.session.id)
    if (binding === undefined) return ''
    const chat = this.repository.getChat(binding.canvasId, binding.nodeId)
    if (chat === undefined || chat.deleting) return ''
    const identity = {
      canvasId: binding.canvasId, chatNodeId: binding.nodeId, sessionId: agent.session.id,
      projectDirectory: agent.session.header.cwd ?? chat.cwd,
    }
    return [
      `Convax Chat identity: ${JSON.stringify(identity)}`,
      'For work involving the canvas, its resources, or Chat threads, load the `convax` skill when available. Convax tools default to this bound canvas, independently of the open tab.',
    ].join('\n')
  }
}

/**
 * Contribute bound Chat identity without copying the graph or changing Session input.
 * Unbound, removed, and deleting Chats contribute no text. DSH refreshes and persists
 * the optional runtime snapshot; disposing this Host removes the contribution.
 * @param ctx - Host lifetime; the system-prompt registry may become available later.
 * @param repository - Authoritative Session bindings and current Chat state.
 */
export function registerCanvasChatContext(ctx: Context, repository: ChatRepository): void {
  const context = new CanvasChatContext(repository)
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.context({
      name: 'convax:chat', order: 250, interpolate: false,
      text: ({ agent }) => context.render(agent),
    })
  })
}
