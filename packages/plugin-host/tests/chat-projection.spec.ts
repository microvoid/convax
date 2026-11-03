/** Chat reads preserve durable ordering, error priority, and detached public values. */
import { afterEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import { CanvasDatabase } from '../src/database.ts'
import { CanvasNodeRegistry } from '../src/registry.ts'
import { CanvasRepository } from '../src/repository.ts'
import type { CanvasCommandRequest, CanvasData, CanvasId, CanvasNode, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId } from '../src/types.ts'

const canvasId = brandString<CanvasId>('canvas-a')
const otherCanvasId = brandString<CanvasId>('canvas-b')
const chatId = brandString<CanvasNodeId>('chat-a')
const otherChatId = brandString<CanvasNodeId>('chat-b')
const fallbackChatId = brandString<CanvasNodeId>('chat-fallback')
const fileId = brandString<CanvasNodeId>('file')
const pendingId = brandString<CanvasOperationId>('pending-thread')
const deletionId = brandString<CanvasOperationId>('deletion')
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

function node(id: CanvasNodeId, data: CanvasData = {}, typeId = 'convax.chat'): CanvasNode {
  return { id, data, typeId: brandString<CanvasNodeTypeId>(typeId), dataVersion: 1, position: { x: 0, y: 0 }, revision: 1 }
}

async function fixture() {
  const database = await CanvasDatabase.open({ path: ':memory:' })
  const registry = new CanvasNodeRegistry((error) => { throw error })
  const repository = new CanvasRepository(database, registry, (error) => { throw error })
  cleanup.push(async () => { repository.close(); await database.close() })
  await database.transaction((tx) => {
    tx.global.set({ revision: 8, canvases: [
      { id: canvasId, title: 'Fallback title', revision: 4, connections: [], nodes: [
        node(chatId, { title: 'Primary chat', cwd: '/synthetic/project' }),
        node(fallbackChatId, { title: 42, cwd: null }), node(fileId, { path: '/synthetic/file.txt' }, 'convax.file'),
      ] },
      { id: otherCanvasId, title: 'Other canvas', revision: 4, connections: [], nodes: [node(otherChatId, { title: '', cwd: '' })] },
    ] })
    for (const [session, ordinal, error, targetCanvas, targetNode] of [
      ['session-z', 1, 'Later key error', canvasId, chatId],
      ['session-b', 2, null, canvasId, chatId],
      ['session-a', 2, 'First key error', canvasId, chatId],
      ['session-0', 0, 'Suppressed error', canvasId, chatId],
      ['session-other', 0, 'Other canvas error', otherCanvasId, otherChatId],
    ] as const) {
      const sessionId = SessionId(session)
      tx.table('bindings').put(sessionId, {
        canvasId: targetCanvas, nodeId: targetNode, sessionId, parentSessionId: null, inheritedEventCount: ordinal,
        ordinal, deliveryCursor: -1, deliveryError: error,
      })
    }
    tx.table('thread_operations').put(brandString<CanvasOperationId>('suppressed'), {
      request: JSON.stringify({ canvasId, nodeId: chatId, operationId: 'suppressed', expectedRevision: 4, kind: 'create' }),
      canvasId, nodeId: chatId, cwd: '/synthetic/project', phase: 'suppressed', sessionId: SessionId('session-0'),
      parentSessionId: null, inheritedEventCount: 0, error: null,
    })
    tx.table('thread_operations').put(pendingId, {
      request: JSON.stringify({ canvasId, nodeId: chatId, operationId: pendingId, expectedRevision: 4, kind: 'create' }),
      canvasId, nodeId: chatId, cwd: '/synthetic/project', phase: 'pending', sessionId: null,
      parentSessionId: null, inheritedEventCount: 0, error: 'Thread failure',
    })
    const request: CanvasCommandRequest = { canvasId, operationId: deletionId, expectedRevision: 4,
      command: { kind: 'remove-nodes', nodeIds: [chatId] }, confirmed: true }
    tx.table('deletions').put(deletionId, {
      request: JSON.stringify(request), canvasId, nodeIds: [chatId], phase: 'deleting', error: 'Archive failure', restoreSessions: [],
    })
  })
  return { database, repository }
}

describe('Chat projections', () => {
  it('uses ordinal and Session identity order, excludes suppressed threads, and isolates canvases and non-Chat nodes', async () => {
    const { repository } = await fixture()
    expect(repository.getChat(canvasId, chatId)).toEqual({
      canvasId, nodeId: chatId, title: 'Primary chat', cwd: '/synthetic/project', deleting: true, issue: 'Thread failure',
      threads: [
        { sessionId: SessionId('session-z'), parentSessionId: null, inheritedEventCount: 1 },
        { sessionId: SessionId('session-a'), parentSessionId: null, inheritedEventCount: 2 },
        { sessionId: SessionId('session-b'), parentSessionId: null, inheritedEventCount: 2 },
      ],
    })
    expect(repository.getChat(canvasId, fallbackChatId)).toMatchObject({ title: 'Fallback title', cwd: '', issue: null, threads: [] })
    expect(repository.getChat(otherCanvasId, otherChatId)).toMatchObject({ title: '', cwd: '', issue: 'Other canvas error' })
    expect(repository.getChat(canvasId, otherChatId)).toBeUndefined()
    expect(repository.getChat(otherCanvasId, chatId)).toBeUndefined()
    expect(repository.getChat(canvasId, fileId)).toBeUndefined()
    for (const chat of repository.snapshot().chats) expect(repository.getChat(chat.canvasId, chat.nodeId)).toEqual(chat)
  })

  it('retains thread, active deletion, then delivery error priority without reordering delivery errors', async () => {
    const { database, repository } = await fixture()
    const pending = database.table('thread_operations').get(pendingId)!
    expect(repository.getChat(canvasId, chatId)?.issue).toBe('Thread failure')
    await database.table('thread_operations').put(pendingId, { ...pending, error: '' })
    expect(repository.getChat(canvasId, chatId)?.issue).toBe('')
    await database.table('thread_operations').put(pendingId, { ...pending, error: null })
    expect(repository.getChat(canvasId, chatId)?.issue).toBe('Archive failure')
    const deletion = database.table('deletions').get(deletionId)!
    await database.table('deletions').put(deletionId, { ...deletion, phase: 'completed' })
    expect(repository.getChat(canvasId, chatId)).toMatchObject({ deleting: false, issue: 'First key error' })
    const first = database.table('bindings').get(SessionId('session-a'))!
    await database.table('bindings').put(first.sessionId, { ...first, deliveryError: null })
    expect(repository.getChat(canvasId, chatId)?.issue).toBe('Later key error')
    const last = database.table('bindings').get(SessionId('session-z'))!
    await database.table('bindings').put(last.sessionId, { ...last, deliveryError: null })
    expect(repository.getChat(canvasId, chatId)?.issue).toBeNull()
  })

  it('keeps a successfully bound Session visible after its creation operation completes', async () => {
    const { repository } = await fixture()
    const operationId = brandString<CanvasOperationId>('completed-thread')
    const sessionId = SessionId('completed-session')
    await repository.coordination.reserveThread({
      canvasId, nodeId: fallbackChatId, operationId, expectedRevision: 4, kind: 'create',
    }, '/synthetic/project')
    await repository.coordination.failThread(operationId, 'Temporary creation failure')
    expect(await repository.coordination.completeThread(operationId, sessionId, 3)).toBe(true)
    const chat = repository.getChat(canvasId, fallbackChatId)
    expect(chat).toMatchObject({ issue: null, threads: [{ sessionId, parentSessionId: null, inheritedEventCount: 3 }] })
    expect(repository.snapshot().chats.find(value => value.nodeId === fallbackChatId)).toEqual(chat)
  })

  it('keeps the first durable-key failure when several pending operations affect the same Chat', async () => {
    const { database, repository } = await fixture()
    const laterThreadId = brandString<CanvasOperationId>('zzz-thread')
    const pending = database.table('thread_operations').get(pendingId)!
    await database.table('thread_operations').put(laterThreadId, { ...pending, error: 'Later thread failure', request: JSON.stringify({
      canvasId, nodeId: chatId, operationId: laterThreadId, expectedRevision: 4, kind: 'create',
    }) })
    const laterDeletionId = brandString<CanvasOperationId>('zzz-deletion')
    const deletion = database.table('deletions').get(deletionId)!
    await database.table('deletions').put(laterDeletionId, { ...deletion, error: 'Later archive failure', request: JSON.stringify({
      canvasId, operationId: laterDeletionId, expectedRevision: 4, command: { kind: 'remove-nodes', nodeIds: [chatId] }, confirmed: true,
    }) })
    expect(repository.getChat(canvasId, chatId)?.issue).toBe('Thread failure')
    await database.table('thread_operations').put(pendingId, { ...pending, error: null })
    expect(repository.getChat(canvasId, chatId)?.issue).toBe('Later thread failure')
    const laterThread = database.table('thread_operations').get(laterThreadId)!
    await database.table('thread_operations').put(laterThreadId, { ...laterThread, error: null })
    expect(repository.getChat(canvasId, chatId)?.issue).toBe('Archive failure')
    await database.table('deletions').put(deletionId, { ...deletion, phase: 'completed' })
    expect(repository.getChat(canvasId, chatId)?.issue).toBe('Later archive failure')
  })

  it('returns detached graph, thread and issue values and observes the next committed state without retained projection state', async () => {
    const { database, repository } = await fixture()
    repository.setNodeIssues([{ canvasId, nodeId: fileId, kind: 'incompatible', message: 'Provider unavailable' }])
    const original = repository.snapshot()
    const returned = repository.snapshot()
    returned.canvases[0]!.nodes[0]!.data.title = 'Caller changed title'
    returned.chats[0]!.threads[0]!.inheritedEventCount = 999
    returned.nodeIssues[0]!.message = 'Caller changed issue'
    const chat = repository.getChat(canvasId, chatId)!
    chat.threads.splice(0)
    chat.title = 'Caller changed Chat'
    expect(repository.snapshot()).toEqual(original)
    const graph = database.global.get()
    graph.canvases[0]!.nodes[0]!.data.title = 'Committed title'
    await database.global.set(graph)
    expect(repository.getChat(canvasId, chatId)?.title).toBe('Committed title')
    expect(repository.snapshot().chats[0]?.title).toBe('Committed title')
  })
})
