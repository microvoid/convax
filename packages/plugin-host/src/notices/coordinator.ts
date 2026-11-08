/** Host-owned candidate selection, local frequency limits and cross-window presentation leases. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from 'zod'
import type { ClientGuidanceItem, ClientGuidanceSnapshot, ClientPolicySnapshot } from '@convax/api-contracts/notices'
import type { NoticeHistory, NoticeHistoryRecord, NoticePersistence } from './persistence.ts'
import { NOTICE_HISTORY_LIMIT } from './persistence.ts'
import type { NoticeClientId, NoticeCoordinatorConfig, NoticeDisplayContext, NoticeOutcome, NoticePresentation, NoticePresentationId } from './types.ts'

/** Independent endpoint results; an unavailable endpoint never implicitly clears its last snapshot. */
export interface NoticeSourceResult {
  readonly policy?: ClientPolicySnapshot
  readonly guidance?: ClientGuidanceSnapshot
  readonly errors?: readonly ('policy' | 'guidance')[]
}

/** One configured source; the coordinator owns refresh timing and disposal. */
export interface NoticeSource {
  /** @param signal - Host shutdown cancellation. @returns Independently successful endpoint snapshots. */
  read(signal?: AbortSignal): Promise<NoticeSourceResult>
  /** Abort pending transport work without publishing a new snapshot. */
  dispose(): void
}

/** Constructor dependencies owned by the composing Host plugin. */
export interface NoticeCoordinatorOptions {
  readonly source?: NoticeSource
  readonly persistence: NoticePersistence
  readonly config: NoticeCoordinatorConfig
  readonly now?: () => number
}

interface Candidate {
  readonly key: string
  readonly notice: Omit<NoticePresentation, 'id'>
  readonly priority: number
  readonly item?: ClientGuidanceItem
}

interface Lease {
  readonly clientId: NoticeClientId
  readonly owner: string
  readonly candidate: Candidate
  readonly presentation: NoticePresentation
  expiresAt: number
  shown: boolean
}

const identitySchema = z.uuid()
const displayContextSchema = z.object({
  available: z.boolean(), busy: z.boolean(), capabilities: z.array(z.string().min(1).max(128)).max(128),
}).strict()
const outcomeSchema = z.enum(['dismissed', 'snoozed', 'action', 'expired'])

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-owned installation notice scheduling and presentation leases. */
    convaxNotices: NoticeCoordinator
  }
}

/** Selects one presentation across every renderer connected to this Host. */
export class NoticeCoordinator extends TypertRemoteService {
  private readonly now: () => number
  private history: NoticeHistory
  private policy: ClientPolicySnapshot | undefined
  private guidance: ClientGuidanceSnapshot | undefined
  private lease: Lease | undefined
  private pending: Promise<void> | undefined
  private nextCheckAt = 0
  private modalCount = 0
  private disposed = false
  private readonly lifetime = new AbortController()

  /**
   * @param ctx - Owning plugin context; disposal is registered by that plugin.
   * @param options - Explicit source, durable history, schedule and clock dependencies.
   */
  constructor(ctx: Context, private readonly options: NoticeCoordinatorOptions) {
    super(ctx, 'convaxNotices')
    this.now = options.now ?? Date.now
    this.history = options.persistence.load()
  }

  /** @param signal - Caller cancellation. @returns Source status and renderer polling and idle intervals. */
  @Remote
  configuration(signal?: AbortSignal): { enabled: boolean; pollIntervalMs: number; idleMs: number } {
    this.assertLive()
    signal?.throwIfAborted()
    return { enabled: this.options.source !== undefined,
      pollIntervalMs: this.options.config.pollIntervalMs, idleMs: this.options.config.idleMs }
  }

  /**
   * Refresh due data and acquire or renew the sole presentation lease.
   * @param clientId - Connected renderer ownership identity.
   * @param context - Current local availability and enabled capabilities.
   * @param signal - Caller cancellation; does not abort a shared source refresh.
   * @returns This renderer's lease, or null when no eligible notice can be displayed.
   */
  @Remote
  async poll(clientId: NoticeClientId, context: NoticeDisplayContext, signal?: AbortSignal): Promise<NoticePresentation | null> {
    this.assertLive()
    identitySchema.parse(clientId)
    displayContextSchema.parse(context)
    const owner = this.ownerOf(clientId)
    signal?.throwIfAborted()
    if (this.options.source === undefined) return null
    await this.refresh()
    this.assertLive()
    signal?.throwIfAborted()
    const now = this.now()
    const candidates = this.candidates(context)
    if (this.lease !== undefined) {
      const stillEligible = this.current(this.lease.candidate, now)
        && (this.lease.owner !== owner || candidates.some(candidate => candidate.key === this.lease?.candidate.key))
      const preempted = this.lease.presentation.kind !== 'mandatory-update' && candidates.some(candidate => candidate.notice.kind === 'mandatory-update')
      if (this.lease.expiresAt <= now || !stillEligible || preempted) this.lease = undefined
      else {
        const replacement = candidates.find(candidate => candidate.key === this.lease?.candidate.key)
        if (replacement !== undefined && replacement.notice.revision !== this.lease.presentation.revision) {
          if (replacement.notice.surface !== this.lease.presentation.surface || replacement.notice.kind !== this.lease.presentation.kind) {
            this.lease = undefined
          } else {
            this.lease = { ...this.lease, candidate: replacement, presentation: { id: this.lease.presentation.id, ...replacement.notice } }
          }
        }
      }
    }
    if (this.lease !== undefined) {
      if (this.lease.owner !== owner) return null
      this.lease.expiresAt = now + this.options.config.leaseMs
      return this.lease.presentation
    }
    if (!context.available) return null
    const candidate = candidates.find((entry) => {
      if (entry.notice.kind === 'mandatory-update') return true
      if (context.busy) return false
      if (!this.canShow(entry, now)) return false
      if (entry.notice.surface !== 'modal') return true
      return this.modalCount < this.options.config.maxModalPerLaunch
        && (this.history.lastModalShownAt === null || now - this.history.lastModalShownAt >= this.options.config.modalCooldownMs)
    })
    if (candidate === undefined) return null
    const presentation: NoticePresentation = { id: randomUUID() as NoticePresentationId, ...candidate.notice }
    this.lease = { clientId, owner, candidate, presentation, expiresAt: now + this.options.config.leaseMs, shown: false }
    return presentation
  }

  /**
   * Commit an actual visible exposure once, without counting fetched or queued notices.
   * @param clientId - Owner of the active lease.
   * @param presentationId - Exact presentation confirmed by the renderer.
   * @param signal - Caller cancellation before the local commit.
   */
  @Remote
  presented(clientId: NoticeClientId, presentationId: NoticePresentationId, signal?: AbortSignal): void {
    this.assertLive()
    signal?.throwIfAborted()
    const lease = this.owned(clientId, presentationId)
    if (lease.shown) return
    const now = this.now()
    if (lease.presentation.kind !== 'mandatory-update') {
      const previous = this.history.records[lease.candidate.key]
      const record: NoticeHistoryRecord = { impressions: (previous?.impressions ?? 0) + 1, lastShownAt: now,
        dismissed: previous?.dismissed ?? false, snoozedUntil: previous?.snoozedUntil ?? null, updatedAt: now }
      const isModal = lease.presentation.surface === 'modal'
      this.commit(lease.candidate.key, record, isModal ? now : this.history.lastModalShownAt)
      if (isModal) this.modalCount++
    } else this.modalCount = this.options.config.maxModalPerLaunch
    lease.shown = true
  }

  /**
   * Commit a user choice after its action succeeds; mandatory actions retain the blocking surface.
   * @param clientId - Owner of the active lease.
   * @param presentationId - Visible presentation identity.
   * @param outcome - Close, configured reminder, successful action or transient message timeout.
   * @param actionId - Configured action authorizing reminder or action completion.
   * @param signal - Caller cancellation before the local commit.
   */
  @Remote
  finish(
    clientId: NoticeClientId, presentationId: NoticePresentationId, outcome: NoticeOutcome, actionId?: string, signal?: AbortSignal,
  ): void {
    this.assertLive()
    signal?.throwIfAborted()
    outcomeSchema.parse(outcome)
    if (actionId !== undefined) z.string().min(1).max(128).parse(actionId)
    const lease = this.owned(clientId, presentationId)
    const action = actionId === undefined ? undefined : lease.presentation.actions.find(value => value.id === actionId)
    if (actionId !== undefined && action === undefined) throw new Error('Convax notice action is not available')
    if (!lease.presentation.dismissible) {
      if (outcome !== 'action' || action === undefined || (action.type !== 'open_update' && action.type !== 'open_url')) {
        throw new Error('A required Convax update cannot be dismissed or postponed')
      }
      this.presented(clientId, presentationId, signal)
      return
    }
    if (outcome === 'snoozed' && action?.type !== 'snooze') throw new Error('Convax reminder needs its configured snooze action')
    if (outcome === 'action' && (action === undefined || (action.type !== 'open_update' && action.type !== 'open_url'))) {
      throw new Error('Convax notice completion needs its configured action')
    }
    if (outcome === 'expired' && lease.presentation.surface !== 'message') throw new Error('Only transient Convax messages can expire')
    this.presented(clientId, presentationId, signal)
    const previous = this.history.records[lease.candidate.key]
    if (previous === undefined) throw new Error('Convax notice exposure was not committed')
    const now = this.now()
    this.commit(lease.candidate.key, { ...previous, updatedAt: now,
      dismissed: outcome !== 'snoozed', snoozedUntil: action?.type === 'snooze' && outcome === 'snoozed' ? now + action.snoozeSeconds * 1000 : null,
    }, this.history.lastModalShownAt)
    if (this.lease === lease) this.lease = undefined
  }

  /** @param clientId - Renderer leaving the connection; only its own grant is released. */
  @Remote
  release(clientId: NoticeClientId): void {
    identitySchema.parse(clientId)
    if (this.lease?.owner === this.ownerOf(clientId)) this.lease = undefined
  }

  /** Abort and await the owned read; no later callback can publish or grant a presentation. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.lifetime.abort()
    this.options.source?.dispose()
    this.lease = undefined
    await this.pending
  }

  private async refresh(): Promise<void> {
    if (this.pending !== undefined) return this.pending
    if (this.options.source === undefined || this.now() < this.nextCheckAt) return
    const source = this.options.source
    this.pending = Promise.resolve().then(async () => {
      try {
        const result = await source.read(this.lifetime.signal)
        if (this.disposed) return
        if (result.policy !== undefined) this.policy = result.policy
        if (result.guidance !== undefined) this.guidance = result.guidance
        const intervals = [result.policy?.nextCheckAfterSeconds, result.guidance?.nextCheckAfterSeconds]
          .filter((value): value is number => value !== undefined)
        if (result.errors?.length) intervals.push(this.options.config.failureRetryMs / 1000)
        this.nextCheckAt = this.now() + (intervals.length === 0 ? this.options.config.failureRetryMs : Math.min(...intervals) * 1000)
      } catch (error) {
        if (this.disposed && this.lifetime.signal.aborted) return
        this.nextCheckAt = this.now() + this.options.config.failureRetryMs
        this.ctx.logger.warn('Convax notice refresh failed; retaining the last policy and guidance', error)
      }
    }).finally(() => { this.pending = undefined })
    return this.pending
  }

  private candidates(context: NoticeDisplayContext): Candidate[] {
    const candidates: Candidate[] = []
    const policy = this.policy
    if (policy?.update.required === true) {
      const update = policy.update
      const actions: NoticePresentation['actions'][number][] = []
      if (update.releaseId !== undefined) actions.push({ id: 'update', type: 'open_update', label: '', releaseId: update.releaseId })
      if (update.fallbackPage !== undefined) actions.push({ id: 'download-page', type: 'open_url', label: '', url: update.fallbackPage })
      candidates.push({ key: 'policy:update', priority: 100,
        notice: { noticeId: 'policy:update', revision: policy.revision, kind: 'mandatory-update', surface: 'modal',
          title: '', body: '', actions, dismissible: false } })
    }
    for (const maintenance of policy?.maintenance ?? []) {
      if (maintenance.status === 'resolved' || !maintenance.affectedCapabilities.some(capability => context.capabilities.includes(capability))) continue
      const key = `maintenance:${maintenance.id}:${maintenance.status}`
      candidates.push({ key, priority: 90, notice: { noticeId: key, revision: maintenance.revision, kind: 'maintenance',
        surface: 'message', title: maintenance.title, body: maintenance.body, actions: [], dismissible: true,
        holdMs: this.options.config.messageHoldMs } })
    }
    const now = this.now()
    for (const item of this.guidance?.items ?? []) {
      if (Date.parse(item.startsAt) > now || Date.parse(item.expiresAt) <= now
        || !item.requiresCapabilities.every(capability => context.capabilities.includes(capability))) continue
      candidates.push({ key: `guidance:${item.id}`, priority: item.kind === 'upgrade' ? 50 : item.kind === 'feature' ? 30 : 20, item,
        notice: { noticeId: item.id, revision: item.revision, kind: item.kind, surface: item.surface,
          title: item.content.title, body: item.content.body, actions: item.actions, dismissible: true,
          ...(item.surface === 'message' ? { holdMs: this.options.config.messageHoldMs } : {}) } })
    }
    return candidates.sort((left, right) => right.priority - left.priority)
  }

  private canShow(candidate: Candidate, now: number): boolean {
    const record = this.history.records[candidate.key]
    if (record === undefined) return true
    if (record.dismissed || (record.snoozedUntil !== null && record.snoozedUntil > now)) return false
    if (record.snoozedUntil !== null) return true
    if (record.impressions >= (candidate.item?.frequency.maxImpressions ?? 1)) return false
    return record.lastShownAt === null || now - record.lastShownAt >= (candidate.item?.frequency.cooldownSeconds ?? 0) * 1000
  }

  private current(candidate: Candidate, now: number): boolean {
    if (candidate.notice.kind === 'mandatory-update') return this.policy?.update.required === true
    if (candidate.notice.kind === 'maintenance') return this.policy?.maintenance.some(maintenance =>
      maintenance.status !== 'resolved' && `maintenance:${maintenance.id}:${maintenance.status}` === candidate.key) === true
    return this.guidance?.items.some(item => `guidance:${item.id}` === candidate.key
      && Date.parse(item.startsAt) <= now && Date.parse(item.expiresAt) > now) === true
  }

  private owned(clientId: NoticeClientId, id: NoticePresentationId): Lease {
    identitySchema.parse(clientId)
    identitySchema.parse(id)
    const lease = this.lease
    if (lease === undefined || lease.owner !== this.ownerOf(clientId) || lease.presentation.id !== id || lease.expiresAt <= this.now()) {
      throw new Error('Convax notice presentation is no longer owned by this window')
    }
    return lease
  }

  private ownerOf(clientId: NoticeClientId): string {
    return `${this.ctx.invocation?.peer.id ?? 'local'}:${clientId}`
  }

  private commit(key: string, record: NoticeHistoryRecord, lastModalShownAt: number | null): void {
    const entries = Object.entries(this.history.records).filter(([id]) => id !== key)
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt).slice(0, NOTICE_HISTORY_LIMIT - 1)
    const history: NoticeHistory = { ...this.history, lastModalShownAt, records: Object.fromEntries([...entries, [key, record]]) }
    this.options.persistence.save(history)
    this.history = history
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('Convax notice coordinator is disposed')
  }
}
