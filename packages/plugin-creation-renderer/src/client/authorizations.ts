/** Observe a Host-owned account challenge for one immutable connection context. */
import type { CreationRemote, ProviderAuthorization, SaveConnectionInput } from '@deepseek-ai/dsh-convax-plugin-creation-host/types'

export interface AuthorizationObservation {
  status: ProviderAuthorization | undefined
  pending: boolean
  statusUnavailable: boolean
  openFailed: boolean
}

/** A pending device challenge remains owned by the Host when its observer closes. */
export function authorizationActive(status: ProviderAuthorization | undefined): boolean {
  return status?.state === 'starting' || status?.state === 'waiting'
}

/** A profile, executable or working-directory change creates a separate observer. */
export class CreationAuthorizationObserver {
  private observation: AuthorizationObservation = { status: undefined, pending: false, statusUnavailable: false, openFailed: false }
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private openRequested = false

  constructor(private readonly remote: Pick<CreationRemote, 'authorizationStatus' | 'beginAuthorization'>,
    private readonly input: SaveConnectionInput,
    private readonly publish: (observation: AuthorizationObservation) => void,
    private readonly authorized: () => void,
    private readonly openExternal: (url: string) => void,
    private readonly report: (error: unknown) => void) {}

  private update(patch: Partial<AuthorizationObservation>): void {
    if (this.disposed) return
    this.observation = { ...this.observation, ...patch }
    this.publish(this.observation)
  }

  private adopt(status: ProviderAuthorization): void {
    if (this.disposed) return
    const previouslyAuthorized = this.observation.status?.state === 'authorized'
    this.update({ status, pending: false, statusUnavailable: false })
    if (this.openRequested && status.state === 'waiting' && status.verificationUrl !== undefined) {
      this.openRequested = false
      try { this.openExternal(status.verificationUrl) }
      catch (error) { this.update({ openFailed: true }); this.report(error) }
    }
    if (!authorizationActive(status)) this.openRequested = false
    if (authorizationActive(status)) this.timer = setTimeout(() => { this.timer = undefined; void this.resume() }, 1000)
    else if (status.state === 'authorized' && !previouslyAuthorized) this.authorized()
  }

  /** Restore observation only; never starts a challenge or opens a browser. */
  async resume(): Promise<void> {
    if (this.disposed || this.observation.pending) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.update({ pending: true, statusUnavailable: false })
    try { this.adopt(await this.remote.authorizationStatus(this.input)) }
    catch (error) { this.update({ pending: false, statusUnavailable: true }); this.report(error) }
  }

  /** Explicitly request authorization; the Host validates the external URL. */
  async begin(): Promise<void> {
    if (this.disposed || this.observation.pending || authorizationActive(this.observation.status)) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.openRequested = true
    this.update({ pending: true, statusUnavailable: false, openFailed: false })
    try {
      const status = await this.remote.beginAuthorization(this.input)
      this.adopt(status)
    } catch (error) {
      this.report(error)
      this.update({ pending: false })
      // The Host may have accepted the mutation even when its reply was lost.
      await this.resume()
      if (this.observation.status?.state === 'idle') this.update({ status: { state: 'failed', reason: 'unreachable' } })
    }
  }

  /** Stop local polling without cancelling the approved Host operation. */
  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }
}
