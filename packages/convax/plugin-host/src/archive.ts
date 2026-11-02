/** Convax deletion settlement using the original Workspace and activity APIs. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-jobs'
import { WorkspaceActiveSessionError } from '@deepseek-ai/dsh-workspace'

/**
 * Archive a Chat thread and its actual subagent descendants, retaining history.
 * Stop failures and residual activity reject; the caller retains its deletion
 * intention for retry. Cancellation ends waiting without reversing archival.
 * @param ctx - Host context carrying Session persistence and activity owners.
 * @param root - Thread whose work must settle before graph removal.
 * @param signal - Caller and Host lifetime cancellation for waiting.
 * @param beforeArchive - Persist a previously unarchived restoration target before its archive write.
 * @returns Once all discovered Sessions are archived and inactive.
 */
export async function archiveCanvasThread(
  ctx: Context, root: SessionId, signal: AbortSignal, beforeArchive?: (sessionId: SessionId) => Promise<void>,
): Promise<void> {
  const stopped = new Set<SessionId>()
  for (;;) {
    signal.throwIfAborted()
    const ids = await descendants(ctx, root, signal)
    for (const id of ids) {
      if (stopped.has(id)) continue
      const wasArchived = ctx.workspaceRegistry.archivedSessionIds.includes(id)
      if (!wasArchived) await beforeArchive?.(id)
      await ctx.workspaceRegistry.archiveSession(id, { stopActivity: true })
      // Native archival does not request another stop for an already archived id.
      if (wasArchived) await ctx.parallel('workspace/session-stop', { sessionId: id })
      stopped.add(id)
    }
    for (const id of ids) {
      signal.throwIfAborted()
      const agent = ctx.agents.get(id)
      if (agent !== undefined) {
        agent.cancel({ kind: 'user' })
        await cancellable(agent.whenIdle(), signal)
      }
      await settleJobs(ctx, id, signal)
    }
    const observed = await descendants(ctx, root, signal)
    if (observed.some(id => !stopped.has(id))) continue
    for (const id of observed) {
      signal.throwIfAborted()
      const activity = await ctx.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([]))
      if (activity.length > 0) throw new WorkspaceActiveSessionError(id, activity)
      if (!ctx.workspaceRegistry.archivedSessionIds.includes(id)) throw new Error(`Session "${id}" was restored while its Chat was being deleted; retry deletion`)
    }
    signal.throwIfAborted()
    return
  }
}

async function descendants(ctx: Context, root: SessionId, signal: AbortSignal): Promise<SessionId[]> {
  const headers = new Map<SessionId, SessionHeader>()
  for (const item of await ctx.sessionPersistence.list({ signal })) headers.set(item.header.id, item.header)
  for (const session of ctx.sessions.list()) headers.set(session.id, session.header)
  const ids = new Set([root])
  for (let changed = true; changed;) {
    changed = false
    for (const header of headers.values()) {
      if (header.origin !== 'subagent' || header.parentSession === undefined || !ids.has(header.parentSession) || ids.has(header.id)) continue
      ids.add(header.id)
      changed = true
    }
  }
  return [...ids]
}

function settleJobs(ctx: Context, owner: SessionId, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const jobs = ctx.get('jobs')
  if (jobs === undefined) return Promise.resolve()
  const running = () => jobs.list(owner).filter(job => job.owner === owner && (job.status === 'running' || job.status === 'stopping'))
  return new Promise<void>((resolve, reject) => {
    let dispose = (): void => {}
    const finish = (error?: unknown): void => {
      dispose()
      signal.removeEventListener('abort', abort)
      if (error === undefined) resolve()
      else reject(error instanceof Error ? error : new Error('Session job settlement failed', { cause: error }))
    }
    const check = (): void => { if (running().length === 0) finish() }
    const abort = (): void => { finish(signal.reason) }
    dispose = jobs.events.subscribe({ owner }, check)
    signal.addEventListener('abort', abort, { once: true })
    try {
      for (const job of running()) jobs.kill(job.id, owner, 'Chat deleted')
      check()
    } catch (error) { finish(error) }
  })
}

function cancellable(pending: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const abort = (): void => { reject(signal.reason instanceof Error ? signal.reason : new Error('Session stop wait cancelled', { cause: signal.reason })) }
    signal.addEventListener('abort', abort, { once: true })
    void pending.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
  })
}
