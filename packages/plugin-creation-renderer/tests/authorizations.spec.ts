/** Device authorization is user initiated and remains Host-owned across dialog lifetimes. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasId, CanvasNodeId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { CreationRemote, ProviderId, SaveConnectionInput } from '@deepseek-ai/dsh-convax-plugin-creation-host/types'
import { CreationAuthorizationObserver, type AuthorizationObservation } from '../src/client/authorizations.ts'

const input: SaveConnectionInput = { ref: { canvasId: 'board' as CanvasId, nodeId: 'studio' as CanvasNodeId },
  connection: { providerId: 'cli' as ProviderId, label: 'CLI', settings: { profile: 'studio' } } }
const observers: CreationAuthorizationObserver[] = []
function fixture() {
  const remote = {
    authorizationStatus: vi.fn<CreationRemote['authorizationStatus']>().mockResolvedValue({ state: 'idle' }),
    beginAuthorization: vi.fn<CreationRemote['beginAuthorization']>().mockResolvedValue({ state: 'waiting', verificationUrl: 'https://example.com/authorize', userCode: 'ABCD' }),
  }
  let state: AuthorizationObservation | undefined
  const authorized = vi.fn(), open = vi.fn(), report = vi.fn()
  const observer = new CreationAuthorizationObserver(remote, input, (value) => { state = value }, authorized, open, report)
  observers.push(observer)
  return { remote, observer, authorized, open, report, state: () => state }
}
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { for (const observer of observers.splice(0)) observer.dispose(); vi.useRealTimers() })

describe('Creation account authorization', () => {
  it('reads status without opening a browser or requesting authorization', async () => {
    const f = fixture()
    await f.observer.resume()
    expect(f.remote.authorizationStatus).toHaveBeenCalledExactlyOnceWith(input)
    expect(f.remote.beginAuthorization).not.toHaveBeenCalled()
    expect(f.open).not.toHaveBeenCalled()
  })

  it('opens only the Host-issued URL and prepares once when authorization completes', async () => {
    const f = fixture()
    await f.observer.begin()
    await f.observer.begin()
    expect(f.remote.beginAuthorization).toHaveBeenCalledOnce()
    expect(f.open).toHaveBeenCalledExactlyOnceWith('https://example.com/authorize')
    f.remote.authorizationStatus.mockResolvedValue({ state: 'authorized' })
    await vi.advanceTimersByTimeAsync(1000)
    await f.observer.resume()
    expect(f.authorized).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shows expiry without automatically starting another authorization request', async () => {
    const f = fixture()
    await f.observer.begin()
    f.remote.authorizationStatus.mockResolvedValue({ state: 'expired' })
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.state()?.status?.state).toBe('expired')
    expect(f.remote.beginAuthorization).toHaveBeenCalledOnce()
    await f.observer.begin()
    expect(f.remote.beginAuthorization).toHaveBeenCalledTimes(2)
  })

  it('opens once when an explicitly requested starting challenge receives its URL later', async () => {
    const f = fixture()
    f.remote.beginAuthorization.mockResolvedValueOnce({ state: 'starting' })
    f.remote.authorizationStatus.mockResolvedValue({ state: 'waiting', verificationUrl: 'https://example.com/authorize' })
    await f.observer.begin()
    expect(f.open).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.open).toHaveBeenCalledExactlyOnceWith('https://example.com/authorize')
  })

  it('retains a waiting challenge after a lost reply and failed status reads', async () => {
    const f = fixture()
    f.remote.beginAuthorization.mockRejectedValueOnce(new Error('Reply lost'))
    f.remote.authorizationStatus.mockResolvedValue({ state: 'waiting', verificationUrl: 'https://example.com/authorize' })
    await f.observer.begin()
    expect(f.state()?.status?.state).toBe('waiting')
    f.remote.authorizationStatus.mockRejectedValueOnce(new Error('Offline'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.state()).toMatchObject({ statusUnavailable: true, status: { state: 'waiting' } })
    await f.observer.resume()
    expect(f.state()?.statusUnavailable).toBe(false)
    expect(f.remote.beginAuthorization).toHaveBeenCalledOnce()
  })

  it('disposes polling without cancelling the Host authorization', async () => {
    const f = fixture()
    await f.observer.begin()
    f.observer.dispose()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.remote.authorizationStatus).not.toHaveBeenCalled()
    expect(f.authorized).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
