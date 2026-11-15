/** Durable Host declarations share the existing file delivery event and UI. */
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionEventMap, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { ProjectionDefinition, ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { validatePresentedFiles } from './files.ts'
import type { DeliveryReceipt, PresentedFile, PublishDeliverables } from './types.ts'

type Declaration = SessionEventMap['deliverables/presented']
const stateSchema = z.object({
  inheritedEventCount: z.number().int().nonnegative(),
  receipts: z.array(z.object({
    seq: z.number().int().nonnegative(), key: z.string(), turn: z.number().int().nonnegative(), callId: z.string(),
    files: z.array(z.object({ path: z.string(), description: z.string().optional() })),
  })),
})
type ReceiptState = z.infer<typeof stateSchema>

// Retains one compact receipt per keyed delivery; unrelated events retain no state.
const receiptProjection: ProjectionDefinition<'deliverableReceipts', ReceiptState> = {
  key: 'deliverableReceipts', stateVersion: 1, stateSchema,
  init: (_header, inheritedEventCount) => ({ inheritedEventCount, receipts: [] }),
  apply: (state, event) => event.type === 'deliverables/presented'
    && event.seq >= state.inheritedEventCount && event.data.deliveryKey !== undefined
    ? { ...state, receipts: [...state.receipts, {
      seq: event.seq, key: event.data.deliveryKey, turn: event.data.turn,
      callId: event.data.callId, files: event.data.files,
    }] }
    : state,
}

/** A reused delivery key names a different declaration. */
export class DeliveryKeyConflictError extends Error {
  /** Stable discriminator for an immutable delivery-key conflict. */
  readonly code = 'DELIVERY_KEY_CONFLICT'
  /** Previously committed key whose invocation or files differ. */
  readonly deliveryKey: string
  /** @param deliveryKey - Previously committed key that cannot be reassigned. */
  constructor(deliveryKey: string) {
    super(`Delivery key ${JSON.stringify(deliveryKey)} already belongs to a different declaration`)
    this.name = 'DeliveryKeyConflictError'
    this.deliveryKey = deliveryKey
  }
}

/**
 * Append one admitted declaration; the caller owns filesystem admission and durability.
 * @param session - Live or exclusively restored Session.
 * @param data - Validated files and original invocation coordinates.
 * @returns The appended Session position.
 */
export function appendDelivery(session: Session, data: Declaration): SessionSeq {
  return session.append('deliverables/presented', data).seq
}

/** Owns publication until its Host plugin drains it; never starts or retains an Agent. */
export class DeliverablePublisher {
  private readonly pending = new Map<SessionId, Promise<unknown>>()
  private readonly lifetime = new AbortController()
  private ready: Promise<ProjectionHandle<ReceiptState>> | undefined
  private closing: Promise<void> | undefined

  /** @param ctx - Host owner injecting fs, sessions, sessionPersistence and sessionProjections. */
  constructor(private readonly ctx: Context) {}

  /**
   * Prepare receipt recovery before accepting background publications.
   * @returns Once the private durable receipt projection is ready.
   */
  async start(): Promise<void> {
    this.lifetime.signal.throwIfAborted()
    this.ready ??= this.ctx.sessionProjections.register(receiptProjection)
    await this.ready
    this.lifetime.signal.throwIfAborted()
  }

  /**
   * Publish once under the Session writer and flush before returning. An uncertain
   * durability error may be retried with the same key; changed payloads conflict.
   * @param input - Original invocation and existing absolute file paths.
   * @param signal - Cancellation observed before append; committed writes still flush.
   * @returns A durable declaration receipt, independently of later canvas projection.
   */
  async publish(input: PublishDeliverables, signal?: AbortSignal): Promise<DeliveryReceipt> {
    await this.start()
    if (input.deliveryKey.trim().length === 0) throw new Error('A delivery key is required')
    if (input.files.length === 0 || input.files.some(file => !isAbsolute(file.path))) {
      throw new Error('Host deliveries require existing absolute file paths')
    }
    const request = structuredClone(input)
    const operationSignal = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
    const previous = this.pending.get(request.origin.sessionId)
    const run = (previous ?? Promise.resolve()).then(
      () => this.publishOwned(request, operationSignal),
      () => this.publishOwned(request, operationSignal),
    )
    this.pending.set(request.origin.sessionId, run)
    try { return await run } finally {
      if (this.pending.get(request.origin.sessionId) === run) this.pending.delete(request.origin.sessionId)
    }
  }

  private async publishOwned(input: PublishDeliverables, signal: AbortSignal): Promise<DeliveryReceipt> {
    signal.throwIfAborted()
    // Resolve aliases before matching receipts; a previously delivered file need not still exist.
    const files: PresentedFile[] = []
    for (const file of input.files) {
      const target = await this.ctx.fs.resolve(file.path, { signal })
      files.push({ ...file, path: this.ctx.fs.processPath(target) })
    }
    const data: Declaration = {
      turn: input.origin.turn, callId: input.origin.callId, deliveryKey: input.deliveryKey, files,
    }
    const projection = await this.ready
    if (projection === undefined) throw new Error('Delivery publisher is not ready')
    let live = this.ctx.sessions.get(input.origin.sessionId)
    if (live !== undefined) {
      let eventSeq = this.findReceipt(live, data, projection)
      if (eventSeq === undefined) {
        await validatePresentedFiles(this.ctx.fs, input.files, { signal })
        live = this.ctx.sessions.get(input.origin.sessionId)
        if (live === undefined) return this.publishCold(input, data, projection, signal)
        eventSeq = this.findReceipt(live, data, projection) ?? appendDelivery(live, data)
      }
      if (!await this.ctx.sessions.flush(live)) throw new Error('No durability owner is available for this Session')
      return this.announced(input.origin.sessionId, eventSeq)
    }
    return this.publishCold(input, data, projection, signal)
  }

  private async publishCold(
    input: PublishDeliverables, data: Declaration, projection: ProjectionHandle<ReceiptState>, signal: AbortSignal,
  ): Promise<DeliveryReceipt> {
    const handle = await this.ctx.sessionPersistence.open(input.origin.sessionId, 'write', { signal })
    let eventSeq: SessionSeq
    try {
      const read = await handle.read(0, undefined, { signal })
      const restored = Session.fromRestore(handle.id, read.events, handle.header, handle.inheritedEventCount, read.eventState)
      const previous = this.findReceipt(restored, data, projection)
      if (previous === undefined) {
        await validatePresentedFiles(this.ctx.fs, input.files, { signal })
        signal.throwIfAborted()
        const event: SessionEvent<'deliverables/presented'> = {
          type: 'deliverables/presented', seq: SessionSeq(read.events.length), time: Date.now(), data,
        }
        await handle.append([event])
        eventSeq = event.seq
      } else eventSeq = previous
      await handle.flush()
    } finally { await handle.close() }
    return this.announced(input.origin.sessionId, eventSeq)
  }

  private findReceipt(session: Session, data: Declaration, projection: ProjectionHandle<ReceiptState>): SessionSeq | undefined {
    const previous = projection.stateOf(session).receipts.find(receipt => receipt.key === data.deliveryKey)
    if (previous === undefined) return undefined
    if (previous.turn !== data.turn || previous.callId !== data.callId || previous.files.length !== data.files.length
      || previous.files.some((file, index) => {
        const current = data.files[index]
        return current === undefined || file.path !== current.path || file.description !== current.description
      })) {
      throw new DeliveryKeyConflictError(previous.key)
    }
    return SessionSeq(previous.seq)
  }

  private announced(sessionId: SessionId, eventSeq: SessionSeq): DeliveryReceipt {
    try { this.ctx.emit('deliverables/published', sessionId, eventSeq) } catch (error) {
      this.ctx.logger.error('A durable delivery observer failed; retry delivery projection', error)
    }
    return { sessionId, eventSeq }
  }

  /**
   * Stop admission and drain publication before releasing receipt recovery.
   * @returns Once pending writes and the projection registration have drained.
   */
  close(): Promise<void> {
    return this.closing ??= this.finishClose()
  }

  private async finishClose(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled([...this.pending.values()])
    const projection = await this.ready?.catch(() => undefined)
    await projection?.dispose()
  }
}
