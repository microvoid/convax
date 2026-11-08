/** Chat tools exercise the native coordinators, Session persistence and tool result validation together. */
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { TestSessionQueryEngine } from '../../../libs/dsh/packages/session-query/session-query/tests/test-service.ts'
import { MemoryStorageBackend } from '../../../libs/dsh/packages/storage/storage-domain/tests/helpers/memory-backend.ts'
import * as Convax from '../src/index.ts'
import * as DefaultNodes from '../../plugin-inernal-nodes-host/src/index.ts'
import type { CanvasCommand, CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId } from '../src/types.ts'

const canvasId = 'chat-tools-canvas' as CanvasId
const otherCanvasId = 'chat-tools-other-canvas' as CanvasId
const nodeId = 'chat-tools-node' as CanvasNodeId
const otherNodeId = 'chat-tools-other-node' as CanvasNodeId
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanups.splice(0).reverse()) await close()
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'convax-chat-tools-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const otherDirectory = join(root, 'other-project')
  await mkdir(otherDirectory)
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(RemoteAccess)
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const domain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', domain)
  ctx.provide('storageDomain', domain)
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(TestSessionQueryEngine)
  const fiber = ctx.plugin(Convax, { databasePath: join(root, 'canvas.sqlite'), canvasDirectoryRoot: join(root, 'workspaces'), previewBytes: 1024, documentBytes: 1024, mediaChunkBytes: 1024 })
  await fiber
  const nodesFiber = ctx.plugin(DefaultNodes)
  await nodesFiber
  await nodesFiber.await()
  const host = ctx.convax
  const driver = await mountAgentLoopTestHarness(ctx)
  const owner = await driver.create(SessionId('chat-tools-owner'), {}, { cwd: root })
  const outsider = await driver.create(SessionId('chat-tools-outsider'), {}, { cwd: otherDirectory })
  const revision = (id = canvasId): number => host.workspace().canvases.find(canvas => canvas.id === id)?.revision ?? 0
  let operation = 0, call = 0
  const execute = async (command: CanvasCommand, id = canvasId) => {
    const result = await host.execute({ canvasId: id, expectedRevision: revision(id), operationId: `seed-${++operation}` as CanvasOperationId, command })
    expect(result.ok).toBe(true)
    return result
  }
  for (const [id, chatId, cwd] of [[canvasId, nodeId, root], [otherCanvasId, otherNodeId, otherDirectory]] as const) {
    await execute({ kind: 'create', title: id }, id)
    await execute({ kind: 'add-node', node: { id: chatId, typeId: 'convax.chat' as CanvasNodeTypeId, dataVersion: 1, revision: 0,
      data: { title: chatId, cwd }, position: { x: 10, y: 20 } } }, id)
  }
  const binding = 'bind-owner' as CanvasOperationId
  await host.repository.coordination.reserveThread({ canvasId, nodeId, expectedRevision: revision(), operationId: binding, kind: 'create' }, root)
  expect(await host.repository.coordination.completeThread(binding, owner.id, 0)).toBe(true)
  const invoke = (args: object, options: { agent?: Agent | null; signal?: AbortSignal } = {}) => executeToolFixture(ctx, {
    callId: ToolCallId(`chat-call-${++call}`), name: 'convax_chat', arguments: args,
    signal: options.signal ?? new AbortController().signal,
    ...options.agent === null ? {} : { agent: options.agent ?? owner },
  })
  return { ctx, host, root, otherDirectory, owner, outsider, fiber, nodesFiber, revision, execute, invoke }
}

describe('Convax Chat tools', () => {
  it('creates a cold native thread in the calling Chat and reuses its durable retry identity', async () => {
    const f = await fixture()
    const request = { action: 'create-thread', expectedRevision: f.revision(), operationId: 'create-thread' }
    const created = await f.invoke(request)
    expect(created.isError).toBe(false)
    expect(created.value).toMatchObject({ ok: true, action: 'create-thread', canvasId, nodeId, operationId: request.operationId, error: null, revision: f.revision() })
    const thread = f.host.workspace().chats.find(chat => chat.nodeId === nodeId)!.threads.find(value => value.sessionId !== f.owner.id)!
    expect(created.value).toHaveProperty('sessionId', thread.sessionId)
    expect(f.ctx.agents.get(thread.sessionId)).toBeUndefined()
    expect((await f.ctx.sessionPersistence.stat(thread.sessionId))?.header).toMatchObject({ cwd: f.root, isSeeded: false })
    expect(f.ctx.workspaceRegistry.list().some(workspace => workspace.sessionIds.includes(thread.sessionId))).toBe(true)
    await using log = await f.ctx.sessionPersistence.open(thread.sessionId, 'read')
    expect((await log.read(0)).events).toEqual([])
    const retried = await f.invoke(request)
    expect(retried.value).toEqual(created.value)
    expect(f.host.workspace().chats.find(chat => chat.nodeId === nodeId)?.threads).toHaveLength(2)
    const changedRetry = await f.invoke({ ...request, cwd: f.otherDirectory })
    expect(changedRetry.value).toMatchObject({ ok: false, operationId: request.operationId, error: { code: 'invalid-command' } })
  })

  it('requires explicit targets for unbound Sessions and never borrows a Chat from another canvas', async () => {
    const f = await fixture()
    const request = { action: 'create-thread', expectedRevision: f.revision(otherCanvasId), operationId: 'explicit-thread' }
    expect(await f.invoke(request, { agent: f.outsider })).toMatchObject({
      isError: true, content: [{ text: expect.stringContaining('canvasId is required') as string }],
    })
    expect(await f.invoke({ ...request, canvasId: otherCanvasId })).toMatchObject({
      isError: true, content: [{ text: expect.stringContaining('nodeId must be') as string }],
    })
    expect(await f.invoke({ ...request, canvasId: otherCanvasId, nodeId: otherNodeId }, { agent: null })).toMatchObject({
      isError: false, value: { ok: true, canvasId: otherCanvasId, nodeId: otherNodeId, error: null },
    })
    const thread = f.host.workspace().chats.find(chat => chat.nodeId === otherNodeId)!.threads[0]!
    expect((await f.ctx.sessionPersistence.stat(thread.sessionId))?.header.cwd).toBe(f.otherDirectory)
  })

  it('forks the native source prefix and source directory instead of the target Chat directory', async () => {
    const f = await fixture()
    f.owner.session.append('turn/start', { turn: 1 })
    f.owner.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Existing source work' }] }), { surfaceOp: 'append' })
    f.owner.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await f.ctx.sessions.flush(f.owner.session)
    const sourceEvents = f.owner.session.snapshotEvents()
    const request = { action: 'fork-thread', canvasId: otherCanvasId, nodeId: otherNodeId,
      sourceSessionId: f.owner.id, expectedRevision: f.revision(otherCanvasId), operationId: 'fork-thread' }
    const result = await f.invoke(request)
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ ok: true, action: 'fork-thread', canvasId: otherCanvasId, nodeId: otherNodeId })
    const thread = f.host.workspace().chats.find(chat => chat.nodeId === otherNodeId)!.threads[0]!
    expect(thread).toMatchObject({ parentSessionId: f.owner.id, inheritedEventCount: sourceEvents.length })
    expect((await f.ctx.sessionPersistence.stat(thread.sessionId))?.header).toMatchObject({ cwd: f.root, isSeeded: true })
    await using log = await f.ctx.sessionPersistence.open(thread.sessionId, 'read')
    const forkEvents = (await log.read(0)).events
    expect(forkEvents.slice(0, sourceEvents.length)).toEqual(sourceEvents)
    expect(forkEvents.at(-1)).toMatchObject({ type: 'session/end-seed', data: { inherited: true } })
    expect(f.ctx.agents.get(thread.sessionId)).toBeUndefined()
    expect((await f.invoke(request)).value).toEqual(result.value)
  })

  it('reports native conflicts and deleting Chats without allocating another Session', async () => {
    const f = await fixture()
    const stale = await f.invoke({ action: 'create-thread', expectedRevision: 0, operationId: 'stale' })
    expect(stale).toMatchObject({ isError: false, value: { ok: false, sessionId: null, error: { code: 'conflict' } } })
    await f.host.repository.coordination.beginDeletion({ canvasId, expectedRevision: f.revision(), operationId: 'deleting' as CanvasOperationId,
      command: { kind: 'remove-nodes', nodeIds: [nodeId] }, confirmed: true })
    expect(await f.invoke({ action: 'create-thread', expectedRevision: f.revision(), operationId: 'during-deletion' })).toMatchObject({
      isError: false, value: { ok: false, sessionId: null, error: { code: 'deleting' } },
    })
    expect(f.host.workspace().chats.find(chat => chat.nodeId === nodeId)?.threads).toHaveLength(1)
  })

  it('retries a native persistence failure with the originally reserved Session identity', async () => {
    const f = await fixture()
    const request = { action: 'create-thread', expectedRevision: f.revision(), operationId: 'recover-thread' }
    vi.spyOn(f.ctx.sessionPersistence, 'create').mockRejectedValueOnce(new Error('Storage unavailable'))
    expect(await f.invoke(request)).toMatchObject({ isError: false, value: { ok: false, sessionId: null, error: { code: 'operation-pending', message: 'Storage unavailable' } } })
    const reserved = f.host.repository.coordination.thread(request.operationId as CanvasOperationId)!.session!.sessionId
    expect(await f.invoke(request)).toMatchObject({ isError: false, value: { ok: true, sessionId: reserved, error: null } })
    expect(f.host.workspace().chats.find(chat => chat.nodeId === nodeId)?.threads.map(thread => thread.sessionId))
      .toEqual([f.owner.id, reserved])
  })

  it('places an existing Session once and returns its unique binding even when another canvas was requested', async () => {
    const f = await fixture()
    await f.ctx.sessions.flush(f.outsider.session)
    const request = { action: 'open-session', canvasId: otherCanvasId, nodeId: 'placed-chat', sessionId: f.outsider.id,
      expectedRevision: f.revision(otherCanvasId), position: { x: 720, y: 50 } }
    const sourceEvents = f.outsider.session.snapshotEvents()
    const opened = await f.invoke(request)
    expect(opened).toMatchObject({ isError: false, value: {
      ok: true, canvasId: otherCanvasId, nodeId: request.nodeId, sessionId: f.outsider.id, operationId: null, error: null,
    } })
    expect((await f.invoke(request)).value).toEqual(opened.value)
    expect(f.outsider.session.snapshotEvents()).toEqual(sourceEvents)
    expect(await f.invoke({ ...request, sessionId: f.owner.id, nodeId: 'unused-chat' })).toMatchObject({
      isError: false, value: { ok: true, canvasId, nodeId, sessionId: f.owner.id, operationId: null, revision: f.revision() },
    })
    expect(f.host.workspace().canvases.flatMap(canvas => canvas.nodes).some(node => node.id === 'unused-chat')).toBe(false)
    expect(await f.invoke({ ...request, sessionId: 'missing-session', nodeId: 'missing-chat', expectedRevision: f.revision(otherCanvasId) })).toMatchObject({
      isError: false, value: { ok: false, error: { code: 'not-found' } },
    })
  })

  it('rejects action overrides and cancelled calls before any native operation begins', async () => {
    const f = await fixture()
    const fork = { action: 'fork-thread', expectedRevision: f.revision(), operationId: 'invalid-fork', sourceSessionId: f.owner.id }
    for (const extra of [{ cwd: f.root }, { agentPreset: 'another-preset' }, { sessionId: f.owner.id }, { atSeq: -1 }]) {
      expect((await f.invoke({ ...fork, ...extra })).isError).toBe(true)
    }
    expect((await f.invoke({ action: 'open-session', expectedRevision: f.revision(), nodeId: 'new-chat', sessionId: f.outsider.id,
      operationId: 'not-a-placement-key', position: { x: 0, y: 0 } })).isError).toBe(true)
    const signal = AbortSignal.abort(new Error('Cancelled before submission'))
    expect((await f.invoke({ action: 'create-thread', expectedRevision: f.revision(), operationId: 'cancelled-thread' }, { signal })).isError).toBe(true)
    expect(f.host.repository.coordination.thread('cancelled-thread' as CanvasOperationId)).toBeUndefined()
    expect(f.host.repository.coordination.thread('invalid-fork' as CanvasOperationId)).toBeUndefined()
  })

  it('reports an unavailable native adapter and removes the tool with its owning Host', async () => {
    const f = await fixture()
    await f.nodesFiber.dispose()
    expect(await f.invoke({ action: 'create-thread', expectedRevision: f.revision(), operationId: 'unavailable' })).toMatchObject({
      isError: true, content: [{ text: expect.stringContaining('does not provide Chat Session coordination') as string }],
    })
    expect(f.ctx.tools.get('convax_chat')).toBeDefined()
    await f.fiber.dispose()
    expect(f.ctx.tools.get('convax_chat')).toBeUndefined()
    expect(f.ctx.agents.get(f.owner.id)).toBe(f.owner)
  })
})
