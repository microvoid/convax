/** Verify a real model consumes an explicit native path reference and declares a projected output. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-convax-plugin-host'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type { CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasConnectionId, CanvasOperationId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { bootProductionProfile } from '../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

const overlay = process.argv[2]
if (overlay === undefined) throw new Error('Real Chat model fixture requires a profile overlay')
const ctx = await bootProductionProfile({
  binName: 'convax-chat-model-test', profile: 'web',
  overlayPaths: [fileURLToPath(new URL('../../../plugin-renderer/cordis.patch.yml', import.meta.url)), overlay],
  prepare: (context) => { provideCmdline(context, { args: ['--port', '0', '--no-open'], exit: (code) => { throw new Error(`Unexpected exit ${code}`) } }) },
})
try {
  await [...ctx.loader.entries()].find(entry => entry.options.id === 'convax-host')?.fiber?.await()
  const host = ctx.convax
  const canvasId = 'real-model-canvas' as CanvasId
  const nodeId = 'real-model-chat' as CanvasNodeId
  const inputId = 'real-model-input' as CanvasNodeId
  const revision = (): number => host.workspace().canvases.find(value => value.id === canvasId)?.revision ?? 0
  async function execute(operationId: string, command: Parameters<typeof host.execute>[0]['command']): Promise<void> {
    const result = await host.execute({ canvasId, operationId: operationId as CanvasOperationId, expectedRevision: revision(), command })
    assert(result.ok, JSON.stringify(result))
  }
  await execute('canvas', { kind: 'create', title: 'Real Chat delivery' })
  await execute('input', { kind: 'add-node', node: {
    id: inputId, typeId: 'convax.file' as CanvasNodeTypeId, dataVersion: 1, revision: 0,
    data: { path: join(process.cwd(), 'source', 'input.txt') }, position: { x: 0, y: 0 },
  } })
  await execute('chat', { kind: 'add-node', node: {
    id: nodeId, typeId: 'convax.chat' as CanvasNodeTypeId, dataVersion: 1, revision: 0,
    data: { title: 'Real model', cwd: join(process.cwd(), 'work') }, position: { x: 360, y: 0 },
  } })
  await execute('connect', { kind: 'add-connection', connection: {
    id: 'real-model-connection' as CanvasConnectionId, source: inputId, sourcePort: 'output', target: nodeId, targetPort: 'input', purpose: 'input',
  } })
  const thread = await host.createThread({ canvasId, nodeId, operationId: 'real-thread' as CanvasOperationId, expectedRevision: revision(), kind: 'create' })
  assert(thread.ok, JSON.stringify(thread))
  const models = await ctx.llm.listModels('deepseek-official')
  const model = models.find(value => value.id === 'deepseek-chat') ?? models[0]
  assert(model !== undefined, 'The configured DeepSeek credential must advertise a usable model')
  await ctx.sessionController.selectModel({ sessionId: thread.sessionId, provider: 'deepseek-official', model: model.id })
  await ctx.sessionController.prompt({
    sessionId: thread.sessionId, requestId: 'real-chat-send' as SessionRequestId, mode: 'queue',
    content: [{ type: 'text', text: `Read @"${join(process.cwd(), 'source', 'input.txt')}". Copy its complete contents into result.txt in your current working directory. Read result.txt to verify it, then call present with that file as the final deliverable. Do not create any other files. Reply briefly.` }],
  }, new AbortController().signal)
  const agent = ctx.agents.get(thread.sessionId)
  assert(agent !== undefined)
  await agent.whenIdle()
  await ctx.sessions.flush(agent.session)
  await host.retryOperations()
  const output = join(process.cwd(), 'work', 'result.txt')
  assert.equal(await readFile(output, 'utf8'), 'value=from-connected-input\n')
  const snapshot = host.workspace()
  const deliveries = snapshot.canvases[0]?.connections.filter(value => value.purpose === 'delivery') ?? []
  assert.equal(deliveries.length, 1)
  const target = snapshot.canvases[0]?.nodes.find(value => value.id === deliveries[0]?.target)
  assert.equal(target?.data.path, output)
  const suffix = agent.session.ownEvents().find(event => event.type === 'user/message')
  assert(suffix?.type === 'user/message')
  assert.equal(suffix.data.content.length, 1)
  assert(suffix.data.content.some(block => block.type === 'text' && block.text.includes(join(process.cwd(), 'source', 'input.txt'))))
  await writeFile(join(process.cwd(), 'convax-real-report.json'), JSON.stringify({ sessionId: thread.sessionId, output, deliveryCount: deliveries.length }))
} finally { await ctx.fiber.dispose() }
