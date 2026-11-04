// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, onTestFinished, vi } from 'vitest'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { ClientSessions } from '@deepseek-ai/dsh-api-session-controller/src/client/sessions/service.ts'
import type { SessionFollowFrame, SessionFollowRequest } from '@deepseek-ai/dsh-api-session-controller/types'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session/types'
import { createThreadProvider } from '../src/client/thread-resource.ts'
import { resourceAddress } from '@deepseek-ai/dsh-convax-plugin-renderer/client'

const it = createClientTest({ roster: webApp.closure(['@deepseek-ai/dsh-api-gateway']) })
const sessionId = SessionId('host-published-thread')
const listed = { sessionId, updatedAt: 1, running: false, blank: true, agentAvailable: true }

describe('Convax thread resource discovery', () => {
  it('opens a Host-published thread after a coalesced stale catalog pull and releases its real Session generation', async ({ remote, mock, start }) => {
    const stale = Promise.withResolvers<Awaited<ReturnType<typeof remote.session.list>>>()
    remote.session.list.mockReturnValueOnce(stale.promise)
    remote.session.list.mockResolvedValue({ ok: true, value: { items: [listed] } })
    mock.stream('session/follow', ([raw], stream) => {
      const request = raw as SessionFollowRequest
      const frame: SessionFollowFrame = {
        type: 'snapshot', header: {
          version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 0, isSeeded: false,
        },
        cursor: -1, records: [], hasMore: false, projections: { asOfSeq: -1, values: {} },
        ...(request.assistantStream === true ? { assistantStream: { revision: 0 } } : {}),
      }
      stream.push(frame)
    })
    const client = await start()
    const ctx = new Context()
    const sessions = new ClientSessions(ctx, client.ctx.remote)
    const lifetime = new AbortController()
    onTestFinished(async () => {
      stale.resolve({ ok: true, value: { items: [] } })
      lifetime.abort()
      await ctx.fiber.dispose()
    })
    const originalPull = sessions.refresh()
    const provider = createThreadProvider(sessions)
    const iterator = provider.open(resourceAddress('convax-thread', sessionId), { signal: lifetime.signal })[Symbol.asyncIterator]()
    const opening = iterator.next()
    expect(remote.session.list).toHaveBeenCalledOnce()
    stale.resolve({ ok: true, value: { items: [] } })
    await originalPull
    const frame = await opening
    expect(remote.session.list).toHaveBeenCalledTimes(2)
    expect(frame.value).toMatchObject({ ok: true, value: { reference: { sessionId } } })
    expect(sessions.retainInfo(sessionId).getSnapshot().retainedBy.convaxChat).toBe(1)
    expect(sessions.binding(sessionId)?.session.getSnapshot().openState).toBe('open')
    const closing = iterator.next()
    lifetime.abort()
    expect(await closing).toEqual({ done: true, value: undefined })
    expect(sessions.retainInfo(sessionId).getSnapshot().referenceCount).toBe(0)
    expect(sessions.binding(sessionId)).toBeUndefined()
  })

  it('yields a visible failure when a removed or inaccessible binding stays absent after discovery', async ({ remote, start }) => {
    remote.session.list.mockResolvedValue({ ok: true, value: { items: [] } })
    const client = await start()
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    const sessions = new ClientSessions(ctx, client.ctx.remote)
    const provider = createThreadProvider(sessions)
    const frames = []
    for await (const frame of provider.open(resourceAddress('convax-thread', sessionId), { signal: new AbortController().signal })) frames.push(frame)
    expect(frames).toMatchObject([{ ok: false, error: { message: 'Convax thread could not be opened' } }])
    expect(remote.session.list).toHaveBeenCalledTimes(2)
    expect(sessions.retainInfo(sessionId).getSnapshot().referenceCount).toBe(0)
  })

  it('does not acquire a reference when a pending discovery is cancelled', async ({ remote, start }) => {
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof remote.session.list>>>()
    remote.session.list.mockReturnValue(pending.promise)
    const client = await start()
    const ctx = new Context()
    onTestFinished(async () => {
      pending.resolve({ ok: true, value: { items: [listed] } })
      await ctx.fiber.dispose()
    })
    const sessions = new ClientSessions(ctx, client.ctx.remote)
    const retain = vi.spyOn(sessions, 'retain')
    const lifetime = new AbortController()
    const iterator = createThreadProvider(sessions).open(resourceAddress('convax-thread', sessionId), { signal: lifetime.signal })[Symbol.asyncIterator]()
    const opening = iterator.next()
    lifetime.abort()
    pending.resolve({ ok: true, value: { items: [listed] } })
    expect(await opening).toEqual({ done: true, value: undefined })
    expect(retain).not.toHaveBeenCalled()
  })
})
