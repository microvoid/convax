/** Batch approval is bound to displayed quotes; all later states remain visible in the same task list. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasId, CanvasNodeId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { CreationRemote, JobId, WorkbenchJobView } from '@deepseek-ai/dsh-convax-plugin-creation-host/types'
import { CreationApprovals, type ApprovalState } from '../src/client/approvals.ts'

const ref = { canvasId: 'board' as CanvasId, nodeId: 'studio' as CanvasNodeId }
function job(id: string, credits = 8): WorkbenchJobView {
  return { jobId: id as JobId, kind: 'image', prompt: 'A cover image', state: 'awaiting-approval', outputs: [], issues: [],
    approval: { quoteId: `quote-${id}`, credits, unit: 'credits', message: 'Official estimate' } }
}
const quote = job('image')
const observers: CreationApprovals[] = []
function fixture() {
  const remote = {
    listWorkbenchJobs: vi.fn<CreationRemote['listWorkbenchJobs']>().mockResolvedValue([quote]),
    approveGeneration: vi.fn<CreationRemote['approveGeneration']>().mockResolvedValue(undefined),
    rejectGeneration: vi.fn<CreationRemote['rejectGeneration']>().mockResolvedValue(undefined),
  }
  let state: ApprovalState | undefined
  const publish = vi.fn((value: ApprovalState) => { state = value })
  const observer = new CreationApprovals(remote, ref, publish, vi.fn())
  observers.push(observer)
  return { remote, observer, publish, state: () => state }
}
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { for (const observer of observers.splice(0)) observer.dispose(); vi.useRealTimers() })

describe('Creation batch approval', () => {
  it('approves only the rendered batch, ignores newer quotes and retains generation progress', async () => {
    const f = fixture(), video = job('video', 20), later = job('later')
    f.remote.listWorkbenchJobs.mockResolvedValue([quote, video])
    await f.observer.refresh()
    const displayed = f.state()!.items.map(item => ({ jobId: item.jobId, quoteId: item.approval!.quoteId }))
    f.remote.listWorkbenchJobs.mockResolvedValue([quote, video, later])
    await f.observer.refresh()
    expect(f.remote.approveGeneration).not.toHaveBeenCalled()
    f.remote.listWorkbenchJobs.mockResolvedValue([{ ...quote, state: 'running' }, { ...video, state: 'completed' }, later])
    await f.observer.approveBatch(displayed)
    expect(f.remote.approveGeneration.mock.calls.map(([input]) => input.jobId)).toEqual([quote.jobId, video.jobId])
    expect(f.state()?.items.map(item => item.state)).toEqual(['running', 'completed', 'awaiting-approval'])
    await f.observer.approveBatch(displayed)
    expect(f.remote.approveGeneration).toHaveBeenCalledTimes(2)
  })

  it('keeps partial failures visible and retries only the failed quote', async () => {
    const f = fixture(), second = job('video')
    f.remote.listWorkbenchJobs.mockResolvedValue([quote, second])
    await f.observer.refresh()
    f.remote.approveGeneration.mockRejectedValueOnce(new Error('Quote expired'))
    f.remote.listWorkbenchJobs.mockResolvedValue([quote, { ...second, state: 'running' }])
    await f.observer.approveBatch([quote, second].map(item => ({ jobId: item.jobId, quoteId: item.approval!.quoteId })))
    expect(f.state()?.failedJobs).toEqual([quote.jobId])
    expect(f.state()?.items).toHaveLength(2)
    await f.observer.approveBatch([{ jobId: quote.jobId, quoteId: 'old-quote' }])
    expect(f.remote.approveGeneration).toHaveBeenCalledTimes(2)
    f.remote.listWorkbenchJobs.mockResolvedValue([{ ...quote, state: 'running' }, { ...second, state: 'completed' }])
    await f.observer.approveBatch([{ jobId: quote.jobId, quoteId: quote.approval!.quoteId }])
    expect(f.remote.approveGeneration).toHaveBeenCalledTimes(3)
    expect(f.state()?.failedJobs).toEqual([])
  })

  it('retains cancelled tasks without payment and keeps the last status during read failures', async () => {
    const f = fixture()
    await f.observer.refresh()
    f.remote.listWorkbenchJobs.mockRejectedValueOnce(new Error('Disconnected'))
    await f.observer.refresh()
    expect(f.state()).toMatchObject({ failed: true, items: [quote] })
    f.remote.listWorkbenchJobs.mockResolvedValue([{ ...quote, state: 'cancelled' }])
    await f.observer.reject(quote.jobId)
    expect(f.remote.rejectGeneration).toHaveBeenCalledExactlyOnceWith({ ref, jobId: quote.jobId })
    expect(f.remote.approveGeneration).not.toHaveBeenCalled()
    expect(f.state()).toMatchObject({ failed: false, items: [{ state: 'cancelled' }] })
  })

  it('blocks duplicate batch submissions and ignores a read settling after disposal', async () => {
    const f = fixture()
    await f.observer.refresh()
    let resolve!: () => void
    const completion = new Promise<void>((done) => { resolve = done })
    f.remote.approveGeneration.mockReturnValueOnce(completion)
    const displayed = [{ jobId: quote.jobId, quoteId: quote.approval!.quoteId }]
    const submitting = f.observer.approveBatch(displayed)
    await f.observer.approveBatch(displayed)
    expect(f.remote.approveGeneration).toHaveBeenCalledOnce()
    f.observer.dispose()
    const published = f.publish.mock.calls.length
    resolve(); await submitting
    await vi.advanceTimersByTimeAsync(20_000)
    expect(f.publish).toHaveBeenCalledTimes(published)
    expect(vi.getTimerCount()).toBe(0)
  })
})
