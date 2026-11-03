/** Original Session placement through the production Loader preserves native logs and reminder bindings. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type {} from '@deepseek-ai/dsh-convax-plugin-host'
import type {} from '@deepseek-ai/dsh-schedule'
import type { CanvasId, CanvasNodeId, CanvasOpenSessionRequest, CanvasOperationId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { bootProductionProfile } from '../../../../libs/dsh/packages/test-support/loader-smoke/tests/fixtures/production-profile.ts'

const [overlay, phase] = process.argv.slice(2)
if (overlay === undefined || phase !== 'create' && phase !== 'reopen') throw new Error('Existing Session fixture requires an overlay and phase')
const ctx = await bootProductionProfile({
  binName: 'convax-open-session', profile: 'web',
  overlayPaths: [fileURLToPath(new URL('../../../plugin-renderer/cordis.patch.yml', import.meta.url)), overlay],
  prepare: (context) => { provideCmdline(context, { args: ['--port', '0', '--no-open'], exit: (code) => { throw new Error(`Unexpected exit ${code}`) } }) },
})
const statePath = join(process.cwd(), 'open-session-state.json')
try {
  const host = ctx.convax
  const hostRow = [...ctx.loader.entries()].find(entry => entry.options.id === 'convax-host')
  assert(hostRow?.fiber !== undefined)
  await hostRow.fiber.await()
  const sessionId = SessionId('original-automation-session')
  const canvasId = 'original-session-canvas' as CanvasId
  const nodeId = 'original-session-chat' as CanvasNodeId
  const request: CanvasOpenSessionRequest = { canvasId, nodeId, sessionId, expectedRevision: 1, position: { x: 120, y: 80 } }
  if (phase === 'create') {
    const source = ctx.sessions.create(sessionId, { meta: { cwd: process.cwd(), createdAt: 1 } })
    source.append('turn/start', { turn: 1 })
    source.append('deliverables/presented', { turn: 1, callId: 'old-delivery' as ToolCallId,
      files: [{ path: join(process.cwd(), 'previous.txt'), description: 'Previously delivered file' }] })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    {
      await using stored = await ctx.sessionPersistence.create(source.header)
      await stored.append([...source.ownEvents()])
      await stored.flush()
    }
    const workspace = await ctx.workspaceRegistry.create(process.cwd())
    await workspace.attachSession(sessionId)
    await ctx.schedule.create(sessionId, { title: 'Original automation', prompt: 'Retain this original Session', after_seconds: 86400 })
    assert((await host.execute({ canvasId, expectedRevision: 0, operationId: 'open-session-create-canvas' as CanvasOperationId,
      command: { kind: 'create', title: 'Original Sessions' } })).ok)
  }
  const schedules = await ctx.schedule.catalog()
  const membership = ctx.workspaceRegistry.list().map(workspace => ({ path: workspace.path, sessionIds: workspace.sessionIds }))
  using before = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none' })
  const events = [...before.events]
  const count = (await ctx.sessionPersistence.list()).length
  const placements = await Promise.all([
    host.openSession(request),
    host.openSession({ ...request, nodeId: 'redundant-location' as CanvasNodeId }),
  ])
  for (const result of placements) {
    assert(result.ok, JSON.stringify(result))
    assert.deepEqual({ canvasId: result.canvasId, nodeId: result.nodeId, sessionId: result.sessionId }, { canvasId, nodeId, sessionId })
  }
  await host.retryOperations()
  using after = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none' })
  assert.deepEqual([...after.events], events, 'opening the original Session cannot append or replay conversation events')
  assert.equal((await ctx.sessionPersistence.list()).length, count, 'opening a Session cannot create a replacement')
  assert.deepEqual(await ctx.schedule.catalog(), schedules, 'the reminder keeps its exact original Session and task record')
  assert.deepEqual(ctx.workspaceRegistry.list().map(workspace => ({ path: workspace.path, sessionIds: workspace.sessionIds })), membership)
  assert.equal(ctx.agents.get(sessionId), undefined, 'opening a cold Session must not start an Agent')
  assert.equal(host.workspace().chats.length, 1)
  assert.deepEqual(host.workspace().chats[0]?.threads.map(thread => thread.sessionId), [sessionId])
  const outputCount = host.workspace().canvases[0]?.nodes.filter(node => node.typeId === 'convax.file').length ?? -1
  assert.equal(outputCount, 0, 'opening an old Session does not import historical deliveries as new graph outputs')
  if (phase === 'create') await writeFile(statePath, JSON.stringify({ events, schedules, membership }))
  else {
    const original = JSON.parse(await readFile(statePath, 'utf8')) as { events: typeof events; schedules: typeof schedules; membership: typeof membership }
    assert.deepEqual(events, original.events)
    assert.deepEqual(schedules, original.schedules)
    assert.deepEqual(membership, original.membership)
  }
  await writeFile(join(process.cwd(), 'open-session-report.json'), JSON.stringify({ phase, sessionId, canvasId, nodeId,
    storedSessionCount: count, scheduleSessionId: schedules[0]?.sessionId, chatCount: host.workspace().chats.length, outputCount }))
} finally { await ctx.fiber.dispose() }
