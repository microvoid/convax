/** Exercise Chat coordination against the complete Web profile and real persistence. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-convax-plugin-host'
import type {} from '@deepseek-ai/dsh-tool-present/types'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId, CanvasThreadRequest } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { bootProductionProfile } from '../../../../libs/dsh/packages/test-support/loader-smoke/tests/fixtures/production-profile.ts'

const [overlay, phase] = process.argv.slice(2)
if (overlay === undefined || (phase !== 'create' && phase !== 'reopen')) throw new Error('Chat Loader fixture needs an overlay and phase')
const canvasId = 'chat-loader-canvas' as CanvasId
const nodeId = 'chat-loader-node' as CanvasNodeId
const reportPath = join(process.cwd(), 'convax-chat-report.json')
const statePath = join(process.cwd(), 'convax-chat-state.json')
const ctx = await bootProductionProfile({
  binName: 'convax-chat-loader-test', profile: 'web',
  overlayPaths: [fileURLToPath(new URL('../../../plugin-renderer/cordis.patch.yml', import.meta.url)), overlay],
  prepare: (context) => {
    provideCmdline(context, { args: ['--port', '0', '--no-open'], exit: (code) => { throw new Error(`Web startup requested exit ${code}`) } })
  },
})
try {
  const host = ctx.convax
  assert(host !== undefined, 'production Web profile must mount Convax Host')
  assert(ctx.sessionController !== undefined && ctx.workspaceRegistry !== undefined)
  const hostRow = [...ctx.loader.entries()].find(entry => entry.options.id === 'convax-host')
  const rendererRow = [...ctx.loader.entries()].find(entry => entry.options.id === 'convax-renderer')
  assert(hostRow?.fiber !== undefined && rendererRow?.fiber !== undefined)
  await hostRow.fiber.await()
  const hostFiber = hostRow.fiber
  let sourceId: SessionId
  let forkId: SessionId
  let createRequest: CanvasThreadRequest
  let forkRequest: CanvasThreadRequest
  const currentRevision = (): number => host.workspace().canvases.find(canvas => canvas.id === canvasId)?.revision ?? 0
  if (phase === 'create') {
    assert((await host.execute({ canvasId, operationId: 'chat-loader-create-canvas' as CanvasOperationId, expectedRevision: 0, command: { kind: 'create', title: 'Chat integration' } })).ok)
    assert((await host.execute({ canvasId, operationId: 'chat-loader-add-chat' as CanvasOperationId, expectedRevision: currentRevision(), command: { kind: 'add-node', node: {
      id: nodeId, typeId: 'convax.chat' as CanvasNodeTypeId, dataVersion: 1,
      data: { title: 'Integration Chat', cwd: process.cwd() }, position: { x: 0, y: 0 }, revision: 0,
    } } })).ok)
    createRequest = { kind: 'create', canvasId, nodeId, operationId: 'chat-loader-create-thread' as CanvasOperationId, expectedRevision: currentRevision(), cwd: process.cwd() }
    const created = await host.createThread(createRequest)
    assert(created.ok, JSON.stringify(created))
    sourceId = created.sessionId
    assert.equal(ctx.agents.get(sourceId), undefined, 'thread creation must leave its Agent cold')
    assert(ctx.workspaceRegistry.list().some(workspace => workspace.sessionIds.includes(sourceId)), 'cold thread must own a native workspace')
    const duplicate = await host.createThread(createRequest)
    assert(duplicate.ok)
    assert.equal(duplicate.sessionId, sourceId)
    const resolved = await ctx.sessionController.resolveAgent(sourceId)
    if ('error' in resolved) throw resolved.error
    const session = resolved.agent.session
    await rendererRow.update({ disabled: true })
    await ctx.loader.await()
    assert.equal(hostRow.fiber, hostFiber, 'renderer disposal must retain the delivery owner')
    session.append('turn/start', { turn: 1 })
    await writeFile(join(process.cwd(), 'result.txt'), 'Durable Chat delivery\n')
    session.append('deliverables/presented', { turn: 1, callId: 'chat-loader-present' as ToolCallId, files: [{ path: join(process.cwd(), 'result.txt'), description: 'Loader result' }] })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessions.flush(session)
    await host.retryOperations()
    const outputs = host.workspace().canvases[0]?.nodes.filter(node => node.typeId === 'convax.file')
    assert.equal(outputs?.length, 1, 'one presented file must produce one output node')
    forkRequest = { kind: 'fork', canvasId, nodeId, operationId: 'chat-loader-fork-thread' as CanvasOperationId, expectedRevision: currentRevision(), sourceSessionId: sourceId }
    const forked = await host.createThread(forkRequest)
    assert(forked.ok, JSON.stringify(forked))
    forkId = forked.sessionId
    assert(ctx.workspaceRegistry.list().some(workspace => workspace.sessionIds.includes(forkId)), 'cold fork must own a native workspace')
    assert.notEqual(forkId, sourceId)
    const forkBinding = host.workspace().chats.find(chat => chat.nodeId === nodeId)?.threads.find(thread => thread.sessionId === forkId)
    assert.equal(forkBinding?.inheritedEventCount, session.snapshotEvents().length)
    await host.retryOperations()
    assert.equal(host.workspace().canvases[0]?.nodes.filter(node => node.typeId === 'convax.file').length, 1, 'fork history must not re-deliver inherited files')
    await writeFile(statePath, JSON.stringify({ sourceId, forkId, createRequest, forkRequest, outputId: outputs?.[0]?.id }))
  } else {
    const stored = JSON.parse(await readFile(statePath, 'utf8')) as { sourceId: SessionId; forkId: SessionId; createRequest: CanvasThreadRequest; forkRequest: CanvasThreadRequest; outputId: CanvasNodeId }
    ;({ sourceId, forkId, createRequest, forkRequest } = stored)
    assert.equal(ctx.agents.get(sourceId), undefined, 'recovery must not activate a completed thread')
    const sourceRetry = await host.createThread(createRequest)
    const forkRetry = await host.createThread(forkRequest)
    assert(sourceRetry.ok && forkRetry.ok)
    assert.equal(sourceRetry.sessionId, sourceId)
    assert.equal(forkRetry.sessionId, forkId)
    await host.retryOperations()
    const outputs = host.workspace().canvases[0]?.nodes.filter(node => node.typeId === 'convax.file')
    assert.deepEqual(outputs?.map(node => node.id), [stored.outputId], 'reopen and replay must retain the original output identity')
  }
  const threadIds = host.workspace().chats.find(chat => chat.nodeId === nodeId)?.threads.map(thread => thread.sessionId)
  assert.deepEqual(threadIds, [sourceId, forkId])
  await rendererRow.update({ disabled: true })
  await ctx.loader.await()
  assert.equal(hostRow.fiber, hostFiber, 'renderer unload must preserve Host coordination')
  const beforeDeletion = host.workspace()
  const deletion = { canvasId, operationId: 'chat-loader-delete' as CanvasOperationId, expectedRevision: currentRevision(), command: { kind: 'remove-nodes' as const, nodeIds: [nodeId] }, confirmed: true }
  if (phase === 'reopen') {
    const refusal = await host.execute({ ...deletion, confirmed: false })
    assert(!refusal.ok && refusal.code === 'confirmation-required')
    const deleted = await host.execute(deletion)
    assert(deleted.ok, JSON.stringify(deleted))
    assert(!host.workspace().chats.some(chat => chat.nodeId === nodeId))
    assert(ctx.workspaceRegistry.archivedSessionIds.includes(sourceId))
    assert(ctx.workspaceRegistry.archivedSessionIds.includes(forkId))
    assert.equal((await ctx.sessionPersistence.list()).length, 2, 'deleting Chat retains its Session histories')
  }
  await writeFile(reportPath, JSON.stringify({ phase, sourceId, forkId, beforeDeletion,
    rendererDisabled: rendererRow.disabled, hostRetained: hostRow.fiber === hostFiber,
    storedSessionCount: (await ctx.sessionPersistence.list()).length,
    archived: ctx.workspaceRegistry.archivedSessionIds,
    remainingChats: host.workspace().chats.length,
  }))
} finally { await ctx.fiber.dispose() }
