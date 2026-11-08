/** Client-safe presentation and ownership of Convax application notices. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ClientNoticeAction } from '@convax/api-contracts/notices'

/** One connected renderer's notice ownership identity. */
export type NoticeClientId = Branded<'ConvaxNoticeClientId'>
/** One leased presentation, distinct from its stable campaign identity. */
export type NoticePresentationId = Branded<'ConvaxNoticePresentationId'>

/** Current rendering conditions; the Host remains the owner of display selection. */
export interface NoticeDisplayContext {
  readonly available: boolean
  readonly busy: boolean
  readonly capabilities: readonly string[]
}

/** Resolved presentation; mandatory copy and empty action labels are localized by the renderer. */
export interface NoticePresentation {
  readonly id: NoticePresentationId
  readonly noticeId: string
  readonly revision: string
  readonly kind: 'mandatory-update' | 'feature' | 'upgrade' | 'maintenance' | 'announcement'
  readonly surface: 'modal' | 'banner' | 'message'
  readonly title: string
  readonly body: string
  readonly actions: readonly ClientNoticeAction[]
  readonly dismissible: boolean
  readonly holdMs?: number
}

/** Completion of a visible notice; action execution remains renderer or Desktop owned. */
export type NoticeOutcome = 'dismissed' | 'snoozed' | 'action' | 'expired'

/** Host scheduling choices supplied by validated plugin configuration. */
export interface NoticeCoordinatorConfig {
  /** Quiet interval before ordinary notices may interrupt this window, in milliseconds. */
  readonly idleMs: number
  /** Renderer lease renewal and eligibility polling interval, in milliseconds. */
  readonly pollIntervalMs: number
  /** Delay before retrying a failed source read, in milliseconds. */
  readonly failureRetryMs: number
  /** Maximum ownership gap before another window may acquire a presentation, in milliseconds. */
  readonly leaseMs: number
  /** Minimum time between ordinary automatic modals, in milliseconds. */
  readonly modalCooldownMs: number
  /** Ordinary automatic modal budget for one Host lifetime. */
  readonly maxModalPerLaunch: number
  /** Full-opacity reading interval before a Message fades, in milliseconds. */
  readonly messageHoldMs: number
}
