/** Independent HTTP reads for optional Convax client notice endpoints. */
import { z } from 'zod'
import type {
  ClientGuidanceSnapshot, ClientNoticeArch, ClientNoticeChannel, ClientNoticePlatform, ClientPolicySnapshot,
} from '@convax/api-contracts/notices'

export interface ClientNoticeApiOptions {
  readonly origin: string
  readonly appVersion: string
  readonly platform: ClientNoticePlatform
  readonly arch: ClientNoticeArch
  readonly channel: ClientNoticeChannel
  readonly locale: string
  readonly installationId: string
  readonly allowedPageOrigins: readonly string[]
  readonly timeoutMs: number
}

export interface ClientNoticeApiResult {
  readonly policy?: ClientPolicySnapshot
  readonly guidance?: ClientGuidanceSnapshot
  readonly errors?: readonly ('policy' | 'guidance')[]
}

const identity = z.string().min(1).max(128)
const timestamp = z.iso.datetime({ offset: true })
const semver = z.string().max(64).regex(
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
)
const snapshot = {
  schemaVersion: z.literal(1), revision: identity, serverTime: timestamp,
  nextCheckAfterSeconds: z.number().int().min(30).max(3600),
}
const update = z.strictObject({
  required: z.boolean(), minSupportedVersion: semver.optional(), targetVersion: semver.optional(),
  releaseId: identity.optional(), reasonCode: z.enum(['protocol_incompatible', 'security_fix', 'support_ended']).optional(),
  fallbackPage: z.url().max(2048).optional(),
}).refine(value => !value.required || (value.minSupportedVersion !== undefined && value.targetVersion !== undefined
  && value.releaseId !== undefined && value.reasonCode !== undefined), 'Required update is missing its release')
const maintenance = z.strictObject({
  id: identity, revision: identity, status: z.enum(['scheduled', 'active', 'resolved']), startsAt: timestamp,
  estimatedEndsAt: timestamp.nullable(), affectedCapabilities: z.array(identity).min(1).max(100)
    .refine(value => new Set(value).size === value.length, 'Capability identity is duplicated'),
  title: z.string().min(1).max(120), body: z.string().min(1).max(1000),
})
const actionBase = { id: identity, label: z.string().min(1).max(40) }
const action = z.discriminatedUnion('type', [
  z.strictObject({ ...actionBase, type: z.literal('dismiss') }),
  z.strictObject({ ...actionBase, type: z.literal('snooze'), snoozeSeconds: z.number().int().min(3600).max(2592000) }),
  z.strictObject({ ...actionBase, type: z.literal('open_update'), releaseId: identity }),
  z.strictObject({ ...actionBase, type: z.literal('open_url'), url: z.url().max(2048) }),
])
const guidanceItem = z.strictObject({
  id: identity, revision: identity, kind: z.enum(['feature', 'upgrade', 'announcement']),
  surface: z.enum(['modal', 'banner', 'message']), startsAt: timestamp, expiresAt: timestamp,
  requiresCapabilities: z.array(identity).max(100).refine(value => new Set(value).size === value.length, 'Capability identity is duplicated'),
  releaseId: identity.optional(),
  frequency: z.strictObject({ scope: z.literal('installation'), maxImpressions: z.number().int().min(1).max(20),
    cooldownSeconds: z.number().int().min(0).max(2592000) }),
  content: z.strictObject({ title: z.string().min(1).max(120), body: z.string().min(1).max(1000) }),
  actions: z.array(action).min(1).max(3),
}).refine(value => value.kind !== 'upgrade' || value.releaseId !== undefined, 'Upgrade guidance is missing its release')
  .refine(value => Date.parse(value.expiresAt) > Date.parse(value.startsAt), 'Guidance expires before it starts')
  .refine(value => new Set(value.actions.map(entry => entry.id)).size === value.actions.length, 'Action identity is duplicated')
  .refine(value => value.actions.every(entry => entry.type !== 'open_update' || entry.releaseId === value.releaseId), 'Update action has a different release')
const policySchema = z.strictObject({ ...snapshot, update, maintenance: z.array(maintenance).max(50) })
  .refine(value => new Set(value.maintenance.map(entry => entry.id)).size === value.maintenance.length, 'Maintenance identity is duplicated')
const guidanceSchema = z.strictObject({ ...snapshot, items: z.array(guidanceItem).max(50) })
  .refine(value => new Set(value.items.map(entry => entry.id)).size === value.items.length, 'Guidance identity is duplicated')

function origin(value: string): string {
  const url = new URL(value)
  if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== ''
    || url.protocol !== 'https:') {
    throw new Error('Convax notice pages require an exact HTTPS origin')
  }
  return url.origin
}

function allowedPage(value: string, allowedOrigins: readonly string[]): boolean {
  const url = new URL(value)
  return url.protocol === 'https:' && url.username === '' && url.password === '' && allowedOrigins.includes(url.origin)
}

function apiBase(value: string): string {
  const url = new URL(value)
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== ''
    || (url.protocol !== 'https:' && !(url.protocol === 'http:'
      && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new Error('Convax notice API requires an HTTPS base URL or explicit loopback development URL')
  }
  // Bare origins keep the API's root /api prefix; explicit paths already name the API base.
  url.pathname = url.pathname === '/' ? '/api/' : `${url.pathname.replace(/\/+$/u, '')}/`
  return url.href
}

/** Owns request cancellation only; its caller owns polling, policy retention and local delivery records. */
export class ClientNoticeApiSource {
  private readonly apiBaseUrl: string
  private readonly pageOrigins: readonly string[]
  private readonly requests = new Set<() => void>()
  private disposed = false

  constructor(private readonly options: ClientNoticeApiOptions, private readonly request: typeof fetch = fetch) {
    this.apiBaseUrl = apiBase(options.origin)
    this.pageOrigins = options.allowedPageOrigins.map(value => origin(value))
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2_147_483_647) {
      throw new Error('Convax notice API timeout must be a positive timer duration')
    }
    semver.parse(options.appVersion)
    z.uuid().parse(options.installationId)
  }

  /** Partial endpoint failures omit that snapshot; cancellation rejects and never publishes a partial read. */
  async read(signal?: AbortSignal): Promise<ClientNoticeApiResult> {
    this.assertLive(signal)
    const [policy, guidance] = await Promise.all([
      this.readEndpoint('policy', signal), this.readEndpoint('guidance', signal),
    ])
    this.assertLive(signal)
    const errors: ('policy' | 'guidance')[] = []
    if (policy === undefined) errors.push('policy')
    if (guidance === undefined) errors.push('guidance')
    return { ...(policy === undefined ? {} : { policy: policy as ClientPolicySnapshot }),
      ...(guidance === undefined ? {} : { guidance: guidance as ClientGuidanceSnapshot }),
      ...(errors.length === 0 ? {} : { errors }) }
  }

  /** Abort owned reads; settled or late transport responses cannot become a successful read. */
  dispose(): void {
    this.disposed = true
    for (const cancel of this.requests) cancel()
  }

  private assertLive(signal?: AbortSignal): void {
    if (this.disposed || signal?.aborted === true) throw new DOMException('Convax notice API read was cancelled', 'AbortError')
  }

  private async readEndpoint(kind: 'policy' | 'guidance', signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController()
    const abort = (): void => { clearTimeout(timeout); controller.abort() }
    const timeout = setTimeout(abort, this.options.timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    this.requests.add(abort)
    try {
      if (this.disposed || signal?.aborted === true) abort()
      const url = new URL(`v1/client/${kind}`, this.apiBaseUrl)
      for (const key of ['appVersion', 'platform', 'arch', 'channel', 'locale'] as const) url.searchParams.set(key, this.options[key])
      const response = await this.request(url, { signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: { Accept: 'application/json', 'X-Installation-Id': this.options.installationId } })
      if (!response.ok || controller.signal.aborted) return undefined
      const body: unknown = await response.json()
      controller.signal.throwIfAborted()
      if (kind === 'policy') {
        const result = policySchema.parse(body)
        if (result.update.fallbackPage !== undefined && !allowedPage(result.update.fallbackPage, this.pageOrigins)) return undefined
        return result
      }
      const result = guidanceSchema.parse(body)
      if (!result.items.every(item => item.actions.every(entry => entry.type !== 'open_url' || allowedPage(entry.url, this.pageOrigins)))) return undefined
      return result
    } catch {
      return undefined
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      this.requests.delete(abort)
    }
  }
}
