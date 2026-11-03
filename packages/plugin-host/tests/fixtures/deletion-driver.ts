/** Exercise Convax deletion against real Agents, Workspace archives and Loader recovery. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-convax-plugin-host'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { bootProductionProfile } from '../../../../libs/dsh/packages/test-support/loader-smoke/tests/fixtures/production-profile.ts'

const [overlay, phase] = process.argv.slice(2)
if (overlay === undefined || (phase !== 'stop-failure' && phase !== 'recover')) throw new Error('Deletion fixture requires overlay and phase')
const statePath = join(process.cwd(), 'convax-deletion-state.json')
const canvasId = 'deletion-canvas' as CanvasId
const activeNode = 'active-chat' as CanvasNodeId
const failedNode = 'failed-chat' as CanvasNodeId
const entered = Promise.withResolvers<undefined>()
const release = Promise.withResolvers<undefined>()
const stopRequested = Promise.withResolvers<undefined>()
let activeId: SessionId | undefined
let failingId: SessionId | undefined
let stopCalls = 0
if (phase === 'recover') failingId = (JSON.parse(await readFile(statePath, 'utf8')) as { failingId: SessionId }).failingId
const ctx = await bootProductionProfile({
  binName: 'convax-deletion-loader-test', profile: 'web',
  overlayPaths: [fileURLToPath(new URL('../../../plugin-renderer/cordis.patch.yml', import.meta.url)), overlay],
  prepare(context) {
    provideCmdline(context, { args: ['--port', '0', '--no-open'], exit: (code) => { throw new Error(`Unexpected exit ${code}`) } })
    context.on('agent/pre-step', async ({ agent }, next) => {
      if (agent.id === activeId) { entered.resolve(undefined); await release.promise }
      return next()
    })
    context.on('workspace/session-stop', ({ sessionId }) => {
      if (sessionId === activeId) stopRequested.resolve(undefined)
      if (sessionId === failingId) {
        stopCalls++
        if (phase === 'stop-failure') throw new Error('Fixture stop owner refused cancellation')
      }
    })
    context.on('workspace/session-activity', async ({ sessionId }, next) => {
      const rest = await next()
      return phase === 'stop-failure' && sessionId === failingId ? [{ kind: 'turn' as const }, ...rest] : rest
    })
  },
})
try {
  await [...ctx.loader.entries()].find(entry => entry.options.id === 'convax-host')?.fiber?.await()
  const host = ctx.convax
  const revision = (): number => host.workspace().canvases.find(canvas => canvas.id === canvasId)?.revision ?? 0
  async function execute(id: string, command: Parameters<typeof host.execute>[0]['command']): Promise<void> {
    const result = await host.execute({ canvasId, operationId: id as CanvasOperationId, expectedRevision: revision(), command })
    assert(result.ok, JSON.stringify(result))
  }
  async function createChat(nodeId: CanvasNodeId): Promise<SessionId> {
    await execute(`add-${nodeId}`, { kind: 'add-node', node: {
      id: nodeId, typeId: 'convax.chat' as CanvasNodeTypeId, dataVersion: 1, revision: 0,
      data: { title: nodeId, cwd: process.cwd() }, position: { x: 0, y: 0 },
    } })
    const result = await host.createThread({ kind: 'create', canvasId, nodeId, operationId: `thread-${nodeId}` as CanvasOperationId, expectedRevision: revision() })
    assert(result.ok, JSON.stringify(result))
    return result.sessionId
  }
  let pendingIssue: string | null = null
  let waitedForIdle = false
  if (phase === 'stop-failure') {
    await execute('create-canvas', { kind: 'create', title: 'Deletion integration' })
    activeId = await createChat(activeNode)
    await ctx.sessionController.prompt({ sessionId: activeId, requestId: 'blocked-active-turn' as SessionRequestId,
      mode: 'queue', content: [{ type: 'text', text: 'This turn is stopped before any model request.' }] }, new AbortController().signal)
    await entered.promise
    const agent = ctx.agents.get(activeId)
    assert(agent !== undefined && agent.status === 'running')
    let completed = false
    const deleting = host.execute({ canvasId, operationId: 'delete-active' as CanvasOperationId, expectedRevision: revision(),
      command: { kind: 'remove-nodes', nodeIds: [activeNode] }, confirmed: true }).then((result) => { completed = true; return result })
    await stopRequested.promise
    assert(host.workspace().chats.find(chat => chat.nodeId === activeNode)?.deleting, 'graph deletion gate must precede stopping')
    assert.equal(completed, false, 'graph must remain while the real Agent is held inside pre-step')
    waitedForIdle = true
    release.resolve(undefined)
    const deleted = await deleting
    assert(deleted.ok, JSON.stringify(deleted))
    assert.equal(agent.status, 'idle')
    assert(!agent.session.snapshotEvents().some(event => event.type === 'step/start'), 'cancelled Agent must never enter a model request')
    assert(ctx.workspaceRegistry.archivedSessionIds.includes(activeId))
    failingId = await createChat(failedNode)
    await writeFile(statePath, JSON.stringify({ failingId }))
    const failed = await host.execute({ canvasId, operationId: 'delete-failed' as CanvasOperationId, expectedRevision: revision(),
      command: { kind: 'remove-nodes', nodeIds: [failedNode] }, confirmed: true })
    assert(!failed.ok && failed.code === 'operation-pending', JSON.stringify(failed))
    const chat = host.workspace().chats.find(chat => chat.nodeId === failedNode)
    assert(chat?.deleting && chat.issue !== null, 'failed stop must retain its visible deletion intention')
    pendingIssue = chat.issue
    assert(ctx.workspaceRegistry.archivedSessionIds.includes(failingId), 'failed stop must preserve archival')
    assert.equal(stopCalls, 1, 'fresh archival must request its stop exactly once')
  } else {
    await host.retryOperations()
    assert(stopCalls >= 1, 'activation recovery must retry stop for an already archived Session')
    assert(!host.workspace().chats.some(chat => chat.nodeId === failedNode), 'recovered deletion must remove its graph')
    assert(failingId !== undefined && ctx.workspaceRegistry.archivedSessionIds.includes(failingId))
  }
  const persisted = await ctx.sessionPersistence.list()
  assert.equal(persisted.length, 2, 'deletion retains both Session histories')
  await writeFile(join(process.cwd(), 'convax-deletion-report.json'), JSON.stringify({ phase, waitedForIdle, stopCalls, pendingIssue,
    remainingChats: host.workspace().chats.length, storedSessions: persisted.length, failingId,
    archived: ctx.workspaceRegistry.archivedSessionIds,
  }))
} finally {
  release.resolve(undefined)
  await ctx.fiber.dispose()
}
