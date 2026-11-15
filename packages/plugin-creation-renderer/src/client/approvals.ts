/** Observe the full generation lifecycle and carry only explicitly displayed quotes to the Host. */
import type { CreationRemote, JobId, WorkbenchJobView, WorkbenchRef } from '@deepseek-ai/dsh-convax-plugin-creation-host/types'

export interface DisplayedQuote { jobId: JobId; quoteId: string }
export interface ApprovalState {
  items: readonly WorkbenchJobView[]
  pending: JobId | 'batch' | undefined
  failed: boolean
  failedJobs: readonly JobId[]
}

/** A workbench owns this observer; closing its task panel never stops generation or status reads. */
export class CreationApprovals {
  private state: ApprovalState = { items: [], pending: undefined, failed: false, failedJobs: [] }
  private timer: ReturnType<typeof setTimeout> | undefined
  private reading = false
  private disposed = false
  private epoch = 0

  constructor(private readonly remote: Pick<CreationRemote, 'listWorkbenchJobs' | 'approveGeneration' | 'rejectGeneration'>,
    private readonly ref: WorkbenchRef, private readonly publish: (state: ApprovalState) => void,
    private readonly report: (error: unknown) => void) {}

  private active(): boolean { return !this.disposed }

  private update(patch: Partial<ApprovalState>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }; this.publish(this.state)
  }

  /** Retain pending, running and settled jobs in the same task rows. */
  async refresh(): Promise<void> {
    if (this.disposed || this.reading || this.state.pending !== undefined) return
    this.reading = true
    const epoch = this.epoch
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    try {
      const items = await this.remote.listWorkbenchJobs(this.ref)
      if (epoch === this.epoch) this.update({ items, failed: false })
    } catch (error) { if (epoch === this.epoch) this.update({ failed: true }); this.report(error) }
    finally { this.reading = false; this.schedule() }
  }

  private schedule(): void {
    if (!this.disposed && this.timer === undefined) this.timer = setTimeout(() => { this.timer = undefined; void this.refresh() }, 2000)
  }

  /** Approve only the batch rendered when the user clicked, never quotes arriving in a later poll. */
  async approveBatch(quotes: readonly DisplayedQuote[]): Promise<void> {
    if (this.disposed || this.state.pending !== undefined || quotes.length === 0) return
    const unique = new Set(quotes.map(item => item.jobId))
    if (unique.size !== quotes.length || !quotes.every(quote => this.state.items.some(item => item.jobId === quote.jobId
      && item.state === 'awaiting-approval' && item.approval?.quoteId === quote.quoteId))) {
      this.update({ failedJobs: quotes.map(item => item.jobId) }); return
    }
    this.epoch += 1
    this.update({ pending: 'batch', failedJobs: [] })
    const results = await Promise.allSettled(quotes.map(quote => this.remote.approveGeneration({ ref: this.ref, ...quote })))
    if (!this.active()) return
    const accepted = new Set<JobId>(), failedJobs: JobId[] = []
    for (const [index, quote] of quotes.entries()) {
      const result = results[index]
      if (result?.status === 'fulfilled') accepted.add(quote.jobId)
      else if (result?.status === 'rejected') { failedJobs.push(quote.jobId); this.report(result.reason) }
    }
    this.update({ items: this.state.items.map(item => accepted.has(item.jobId) ? { ...item, state: 'approving' } : item),
      pending: undefined, failedJobs })
    await this.refresh()
  }

  /** Cancelling an unapproved quote never spends credits. */
  async reject(jobId: JobId): Promise<void> {
    if (this.disposed || this.state.pending !== undefined
      || !this.state.items.some(item => item.jobId === jobId && item.state === 'awaiting-approval')) return
    this.epoch += 1
    this.update({ pending: jobId, failedJobs: this.state.failedJobs.filter(id => id !== jobId) })
    try {
      await this.remote.rejectGeneration({ ref: this.ref, jobId })
      this.update({ items: this.state.items.map(item => item.jobId === jobId ? { ...item, state: 'cancelled' } : item) })
    } catch (error) { this.update({ failedJobs: [...this.state.failedJobs, jobId] }); this.report(error) }
    finally { this.update({ pending: undefined }); await this.refresh() }
  }

  /** Ignore late reads when the workbench or its owning window is removed. */
  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }
}
