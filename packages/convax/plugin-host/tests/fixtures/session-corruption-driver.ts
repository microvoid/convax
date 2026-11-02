/** Damaged inherited history stays pending under its reserved identity. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-convax-plugin-host'
import type { CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { bootProductionProfile } from '../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

const overlay = process.argv[2]
if (overlay === undefined) throw new Error('Corruption fixture requires its overlay')
const ctx = await bootProductionProfile({
  binName: 'convax-session-corruption', profile: 'web',
  overlayPaths: [fileURLToPath(new URL('../../../plugin-renderer/cordis.patch.yml', import.meta.url)), overlay],
  prepare: (context) => { provideCmdline(context, { args: ['--port', '0', '--no-open'], exit: (code) => { throw new Error(`Unexpected exit ${code}`) } }) },
})
try {
  const host = ctx.convax
  const canvasId = 'corrupt-canvas' as CanvasId
  const nodeId = 'corrupt-chat' as CanvasNodeId
  const revision = (): number => host.workspace().canvases[0]?.revision ?? 0
  const createCanvas = await host.execute({ canvasId, operationId: 'canvas' as CanvasOperationId, expectedRevision: 0, command: { kind: 'create', title: 'Corruption' } })
  assert(createCanvas.ok)
  const addChat = await host.execute({ canvasId, operationId: 'chat' as CanvasOperationId, expectedRevision: revision(), command: { kind: 'add-node', node: {
    id: nodeId, typeId: 'convax.chat' as CanvasNodeTypeId, dataVersion: 1, revision: 0,
    data: { title: 'Corruption', cwd: process.cwd() }, position: { x: 0, y: 0 },
  } } })
  assert(addChat.ok)
  const sourceThread = await host.createThread({ canvasId, nodeId, operationId: 'source' as CanvasOperationId, expectedRevision: revision(), kind: 'create' })
  assert(sourceThread.ok)
  const resolved = await ctx.sessionController.resolveAgent(sourceThread.sessionId)
  if ('error' in resolved) throw resolved.error
  const source = resolved.agent.session
  source.append('turn/start', { turn: 1 })
  source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await ctx.sessions.flush(source)
  const request = { canvasId, nodeId, operationId: 'damaged-fork' as CanvasOperationId,
    expectedRevision: revision(), kind: 'fork' as const, sourceSessionId: source.id }
  const seed = buildForkSeed([...source.ownEvents()], SessionSeq(source.seq - 1))
  const create = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
  // Deliberately violate first-batch publication to represent externally damaged data.
  ctx.sessionPersistence.create = async (header, options) => {
    await using handle = await create(header, options)
    await handle.append(seed.slice(0, 1))
    throw new Error('Fixture stored an incomplete inherited prefix')
  }
  try { assert.equal((await host.createThread(request)).ok, false) } finally { ctx.sessionPersistence.create = create }
  const original = host.repository.coordination.thread(request.operationId)?.session?.sessionId
  assert(original !== undefined)
  const retry = await host.createThread(request)
  assert.equal(retry.ok, false)
  assert.equal(host.repository.coordination.thread(request.operationId)?.session?.sessionId, original)
  assert.equal(host.repository.coordination.thread(request.operationId)?.phase, 'pending')
  assert.equal(host.workspace().chats[0]?.threads.length, 1)
  assert.equal((await ctx.sessionPersistence.list()).length, 2)
  await writeFile(join(process.cwd(), 'corruption-report.json'), JSON.stringify({ retained: true, stored: 2, bound: 1 }))
} finally { await ctx.fiber.dispose() }
