/** Dialog lifetimes only observe the Host's installer; they cannot cancel or duplicate it. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasId, CanvasNodeId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { CreationRemote, ProviderId, ProviderInstallation } from '@deepseek-ai/dsh-convax-plugin-creation-host/types'
import { CreationInstallationObserver, type InstallationObservation } from '../src/client/installations.ts'

const ref = { canvasId: 'canvas' as CanvasId, nodeId: 'workbench' as CanvasNodeId }
const providerId = 'official-cli' as ProviderId
const observers: CreationInstallationObserver[] = []
function fixture() {
  const remote = {
    installationStatus: vi.fn<CreationRemote['installationStatus']>().mockResolvedValue({ state: 'idle' }),
    installProvider: vi.fn<CreationRemote['installProvider']>().mockResolvedValue({ state: 'downloading', receivedBytes: 2, totalBytes: 10 }),
  }
  let state: InstallationObservation | undefined
  const publish = vi.fn((value: InstallationObservation) => { state = value })
  const settled = vi.fn<(value: ProviderInstallation) => void>()
  const report = vi.fn()
  const observer = new CreationInstallationObserver(remote, ref, providerId, publish, settled, report)
  observers.push(observer)
  return { remote, publish, settled, report, observer, state: () => state }
}
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { for (const observer of observers.splice(0)) observer.dispose(); vi.useRealTimers() })

describe('Creation CLI installation observation', () => {
  it('only reads an existing installation when the service is selected', async () => {
    const f = fixture()
    await f.observer.resume()
    expect(f.remote.installationStatus).toHaveBeenCalledExactlyOnceWith(ref, providerId)
    expect(f.remote.installProvider).not.toHaveBeenCalled()
    expect(f.state()).toEqual({ status: { state: 'idle' }, pending: false, statusUnavailable: false, requestFailed: false })
    expect(f.settled).toHaveBeenCalledWith({ state: 'idle' })
  })

  it('reports real installation phases, deduplicates clicks and rechecks only after completion', async () => {
    const f = fixture()
    await f.observer.install()
    await f.observer.install()
    expect(f.remote.installProvider).toHaveBeenCalledOnce()
    expect(f.state()?.status).toEqual({ state: 'downloading', receivedBytes: 2, totalBytes: 10 })
    expect(f.settled).not.toHaveBeenCalled()
    f.remote.installationStatus.mockResolvedValueOnce({ state: 'verifying' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.state()?.status?.state).toBe('verifying')
    f.remote.installationStatus.mockResolvedValueOnce({ state: 'ready', executable: '/managed/cli' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.settled).toHaveBeenCalledExactlyOnceWith({ state: 'ready', executable: '/managed/cli' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains failure details and starts a retry only after another explicit action', async () => {
    const f = fixture()
    f.remote.installProvider.mockResolvedValueOnce({ state: 'failed', message: 'Download interrupted' })
    await f.observer.install()
    expect(f.state()?.status).toEqual({ state: 'failed', message: 'Download interrupted' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.remote.installProvider).toHaveBeenCalledOnce()
    await f.observer.install()
    expect(f.remote.installProvider).toHaveBeenCalledTimes(2)
    expect(f.state()?.status?.state).toBe('downloading')
  })

  it('resolves a lost installation reply with a status read instead of a second installation', async () => {
    const f = fixture()
    f.remote.installProvider.mockRejectedValueOnce(new Error('Reply lost'))
    f.remote.installationStatus.mockResolvedValueOnce({ state: 'installing' })
    await f.observer.install()
    expect(f.remote.installProvider).toHaveBeenCalledOnce()
    expect(f.remote.installationStatus).toHaveBeenCalledOnce()
    expect(f.state()?.status?.state).toBe('installing')
    expect(f.state()?.statusUnavailable).toBe(false)
  })

  it('shows uncertain status and resumes observation without restarting installation', async () => {
    const f = fixture()
    await f.observer.install()
    f.remote.installationStatus.mockRejectedValueOnce(new Error('Disconnected'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.state()).toMatchObject({ pending: false, statusUnavailable: true, status: { state: 'downloading' } })
    expect(vi.getTimerCount()).toBe(0)
    f.remote.installationStatus.mockResolvedValueOnce({ state: 'ready' })
    await f.observer.resume()
    expect(f.remote.installProvider).toHaveBeenCalledOnce()
    expect(f.state()).toMatchObject({ statusUnavailable: false, status: { state: 'ready' } })
  })

  it('reports a rejected request when the Host confirms no installation started', async () => {
    const f = fixture()
    f.remote.installProvider.mockRejectedValueOnce(new Error('Request rejected'))
    await f.observer.install()
    expect(f.state()).toMatchObject({ status: { state: 'idle' }, requestFailed: true, statusUnavailable: false })
    expect(f.remote.installProvider).toHaveBeenCalledOnce()
    await f.observer.install()
    expect(f.state()).toMatchObject({ status: { state: 'downloading' }, requestFailed: false })
    expect(f.remote.installProvider).toHaveBeenCalledTimes(2)
  })

  it('stops polling when closed and ignores a pending response after disposal', async () => {
    const f = fixture()
    await f.observer.install()
    f.observer.dispose()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.remote.installationStatus).not.toHaveBeenCalled()
    const other = fixture()
    let resolve: (status: ProviderInstallation) => void = () => { throw new Error('Missing resolver') }
    other.remote.installationStatus.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const pending = other.observer.resume()
    other.observer.dispose()
    const calls = other.publish.mock.calls.length
    resolve({ state: 'ready' })
    await pending
    expect(other.publish.mock.calls).toHaveLength(calls)
    expect(other.settled).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
