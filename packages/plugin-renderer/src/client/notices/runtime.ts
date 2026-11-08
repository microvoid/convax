/** Window-owned notice observation and user actions; selection and durable history belong to the Host. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { ClientNoticeAction } from '@convax/api-contracts/notices'
import type { NoticeClientId, NoticeDisplayContext } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { NoticeOverlaySnapshot } from './NoticeOverlay.tsx'

/** Browser facts and explicit user operations owned by this window. */
export interface NoticeEnvironment {
  /** Apply the deployment's idle interval before observation starts. */
  configure(idleMs: number): void
  /** Read fresh visibility, interaction and installed feature availability. */
  context(): NoticeDisplayContext
  /** Observe window activity until the returned disposer runs. */
  subscribe(wake: () => void): () => void
  /** Perform an allowed user action without authorizing an installation. */
  execute(action: ClientNoticeAction): Promise<void>
}

/** One mounted window's Remote and localized failure reporting. */
export interface NoticeRuntimeOptions {
  remote: TypertClientRemote['convaxNotices']
  clientId: NoticeClientId
  environment: NoticeEnvironment
  actionFailed: (error: unknown) => string
  report: (error: unknown) => void
}

/** Polls only a configured deployment and releases its display lease before the window leaves. */
export class NoticeRuntime {
  readonly state = createSnapshotStore<NoticeOverlaySnapshot>({ presentation: null, busy: false, error: null })
  private timer: ReturnType<typeof setTimeout> | undefined
  private unsubscribe: (() => void) | undefined
  private pending: Promise<void> | undefined
  private actionPending: Promise<void> | undefined
  private closed = false
  private intervalMs = 0
  private readonly lifetime = new AbortController()

  /** @param options - Window-owned Remote, activity observation and user operations. */
  constructor(private readonly options: NoticeRuntimeOptions) {}

  /** Activate once; an unconfigured Host leaves no activity listeners or polling timer. */
  async start(): Promise<void> {
    const result = await this.options.remote.configuration(this.lifetime.signal)
    if (this.closed) return
    if (!result.ok) throw result.error
    if (!result.value.enabled) return
    this.intervalMs = result.value.pollIntervalMs
    this.options.environment.configure(result.value.idleMs)
    this.unsubscribe = this.options.environment.subscribe(() => { this.wake() })
    await this.poll()
  }

  /** Recheck after activity without overlapping the current Remote request. */
  wake(): void {
    if (this.closed || this.intervalMs === 0) return
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.poll() }, this.intervalMs)
  }

  /** Record exposure after the component actually mounts. @param id - Current presentation identity. */
  shown(id: string): void {
    const presentation = this.state.getSnapshot().presentation
    if (this.closed || presentation?.id !== id) return
    void this.options.remote.presented(this.options.clientId, presentation.id, this.lifetime.signal)
      .then((result) => { if (!result.ok) throw result.error })
      .catch((error: unknown) => { if (!this.closed) this.options.report(error) })
  }

  /** Apply the template's close behavior; mandatory notices reject dismissal. @param id - Current presentation identity. */
  close(id: string): void {
    const presentation = this.state.getSnapshot().presentation
    if (presentation?.id !== id || !presentation.dismissible) return
    const snooze = presentation.actions.find(action => action.type === 'snooze')
    this.settle(id, snooze === undefined ? 'dismissed' : 'snoozed', snooze?.id)
  }

  /** Retire a finished transient message. @param id - Current presentation identity. */
  expired(id: string): void { this.settle(id, 'expired') }

  /**
   * Execute one configured action and keep its notice visible after failure.
   * @param id - Current presentation identity.
   * @param actionId - Action registered by the notice.
   */
  action(id: string, actionId: string): void {
    const presentation = this.state.getSnapshot().presentation
    if (this.closed || this.actionPending !== undefined || presentation?.id !== id) return
    const action = presentation.actions.find(item => item.id === actionId)
    if (action === undefined) return
    if (action.type === 'dismiss' || action.type === 'snooze') {
      this.settle(id, action.type === 'snooze' ? 'snoozed' : 'dismissed', action.id)
      return
    }
    this.state.set({ presentation, busy: true, error: null })
    this.actionPending = this.options.environment.execute(action).then(async () => {
      if (this.closed) return
      const result = await this.options.remote.finish(this.options.clientId, presentation.id, 'action', action.id, this.lifetime.signal)
      if (!result.ok) throw result.error
      if (!this.lifetime.signal.aborted && this.state.getSnapshot().presentation?.id === id) {
        this.state.set({ presentation: presentation.dismissible ? null : presentation, busy: false, error: null })
      }
    }).catch((error: unknown) => {
      if (this.closed) return
      this.options.report(error)
      if (this.state.getSnapshot().presentation?.id === id) {
        this.state.set({ ...this.state.getSnapshot(), busy: false, error: this.options.actionFailed(error) })
      }
    }).finally(() => {
      this.actionPending = undefined
      this.wake()
    })
  }

  /** Stop callbacks, cancel observation and drain accepted operations before returning the lease. */
  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.timer)
    this.unsubscribe?.()
    this.lifetime.abort()
    await Promise.allSettled([this.pending, this.actionPending])
    const result = await this.options.remote.release(this.options.clientId)
    if (!result.ok) this.options.report(result.error)
  }

  private settle(id: string, outcome: 'dismissed' | 'snoozed' | 'expired', actionId?: string): void {
    const presentation = this.state.getSnapshot().presentation
    if (this.closed || this.actionPending !== undefined || presentation?.id !== id) return
    this.state.set({ presentation, busy: true, error: null })
    this.actionPending = this.options.remote.finish(this.options.clientId, presentation.id, outcome, actionId, this.lifetime.signal)
      .then((result) => {
        if (!result.ok) throw result.error
        if (!this.closed && this.state.getSnapshot().presentation?.id === id) {
          this.state.set({ presentation: null, busy: false, error: null })
        }
      }).catch((error: unknown) => {
        if (this.closed) return
        this.options.report(error)
        if (this.state.getSnapshot().presentation?.id === id) {
          this.state.set({ ...this.state.getSnapshot(), busy: false, error: this.options.actionFailed(error) })
        }
      }).finally(() => { this.actionPending = undefined; this.wake() })
  }

  private poll(): Promise<void> {
    if (this.closed || this.pending !== undefined) return this.pending ?? Promise.resolve()
    this.pending = (async () => {
      const context = this.options.environment.context()
      const result = await this.options.remote.poll(this.options.clientId, context, this.lifetime.signal)
      if (this.closed) return
      if (!result.ok) throw result.error
      const current = this.state.getSnapshot()
      if (result.value !== null && current.presentation?.id !== result.value.id) {
        const latest = this.options.environment.context()
        if (!latest.available || (latest.busy && result.value.kind !== 'mandatory-update')) {
          const released = await this.options.remote.release(this.options.clientId)
          if (!released.ok) throw released.error
          return
        }
      }
      if (current.presentation?.id !== result.value?.id) this.state.set({ presentation: result.value, busy: false, error: null })
      else if (current.presentation?.revision !== result.value?.revision) this.state.set({ ...current, presentation: result.value })
    })().catch((error: unknown) => { if (!this.closed) this.options.report(error) })
      .finally(() => { this.pending = undefined; this.wake() })
    return this.pending
  }
}
