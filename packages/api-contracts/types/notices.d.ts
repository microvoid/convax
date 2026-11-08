/** Public client policy and announcement delivery contracts owned by the Convax API. */
export type ClientNoticePlatform = 'darwin' | 'win32' | 'linux' | 'web'
export type ClientNoticeArch = 'arm64' | 'x64' | 'universal'
export type ClientNoticeChannel = 'latest' | 'nightly'

export interface ClientNoticeSnapshot {
  readonly schemaVersion: 1
  readonly revision: string
  readonly serverTime: string
  readonly nextCheckAfterSeconds: number
}

/** Only Desktop or the affected operation can enforce or clear an update requirement. */
export interface ClientUpdatePolicy {
  readonly required: boolean
  readonly minSupportedVersion?: string
  readonly targetVersion?: string
  readonly releaseId?: string
  readonly reasonCode?: 'protocol_incompatible' | 'security_fix' | 'support_ended'
  readonly fallbackPage?: string
}

export interface ClientMaintenancePolicy {
  readonly id: string
  readonly revision: string
  readonly status: 'scheduled' | 'active' | 'resolved'
  readonly startsAt: string
  readonly estimatedEndsAt: string | null
  readonly affectedCapabilities: readonly string[]
  readonly title: string
  readonly body: string
}

/** Full authoritative snapshot; an empty maintenance array explicitly means no maintenance. */
export interface ClientPolicySnapshot extends ClientNoticeSnapshot {
  readonly update: ClientUpdatePolicy
  readonly maintenance: readonly ClientMaintenancePolicy[]
}

interface ClientNoticeActionBase {
  readonly id: string
  readonly label: string
}

export type ClientNoticeAction =
  | (ClientNoticeActionBase & { readonly type: 'dismiss' })
  | (ClientNoticeActionBase & { readonly type: 'snooze'; readonly snoozeSeconds: number })
  | (ClientNoticeActionBase & { readonly type: 'open_update'; readonly releaseId: string })
  | (ClientNoticeActionBase & { readonly type: 'open_url'; readonly url: string })

/** Stable id owns local read state; changing revision does not request another automatic display. */
export interface ClientGuidanceItem {
  readonly id: string
  readonly revision: string
  readonly kind: 'feature' | 'upgrade' | 'announcement'
  readonly surface: 'modal' | 'banner' | 'message'
  readonly startsAt: string
  readonly expiresAt: string
  readonly requiresCapabilities: readonly string[]
  readonly releaseId?: string
  readonly frequency: {
    readonly scope: 'installation'
    readonly maxImpressions: number
    readonly cooldownSeconds: number
  }
  readonly content: { readonly title: string; readonly body: string }
  readonly actions: readonly ClientNoticeAction[]
}

export interface ClientGuidanceSnapshot extends ClientNoticeSnapshot {
  readonly items: readonly ClientGuidanceItem[]
}
