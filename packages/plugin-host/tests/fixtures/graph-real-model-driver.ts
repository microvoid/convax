/** A real model edits the durable graph while the Convax renderer is unloaded. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-convax-plugin-host'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type { CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { bootProductionProfile } from '../../../../libs/dsh/packages/test-support/loader-smoke/tests/fixtures/production-profile.ts'

const overlay = process.argv[2]
if (overlay === undefined) throw new Error('Graph model fixture requires a profile overlay')
const ctx = await bootProductionProfile({
  binName: 'convax-graph-model-test', profile: 'web',
  overlayPaths: [fileURLToPath(new URL('../../../plugin-renderer/cordis.patch.yml', import.meta.url)), overlay],
  prepare: (context) => { provideCmdline(context, {
    args: ['--port', '0', '--no-open'], exit: (code) => { throw new Error(`Unexpected exit ${code}`) },
  }) },
})
try {
  const entries = [...ctx.loader.entries()]
  const hostRow = entries.find(entry => entry.options.id === 'convax-host')
  const rendererRow = entries.find(entry => entry.options.id === 'convax-renderer')
  assert(hostRow !== undefined && rendererRow !== undefined)
  await hostRow.fiber?.await()
  const host = ctx.convax, hostFiber = hostRow.fiber
  const canvasId = 'model-graph' as CanvasId
  const chatId = 'model-chat' as CanvasNodeId
  const extensionId = 'model-extension' as CanvasNodeId
  const typeId = 'fixture.graph-note' as CanvasNodeTypeId
  ctx.effect(() => host.registerNodeType({
    id: typeId, dataVersion: 1, description: 'A graph note with a required label.',
    dataSchema: { type: 'object', required: ['label'], properties: { label: { type: 'string' } }, additionalProperties: false },
    ports: [{ id: 'input', direction: 'input', valueKind: 'resource' }, { id: 'output', direction: 'output', valueKind: 'resource' }],
    parse(data) {
      if (typeof data.label !== 'string') throw new Error('A graph-note label is required')
      return data
    },
  }))
  const revision = (): number => host.workspace().canvases.find(canvas => canvas.id === canvasId)?.revision ?? 0
  async function execute(operationId: string, command: Parameters<typeof host.execute>[0]['command']): Promise<void> {
    const result = await host.execute({ canvasId, operationId: operationId as CanvasOperationId, expectedRevision: revision(), command })
    assert(result.ok, JSON.stringify(result))
  }
  await execute('seed-canvas', { kind: 'create', title: 'Model graph tools' })
  await execute('seed-chat', { kind: 'add-node', node: {
    id: chatId, typeId: 'convax.chat' as CanvasNodeTypeId, dataVersion: 1, revision: 0,
    data: { title: 'Graph model', cwd: process.cwd() }, position: { x: 0, y: 0 },
  } })
  await execute('seed-extension', { kind: 'add-node', node: {
    id: extensionId, typeId, dataVersion: 1, revision: 0, data: { label: 'Keep this extension payload' }, position: { x: 0, y: 100 },
  } })
  const thread = await host.createThread({
    kind: 'create', canvasId, nodeId: chatId, expectedRevision: revision(), operationId: 'model-thread' as CanvasOperationId,
  })
  assert(thread.ok, JSON.stringify(thread))
  await rendererRow.update({ disabled: true })
  await ctx.loader.await()
  assert.equal(hostRow.fiber, hostFiber)
  const models = await ctx.llm.listModels('deepseek-official')
  const model = models.find(value => value.id === 'deepseek-chat') ?? models[0]
  assert(model !== undefined, 'The configured credential must advertise a usable model')
  await ctx.sessionController.selectModel({ sessionId: thread.sessionId, provider: 'deepseek-official', model: model.id })
  await ctx.sessionController.prompt({
    sessionId: thread.sessionId, requestId: 'model-graph-send' as SessionRequestId, mode: 'queue',
    content: [{ type: 'text', text: [
      'Use only convax_graph and convax_commit. Do not modify real files or create Sessions.',
      'First read the default canvas with include ["nodes","connections","nodeTypes"] and discover the fixture.graph-note schema.',
      'Submit exactly one ordered commit with operationId "model-batch" and the actual canvas revision:',
      `1. node.add model-file with typeId convax.file, dataVersion 1, data.path ${JSON.stringify(join(process.cwd(), 'input.txt'))}, position {x:500,y:200}.`,
      '2. edge.add model-link from model-file output to model-chat input, purpose input.',
      '3. node.set model-chat position {x:100,y:200}.',
      '4. node.set model-extension position {x:900,y:600}; retain its existing data.',
      '5. node.add model-note with typeId fixture.graph-note, dataVersion 1, data {label:"Created through generic commit"}, position {x:1200,y:600}.',
      '6. node.set model-note ifRevision 1, dataVersion 1, data {label:"Updated through generic commit"}.',
      '7. node.remove model-note.',
      '8. group.add model-group with title "References".',
      '9. node.set model-file groupId "model-group".',
      '10. node.set model-extension groupId "model-group".',
      '11. group.move model-group with delta {x:30,y:40}.',
      'Read the final default canvas with include ["nodes","connections","groups"] to verify it, then reply DONE.',
    ].join('\n') }],
  }, new AbortController().signal)
  const agent = ctx.agents.get(thread.sessionId)
  assert(agent !== undefined)
  await agent.whenIdle()
  await ctx.sessions.flush(agent.session)
  const names = agent.session.ownEvents().flatMap(event =>
    event.type === 'tool/call' || event.type === 'tool/ptc-dispatch' ? [event.data.name] : [])
  for (const name of ['convax_graph', 'convax_commit']) {
    assert(names.includes(name), `The real model did not call ${name}`)
  }
  const graph = host.workspace().canvases.find(canvas => canvas.id === canvasId)
  assert(graph !== undefined)
  assert.deepEqual(graph.nodes.find(node => node.id === chatId)?.position, { x: 100, y: 200 })
  assert.deepEqual(graph.nodes.find(node => node.id === 'model-file')?.position, { x: 530, y: 240 })
  assert.deepEqual(graph.nodes.find(node => node.id === extensionId)?.position, { x: 930, y: 640 })
  assert.deepEqual(graph.groups, [{ id: 'model-group', title: 'References' }])
  assert.equal(graph.nodes.find(node => node.id === 'model-file')?.groupId, 'model-group')
  assert.equal(graph.nodes.find(node => node.id === extensionId)?.groupId, 'model-group')
  assert.deepEqual(graph.nodes.find(node => node.id === extensionId)?.data, { label: 'Keep this extension payload' })
  assert.equal(graph.connections.find(edge => edge.id === 'model-link')?.target, chatId)
  assert(!graph.nodes.some(node => node.id === 'model-note'))
  assert.equal(graph.revision, 5)
  await writeFile(join(process.cwd(), 'graph-real-report.json'), JSON.stringify({ names, rendererDisabled: true, hostRetained: hostRow.fiber === hostFiber }))
} finally { await ctx.fiber.dispose() }
