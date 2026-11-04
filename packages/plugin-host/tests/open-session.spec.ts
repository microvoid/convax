/** Existing Session placement commits its graph, unique binding, and receipts in one SQLite transaction. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import { CanvasDatabase } from '../src/database.ts'
import { CanvasRepository } from '../src/repository.ts'
import { CanvasNodeRegistry } from '../src/registry.ts'
import { CanvasChatCoordinator } from '../../plugin-inernal-nodes-host/src/chats.ts'
import { ConvaxHost } from '../src/index.ts'
import type { CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasOpenSessionRequest, CanvasOperationId } from '../src/types.ts'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'convax-open-session-'))
  closes.push(() => rm(cwd, { recursive: true, force: true }))
  const archived = new Set<SessionId>()
  const sessionId = SessionId('original-session')
  const canvasId = brandString<CanvasId>('placement-canvas')
  const nodeId = brandString<CanvasNodeId>('placement-chat')
  const dispose = vi.fn()
  const observation: SessionObservation = {
    header: { version: 4, id: sessionId, createdAt: 1, cwd, isSeeded: true }, source: 'prepared',
    inheritedEventCount: SessionLogOffset(2), cursor: SessionSeq(7), events: [],
    retain: () => observation, [Symbol.dispose]: dispose,
  }
  const observe = vi.fn(async () => observation)
  const allows = vi.fn(() => true)
  const open = async () => {
    const ctx = new Context()
    ctx.provide('sessionQuery', { observeSession: observe } as never)
    ctx.provide('workspaceRegistry', { get archivedSessionIds() { return [...archived] } } as never)
    ctx.provide('remoteAccess', { allows } as never)
    const domain = await CanvasDatabase.open({ path: join(cwd, 'canvas.sqlite') })
    const registry = new CanvasNodeRegistry((error) => { throw error })
    registry.register({ id: brandString<CanvasNodeTypeId>('convax.chat'), dataVersion: 1, capabilities: { sessions: true }, ports: [], parse: data => data })
    const repository = new CanvasRepository(domain, registry, (error) => { throw error })
    const materialize = vi.fn(async () => { throw new Error('Opening must not create a Session') })
    const coordinator = new CanvasChatCoordinator(ctx, repository, { materialize })
    const host = new ConvaxHost(ctx, repository, { previewBytes: 1, documentBytes: 1, mediaChunkBytes: 1 }, { chats: coordinator })
    let closed = false
    const close = async () => {
      if (closed) return
      closed = true
      await host.close()
      repository.close()
      await domain.close()
    }
    closes.push(close)
    return { ctx, domain, repository, coordinator, host, close, materialize }
  }
  const current = await open()
  expect(await current.host.execute({ canvasId, expectedRevision: 0, operationId: brandString<CanvasOperationId>('create'),
    command: { kind: 'create', title: 'Existing Sessions' } })).toMatchObject({ ok: true })
  const request: CanvasOpenSessionRequest = { canvasId, nodeId, sessionId, expectedRevision: 1, position: { x: 50, y: 80 } }
  return { ...current, open, cwd, archived, request, observe, observation, dispose, allows }
}

describe('Opening an existing Session', () => {
  it('publishes a Chat with its original Session atomically and skips historical delivery replay', async () => {
    const f = await fixture()
    const published: number[] = []
    const unsubscribe = f.repository.subscribe(() => { published.push(f.host.workspace().chats[0]?.threads.length ?? -1) })
    const result = await f.host.openSession(f.request)
    unsubscribe()
    expect(result).toMatchObject({ ok: true, canvasId: f.request.canvasId, nodeId: f.request.nodeId, sessionId: f.request.sessionId })
    expect(f.host.workspace().chats).toMatchObject([{ cwd: f.cwd, threads: [{ sessionId: f.request.sessionId, inheritedEventCount: 2 }] }])
    expect(f.host.workspace().canvases[0]?.nodes[0]).toMatchObject({ position: f.request.position, data: { cwd: f.cwd } })
    expect(f.domain.table('bindings').get(f.request.sessionId)).toMatchObject({ deliveryCursor: 7, ordinal: 0 })
    expect(f.domain.table('operations').size).toBe(2)
    expect(f.domain.table('history').size).toBe(1)
    expect(published).toEqual([1])
    expect(f.materialize).not.toHaveBeenCalled()
    expect(f.dispose).toHaveBeenCalledOnce()
  })

  it('returns the first durable location for concurrent placements and after reopening with a stale preferred canvas', async () => {
    const f = await fixture()
    const other = { ...f.request, canvasId: brandString<CanvasId>('absent'), nodeId: brandString<CanvasNodeId>('other'), expectedRevision: 0 }
    const results = await Promise.all([f.host.openSession(f.request), f.host.openSession(other)])
    expect(results.every(result => result.ok && result.nodeId === f.request.nodeId && result.canvasId === f.request.canvasId)).toBe(true)
    expect(f.host.workspace().canvases[0]?.nodes).toHaveLength(1)
    await f.close()
    const reopened = await f.open()
    expect(await reopened.host.openSession(other)).toMatchObject({ ok: true, nodeId: f.request.nodeId, canvasId: f.request.canvasId })
    expect(reopened.domain.table('operations').size).toBe(2)
    expect(reopened.materialize).not.toHaveBeenCalled()
  })

  it('rejects an archived or missing original Session and unavailable project metadata without publishing a Chat', async () => {
    const f = await fixture()
    f.archived.add(f.request.sessionId)
    expect(await f.host.openSession(f.request)).toMatchObject({ ok: false, code: 'invalid-command' })
    expect(f.observe).not.toHaveBeenCalled()
    f.archived.clear()
    f.observe.mockRejectedValueOnce(new SessionQueryError('Session is absent', 'SESSION_QUERY_SESSION_NOT_FOUND'))
    expect(await f.host.openSession(f.request)).toMatchObject({ ok: false, code: 'not-found' })
    f.observe.mockResolvedValueOnce({ ...f.observation, header: { version: 4, id: f.request.sessionId, createdAt: 1, isSeeded: false } })
    expect(await f.host.openSession(f.request)).toMatchObject({ ok: false, code: 'invalid-command' })
    expect(f.host.workspace().chats).toEqual([])
    expect(f.domain.table('bindings').size).toBe(0)
  })

  it('rechecks archival after reading and retains the placement identity after a revision conflict', async () => {
    const f = await fixture()
    f.observe.mockImplementationOnce(async () => { f.archived.add(f.request.sessionId); return f.observation })
    expect(await f.host.openSession(f.request)).toMatchObject({ ok: false, code: 'invalid-command' })
    f.archived.clear()
    expect(await f.host.openSession({ ...f.request, expectedRevision: 0 })).toMatchObject({ ok: false, code: 'conflict' })
    expect(f.host.workspace().chats).toEqual([])
    expect(await f.host.openSession(f.request)).toMatchObject({ ok: true })
  })

  it('rolls the graph and receipt back when its Session binding cannot commit, then retries once', async () => {
    const f = await fixture()
    const db = new DatabaseSync(join(f.cwd, 'canvas.sqlite'))
    try {
      db.exec("CREATE TRIGGER reject_binding BEFORE INSERT ON u_convax_bindings BEGIN SELECT RAISE(ABORT, 'binding unavailable'); END")
      const result = await f.host.openSession(f.request)
      expect(result).toMatchObject({ ok: false, code: 'operation-pending' })
      expect(f.host.workspace().chats).toEqual([])
      expect(f.domain.table('operations').size).toBe(1)
      expect(f.domain.table('history').size).toBe(0)
      db.exec('DROP TRIGGER reject_binding')
      expect(await f.host.openSession(f.request)).toMatchObject({ ok: true })
      expect(await f.host.openSession(f.request)).toMatchObject({ ok: true })
      expect(f.host.workspace().chats).toHaveLength(1)
    } finally { db.close() }
  })

  it('rejects a reused Chat identity for another Session and checks workspace access before querying native data', async () => {
    const f = await fixture()
    expect(await f.host.openSession(f.request)).toMatchObject({ ok: true })
    expect(await f.host.openSession({ ...f.request, sessionId: SessionId('another-session'), expectedRevision: 2 })).toMatchObject({ ok: false, code: 'invalid-command' })
    f.allows.mockReturnValue(false)
    f.observe.mockClear()
    expect(() => f.host.openSession(f.request)).toThrow('Canvas workspace access is required')
    expect(f.observe).not.toHaveBeenCalled()
    expect(f.host.workspace().chats).toHaveLength(1)
  })

  it('does not steal a Session reserved by an unfinished native thread creation', async () => {
    const f = await fixture()
    const operationId = brandString<CanvasOperationId>('pending-native-binding')
    const pendingNode = brandString<CanvasNodeId>('pending-chat')
    expect(await f.host.execute({ canvasId: f.request.canvasId, operationId: brandString<CanvasOperationId>('pending-chat-add'),
      expectedRevision: 1, command: { kind: 'add-node', node: {
        id: pendingNode, typeId: brandString<CanvasNodeTypeId>('convax.chat'), dataVersion: 1, revision: 0,
        position: { x: 0, y: 0 }, data: { cwd: f.cwd, title: 'Pending Chat' },
      } } })).toMatchObject({ ok: true })
    await f.domain.table('thread_operations').put(operationId, {
      request: JSON.stringify({ kind: 'create', canvasId: f.request.canvasId, nodeId: pendingNode, expectedRevision: 2, operationId }),
      canvasId: f.request.canvasId, nodeId: pendingNode, cwd: f.cwd, phase: 'pending',
      sessionId: null, parentSessionId: null, inheritedEventCount: 0, error: null,
      session: { phase: 'completed', sessionId: f.request.sessionId, createdAt: 1, cwd: f.cwd },
    })
    expect(await f.host.openSession({ ...f.request, expectedRevision: 2 })).toMatchObject({ ok: false, code: 'conflict' })
    expect(f.domain.table('bindings').size).toBe(0)
    expect(f.host.workspace().canvases[0]?.nodes.map(node => node.id)).toEqual([pendingNode])
  })
})
