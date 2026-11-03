/** Crash-boundary recovery through the production Loader and native Session persistence. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-convax-plugin-host'
import type { CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId, CanvasThreadRequest } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { bootProductionProfile } from '../../../../libs/dsh/packages/test-support/loader-smoke/tests/fixtures/production-profile.ts'

const [overlay, phase] = process.argv.slice(2)
const home = process.env['DSH_HOME']
if (overlay === undefined || home === undefined || (phase !== 'create' && phase !== 'reopen')) throw new Error('Session recovery fixture requires an overlay, home and phase')
const canvasId = 'recovery-canvas' as CanvasId
const nodeId = 'recovery-chat' as CanvasNodeId
const statePath = join(process.cwd(), 'session-recovery-state.json')
const ctx = await bootProductionProfile({
  binName: 'convax-session-recovery', profile: 'web',
  overlayPaths: [fileURLToPath(new URL('../../../plugin-renderer/cordis.patch.yml', import.meta.url)), overlay],
  prepare: (context) => { provideCmdline(context, { args: ['--port', '0', '--no-open'], exit: (code) => { throw new Error(`Unexpected exit ${code}`) } }) },
})
try {
  const host = ctx.convax
  const revision = (): number => host.workspace().canvases.find(canvas => canvas.id === canvasId)?.revision ?? 0
  const execute = async (id: string, command: Parameters<typeof host.execute>[0]['command']): Promise<void> => {
    const result = await host.execute({ canvasId, operationId: id as CanvasOperationId, expectedRevision: revision(), command })
    assert(result.ok, JSON.stringify(result))
  }
  let createRequest: CanvasThreadRequest
  let forkRequest: CanvasThreadRequest
  let sourceId: SessionId
  let forkId: SessionId
  let prefixCount: number
  let seedTypes: string[]
  if (phase === 'create') {
    await execute('canvas', { kind: 'create', title: 'Recovery' })
    await execute('chat', { kind: 'add-node', node: {
      id: nodeId, typeId: 'convax.chat' as CanvasNodeTypeId, dataVersion: 1, revision: 0,
      data: { title: 'Recovery', cwd: process.cwd() }, position: { x: 0, y: 0 },
    } })
    createRequest = { kind: 'create', canvasId, nodeId, operationId: 'create-lost-binding' as CanvasOperationId, expectedRevision: revision() }
    const db = new DatabaseSync(join(home, 'storages', 'convax-canvas.sqlite'))
    try {
      db.exec("CREATE TRIGGER reject_binding BEFORE INSERT ON u_convax_bindings BEGIN SELECT RAISE(ABORT,'binding acknowledgement unavailable'); END")
      assert.equal((await host.createThread(createRequest)).ok, false)
      const intention = host.repository.coordination.thread(createRequest.operationId)
      assert.equal(intention?.phase, 'pending')
      assert.equal(intention?.session?.phase, 'completed')
      assert(intention?.session !== undefined)
      sourceId = intention.session.sessionId
      db.exec('DROP TRIGGER reject_binding')
    } finally { db.close() }
    assert.equal(ctx.agents.get(sourceId), undefined)
    const resolved = await ctx.sessionController.resolveAgent(sourceId)
    if ('error' in resolved) throw resolved.error
    const source = resolved.agent.session
    source.append('turn/start', { turn: 1 })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessions.flush(source)
    forkRequest = { kind: 'fork', canvasId, nodeId, operationId: 'fork-partial-prefix' as CanvasOperationId, expectedRevision: revision(), sourceSessionId: sourceId }
    const create = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
    const seed = buildForkSeed([...source.ownEvents()], SessionSeq(source.seq - 1))
    prefixCount = source.seq
    seedTypes = seed.map(event => event.type)
    ctx.sessionPersistence.create = async (header, options) => {
      await using handle = await create(header, options)
      await handle.append(seed)
      await handle.flush()
      throw new Error('Reply lost after atomic fork-seed publication')
    }
    try { assert.equal((await host.createThread(forkRequest)).ok, false) } finally { ctx.sessionPersistence.create = create }
    const fork = host.repository.coordination.thread(forkRequest.operationId)?.session
    assert(fork !== undefined)
    forkId = fork.sessionId
    assert.equal(fork.phase, 'reserved')
    assert.equal(fork.boundary, prefixCount - 1)
    source.append('turn/start', { turn: 2 })
    source.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await ctx.sessions.flush(source)
    const workspace = ctx.workspaceRegistry.list().find(value => value.sessionIds.includes(sourceId))
    assert(workspace !== undefined)
    await ctx.workspaceRegistry.delete(workspace.id)
    // Reproduce the two-ledger predecessor using the same native Session artifacts.
    const legacy = new DatabaseSync(join(home, 'storages', 'convax.sqlite'))
    const owned = new DatabaseSync(join(home, 'storages', 'convax-canvas.sqlite'))
    try {
      legacy.exec("CREATE TABLE units(name TEXT PRIMARY KEY,version INTEGER NOT NULL); INSERT INTO units VALUES('session_operations',1); CREATE TABLE u_session_operations_operations(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
      for (const request of [createRequest, forkRequest]) {
        const intention = host.repository.coordination.thread(request.operationId)
        assert(intention?.session !== undefined)
        const { session, ...intent } = intention
        const original = request.kind === 'create'
          ? { kind: request.kind, cwd: intent.cwd, ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }) }
          : { kind: request.kind, sessionId: request.sourceSessionId, ...(request.atSeq === undefined ? {} : { atSeq: request.atSeq }) }
        legacy.prepare('INSERT INTO u_session_operations_operations VALUES(?,?)').run(request.operationId, JSON.stringify({ request: original, ...session }))
        owned.prepare('UPDATE u_convax_thread_operations SET value=? WHERE key=?').run(JSON.stringify(intent), request.operationId)
      }
      owned.exec(`
        UPDATE units SET version=2 WHERE name='convax';
        DROP TABLE convax_migration_info;
        DROP TABLE u_convax_history;
        DROP TABLE u_convax_node_revisions;
        DROP TABLE u_convax_retired_connections;
        DROP TABLE u_convax_restorations;
        DROP TABLE u_convax_directories;
      `)
    } finally { owned.close(); legacy.close() }
    await writeFile(statePath, JSON.stringify({ sourceId, forkId, createRequest, forkRequest, prefixCount, seedTypes }))
  } else {
    const state = JSON.parse(await readFile(statePath, 'utf8')) as { sourceId: SessionId; forkId: SessionId; createRequest: CanvasThreadRequest; forkRequest: CanvasThreadRequest; prefixCount: number; seedTypes: string[] }
    ;({ sourceId, forkId, createRequest, forkRequest, prefixCount, seedTypes } = state)
    assert.equal(ctx.agents.get(sourceId), undefined, 'recovery must not activate completed Sessions')
    for (const [request, id] of [[createRequest, sourceId], [forkRequest, forkId]] as const) {
      const retry = await host.createThread(request)
      assert(retry.ok, JSON.stringify(retry))
      assert.equal(retry.sessionId, id)
    }
    assert(!ctx.workspaceRegistry.list().some(value => value.sessionIds.includes(sourceId)), 'completed materialization must not recreate removed Workspace membership')
    await using fork = await ctx.sessionPersistence.open(forkId, 'read')
    assert.equal(fork.inheritedEventCount, prefixCount)
    assert.deepEqual((await fork.read()).events.map(event => event.type), seedTypes)
    assert.equal((await ctx.sessionPersistence.list()).length, 2)
    const changed = await host.createThread({ ...createRequest, kind: 'create', cwd: join(process.cwd(), 'different') })
    assert.equal(changed.ok, false)
    if (!changed.ok) assert.equal(changed.code, 'invalid-command')
    assert.equal((await ctx.sessionPersistence.list()).length, 2)
  }
  await writeFile(join(process.cwd(), 'session-recovery-report.json'), JSON.stringify({ phase, sourceId, forkId, stored: (await ctx.sessionPersistence.list()).length }))
} finally { await ctx.fiber.dispose() }
