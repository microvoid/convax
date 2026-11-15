/** Observe a Host-owned CLI installation without making the dialog its lifetime owner. */
import type { CreationRemote, ProviderId, ProviderInstallation, WorkbenchRef } from '@deepseek-ai/dsh-convax-plugin-creation-host/types'

export interface InstallationObservation {
  status: ProviderInstallation | undefined
  pending: boolean
  statusUnavailable: boolean
  requestFailed: boolean
}

/** Installation readiness describes the executable, never the account's login state. */
export function installationActive(status: ProviderInstallation | undefined): boolean {
  return status !== undefined && ['checking', 'downloading', 'installing', 'verifying'].includes(status.state)
}

/** One selected service owns this observer; closing it only stops local status reads. */
export class CreationInstallationObserver {
  private observation: InstallationObservation = { status: undefined, pending: false, statusUnavailable: false, requestFailed: false }
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(private readonly remote: Pick<CreationRemote, 'installationStatus' | 'installProvider'>,
    private readonly ref: WorkbenchRef, private readonly providerId: ProviderId,
    private readonly publish: (observation: InstallationObservation) => void,
    private readonly settled: (status: ProviderInstallation) => void,
    private readonly report: (error: unknown) => void) {}

  private update(patch: Partial<InstallationObservation>): void {
    if (this.disposed) return
    this.observation = { ...this.observation, ...patch }
    this.publish(this.observation)
  }

  private adopt(status: ProviderInstallation): void {
    if (this.disposed) return
    this.update({ status, pending: false, statusUnavailable: false, requestFailed: false })
    if (installationActive(status)) {
      this.timer = setTimeout(() => { this.timer = undefined; void this.resume() }, 1000)
    } else this.settled(status)
  }

  /** Read the existing task; reopening a dialog never starts another installation. */
  async resume(): Promise<void> {
    if (this.disposed || this.observation.pending) return
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined }
    this.update({ pending: true, statusUnavailable: false, requestFailed: false })
    try {
      const status = await this.remote.installationStatus(this.ref, this.providerId)
      this.adopt(status)
    } catch (error) {
      this.update({ pending: false, statusUnavailable: true })
      this.report(error)
    }
  }

  /** Only a user's installation button invokes this mutation. The Host deduplicates active tasks. */
  async install(): Promise<void> {
    if (this.disposed || this.observation.pending || installationActive(this.observation.status)) return
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined }
    this.update({ pending: true, statusUnavailable: false, requestFailed: false })
    try {
      const status = await this.remote.installProvider(this.ref, this.providerId)
      this.adopt(status)
    } catch (error) {
      this.report(error)
      // A lost mutation reply does not establish whether the Host started a task.
      this.update({ pending: false })
      await this.resume()
      if (!this.observation.statusUnavailable && this.observation.status?.state === 'idle') this.update({ requestFailed: true })
    }
  }

  /** Stop observing; the Host continues the installation after this dialog or window closes. */
  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }
}
