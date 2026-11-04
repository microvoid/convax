/** Chat deletion gates model steps through the ordinary Agent hook. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { registerCanvasAdmission } from '../../plugin-inernal-nodes-host/src/admission.ts'
import type { CanvasChat, CanvasId, CanvasNodeId, CanvasSessionBinding } from '../src/types.ts'

const canvasId = 'canvas' as CanvasId
const nodeId = 'chat' as CanvasNodeId
const root = SessionId('thread')
const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

async function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(root, { meta: { cwd: '/project' } })
  const chat: CanvasChat = { canvasId, nodeId, title: 'Chat', cwd: '/project', deleting: false, issue: null, threads: [] }
  let bound = true
  let present = true
  const repository = {
    bindingOf: (id: typeof root): CanvasSessionBinding | undefined => bound && id === root
      ? { canvasId, nodeId, sessionId: root, parentSessionId: null, inheritedEventCount: 0 } : undefined,
    getChat: () => present ? chat : undefined,
  }
  const dispose = registerCanvasAdmission(ctx, repository)
  const message = createUserMessage({ content: [{ type: 'text', text: 'Summarize @/explicit/notes.txt' }], source: { kind: 'user' } })
  const step = (agent: Agent = { session } as Agent, signal = new AbortController().signal) => ctx.waterfall('agent/pre-step', {
    agent, messages: [message], turn: 1, step: 1, signal,
    modelSelection: { provider: 'test', model: 'test' },
  }, () => Promise.resolve({ kind: 'enter' as const, messages: [message] }))
  return { ctx, chat, session, message, step, dispose, unbind() { bound = false }, remove() { present = false } }
}

describe('Convax model-step admission', () => {
  it('delegates native and bound live Chat messages without changing references', async () => {
    const f = await fixture()
    const original = structuredClone(f.message)
    expect(await f.step()).toEqual({ kind: 'enter', messages: [original] })
    f.unbind()
    expect(await f.step()).toEqual({ kind: 'enter', messages: [original] })
  })

  it('rejects deleting and removed Chats without reviving their bindings', async () => {
    const f = await fixture()
    f.chat.deleting = true
    expect(await f.step()).toEqual({ kind: 'reject' })
    f.chat.deleting = false
    f.remove()
    expect(await f.step()).toEqual({ kind: 'reject' })
  })

  it('rejects actual subagent descendants but keeps ordinary forks independent', async () => {
    const f = await fixture()
    f.chat.deleting = true
    const child = f.ctx.sessions.create(SessionId('child'), { meta: { parentSession: root, origin: 'subagent' } })
    const grandchild = f.ctx.sessions.create(SessionId('grandchild'), { meta: { parentSession: child.id, origin: 'subagent' } })
    const fork = f.ctx.sessions.create(SessionId('fork'), { meta: { parentSession: root } })
    expect(await f.step({ session: child } as Agent)).toEqual({ kind: 'reject' })
    expect(await f.step({ session: grandchild } as Agent)).toEqual({ kind: 'reject' })
    expect(await f.step({ session: fork } as Agent)).toMatchObject({ kind: 'enter' })
    await f.dispose()
    expect(await f.step()).toMatchObject({ kind: 'enter' })
  })

  it('follows persisted intermediate ancestors without resuming them', async () => {
    const f = await fixture()
    f.chat.deleting = true
    const parentId = SessionId('cold-parent')
    const child = f.ctx.sessions.create(SessionId('nested-child'), { meta: { parentSession: parentId, origin: 'subagent' } })
    f.ctx.provide('sessionPersistence', { stat: async () => ({ header: { ...f.session.header, id: parentId, parentSession: root, origin: 'subagent' } }) } as never)
    expect(await f.step({ session: child } as Agent)).toEqual({ kind: 'reject' })
    expect(f.ctx.sessions.get(parentId)).toBeUndefined()
  })

  it('drains an ancestry read during plugin removal without rejecting the native Agent step', async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const child = f.ctx.sessions.create(SessionId('lookup-child'), { meta: { parentSession: SessionId('cold'), origin: 'subagent' } })
    f.ctx.provide('sessionPersistence', { stat: async () => { entered.resolve(undefined); await release.promise; return undefined } } as never)
    const checking = f.step({ session: child } as Agent)
    await entered.promise
    let closed = false
    const closing = f.dispose().then(() => { closed = true })
    await Promise.resolve(undefined)
    expect(closed).toBe(false)
    release.resolve(undefined)
    expect(await checking).toEqual({ kind: 'enter', messages: [f.message] })
    await closing
  })

  it.each(['plugin removal', 'caller cancellation'] as const)('contains only plugin-owned cancellation during %s', async (reason) => {
    const f = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const lookup = Promise.withResolvers<never>()
    const caller = new AbortController()
    const child = f.ctx.sessions.create(SessionId('cancelled-lookup-child'), {
      meta: { parentSession: SessionId('cold-ancestor'), origin: 'subagent' },
    })
    f.ctx.provide('sessionPersistence', { stat: async (_id: SessionId, options: { signal: AbortSignal }) => {
      entered.resolve(undefined)
      options.signal.addEventListener('abort', () => { lookup.reject(options.signal.reason) }, { once: true })
      return lookup.promise
    } } as never)
    const checking = f.step({ session: child } as Agent, caller.signal)
    if (reason === 'plugin removal') {
      await entered.promise
      const closing = f.dispose()
      expect(await checking).toEqual({ kind: 'enter', messages: [f.message] })
      await closing
    } else {
      const cancelled = expect(checking).rejects.toThrow('Caller cancelled')
      await entered.promise
      caller.abort(new Error('Caller cancelled'))
      await cancelled
      await f.dispose()
    }
  })

})
