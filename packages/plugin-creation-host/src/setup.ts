/** Host-owned CLI authorization and canvas selection; secrets never cross the Remote boundary. */
import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { CliRunner, record, setting, string, type ProviderDependencies } from './providers/common.ts'
import type { ConnectionSnapshot, ProviderAuthorization, ProviderCanvas, ProviderCanvasPage, ProviderCanvasResult,
  ProviderDescriptor, ProviderId, ProviderSetupFailure, ProviderSetupReason, WorkbenchRef } from './types.ts'

interface SetupTarget { key: string; connection: ConnectionSnapshot }
interface AuthorizationAttempt {
  target: SetupTarget
  view: ProviderAuthorization
  challenge?: { deviceCode: string; deadline: number; view: ProviderAuthorization }
  pending?: Promise<void>
}
interface CanvasAttempt {
  targetKey: string
  name: string
  pending?: Promise<ProviderCanvasResult>
  result?: Extract<ProviderCanvasResult, { state: 'ready' }>
}

/** Scoped to the owning Host. Closing a dialog only stops observation; disposing the Host drains CLI processes. */
export class CreationProviderSetup {
  private readonly cli: CliRunner
  private readonly lifecycle = new AbortController()
  private readonly authorizations = new Map<string, AuthorizationAttempt>()
  private readonly canvasAttempts = new Map<string, CanvasAttempt>()
  private readonly reads = new Set<Promise<unknown>>()

  constructor(private readonly deps: ProviderDependencies) { this.cli = new CliRunner(deps, 'dreamina-canvas') }

  descriptor(providerId: ProviderId): Pick<ProviderDescriptor, 'authorization' | 'canvasSelection'> {
    return providerId === 'jimeng-cli' ? { authorization: true } : {}
  }

  /** Derive a stable private canvas identity without creating it or changing the CLI's selected canvas. */
  async managedCanvasId(ref: WorkbenchRef, connection: ConnectionSnapshot): Promise<string> {
    const target = await this.capture(ref, connection)
    const hash = createHash('sha256').update(`convax-creation-canvas-v1\0${target.key}`).digest('hex')
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
  }

  /** Called only by an accepted connection action after model validation. Stable IDs make failed acknowledgements retryable. */
  ensureManagedCanvas(ref: WorkbenchRef, connection: ConnectionSnapshot): Promise<ProviderCanvasResult> {
    return this.create(ref, connection, { name: `Convax Creation ${ref.nodeId.slice(0, 12)}`,
      requestId: setting(connection, 'projectId') })
  }

  async begin(ref: WorkbenchRef, connection: ConnectionSnapshot): Promise<ProviderAuthorization> {
    try {
      const target = await this.capture(ref, connection)
      let attempt = this.authorizations.get(target.key)
      if (attempt?.pending !== undefined) return { ...attempt.view }
      if (attempt === undefined) {
        attempt = { target, view: { state: 'starting' } }
        this.authorizations.set(target.key, attempt)
      }
      const active = attempt
      active.view = active.challenge === undefined ? { state: 'starting' } : { ...active.challenge.view }
      active.pending = Promise.resolve().then(() => this.authorize(active)).catch((error: unknown) => {
        const failure = this.failure(error)
        active.view = { state: 'failed', reason: failure.reason, message: failure.message }
      }).finally(() => { delete active.pending })
      return { ...active.view }
    } catch (error) { const failure = this.failure(error); return { ...failure, state: 'failed' } }
  }

  async status(ref: WorkbenchRef, connection: ConnectionSnapshot): Promise<ProviderAuthorization> {
    try {
      const target = await this.capture(ref, connection)
      const existing = this.authorizations.get(target.key)
      if (existing !== undefined) return { ...existing.view }
      const result = await this.command(target, ['auth', 'status'])
      if (result.exitCode !== 0 || result.json?.ok === false) throw new SetupFailure('unreachable', 'Could not read the CLI login state. Try again.')
      return { state: record(result.json?.data).loggedIn === true ? 'authorized' : 'idle' }
    } catch (error) { const failure = this.failure(error); return { ...failure, state: 'failed' } }
  }

  async list(ref: WorkbenchRef, connection: ConnectionSnapshot, cursor?: string): Promise<ProviderCanvasPage> {
    try {
      if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 4096)) {
        throw new SetupFailure('invalid-configuration', 'The canvas cursor is invalid.')
      }
      const target = await this.capture(ref, connection)
      const result = await this.command(target, ['canvas', 'ls', '--limit', '50', ...(cursor === undefined ? [] : ['--cursor', cursor])])
      const data = this.success(result)
      if (!Array.isArray(data.items) || data.items.length > 100 || typeof data.hasMore !== 'boolean') throw new Error('Invalid canvas page')
      const items = data.items.map(item => this.canvas(item))
      const nextCursor = data.hasMore ? string(data.nextCursor, 'next cursor') : undefined
      if (nextCursor !== undefined && nextCursor.length > 4096) throw new Error('Invalid canvas cursor')
      return { state: 'ready', items, ...(nextCursor === undefined ? {} : { nextCursor }) }
    } catch (error) { return this.failure(error) }
  }

  async create(ref: WorkbenchRef, connection: ConnectionSnapshot,
    request: { name: string; requestId: string }): Promise<ProviderCanvasResult> {
    try {
      if (typeof request.name !== 'string' || !request.name.trim() || request.name.length > 200
        || typeof request.requestId !== 'string' || !UUID.test(request.requestId)) {
        throw new SetupFailure('invalid-configuration', 'Enter a canvas name and a valid creation request ID.')
      }
      const target = await this.capture(ref, connection)
      const existing = this.canvasAttempts.get(request.requestId)
      if (existing !== undefined) {
        if (existing.targetKey !== target.key || existing.name !== request.name) {
          throw new SetupFailure('request-conflict', 'This canvas creation request already belongs to different settings. Start a new request.')
        }
        if (existing.result !== undefined) return existing.result
        if (existing.pending !== undefined) return await existing.pending
      }
      const attempt: CanvasAttempt = existing ?? { targetKey: target.key, name: request.name }
      attempt.pending = this.createCanvas(target, request).then((result) => {
        if (result.state === 'ready') attempt.result = result
        return result
      }).finally(() => { delete attempt.pending })
      // The stable project UUID is the provider's retry identity, including after Host restart.
      this.canvasAttempts.set(request.requestId, attempt)
      return await attempt.pending
    } catch (error) { return this.failure(error) }
  }

  async close(): Promise<void> {
    this.lifecycle.abort()
    await Promise.allSettled([
      ...this.reads,
      ...[...this.authorizations.values()].flatMap(item => item.pending === undefined ? [] : [item.pending]),
      ...[...this.canvasAttempts.values()].flatMap(item => item.pending === undefined ? [] : [item.pending]),
    ])
    this.authorizations.clear()
    this.canvasAttempts.clear()
  }

  private async capture(ref: WorkbenchRef, connection: ConnectionSnapshot): Promise<SetupTarget> {
    this.lifecycle.signal.throwIfAborted()
    if (connection.providerId !== 'jimeng-cli') throw new SetupFailure('provider-unloaded', 'This Provider does not offer integrated setup.')
    const cwd = setting(connection, 'cwd', process.cwd())
    if (!isAbsolute(cwd)) throw new SetupFailure('invalid-configuration', 'Choose an absolute CLI working directory.')
    const profile = setting(connection, 'profile', 'default')
    if (profile.length > 200 || /[\r\n\0]/.test(profile)) throw new SetupFailure('invalid-configuration', 'The CLI profile is invalid.')
    const signal = this.signal(30_000)
    const command = setting(connection, 'executable', 'dreamina-canvas')
    const executable = await this.track(this.deps.resolveExecutable?.(command, {}, signal)
      ?? this.deps.subprocess.resolveExecutable(command, {}, signal))
    this.lifecycle.signal.throwIfAborted()
    return { key: JSON.stringify([ref.canvasId, ref.nodeId, executable, resolve(cwd), profile]),
      connection: { ...connection, settings: { executable, cwd: resolve(cwd), profile } } }
  }

  private async authorize(attempt: AuthorizationAttempt): Promise<void> {
    if (attempt.challenge !== undefined && attempt.challenge.deadline <= Date.now()) delete attempt.challenge
    if (attempt.challenge === undefined) {
      const status = await this.command(attempt.target, ['auth', 'status'])
      const state = this.success(status)
      if (state.loggedIn === true) { attempt.view = { state: 'authorized' }; return }
      const result = this.success(await this.command(attempt.target, ['auth', 'login']))
      if (result.status === 'reused' || result.status === 'logged_in') { attempt.view = { state: 'authorized' }; return }
      if (result.status !== 'authorization_required') throw new SetupFailure('authorization-failed', 'The CLI did not return an authorization challenge.')
      const challenge = record(result.challenge)
      const deviceCode = string(challenge.deviceCode, 'device code')
      const verificationUrl = this.verificationUrl(challenge.verificationUriComplete ?? challenge.verificationUri, deviceCode)
      const expiresAt = typeof challenge.expiresAt === 'string' && Number.isFinite(Date.parse(challenge.expiresAt))
        ? new Date(challenge.expiresAt).toISOString() : undefined
      const deadline = Math.min(Date.now() + 10 * 60_000, expiresAt === undefined ? Infinity : Date.parse(expiresAt))
      const userCode = challenge.verificationUriComplete === undefined ? string(challenge.userCode, 'user code') : undefined
      if (userCode !== undefined && (userCode.includes(deviceCode) || !/^[A-Za-z0-9 -]{1,128}$/.test(userCode))) {
        throw new SetupFailure('authorization-failed', 'The CLI returned an invalid user verification code.')
      }
      const view: ProviderAuthorization = { state: 'waiting', verificationUrl,
        ...(userCode === undefined ? {} : { userCode }), ...(expiresAt === undefined ? {} : { expiresAt }) }
      attempt.challenge = { deviceCode, deadline, view }
    }
    const challenge = attempt.challenge
    attempt.view = { ...challenge.view }
    while (Date.now() < challenge.deadline) {
      const result = await this.command(attempt.target, ['auth', 'wait', '--device-code', challenge.deviceCode, '--timeout', '60s'], 70_000)
      const data = result.json?.data === undefined ? undefined : record(result.json.data)
      const error = result.json?.error === undefined ? undefined : record(result.json.error)
      if (result.exitCode === 0 && (data?.status === 'logged_in' || data?.status === 'reused')) {
        delete attempt.challenge
        attempt.view = { state: 'authorized' }
        return
      }
      if (error?.code === 40014 || error?.reason === 'expired_token') break
      if (error?.reason === 'authorization_rejected' || error?.reason === 'access_denied' || data?.status === 'rejected') {
        delete attempt.challenge
        attempt.view = { state: 'rejected', reason: 'authorization-failed', message: 'Authorization was declined. You can start again.' }
        return
      }
      if (error?.code !== 40011) throw new SetupFailure('unreachable',
        `Authorization could not finish. Retry to resume the current authorization.${authorizationDiagnostic(result.exitCode, error)}`)
      // The CLI owns polling. Bound unexpectedly immediate timeout responses to avoid a busy loop.
      await delay(250, undefined, { signal: this.lifecycle.signal })
    }
    delete attempt.challenge
    attempt.view = { state: 'expired', reason: 'authorization-failed', message: 'The authorization link expired. Start again for a new link.' }
  }

  private async createCanvas(target: SetupTarget, request: { name: string; requestId: string }): Promise<ProviderCanvasResult> {
    try {
      const result = await this.command(target, ['canvas', 'create', request.name, '--project-id', request.requestId])
      const canvas = this.canvas(this.success(result).project)
      if (canvas.id !== request.requestId) throw new Error('Canvas response identity mismatch')
      return { state: 'ready', canvas }
    } catch (error) { return this.failure(error) }
  }

  private canvas(value: unknown): ProviderCanvas {
    const item = record(value)
    const id = string(item.projectId, 'canvas ID')
    if (!UUID.test(id)) throw new Error('Invalid canvas identity')
    // Canvases created on the official website may have no name. The client supplies a localized fallback.
    if (typeof item.name !== 'string') throw new Error('Invalid canvas name')
    const label = item.name
    let webUrl: string | undefined
    if (typeof item.webUrl === 'string' && URL.canParse(item.webUrl)) {
      const url = new URL(item.webUrl)
      if (url.origin === 'https://jimeng.jianying.com' && !url.username && !url.password) webUrl = url.href
    }
    return { id, label, ...(webUrl === undefined ? {} : { webUrl }) }
  }

  private verificationUrl(value: unknown, deviceCode: string): string {
    const url = new URL(string(value, 'authorization URL'))
    const valid = (candidate: URL, path: string, keys: readonly string[]) => candidate.origin === 'https://jimeng.jianying.com'
      && candidate.pathname === path && !candidate.username && !candidate.password && !candidate.hash
      && !decodeURIComponent(candidate.href).includes(deviceCode)
      && [...candidate.searchParams.keys()].every(key => keys.includes(key) && candidate.searchParams.getAll(key).length === 1)
    const isDirect = valid(url, '/passport/open/scan_user_code/', ['user_code'])
    const isWrapper = valid(url, '/ai-tool/cli-auth', ['agent_role', 'cli_name', 'verification_uri'])
    const nested = url.searchParams.get('verification_uri')
    if ((!isDirect && !isWrapper) || (nested !== null
      && (!URL.canParse(nested) || !valid(new URL(nested), '/passport/open/scan_user_code/', ['user_code'])))) {
      throw new SetupFailure('unsafe-url', 'The CLI returned an unsupported authorization address.')
    }
    return url.href
  }

  private success(result: Awaited<ReturnType<CliRunner['run']>>): Record<string, unknown> {
    if (result.exitCode !== 0 || result.json?.ok === false) {
      const reason = result.exitCode === 11 ? 'not-authorized' : 'unreachable'
      throw new SetupFailure(reason, reason === 'not-authorized' ? 'Authorize this CLI profile first.' : 'The CLI request failed. Try again.')
    }
    return record(result.json?.data)
  }

  private command(target: SetupTarget, args: readonly string[], timeout = 30_000): ReturnType<CliRunner['run']> {
    return this.track(this.cli.run(target.connection,
      [...args, '--format', 'json', '--non-interactive', '--profile', setting(target.connection, 'profile')], this.signal(timeout)))
  }

  private signal(timeout: number): AbortSignal { return AbortSignal.any([this.lifecycle.signal, AbortSignal.timeout(timeout)]) }

  private async track<T>(pending: Promise<T>): Promise<T> {
    this.reads.add(pending)
    try { return await pending } finally { this.reads.delete(pending) }
  }

  private failure(error: unknown): ProviderSetupFailure {
    if (error instanceof SetupFailure) return { state: 'unavailable', reason: error.reason, message: error.message }
    if (error instanceof Error && error.name === 'SubprocessExecutableNotFoundError') {
      return { state: 'unavailable', reason: 'not-installed', message: 'Install the CLI or choose its executable.' }
    }
    return { state: 'unavailable', reason: 'unreachable', message: 'Could not reach the CLI. Check its settings and try again.' }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Only fixed protocol facts are public; provider messages and arbitrary reasons can contain credentials. */
function authorizationDiagnostic(exitCode: number | null, error: Record<string, unknown> | undefined): string {
  const facts = [`exit=${exitCode === null ? 'unknown' : exitCode}`]
  if (typeof error?.code === 'number' && Number.isSafeInteger(error.code) && error.code >= 0 && error.code <= 1_000_000) {
    facts.push(`code=${error.code}`)
  }
  if (typeof error?.reason === 'string' && AUTHORIZATION_REASONS.has(error.reason)) facts.push(`reason=${error.reason}`)
  return ` (CLI ${facts.join(', ')})`
}

const AUTHORIZATION_REASONS = new Set([
  'dns_resolution_failed', 'network_permission_denied', 'credential_store_permission_denied',
  'credential_store_unavailable', 'credential_store_corrupt', 'network_timeout', 'auth_dependency_failed', 'account_changed',
])

class SetupFailure extends Error {
  constructor(readonly reason: ProviderSetupReason, message: string) { super(message) }
}
