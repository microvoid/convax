/** Window activity and Remote completion cannot duplicate actions or outlive notice disposal. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientNoticeAction } from '@convax/api-contracts/notices'
import type { NoticeClientId, NoticePresentation, NoticePresentationId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { NoticeRuntime, type NoticeEnvironment, type NoticeRuntimeOptions } from '../src/client/notices/runtime.ts'

type NoticeRemote = NoticeRuntimeOptions['remote']
const clientId = '00000000-0000-4000-8000-000000000001' as NoticeClientId
const presentationId = '00000000-0000-4000-8000-000000000002' as NoticePresentationId
const context = { available: true, busy: false, capabilities: ['canvas.resources'] }
const cleanups: Array<() => Promise<void>> = []

beforeEach(() => { vi.useFakeTimers() })
afterEach(async () => {
  try { for (const close of cleanups.splice(0).reverse()) await close() }
  finally { vi.useRealTimers(); vi.restoreAllMocks() }
})

function notice(overrides: Partial<NoticePresentation> = {}): NoticePresentation {
  return { id: presentationId, noticeId: 'feature', revision: '1', kind: 'feature', surface: 'modal',
    title: 'Feature title', body: 'Feature description', actions: [{ id: 'details', type: 'open_url', label: 'Details', url: 'https://example.com/details' }],
    dismissible: true, ...overrides }
}

function fixture(presentation: NoticePresentation | null = notice(), enabled = true) {
  const remote = {
    configuration: vi.fn<NoticeRemote['configuration']>().mockResolvedValue({ ok: true, value: { enabled, pollIntervalMs: 1000, idleMs: 5000 } }),
    poll: vi.fn<NoticeRemote['poll']>().mockResolvedValue({ ok: true, value: presentation }),
    presented: vi.fn<NoticeRemote['presented']>().mockResolvedValue({ ok: true, value: undefined }),
    finish: vi.fn<NoticeRemote['finish']>().mockResolvedValue({ ok: true, value: undefined }),
    release: vi.fn<NoticeRemote['release']>().mockResolvedValue({ ok: true, value: undefined }),
  } satisfies NoticeRemote
  let wake: (() => void) | undefined
  const unsubscribe = vi.fn()
  const environment = {
    configure: vi.fn<NoticeEnvironment['configure']>(),
    context: vi.fn<NoticeEnvironment['context']>(() => context),
    subscribe: vi.fn<NoticeEnvironment['subscribe']>((listener) => { wake = listener; return unsubscribe }),
    execute: vi.fn<NoticeEnvironment['execute']>(async () => {}),
  } satisfies NoticeEnvironment
  const report = vi.fn<NoticeRuntimeOptions['report']>()
  const actionFailed = vi.fn<NoticeRuntimeOptions['actionFailed']>(() => 'Localized action failure')
  const runtime = new NoticeRuntime({ remote, clientId, environment, report, actionFailed })
  cleanups.push(() => runtime.dispose())
  return { runtime, remote, environment, unsubscribe, report, actionFailed, wake: () => wake?.() }
}

describe('Convax notice window runtime', () => {
  it.each([{ available: false, busy: false }, { available: true, busy: true }])(
    'releases a grant when the window becomes unavailable or busy during its poll: %j', async (changed) => {
      const f = fixture()
      const reply = Promise.withResolvers<Awaited<ReturnType<NoticeRemote['poll']>>>()
      f.remote.poll.mockReturnValueOnce(reply.promise)
      const started = f.runtime.start()
      await vi.waitFor(() => { expect(f.remote.poll).toHaveBeenCalledOnce() })
      f.environment.context.mockReturnValue({ ...context, ...changed })
      reply.resolve({ ok: true, value: notice() })
      await started
      expect(f.runtime.state.getSnapshot().presentation).toBeNull()
      expect(f.remote.release).toHaveBeenCalledExactlyOnceWith(clientId)
      expect(f.remote.presented).not.toHaveBeenCalled()
    },
  )

  it('leaves a disabled deployment without activity listeners, polling or timers', async () => {
    const f = fixture(null, false)
    await f.runtime.start()
    f.runtime.wake()
    expect(f.environment.configure).not.toHaveBeenCalled()
    expect(f.environment.subscribe).not.toHaveBeenCalled()
    expect(f.remote.poll).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses the configured idle interval and fresh activity facts while coalescing wakeups', async () => {
    const f = fixture()
    await f.runtime.start()
    expect(f.environment.configure).toHaveBeenCalledWith(5000)
    expect(f.remote.poll).toHaveBeenCalledWith(clientId, context, expect.any(AbortSignal))
    expect(f.remote.presented).not.toHaveBeenCalled()
    f.environment.context.mockReturnValue({ ...context, busy: true })
    f.wake()
    f.wake()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.remote.poll).toHaveBeenCalledTimes(2)
    expect(f.remote.poll.mock.lastCall?.[1].busy).toBe(true)
  })

  it('reports exposure only for the currently mounted presentation', async () => {
    const f = fixture()
    await f.runtime.start()
    expect(f.remote.presented).not.toHaveBeenCalled()
    f.runtime.shown('unrelated')
    expect(f.remote.presented).not.toHaveBeenCalled()
    f.runtime.shown(presentationId)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.remote.presented).toHaveBeenCalledWith(clientId, presentationId, expect.any(AbortSignal))
  })

  it('executes a repeated action once and settles only after its operation succeeds', async () => {
    const f = fixture()
    let complete!: () => void
    f.environment.execute.mockReturnValue(new Promise((resolve) => { complete = resolve }))
    await f.runtime.start()
    try {
      f.runtime.action(presentationId, 'details')
      f.runtime.action(presentationId, 'details')
      expect(f.environment.execute).toHaveBeenCalledTimes(1)
      expect(f.runtime.state.getSnapshot().busy).toBe(true)
      expect(f.remote.finish).not.toHaveBeenCalled()
      complete()
      await vi.advanceTimersByTimeAsync(0)
      expect(f.remote.finish).toHaveBeenCalledWith(clientId, presentationId, 'action', 'details', expect.any(AbortSignal))
      expect(f.runtime.state.getSnapshot()).toEqual({ presentation: null, busy: false, error: null })
    } finally { complete() }
  })

  it('retains the original notice and reports localized feedback when an action fails', async () => {
    const presentation = notice()
    const f = fixture(presentation)
    const failure = new Error('External action failed')
    f.environment.execute.mockRejectedValueOnce(failure)
    await f.runtime.start()
    f.runtime.action(presentationId, 'details')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.runtime.state.getSnapshot()).toEqual({ presentation, busy: false, error: 'Localized action failure' })
    expect(f.report).toHaveBeenCalledWith(failure)
    expect(f.remote.finish).not.toHaveBeenCalled()
    f.runtime.action(presentationId, 'details')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.runtime.state.getSnapshot().presentation).toBeNull()
  })

  it('maps the close gesture to the configured reminder and retains the notice after a failed commit', async () => {
    const later: ClientNoticeAction = { id: 'later', label: 'Later', type: 'snooze', snoozeSeconds: 86400 }
    const presentation = notice({ kind: 'upgrade', actions: [later] })
    const f = fixture(presentation)
    f.remote.finish.mockRejectedValueOnce(new Error('Host unavailable'))
    await f.runtime.start()
    f.runtime.close(presentationId)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.remote.finish).toHaveBeenCalledWith(clientId, presentationId, 'snoozed', 'later', expect.any(AbortSignal))
    expect(f.runtime.state.getSnapshot()).toMatchObject({ presentation, busy: false, error: 'Localized action failure' })
    f.runtime.close(presentationId)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.runtime.state.getSnapshot().presentation).toBeNull()
  })

  it('keeps a required update after its action and clears it only after an authoritative poll', async () => {
    const presentation = notice({ kind: 'mandatory-update', dismissible: false,
      actions: [{ id: 'update', label: '', type: 'open_update', releaseId: 'release' }] })
    const f = fixture(presentation)
    await f.runtime.start()
    f.runtime.close(presentationId)
    expect(f.remote.finish).not.toHaveBeenCalled()
    f.runtime.action(presentationId, 'update')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.runtime.state.getSnapshot().presentation).toEqual(presentation)
    f.remote.poll.mockResolvedValue({ ok: true, value: null })
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.runtime.state.getSnapshot().presentation).toBeNull()
  })

  it('adopts changed copy and actions without treating a stable presentation as a new exposure', async () => {
    const initial = notice()
    const f = fixture(initial)
    await f.runtime.start()
    const updated = notice({ revision: '2', body: 'Updated description', actions: [{ id: 'dismiss', label: 'Close', type: 'dismiss' }] })
    f.remote.poll.mockResolvedValue({ ok: true, value: updated })
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.runtime.state.getSnapshot().presentation).toEqual(updated)
    expect(f.remote.presented).not.toHaveBeenCalled()
  })

  it('cancels and drains a late poll without restarting observation after disposal', async () => {
    const f = fixture()
    let complete!: (value: Awaited<ReturnType<NoticeRemote['poll']>>) => void
    f.remote.poll.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    const starting = f.runtime.start()
    await Promise.resolve()
    try {
      const signal = f.remote.poll.mock.calls[0]?.[2]
      const disposing = f.runtime.dispose()
      expect(signal?.aborted).toBe(true)
      expect(f.unsubscribe).toHaveBeenCalledTimes(1)
      complete({ ok: true, value: notice() })
      await Promise.all([starting, disposing])
      f.wake()
      f.runtime.shown(presentationId)
      expect(f.runtime.state.getSnapshot().presentation).toBeNull()
      expect(f.remote.presented).not.toHaveBeenCalled()
      expect(f.remote.release).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally { complete({ ok: true, value: null }) }
  })
})
