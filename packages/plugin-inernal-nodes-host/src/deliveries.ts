/** Session delivery recovery uses a pure projection and transactional file receipts. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-tool-present/types'
import type { ProjectionDefinition, ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { createFileDeliveryOutput } from './file-delivery.ts'
import type { CanvasRepository } from '@deepseek-ai/dsh-convax-plugin-host'

const stateSchema = z.object({
  inheritedEventCount: z.number().int().nonnegative(),
  deliveries: z.array(z.object({
    seq: z.number().int().nonnegative(),
    files: z.array(z.object({ path: z.string(), description: z.string().optional() })),
  })),
})
type DeliveryState = z.infer<typeof stateSchema>

/** Pure file facts needed to repair missed live delivery observations. */
export const canvasDeliveryProjection: ProjectionDefinition<'convaxDeliveries', DeliveryState> = {
  key: 'convaxDeliveries', stateVersion: 1, stateSchema,
  init: (_header, inheritedEventCount) => ({ inheritedEventCount, deliveries: [] }),
  apply: (state, event) => event.type === 'deliverables/presented' && event.seq >= state.inheritedEventCount
    ? { ...state, deliveries: [...state.deliveries, { seq: event.seq, files: event.data.files }] }
    : state,
}

/** Host-owned catch-up survives closed views and never starts an Agent. */
export class CanvasDeliveryCoordinator {
  private readonly known = new Set<SessionId>()
  private readonly running = new Map<SessionId, Promise<void>>()
  private readonly dirty = new Set<SessionId>()
  private readonly lifetime = new AbortController()
  private starting: Promise<void> | undefined
  private closing: Promise<void> | undefined
  private unsubscribeEvents: (() => void) | undefined
  private projection: ProjectionHandle<DeliveryState> | undefined
  private unsubscribe: (() => void) | undefined

  /**
   * @param ctx - Session persistence and projection owners.
   * @param repository - Graph and receipt transaction owner.
   */
  constructor(private readonly ctx: Context, private readonly repository: CanvasRepository) {}

  /**
   * Register recovery before publishing live observers, then catch up existing bindings.
   * @returns Once initial deliveries have completed or exposed a retryable failure.
   */
  start(): Promise<void> {
    return this.starting ??= this.initialize()
  }

  private async initialize(): Promise<void> {
    this.lifetime.signal.throwIfAborted()
    this.projection = await this.ctx.sessionProjections.register(canvasDeliveryProjection)
    this.lifetime.signal.throwIfAborted()
    this.unsubscribeEvents = this.ctx.on('session/event', (session, event) => {
      if (event.type === 'deliverables/presented' && this.repository.bindingOf(session.id) !== undefined) this.schedule(session.id)
    })
    this.unsubscribe = this.repository.subscribe(() => { this.discover() })
    this.discover()
    await Promise.all([...this.running.values()])
  }

  private discover(): void {
    for (const binding of this.repository.coordination.bindings()) {
      if (this.known.has(binding.sessionId)) continue
      this.known.add(binding.sessionId)
      this.schedule(binding.sessionId)
    }
  }

  private schedule(sessionId: SessionId): void {
    if (this.lifetime.signal.aborted) return
    this.dirty.add(sessionId)
    if (this.running.has(sessionId)) return
    const pending = Promise.resolve().then(async () => {
      do {
        this.dirty.delete(sessionId)
        try {
          await this.project(sessionId)
          await this.repository.coordination.deliveryFailure(sessionId, null)
        } catch (error) {
          if (this.lifetime.signal.aborted) return
          const message = error instanceof Error ? error.message : String(error)
          this.ctx.logger.error('Canvas delivery recovery failed', error)
          await this.repository.coordination.deliveryFailure(sessionId, message)
        }
      } while (this.dirty.has(sessionId) && !this.lifetime.signal.aborted)
    })
    this.running.set(sessionId, pending)
    const complete = (): void => {
      this.running.delete(sessionId)
      if (this.dirty.has(sessionId)) this.schedule(sessionId)
    }
    void pending.then(complete, (error: unknown) => {
      complete()
      this.ctx.logger.error('Canvas delivery failure could not be retained', error)
    })
  }

  private async project(sessionId: SessionId): Promise<void> {
    const projection = this.projection
    if (projection === undefined) throw new Error('Delivery projection is not ready')
    const binding = this.repository.coordination.bindings().find(value => value.sessionId === sessionId)
    if (binding === undefined) return
    const live = this.ctx.sessions.get(sessionId)
    let state: DeliveryState
    if (live !== undefined) {
      state = projection.stateOf(live)
      await this.ctx.sessions.flush(live)
    } else {
      const handle = await this.ctx.sessionPersistence.open(sessionId, 'read', { signal: this.lifetime.signal })
      try {
        const read = await handle.read(0, undefined, { signal: this.lifetime.signal })
        const resumed = this.ctx.sessions.get(sessionId)
        if (resumed !== undefined) {
          state = projection.stateOf(resumed)
          await this.ctx.sessions.flush(resumed)
        } else {
          const prepared = this.ctx.sessions.prepare(sessionId, {
            seed: [...read.events], meta: handle.header, inheritedEventCount: handle.inheritedEventCount, eventState: read.eventState,
          })
          state = projection.stateOf(prepared)
        }
      } finally { await handle.close() }
    }
    for (const delivery of state.deliveries) {
      this.lifetime.signal.throwIfAborted()
      if (delivery.seq > binding.deliveryCursor) {
        await this.repository.coordination.projectDelivery(sessionId, delivery.seq, delivery.files, createFileDeliveryOutput)
      }
    }
  }

  /**
   * Retry delivery catch-up after a visible filesystem or storage failure.
   * @returns Once all current bindings have been checked again.
   */
  async retry(): Promise<void> {
    const sessionIds = this.repository.coordination.bindings().map(binding => binding.sessionId)
    for (const sessionId of sessionIds) this.schedule(sessionId)
    await Promise.all(sessionIds.map(async (sessionId) => {
      for (;;) {
        const pending = this.running.get(sessionId)
        if (pending === undefined) return
        await pending
      }
    }))
  }

  /**
   * Cancel cold reads and drain graph writes before dependencies are released.
   * @returns Once every owned catch-up and projection registration is disposed.
   */
  close(): Promise<void> {
    return this.closing ??= this.finishClose()
  }

  private async finishClose(): Promise<void> {
    this.lifetime.abort()
    this.unsubscribeEvents?.()
    this.unsubscribe?.()
    await this.starting?.then(() => {}, () => {})
    await Promise.allSettled([...this.running.values()])
    await this.projection?.dispose()
  }
}
