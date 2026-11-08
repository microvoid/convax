/** Immutable deployment content; publication requires an explicit catalog revision and application deployment. */
import { isISO8601, isSemVer } from 'class-validator'
import { gte } from 'semver'
import type {
  ClientGuidanceItem, ClientMaintenancePolicy, ClientNoticeArch, ClientNoticeChannel, ClientNoticePlatform, ClientUpdatePolicy,
} from '@convax/api-contracts/notices'

/** Supported client facts; neither installation IDs nor optional bearer tokens grant account identity. */
export interface ClientNoticeAudienceContext {
  readonly appVersion: string
  readonly platform: ClientNoticePlatform
  readonly arch: ClientNoticeArch
  readonly channel: ClientNoticeChannel
  readonly locale: string
}

/** Optional deployment targeting. Version bounds are inclusive minimum and exclusive maximum. */
export interface ClientNoticeAudience {
  readonly minAppVersion?: string
  readonly maxAppVersion?: string
  readonly platforms?: readonly ClientNoticePlatform[]
  readonly arches?: readonly ClientNoticeArch[]
  readonly channels?: readonly ClientNoticeChannel[]
  readonly locales?: readonly string[]
}

/** A publisher-confirmed installer identity; no package is discovered or downloaded by these routes. */
export interface ClientUpdateDeployment {
  readonly minSupportedVersion: string
  readonly release: {
    readonly id: string
    readonly version: string
    readonly platform: Exclude<ClientNoticePlatform, 'web'>
    readonly arch: ClientNoticeArch
    readonly channel: ClientNoticeChannel
    readonly available: boolean
  }
  readonly reasonCode: NonNullable<ClientUpdatePolicy['reasonCode']>
  readonly fallbackPage: string
}

/** A notice and its deployment-owned audience, independent of local read state. */
export interface ClientGuidanceDeployment {
  readonly notice: ClientGuidanceItem
  readonly audience?: ClientNoticeAudience
}

export interface ClientNoticeCatalog {
  readonly revision: string
  readonly nextCheckAfterSeconds: number
  readonly update?: ClientUpdateDeployment
  readonly maintenance: readonly ClientMaintenancePolicy[]
  readonly guidance: readonly ClientGuidanceDeployment[]
}

/** Explicit default deployment has no update requirement, maintenance or announcements. */
export const DEFAULT_CLIENT_NOTICE_CATALOG: ClientNoticeCatalog = Object.freeze({
  revision: 'default-1', nextCheckAfterSeconds: 600, maintenance: Object.freeze([]), guidance: Object.freeze([]),
})

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid Convax notice catalog: ${message}`)
}

function keys(value: object, allowed: readonly string[]): void {
  requireValue(Object.keys(value).every(key => allowed.includes(key)), 'unsupported deployment field')
}

function text(value: unknown, limit = 128): void {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= limit, 'text is empty or too long')
}

function integer(value: number, minimum: number, maximum: number): void {
  requireValue(Number.isSafeInteger(value) && value >= minimum && value <= maximum, 'numeric limit is invalid')
}

function version(value: string): void {
  requireValue(typeof value === 'string' && value.length <= 64 && isSemVer(value), 'version must be SemVer')
}

function timestamp(value: string): void {
  requireValue(typeof value === 'string' && value.includes('T') && isISO8601(value, { strict: true, strictSeparator: true })
    && /(?:Z|[+-]\d{2}:\d{2})$/u.test(value), 'timestamp must include a UTC offset')
}

function page(value: string): void {
  text(value, 2048)
  const url = new URL(value)
  requireValue(url.protocol === 'https:' && url.username === '' && url.password === '', 'page must use HTTPS without credentials')
}

function list(value: unknown, maximum: number, minimum = 0): void {
  requireValue(Array.isArray(value) && value.length >= minimum && value.length <= maximum, 'list length is invalid')
}

function identities(values: readonly string[], maximum: number, minimum = 0): void {
  list(values, maximum, minimum)
  for (const value of values) text(value)
  requireValue(new Set(values).size === values.length, 'identity is duplicated')
}

function audience(value: ClientNoticeAudience): void {
  keys(value, ['minAppVersion', 'maxAppVersion', 'platforms', 'arches', 'channels', 'locales'])
  if (value.minAppVersion !== undefined) version(value.minAppVersion)
  if (value.maxAppVersion !== undefined) version(value.maxAppVersion)
  if (value.minAppVersion !== undefined && value.maxAppVersion !== undefined) {
    requireValue(!gte(value.minAppVersion, value.maxAppVersion), 'version interval is empty')
  }
  for (const [entries, allowed] of [
    [value.platforms, ['darwin', 'win32', 'linux', 'web']], [value.arches, ['arm64', 'x64', 'universal']],
    [value.channels, ['latest', 'nightly']],
  ] as const) {
    if (entries === undefined) continue
    identities(entries, 10, 1)
    requireValue(entries.every(entry => (allowed as readonly string[]).includes(entry)), 'unsupported audience value')
  }
  if (value.locales !== undefined) {
    identities(value.locales, 100, 1)
    requireValue(value.locales.every(locale => /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(locale)), 'locale is invalid')
  }
}

function guidance(value: ClientGuidanceItem): void {
  keys(value, ['id', 'revision', 'kind', 'surface', 'startsAt', 'expiresAt', 'requiresCapabilities', 'releaseId', 'frequency', 'content', 'actions'])
  text(value.id); text(value.revision)
  requireValue(['feature', 'upgrade', 'announcement'].includes(value.kind), 'notice kind is unsupported')
  requireValue(['modal', 'banner', 'message'].includes(value.surface), 'notice surface is unsupported')
  timestamp(value.startsAt); timestamp(value.expiresAt)
  requireValue(Date.parse(value.expiresAt) > Date.parse(value.startsAt), 'notice interval is empty')
  identities(value.requiresCapabilities, 100)
  if (value.releaseId !== undefined) text(value.releaseId)
  requireValue(value.kind !== 'upgrade' || value.releaseId !== undefined, 'upgrade notice requires a release')
  keys(value.frequency, ['scope', 'maxImpressions', 'cooldownSeconds'])
  requireValue(value.frequency.scope === 'installation', 'only installation frequency is supported')
  integer(value.frequency.maxImpressions, 1, 20); integer(value.frequency.cooldownSeconds, 0, 2_592_000)
  keys(value.content, ['title', 'body']); text(value.content.title, 120); text(value.content.body, 1000)
  list(value.actions, 3, 1)
  identities(value.actions.map(action => action.id), 3, 1)
  for (const action of value.actions) {
    text(action.label, 40)
    switch (action.type) {
      case 'dismiss': keys(action, ['id', 'label', 'type']); break
      case 'snooze':
        keys(action, ['id', 'label', 'type', 'snoozeSeconds']); integer(action.snoozeSeconds, 3600, 2_592_000); break
      case 'open_update':
        keys(action, ['id', 'label', 'type', 'releaseId'])
        requireValue(action.releaseId === value.releaseId, 'update action must reference its notice release'); break
      case 'open_url': keys(action, ['id', 'label', 'type', 'url']); page(action.url); break
      default: throw new Error('Invalid Convax notice catalog: action is unsupported')
    }
  }
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/** Validate before Nest starts and detach the deployment from future caller mutations. */
export function prepareClientNoticeCatalog(input: ClientNoticeCatalog): ClientNoticeCatalog {
  const catalog = structuredClone(input)
  keys(catalog, ['revision', 'nextCheckAfterSeconds', 'update', 'maintenance', 'guidance'])
  text(catalog.revision); integer(catalog.nextCheckAfterSeconds, 30, 3600)
  if (catalog.update !== undefined) {
    const update = catalog.update
    keys(update, ['minSupportedVersion', 'release', 'reasonCode', 'fallbackPage'])
    keys(update.release, ['id', 'version', 'platform', 'arch', 'channel', 'available'])
    version(update.minSupportedVersion); version(update.release.version); text(update.release.id)
    requireValue(gte(update.release.version, update.minSupportedVersion), 'installer does not satisfy the minimum version')
    requireValue(['darwin', 'win32', 'linux'].includes(update.release.platform), 'installer platform is unsupported')
    requireValue(['arm64', 'x64', 'universal'].includes(update.release.arch), 'installer architecture is unsupported')
    requireValue(['latest', 'nightly'].includes(update.release.channel), 'installer channel is unsupported')
    requireValue(typeof update.release.available === 'boolean', 'installer availability must be explicit')
    requireValue(['protocol_incompatible', 'security_fix', 'support_ended'].includes(update.reasonCode), 'update reason is unsupported')
    page(update.fallbackPage)
  }
  list(catalog.maintenance, 50)
  identities(catalog.maintenance.map(value => value.id), 50)
  for (const value of catalog.maintenance) {
    keys(value, ['id', 'revision', 'status', 'startsAt', 'estimatedEndsAt', 'affectedCapabilities', 'title', 'body'])
    text(value.revision); timestamp(value.startsAt)
    if (value.estimatedEndsAt !== null) timestamp(value.estimatedEndsAt)
    requireValue(['scheduled', 'active', 'resolved'].includes(value.status), 'maintenance status is unsupported')
    identities(value.affectedCapabilities, 100, 1); text(value.title, 120); text(value.body, 1000)
  }
  list(catalog.guidance, 50)
  identities(catalog.guidance.map(value => value.notice.id), 50)
  for (const deployment of catalog.guidance) {
    keys(deployment, ['notice', 'audience']); guidance(deployment.notice)
    if (deployment.audience !== undefined) audience(deployment.audience)
    if (deployment.notice.kind === 'upgrade' || deployment.notice.actions.some(action => action.type === 'open_update')) {
      requireValue(catalog.update !== undefined && deployment.notice.releaseId === catalog.update.release.id,
        'upgrade announcement must reference the configured installer')
    }
  }
  return freeze(catalog)
}
