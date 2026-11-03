/** Cold Session materialization owned by Convax's durable thread intentions. */
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset, SessionPreparation, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { CanvasRepository } from './repository.ts'
import type { CanvasSessionReservation, CanvasThreadIntent } from './coordination-repository.ts'
import { threadRequestSchema } from './schema.ts'
import type { CanvasOperationId, CanvasThreadRequest } from './types.ts'

/** Session identity confirmed by its native persistence and Workspace membership. */
export interface CanvasSessionReceipt {
  readonly sessionId: SessionId
  readonly inheritedEventCount: number
}

/** Private coordinator dependency; tests can control external Session failures. */
export interface CanvasThreadSessions {
  /** @param operationId - Reserved Convax thread intention. @returns Its confirmed native Session. */
  materialize(operationId: CanvasOperationId): Promise<CanvasSessionReceipt>
}

/** Uses DSH's public Session APIs without modifying the Session Controller. */
export class CanvasSessionMaterializer implements CanvasThreadSessions {
  /** @param ctx - Native persistence, query, Session and optional preset services. @param repository - Durable Convax intentions. */
  constructor(private readonly ctx: Context, private readonly repository: CanvasRepository) {}

  /**
   * Complete the same reserved Session after cancellation, a lost reply or restart.
   * @param operationId - Stable Convax operation identity.
   * @returns Confirmed Session identity and its inherited source-prefix length.
   */
  async materialize(operationId: CanvasOperationId): Promise<CanvasSessionReceipt> {
    const intent = this.repository.coordination.thread(operationId)
    if (intent === undefined) throw new Error('Convax thread intention is absent')
    const request = threadRequestSchema.parse(JSON.parse(intent.request))
    const session = intent.session ?? await this.repository.coordination.reserveSession(operationId, await this.plan(request, intent))
    if (session.phase === 'reserved') {
      await this.persist(request, session)
      const stored = await this.ctx.sessionPersistence.stat(session.sessionId)
      if (stored?.header.cwd !== session.cwd) throw new Error('Reserved Session has an unexpected persisted directory')
      const workspace = await this.ctx.workspaceRegistry.create(session.cwd)
      await workspace.attachSession(session.sessionId)
      await this.repository.coordination.completeSession(operationId)
    }
    return { sessionId: session.sessionId, inheritedEventCount: session.boundary === undefined ? 0 : session.boundary + 1 }
  }

  private async preset(requested: string | undefined): Promise<string | undefined> {
    const registry = this.ctx.get('agentPresets')
    if (registry === undefined) {
      if (requested !== undefined) throw new Error(`Agent preset ${requested} is unavailable without a preset registry`)
      return undefined
    }
    return (await registry.resolve(requested)).id
  }

  private async plan(request: CanvasThreadRequest, intent: CanvasThreadIntent): Promise<CanvasSessionReservation> {
    let cwd = intent.cwd
    let boundary: number | undefined
    let requested = request.kind === 'create' ? request.agentPreset : undefined
    if (request.kind === 'fork') {
      using source = await this.ctx.sessionQuery.observeSession(request.sourceSessionId)
      boundary = request.atSeq ?? completedPrefix(source.events)
      if (boundary === undefined || source.events[boundary]?.seq !== boundary) throw new Error('Source Session has no event at the requested fork position')
      if (source.header.cwd === undefined) throw new Error('Source Session has no working directory')
      cwd = source.header.cwd
      if (source.projections === undefined) throw new Error('Fork requires a projected Session observation')
      requested = source.projections.values.agentPreset ?? undefined
      await this.ctx.sessionPersistence.flush()
    }
    const agentPreset = await this.preset(requested)
    return {
      phase: 'reserved', sessionId: SessionId(`session-${randomUUID()}`), createdAt: Date.now(), cwd,
      ...(agentPreset === undefined ? {} : { agentPreset }), ...(boundary === undefined ? {} : { boundary }),
    }
  }

  private async persist(request: CanvasThreadRequest, reservation: CanvasSessionReservation): Promise<void> {
    let seed: readonly SessionEvent[] = []
    if (request.kind === 'fork') {
      using source = await this.ctx.sessionQuery.observeSession(request.sourceSessionId)
      if (reservation.boundary === undefined || source.events[reservation.boundary]?.seq !== reservation.boundary) throw new Error('Reserved fork source no longer contains its inherited prefix')
      seed = buildForkSeed(source.events, SessionSeq(reservation.boundary))
    }
    const inheritedEventCount = SessionLogOffset(reservation.boundary === undefined ? 0 : reservation.boundary + 1)
    const live = this.ctx.sessions.get(reservation.sessionId)
    if (live !== undefined) {
      using source = await this.ctx.sessionQuery.observeSession(live.id)
      this.validate(reservation, request, live.header, live.inheritedEventCount, source.events.slice(0, seed.length), seed)
      if (source.events.length < seed.length || !await this.ctx.sessions.flush(live)) throw new Error('Live reserved Session has no complete persistence checkpoint')
      return
    }
    let handle
    try { handle = await this.ctx.sessionPersistence.open(reservation.sessionId, 'write') } catch (error) {
      if (!(error instanceof SessionPersistenceNotFoundError)) throw error
      await mkdir(reservation.cwd, { recursive: true })
      using prepared = SessionPreparation.create(this.ctx.sessions.prepare(reservation.sessionId, {
        meta: {
          createdAt: reservation.createdAt, cwd: reservation.cwd, isSeeded: request.kind === 'fork',
          ...(reservation.agentPreset === undefined ? {} : { agentPreset: reservation.agentPreset }),
        }, seed, inheritedEventCount,
      }))
      handle = await this.ctx.sessionPersistence.create(prepared.session.header, { inheritedEventCount })
    }
    await using owned = handle
    const existing = (await owned.read(0, seed.length)).events
    this.validate(reservation, request, owned.header, owned.inheritedEventCount, existing, seed)
    if (existing.length < seed.length) await owned.append(seed.slice(existing.length))
    await owned.flush()
  }

  private validate(
    reservation: CanvasSessionReservation, request: CanvasThreadRequest, header: SessionHeader, inherited: number,
    existing: readonly SessionEvent[], seed: readonly SessionEvent[],
  ): void {
    if (header.id !== reservation.sessionId || header.createdAt !== reservation.createdAt || header.cwd !== reservation.cwd
      || header.agentPreset !== reservation.agentPreset || header.isSeeded !== (request.kind === 'fork')
      || inherited !== (reservation.boundary === undefined ? 0 : reservation.boundary + 1)) throw new Error('Reserved Session has different persisted metadata')
    if (!isDeepStrictEqual(existing, seed.slice(0, existing.length))) throw new Error('Reserved Session has a different inherited prefix')
  }
}

function completedPrefix(events: readonly SessionEvent[]): number | undefined {
  const end = events.findLast(event => event.type === 'turn/end')
  if (end === undefined) return undefined
  let boundary: number = end.seq
  for (const event of events.slice(boundary + 1)) {
    if (event.type === 'turn/start' || (event.type === 'user/message' && event.surfaceOp === 'append') || event.type === 'agent/inbox/spliced') break
    boundary = event.seq
  }
  return boundary
}
