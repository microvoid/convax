/** Convax-owned settlement observes native activity without extending DSH. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type { JobStatus } from '@deepseek-ai/dsh-jobs'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { archiveCanvasThread } from '../../plugin-inernal-nodes-host/src/archive.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

async function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  const root = ctx.sessions.create(SessionId('root'), { meta: { cwd: '/project' } })
  ctx.provide('sessionPersistence', { list: async () => [] } as never)
  const agents = new Map<SessionId, Pick<Agent, 'cancel' | 'whenIdle'>>()
  ctx.provide('agents', { get: (id: SessionId) => agents.get(id) } as never)
  const archivedSessionIds: SessionId[] = []
  const archiveSession = vi.fn(async (id: SessionId) => { if (!archivedSessionIds.includes(id)) archivedSessionIds.push(id) })
  ctx.provide('workspaceRegistry', { archiveSession, archivedSessionIds } as never)
  return { ctx, root, agents, archivedSessionIds, archiveSession, signal: new AbortController().signal }
}

function jobsFixture(ctx: Context, owner: SessionId) {
  let status: JobStatus = 'running'
  const id = JobId('owned')
  const listeners = new Set<() => void>()
  const row = () => ({ id, status, owner })
  const kill = vi.fn(() => { status = 'stopping' })
  ctx.provide('jobs', {
    list: () => [row(), { id: JobId('unowned'), status: 'running' }], kill,
    events: { subscribe: (_filter: object, listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    } },
  } as never)
  return { kill, listeners, settle() { status = 'killed'; for (const notify of listeners) notify() } }
}

describe('Convax thread archival', () => {
  it('archives true descendants discovered during settlement while preserving independent forks', async () => {
    const f = await fixture()
    const lateChild = SessionId('late-child')
    let published = false
    const idle = vi.fn(async () => {
      if (published) return
      published = true
      f.ctx.sessions.create(lateChild, { meta: { parentSession: f.root.id, origin: 'subagent' } })
      f.ctx.sessions.create(SessionId('grandchild'), { meta: { parentSession: lateChild, origin: 'subagent' } })
    })
    f.agents.set(f.root.id, { cancel: vi.fn(), whenIdle: idle })
    f.ctx.sessions.create(SessionId('fork'), { meta: { parentSession: f.root.id } })
    await archiveCanvasThread(f.ctx, f.root.id, f.signal)
    expect(f.archivedSessionIds).toEqual([f.root.id, lateChild, SessionId('grandchild')])
    expect(f.archiveSession).toHaveBeenCalledTimes(3)
  })

  it('waits for owned job settlement and removes the observer before completing', async () => {
    const f = await fixture()
    const jobs = jobsFixture(f.ctx, f.root.id)
    const entered = Promise.withResolvers<undefined>()
    jobs.kill.mockImplementation(() => { entered.resolve(undefined) })
    let completed = false
    const pending = archiveCanvasThread(f.ctx, f.root.id, f.signal).then(() => { completed = true })
    await entered.promise
    expect(completed).toBe(false)
    expect(jobs.kill).toHaveBeenCalledWith(JobId('owned'), f.root.id, 'Chat deleted')
    expect(jobs.kill).toHaveBeenCalledTimes(1)
    expect(jobs.listeners.size).toBe(1)
    jobs.settle()
    await pending
    expect(jobs.listeners.size).toBe(0)
  })

  it('cancels waiting and releases its job observer while retaining archival', async () => {
    const f = await fixture()
    const jobs = jobsFixture(f.ctx, f.root.id)
    const entered = Promise.withResolvers<undefined>()
    jobs.kill.mockImplementation(() => { entered.resolve(undefined) })
    const controller = new AbortController()
    const pending = archiveCanvasThread(f.ctx, f.root.id, controller.signal)
    const rejected = expect(pending).rejects.toThrow('caller stopped waiting')
    await entered.promise
    controller.abort(new Error('caller stopped waiting'))
    await rejected
    expect(jobs.listeners.size).toBe(0)
    expect(f.archivedSessionIds).toEqual([f.root.id])
  })

  it('propagates a job cancel failure and does not leave an observer behind', async () => {
    const f = await fixture()
    const jobs = jobsFixture(f.ctx, f.root.id)
    jobs.kill.mockImplementation(() => { throw new Error('producer failed to cancel') })
    await expect(archiveCanvasThread(f.ctx, f.root.id, f.signal)).rejects.toThrow('producer failed to cancel')
    expect(jobs.listeners.size).toBe(0)
    expect(f.archivedSessionIds).toEqual([f.root.id])
  })

  it('returns residual activity for retry instead of spinning or removing its archive', async () => {
    const f = await fixture()
    const activity = vi.fn()
    const dispose = f.ctx.on('workspace/session-activity', async (request, next) => {
      activity(request)
      return [{ kind: 'turn' as const }, ...await next()]
    })
    await expect(archiveCanvasThread(f.ctx, f.root.id, f.signal)).rejects.toThrow()
    expect(activity).toHaveBeenCalledTimes(1)
    expect(f.archivedSessionIds).toEqual([f.root.id])
    dispose()
    const stop = vi.fn()
    f.ctx.on('workspace/session-stop', stop)
    await archiveCanvasThread(f.ctx, f.root.id, f.signal)
    expect(stop).toHaveBeenCalledExactlyOnceWith({ sessionId: f.root.id })
  })

  it('ends an Agent wait on cancellation without undoing its archive', async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const idle = Promise.withResolvers<undefined>()
    f.agents.set(f.root.id, { cancel: vi.fn(), whenIdle: () => { entered.resolve(undefined); return idle.promise } })
    const controller = new AbortController()
    const pending = archiveCanvasThread(f.ctx, f.root.id, controller.signal)
    const rejected = expect(pending).rejects.toThrow('stop wait')
    await entered.promise
    controller.abort(new Error('stop wait'))
    await rejected
    idle.resolve(undefined)
    expect(f.archivedSessionIds).toEqual([f.root.id])
  })
})
