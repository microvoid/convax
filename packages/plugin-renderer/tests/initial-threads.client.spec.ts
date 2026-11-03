/** Initial Chat creation shares one durable request across mounting and connection gestures. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type {
  CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId, CanvasThreadRequest, CanvasThreadResult, CanvasWorkspace,
} from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { CanvasInitialThreads } from '../src/client/initial-threads.ts'

const canvasId = 'canvas' as CanvasId
const nodeId = 'chat' as CanvasNodeId
const sessionId = 'first-thread' as SessionId
const request: CanvasThreadRequest = {
  canvasId, nodeId, kind: 'create', expectedRevision: 2, operationId: 'initial-attempt' as CanvasOperationId,
}

function workspace(revision: number, threads: SessionId[] = [], present = true): CanvasWorkspace {
  return {
    revision, nodeTypes: [], nodeIssues: [],
    canvases: [{ id: canvasId, title: 'Board', revision, connections: [], nodes: present ? [{
      id: nodeId, typeId: 'convax.chat' as CanvasNodeTypeId, dataVersion: 1,
      data: { title: 'Chat', cwd: '/project' }, revision: 0, position: { x: 0, y: 0 },
    }] : [] }],
    chats: present ? [{ canvasId, nodeId, title: 'Chat', cwd: '/project', issue: null, deleting: false,
      threads: threads.map(id => ({ sessionId: id, parentSessionId: null, inheritedEventCount: 0 })),
    }] : [],
  }
}

describe('Convax initial threads', () => {
  it('shares an in-flight request and its actual Session across callers', async () => {
    const reply = Promise.withResolvers<CanvasThreadResult>()
    const create = vi.fn(async () => await reply.promise)
    const owner = new CanvasInitialThreads(create)
    owner.observe(workspace(2))
    const firstStage = vi.fn()
    const secondStage = vi.fn()
    const first = owner.ensure(request, firstStage)
    const second = owner.ensure({ ...request, operationId: 'connection-attempt' as CanvasOperationId }, secondStage)
    const result: CanvasThreadResult = { ok: true, sessionId, workspace: workspace(3, [sessionId]) }
    reply.resolve(result)
    expect(await first).toEqual(result)
    expect(await second).toEqual(result)
    expect(create).toHaveBeenCalledExactlyOnceWith(request)
    expect(firstStage).toHaveBeenCalledExactlyOnceWith(request)
    expect(secondStage).toHaveBeenCalledExactlyOnceWith(request)
    expect(await owner.ensure({ ...request, operationId: 'remount-attempt' as CanvasOperationId })).toEqual(result)
    expect(create).toHaveBeenCalledOnce()
    owner.dispose()
  })

  it('shares a fresh replacement across callers when every retained binding is archived', async () => {
    const archived = new Set([sessionId])
    const replacementId = 'replacement-thread' as SessionId
    const reply = Promise.withResolvers<CanvasThreadResult>()
    const create = vi.fn(async () => await reply.promise)
    const owner = new CanvasInitialThreads(create, id => archived.has(id))
    onTestFinished(() => {
      owner.dispose()
      reply.resolve({ ok: true, sessionId: replacementId, workspace: workspace(3, [sessionId, replacementId]) })
    })
    owner.observe(workspace(2, [sessionId]))
    const stage = vi.fn()
    const pending = owner.ensure(request, stage)
    const linked = owner.ensure({ ...request, operationId: 'connection-attempt' as CanvasOperationId })
    const result: CanvasThreadResult = { ok: true, sessionId: replacementId, workspace: workspace(3, [sessionId, replacementId]) }
    reply.resolve(result)
    expect(await pending).toEqual(result)
    expect(await linked).toEqual(result)
    expect(create).toHaveBeenCalledExactlyOnceWith(request)
    expect(stage).toHaveBeenCalledExactlyOnceWith(request)
    expect(await owner.ensure({ ...request, operationId: 'later-attempt' as CanvasOperationId })).toEqual(result)
    archived.clear()
    expect(await owner.ensure(request)).toEqual({ ok: true, sessionId, workspace: result.workspace })
    expect(create).toHaveBeenCalledOnce()
  })

  it('reads native archives at dispatch after waiting behind another Chat', async () => {
    const blockedNodeId = 'blocking-chat' as CanvasNodeId
    const blockedSessionId = 'blocking-thread' as SessionId
    const replacementId = 'replacement-thread' as SessionId
    const archived = new Set<SessionId>()
    const snapshot = workspace(2, [sessionId])
    snapshot.canvases[0]!.nodes.push({ ...snapshot.canvases[0]!.nodes[0]!, id: blockedNodeId })
    snapshot.chats.push({ ...snapshot.chats[0]!, nodeId: blockedNodeId, threads: [] })
    const entered = Promise.withResolvers<undefined>()
    const reply = Promise.withResolvers<CanvasThreadResult>()
    const create = vi.fn(async (value: CanvasThreadRequest): Promise<CanvasThreadResult> => {
      if (value.nodeId === blockedNodeId) { entered.resolve(undefined); return await reply.promise }
      return { ok: true, sessionId: replacementId, workspace: workspace(4, [sessionId, replacementId]) }
    })
    const owner = new CanvasInitialThreads(create, id => archived.has(id))
    onTestFinished(() => { owner.dispose(); reply.resolve({ ok: true, sessionId: blockedSessionId, workspace: snapshot }) })
    owner.observe(snapshot)
    const blocking = owner.ensure({ ...request, nodeId: blockedNodeId, operationId: 'blocking-attempt' as CanvasOperationId })
    await entered.promise
    archived.add(sessionId)
    const pending = owner.ensure(request)
    expect(create).toHaveBeenCalledTimes(1)
    reply.resolve({ ok: true, sessionId: blockedSessionId, workspace: snapshot })
    await blocking
    expect((await pending).ok).toBe(true)
    expect(create.mock.calls.map(([value]) => value.nodeId)).toEqual([blockedNodeId, nodeId])
  })

  it('serializes two empty Chats on one canvas using the latest committed revision', async () => {
    const secondNodeId = 'second-chat' as CanvasNodeId
    const secondSessionId = 'second-thread' as SessionId
    const initial = workspace(2)
    initial.canvases[0]!.nodes.push({ ...initial.canvases[0]!.nodes[0]!, id: secondNodeId })
    initial.chats.push({ ...initial.chats[0]!, nodeId: secondNodeId, threads: [] })
    const committed = structuredClone(initial)
    committed.revision = 3
    committed.canvases[0]!.revision = 3
    committed.chats[0]!.threads.push({ sessionId, parentSessionId: null, inheritedEventCount: 0 })
    const finished = structuredClone(committed)
    finished.revision = 4
    finished.canvases[0]!.revision = 4
    finished.chats[1]!.threads.push({ sessionId: secondSessionId, parentSessionId: null, inheritedEventCount: 0 })
    const firstResult: CanvasThreadResult = { ok: true, sessionId, workspace: committed }
    const secondResult: CanvasThreadResult = { ok: true, sessionId: secondSessionId, workspace: finished }
    const firstStarted = Promise.withResolvers<undefined>()
    const firstReply = Promise.withResolvers<CanvasThreadResult>()
    const create = vi.fn(async (value: CanvasThreadRequest): Promise<CanvasThreadResult> => {
      if (value.nodeId === nodeId) {
        firstStarted.resolve(undefined)
        return await firstReply.promise
      }
      return secondResult
    })
    const owner = new CanvasInitialThreads(create)
    onTestFinished(() => { owner.dispose(); firstReply.resolve(firstResult) })
    owner.observe(initial)
    const first = owner.ensure(request)
    const stage = vi.fn()
    const secondRequest = { ...request, nodeId: secondNodeId, operationId: 'second-attempt' as CanvasOperationId }
    const second = owner.ensure(secondRequest, stage)
    await firstStarted.promise
    expect(create).toHaveBeenCalledExactlyOnceWith(request)
    expect(stage).not.toHaveBeenCalled()
    owner.observe(committed)
    firstReply.resolve(firstResult)
    expect(await first).toEqual(firstResult)
    expect(await second).toEqual(secondResult)
    const dispatched = { ...secondRequest, expectedRevision: 3 }
    expect(create.mock.calls).toEqual([[request], [dispatched]])
    expect(stage).toHaveBeenCalledExactlyOnceWith(dispatched)
  })

  it('starts a different canvas while another canvas creation is still pending', async () => {
    const otherCanvasId = 'other-canvas' as CanvasId
    const otherNodeId = 'other-chat' as CanvasNodeId
    const otherSessionId = 'other-thread' as SessionId
    const initial = workspace(2)
    initial.canvases.push({ ...initial.canvases[0]!, id: otherCanvasId, revision: 7,
      nodes: [{ ...initial.canvases[0]!.nodes[0]!, id: otherNodeId }],
    })
    initial.chats.push({ ...initial.chats[0]!, canvasId: otherCanvasId, nodeId: otherNodeId, threads: [] })
    const firstResult: CanvasThreadResult = { ok: true, sessionId, workspace: initial }
    const otherResult: CanvasThreadResult = { ok: true, sessionId: otherSessionId, workspace: initial }
    const firstStarted = Promise.withResolvers<undefined>()
    const firstReply = Promise.withResolvers<CanvasThreadResult>()
    const create = vi.fn(async (value: CanvasThreadRequest): Promise<CanvasThreadResult> => {
      if (value.canvasId === canvasId) {
        firstStarted.resolve(undefined)
        return await firstReply.promise
      }
      return otherResult
    })
    const owner = new CanvasInitialThreads(create)
    onTestFinished(() => { owner.dispose(); firstReply.resolve(firstResult) })
    owner.observe(initial)
    const first = owner.ensure(request)
    await firstStarted.promise
    const otherRequest = { ...request, canvasId: otherCanvasId, nodeId: otherNodeId,
      operationId: 'other-attempt' as CanvasOperationId,
    }
    const stage = vi.fn()
    expect(await owner.ensure(otherRequest, stage)).toEqual(otherResult)
    expect(create.mock.calls).toEqual([[request], [{ ...otherRequest, expectedRevision: 7 }]])
    expect(stage).toHaveBeenCalledExactlyOnceWith({ ...otherRequest, expectedRevision: 7 })
    firstReply.resolve(firstResult)
    expect(await first).toEqual(firstResult)
  })

  it('does not create or stage a queued Chat that is removed before dispatch', async () => {
    const removedNodeId = 'removed-chat' as CanvasNodeId
    const initial = workspace(2)
    initial.canvases[0]!.nodes.push({ ...initial.canvases[0]!.nodes[0]!, id: removedNodeId })
    initial.chats.push({ ...initial.chats[0]!, nodeId: removedNodeId, threads: [] })
    const committed = workspace(3, [sessionId])
    const result: CanvasThreadResult = { ok: true, sessionId, workspace: committed }
    const started = Promise.withResolvers<undefined>()
    const reply = Promise.withResolvers<CanvasThreadResult>()
    const create = vi.fn(async (_value: CanvasThreadRequest): Promise<CanvasThreadResult> => {
      started.resolve(undefined)
      return await reply.promise
    })
    const owner = new CanvasInitialThreads(create)
    onTestFinished(() => { owner.dispose(); reply.resolve(result) })
    owner.observe(initial)
    const first = owner.ensure(request)
    const stage = vi.fn()
    const removed = owner.ensure({ ...request, nodeId: removedNodeId,
      operationId: 'removed-attempt' as CanvasOperationId,
    }, stage)
    await started.promise
    owner.observe(committed)
    const rejected = expect(removed).rejects.toThrow('Chat no longer exists')
    reply.resolve(result)
    expect(await first).toEqual(result)
    await rejected
    expect(create).toHaveBeenCalledExactlyOnceWith(request)
    expect(stage).not.toHaveBeenCalled()
  })

  it('refreshes an unreserved request after another Chat commits without returning its reply', async () => {
    const secondNodeId = 'second-chat' as CanvasNodeId
    const secondSessionId = 'second-thread' as SessionId
    const initial = workspace(2)
    initial.canvases[0]!.nodes.push({ ...initial.canvases[0]!.nodes[0]!, id: secondNodeId })
    initial.chats.push({ ...initial.chats[0]!, nodeId: secondNodeId, threads: [] })
    const committed = structuredClone(initial)
    committed.revision = 3
    committed.canvases[0]!.revision = 3
    committed.chats[0]!.threads.push({ sessionId, parentSessionId: null, inheritedEventCount: 0 })
    const finished = structuredClone(committed)
    finished.revision = 4
    finished.canvases[0]!.revision = 4
    finished.chats[1]!.threads.push({ sessionId: secondSessionId, parentSessionId: null, inheritedEventCount: 0 })
    const started = Promise.withResolvers<undefined>()
    const lostReply = Promise.withResolvers<CanvasThreadResult>()
    const create = vi.fn(async (value: CanvasThreadRequest): Promise<CanvasThreadResult> => {
      if (value.nodeId === nodeId) {
        started.resolve(undefined)
        return await lostReply.promise
      }
      if (value.expectedRevision === 2) return {
        ok: false, code: 'conflict', message: 'Canvas changed', workspace: committed,
      }
      return { ok: true, sessionId: secondSessionId, workspace: finished }
    })
    const owner = new CanvasInitialThreads(create)
    onTestFinished(() => { owner.dispose(); lostReply.reject(new Error('Reply lost')) })
    owner.observe(initial)
    const firstFailure = expect(owner.ensure(request)).rejects.toThrow('Reply lost')
    const stage = vi.fn()
    const secondRequest = { ...request, nodeId: secondNodeId, operationId: 'second-attempt' as CanvasOperationId }
    const second = owner.ensure(secondRequest, stage)
    await started.promise
    expect(create).toHaveBeenCalledExactlyOnceWith(request)
    lostReply.reject(new Error('Reply lost'))
    await firstFailure
    expect(await second).toEqual({ ok: true, sessionId: secondSessionId, workspace: finished })
    const refreshed = { ...secondRequest, expectedRevision: 3 }
    expect(create.mock.calls).toEqual([[request], [secondRequest], [refreshed]])
    expect(stage.mock.calls).toEqual([[secondRequest], [refreshed]])
    expect(await owner.ensure(request)).toEqual({ ok: true, sessionId, workspace: finished })
    expect(create).toHaveBeenCalledTimes(3)
  })

  it('retains a conflict without retrying when the returned revision has not advanced', async () => {
    const current = workspace(2)
    const conflict: CanvasThreadResult = { ok: false, code: 'conflict', message: 'Canvas changed', workspace: current }
    const create = vi.fn(async (): Promise<CanvasThreadResult> => conflict)
    const owner = new CanvasInitialThreads(create)
    owner.observe(current)
    const stage = vi.fn()
    expect(await owner.ensure(request, stage)).toEqual(conflict)
    const remountStage = vi.fn()
    expect(await owner.ensure({ ...request, operationId: 'remount-attempt' as CanvasOperationId }, remountStage)).toEqual(conflict)
    expect(create).toHaveBeenCalledExactlyOnceWith(request)
    expect(stage).toHaveBeenCalledExactlyOnceWith(request)
    expect(remountStage).toHaveBeenCalledExactlyOnceWith(request)
    owner.dispose()
  })

  it.each(['rejection', 'transport failure'] as const)('retains the initial identity after a %s', async (failure) => {
    const failed: CanvasThreadResult = {
      ok: false, code: 'operation-pending', message: 'Creation remains pending', workspace: workspace(2),
    }
    const create = vi.fn(async (): Promise<CanvasThreadResult> => {
      if (failure === 'transport failure') throw new Error('Disconnected')
      return failed
    })
    const owner = new CanvasInitialThreads(create)
    const first = owner.ensure(request)
    const stage = vi.fn()
    if (failure === 'transport failure') await expect(first).rejects.toThrow('Disconnected')
    else expect(await first).toEqual(failed)
    const restored = owner.ensure({ ...request, operationId: 'different-attempt' as CanvasOperationId }, stage)
    if (failure === 'transport failure') await expect(restored).rejects.toThrow('Disconnected')
    else expect(await restored).toEqual(failed)
    expect(stage).toHaveBeenCalledExactlyOnceWith(request)
    expect(create).toHaveBeenCalledExactlyOnceWith(request)
    owner.dispose()
  })

  it('uses an existing first thread and ignores an older workspace observation', async () => {
    const create = vi.fn<(value: CanvasThreadRequest) => Promise<CanvasThreadResult>>()
    const owner = new CanvasInitialThreads(create)
    const latest = workspace(4, [sessionId, 'another-thread' as SessionId])
    owner.observe(latest)
    owner.observe(workspace(3))
    const stage = vi.fn()
    expect(await owner.ensure(request, stage)).toEqual({ ok: true, sessionId, workspace: latest })
    expect(stage).toHaveBeenCalledExactlyOnceWith(request)
    expect(create).not.toHaveBeenCalled()
    owner.dispose()
  })

  it('uses the committed thread observed after an explicit creation retry', async () => {
    const create = vi.fn(async (): Promise<CanvasThreadResult> => ({
      ok: false, code: 'operation-pending', message: 'Pending', workspace: workspace(2),
    }))
    const owner = new CanvasInitialThreads(create)
    expect((await owner.ensure(request)).ok).toBe(false)
    const committed = workspace(3, [sessionId])
    owner.observe(committed)
    expect(await owner.ensure(request)).toEqual({ ok: true, sessionId, workspace: committed })
    expect(create).toHaveBeenCalledOnce()
    owner.dispose()
  })

  it('releases an old request when its Chat is removed', async () => {
    const create = vi.fn(async (): Promise<CanvasThreadResult> => ({
      ok: false, code: 'operation-pending', message: 'Pending', workspace: workspace(2),
    }))
    const owner = new CanvasInitialThreads(create)
    owner.observe(workspace(2))
    await owner.ensure(request)
    owner.observe(workspace(3, [], false))
    owner.observe(workspace(4))
    const replacement = { ...request, expectedRevision: 4, operationId: 'replacement-attempt' as CanvasOperationId }
    await owner.ensure(replacement)
    expect(create.mock.calls).toEqual([[request], [replacement]])
    owner.dispose()
  })

  it('rejects initialization after its renderer lifetime ends', async () => {
    const create = vi.fn<(value: CanvasThreadRequest) => Promise<CanvasThreadResult>>()
    const owner = new CanvasInitialThreads(create)
    owner.dispose()
    owner.observe(workspace(3, [sessionId]))
    await expect(owner.ensure(request)).rejects.toThrow('disposed')
    expect(create).not.toHaveBeenCalled()
  })

  it('does not send a queued creation after its renderer lifetime ends', async () => {
    const create = vi.fn<(value: CanvasThreadRequest) => Promise<CanvasThreadResult>>()
    const owner = new CanvasInitialThreads(create)
    const pending = owner.ensure(request)
    owner.dispose()
    await expect(pending).rejects.toThrow('disposed')
    expect(create).not.toHaveBeenCalled()
  })
})
