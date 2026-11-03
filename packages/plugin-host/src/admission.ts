/** Prevent model steps owned by deleting Chats through DSH's existing hook. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CanvasRepository } from './repository.ts'

type AdmissionRepository = Pick<CanvasRepository, 'bindingOf' | 'getChat'>

/**
 * Register the Chat lifecycle guard without changing queued messages or references.
 * Deleting Chats and their subagent lineage cannot enter a model step;
 * native Sessions and independent forks retain their ordinary admission behavior.
 * @param ctx - Host context with live Session lookup and Agent hooks.
 * @param repository - Authoritative unique bindings and Chat deletion state.
 * @returns Registration disposer; await it before closing the repository.
 */
export function registerCanvasAdmission(ctx: Context, repository: AdmissionRepository): () => Promise<void> {
  const lifetime = new AbortController()
  const checks = new Set<Promise<boolean>>()
  const dispose = ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const check = blocked(ctx, repository, agent, AbortSignal.any([signal, lifetime.signal]))
    checks.add(check)
    try {
      return await check || lifetime.signal.aborted ? { kind: 'reject' as const } : await next()
    } finally { checks.delete(check) }
  })
  return async () => {
    dispose()
    lifetime.abort()
    await Promise.allSettled([...checks])
  }
}

async function blocked(ctx: Context, repository: AdmissionRepository, agent: Agent, signal: AbortSignal): Promise<boolean> {
  let header = agent.session.header
  const visited = new Set<SessionId>()
  while (!visited.has(header.id)) {
    signal.throwIfAborted()
    visited.add(header.id)
    const binding = repository.bindingOf(header.id)
    if (binding !== undefined) {
      const chat = repository.getChat(binding.canvasId, binding.nodeId)
      if (chat === undefined || chat.deleting) return true
    }
    if (header.origin !== 'subagent' || header.parentSession === undefined) return false
    const parent = ctx.sessions.get(header.parentSession)?.header
      ?? (await ctx.sessionPersistence.stat(header.parentSession, { signal }))?.header
    if (parent === undefined) return false
    header = parent
  }
  return false
}
