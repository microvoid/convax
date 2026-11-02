/** Attach existing native Sessions to Chat nodes without touching their logs, schedules, or Workspace membership. */
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-workspace'
import { CanvasCoordinationError } from './coordination-repository.ts'
import type { CanvasRepository } from './repository.ts'
import type { CanvasOpenSessionRequest, CanvasOpenSessionResult } from './types.ts'

/**
 * Read the original Session and atomically publish its unique Chat binding.
 * @param ctx - Native Session query and archive owners.
 * @param repository - Exclusive graph and binding transaction owner.
 * @param request - Retained caller placement identity.
 * @param signal - Coordinator lifetime, drained before repository disposal.
 * @returns Existing or newly committed location, or a rejection without creating a Session.
 */
export async function openExistingCanvasSession(
  ctx: Context, repository: CanvasRepository, request: CanvasOpenSessionRequest, signal: AbortSignal,
): Promise<CanvasOpenSessionResult> {
  try {
    signal.throwIfAborted()
    const admit = (): void => {
      signal.throwIfAborted()
      if (ctx.workspaceRegistry.archivedSessionIds.includes(request.sessionId)) {
        throw new CanvasCoordinationError('invalid-command', 'The original Session is archived')
      }
    }
    admit()
    using source = await ctx.sessionQuery.observeSession(request.sessionId, { signal, projectionMode: 'none' })
    const cwd = source.header.cwd
    if (cwd === undefined || !isAbsolute(cwd)) throw new CanvasCoordinationError('invalid-command', 'The original Session has no absolute project directory')
    const bound = await repository.openSession(request, {
      cwd, title: source.header.id, parentSessionId: source.header.parentSession ?? null,
      inheritedEventCount: source.inheritedEventCount, deliveryCursor: source.cursor,
    }, admit, signal)
    return { ok: true, canvasId: bound.canvasId, nodeId: bound.nodeId, sessionId: bound.sessionId, workspace: repository.snapshot() }
  } catch (error) {
    const code = error instanceof CanvasCoordinationError ? error.code
      : error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND' ? 'not-found' : 'operation-pending'
    return { ok: false, code, message: error instanceof Error ? error.message : String(error), workspace: repository.snapshot() }
  }
}
