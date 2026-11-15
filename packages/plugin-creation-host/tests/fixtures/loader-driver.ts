/** Real Loader, native tool executor and native delivery projection with a test-only Provider. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-convax-plugin-creation-host'
import type {} from '@deepseek-ai/dsh-tool-present/types'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId, CanvasConnectionId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { JobId } from '../../src/types.ts'
import { bootProductionProfile } from '../../../../libs/dsh/packages/test-support/loader-smoke/tests/fixtures/production-profile.ts'
import { FixtureCreationProvider } from './provider.ts'

const [overlay, phase] = process.argv.slice(2)
if (overlay === undefined || (phase !== 'create' && phase !== 'reopen')) throw new Error('Creation fixture needs overlay and phase')
const ctx = await bootProductionProfile({ binName: 'convax-creation-loader-test', profile: 'web',
  overlayPaths: [fileURLToPath(new URL('../../../plugin-renderer/cordis.patch.yml', import.meta.url)), overlay],
  prepare: (context) => { provideCmdline(context, { args: ['--port', '0', '--no-open'], exit: (code) => { throw new Error(`Unexpected exit ${code}`) } }) },
})
try {
  const host = ctx.convax, creation = ctx.convaxCreation
  assert(host !== undefined && creation !== undefined, 'built-in Creation Host must mount through the production overlay')
  const rows = [...ctx.loader.entries()]
  const creationRow = rows.find(row => row.options.id === 'convax-creation-host')
  const rendererRow = rows.find(row => row.options.id === 'convax-creation-renderer')
  assert(creationRow?.fiber !== undefined && rendererRow?.fiber !== undefined)
  const creationFiber = creationRow.fiber
  const provider = new FixtureCreationProvider()
  ctx.effect(() => creation.registerProvider(provider))
  const canvasId = 'creation-canvas' as CanvasId, chatId = 'creation-chat' as CanvasNodeId, workbenchId = 'creation-workbench' as CanvasNodeId
  const ref = { canvasId, nodeId: workbenchId }
  const graph = () => host.workspace().canvases.find(canvas => canvas.id === canvasId)!
  const revision = () => graph()?.revision ?? 0
  const execute = async (id: string, command: Parameters<typeof host.execute>[0]['command']) => {
    const result = await host.execute({ canvasId, operationId: id as CanvasOperationId, expectedRevision: revision(), command })
    assert(result.ok, JSON.stringify(result))
  }
  const outputNodes = () => graph().nodes.filter(node => node.typeId === 'convax.file')
  const statePath = join(process.cwd(), 'creation-state.json')
  let sourceId: SessionId, nextThreadId: SessionId, jobs: JobId[]
  if (phase === 'create') {
    await execute('canvas', { kind: 'create', title: 'Creation integration' })
    for (const [id, typeId, data, x] of [
      [workbenchId, 'convax.creation', { title: 'Creation', routes: {} }, 0],
      [chatId, 'convax.chat', { title: 'Native Chat', cwd: process.cwd() }, 400],
      ['plain-chat' as CanvasNodeId, 'convax.chat', { title: 'Ordinary Chat', cwd: process.cwd() }, 800],
    ] as const) await execute(`add-${id}`, { kind: 'add-node', node: { id, typeId: typeId as CanvasNodeTypeId,
      dataVersion: 1, data, position: { x, y: 0 }, revision: 0 } })
    const connection = await creation.saveConnection({ ref, connection: { providerId: provider.descriptor.id, label: 'Local fixture', settings: {} } })
    const configured = await creation.configureWorkbench({ ref, expectedRevision: revision(), operationId: 'configure' as CanvasOperationId,
      data: { title: 'Creation', routes: { image: { connectionId: connection.id }, video: { connectionId: connection.id }, audio: { connectionId: connection.id } } } })
    assert(configured.ok, JSON.stringify(configured))
    await execute('connect', { kind: 'add-connection', connection: { id: 'capability' as CanvasConnectionId,
      source: workbenchId, sourcePort: 'output', target: chatId, targetPort: 'input', purpose: 'capability' } })
    const createThread = async (nodeId: CanvasNodeId, operationId: string) => {
      const result = await host.createThread({ canvasId, nodeId, kind: 'create', agentPreset: 'standard',
        expectedRevision: revision(), operationId: operationId as CanvasOperationId })
      assert(result.ok, JSON.stringify(result)); return result.sessionId
    }
    sourceId = await createThread(chatId, 'source-thread')
    const plainId = await createThread('plain-chat' as CanvasNodeId, 'plain-thread')
    const source = await ctx.sessionController.resolveAgent(sourceId), plain = await ctx.sessionController.resolveAgent(plainId)
    if ('error' in source) throw source.error
    if ('error' in plain) throw plain.error
    const signal = new AbortController().signal, modelSelection = { provider: 'fixture', model: 'fixture' }
    const plainTools = await ctx.tools.resolve({ agent: plain.agent, signal, modelSelection })
    assert.equal(ctx.tools.get('creation_generate', plain.agent, plainTools), undefined, 'ordinary Chats must not inherit Creation tools')
    plainTools.dispose()
    const agent = source.agent
    agent.session.append('turn/start', { turn: 1 })
    const toolSet = await ctx.tools.resolve({ agent, signal, modelSelection })
    assert(ctx.tools.get('creation_generate', agent, toolSet), 'connected Chat must inherit workbench tools')
    const described = await ctx.tools.execute({ agent, toolSet, signal, log: { turn: 1, step: 1 },
      calls: [{ type: 'tool-call', id: ToolCallId('describe'), name: 'creation_describe', arguments: '{}' }] })
    const description = described.results[0]?.result
    assert(description !== undefined && !description.isError, JSON.stringify(description))
    const capabilities = (description.value as { capabilities: Array<{ capability: { kind: string } }> }).capabilities
    assert.deepEqual(capabilities.map(value => value.capability.kind).sort(), ['audio', 'image', 'video'])
    const collecting = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    provider.beforeCollect = async (runtime) => {
      if (provider.collections === 3) collecting.resolve(undefined)
      const abort = () => { release.resolve(undefined) }
      runtime.signal.addEventListener('abort', abort, { once: true })
      try { await release.promise } finally { runtime.signal.removeEventListener('abort', abort) }
    }
    let step = 1
    const invoke = async (kind: string, prompt = `Create ${kind}`) => {
      const batch = await ctx.tools.execute({ agent, toolSet, signal, log: { turn: 1, step: ++step },
        calls: [{ type: 'tool-call', id: ToolCallId(`generate-${kind}`), name: 'creation_generate', arguments: JSON.stringify({ kind, prompt }) }] })
      const result = batch.results[0]?.result
      assert(result !== undefined)
      return result
    }
    jobs = []
    for (const kind of ['image', 'video', 'audio']) {
      const result = await invoke(kind)
      assert(!result.isError, JSON.stringify(result))
      const value = result.value as { jobId: JobId }
      jobs.push(value.jobId)
      if (kind === 'image') {
        const repeated = await invoke(kind)
        assert(!repeated.isError)
        assert.deepEqual(repeated.value, result.value, 'same invocation returns the same durable job')
        assert((await invoke(kind, 'A different request')).isError, 'same invocation cannot silently change a paid request')
      }
    }
    toolSet.dispose()
    await collecting.promise
    assert.equal(provider.submissions, 3)
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessions.flush(agent.session)
    nextThreadId = await createThread(chatId, 'next-thread')
    assert.notEqual(nextThreadId, sourceId)
    assert.equal(outputNodes().length, 0, 'barrier holds outputs until the Chat has another Thread')
    await rendererRow.update({ disabled: true })
    await ctx.loader.await()
    assert.equal(creationRow.fiber, creationFiber, 'renderer lifetime must not own background jobs')
    const projected = new Promise<void>((resolve) => {
      const unsubscribe = host.repository.subscribe(() => { if (outputNodes().length === 3) { unsubscribe(); resolve() } })
    })
    const completed = new Promise<void>((resolve, reject) => {
      const check = async () => {
        const statuses = await Promise.all(jobs.map(jobId => creation.getJob(jobId,
          { sessionId: sourceId, turn: 1, callId: ToolCallId('status') })))
        if (statuses.every(status => status.state === 'completed')) { unsubscribe(); resolve() }
      }
      const unsubscribe = ctx.on('domain/changed', (change) => {
        if (change.domain === 'convax_creation') void check().catch(reject)
      })
      void check().catch(reject)
    })
    release.resolve(undefined)
    await Promise.all([projected, completed])
    for (const jobId of jobs) {
      const status = await creation.getJob(jobId, { sessionId: sourceId, turn: 1, callId: ToolCallId('status') })
      assert.equal(status.outputs[0]?.delivery, 'published')
    }
    const deliveries = agent.session.ownEvents().filter(event => event.type === 'deliverables/presented')
    assert.equal(deliveries.length, 3)
    assert.deepEqual(deliveries.map(event => event.data.callId).sort(), ['generate-audio', 'generate-image', 'generate-video'])
    assert(deliveries.every(event => event.data.turn === 1 && event.data.deliveryKey?.startsWith('creation:')))
    assert.equal(ctx.agents.get(nextThreadId), undefined, 'background results cannot load the newly selected Thread')
    const secondCollecting = Promise.withResolvers<undefined>()
    provider.beforeCollect = (runtime) => {
      secondCollecting.resolve(undefined)
      return new Promise<void>((resolve) => {
        if (runtime.signal.aborted) resolve()
        else runtime.signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }
    agent.session.append('turn/start', { turn: 2 })
    const secondTools = await ctx.tools.resolve({ agent, signal, modelSelection })
    const secondBatch = await ctx.tools.execute({ agent, toolSet: secondTools, signal, log: { turn: 2, step: 1 },
      calls: [{ type: 'tool-call', id: ToolCallId('generate-image'), name: 'creation_generate',
        arguments: JSON.stringify({ kind: 'image', prompt: 'Another image in a later turn' }) }] })
    secondTools.dispose()
    const secondResult = secondBatch.results[0]?.result
    assert(secondResult !== undefined && !secondResult.isError, JSON.stringify(secondResult))
    const secondJob = (secondResult.value as { jobId: JobId }).jobId
    assert.notEqual(secondJob, jobs[0], 'a repeated call ID in a new turn is a distinct paid request')
    await secondCollecting.promise
    await creation.cancelJob(secondJob, { sessionId: sourceId, turn: 2, callId: ToolCallId('cancel-second-image') })
    agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await ctx.sessions.flush(agent.session)
    await writeFile(statePath, JSON.stringify({ sourceId, nextThreadId, jobs, outputs: outputNodes().map(node => node.id) }))
  } else {
    const saved = JSON.parse(await readFile(statePath, 'utf8')) as { sourceId: SessionId; nextThreadId: SessionId; jobs: JobId[]; outputs: CanvasNodeId[] }
    ;({ sourceId, nextThreadId, jobs } = saved)
    assert.equal(ctx.agents.get(sourceId), undefined)
    assert.equal(ctx.agents.get(nextThreadId), undefined)
    await host.retryOperations()
    assert.deepEqual(outputNodes().map(node => node.id), saved.outputs, 'cold recovery must not duplicate existing media nodes')
    assert.equal(provider.submissions, 0)
    assert.equal(provider.reconciliations, 0)
  }
  const deliveries = graph().connections.filter(edge => edge.purpose === 'delivery')
  assert.equal(deliveries.length, 3)
  assert(deliveries.every(edge => edge.source === chatId && outputNodes().some(node => node.id === edge.target)))
  assert.deepEqual(outputNodes().map((node) => {
    assert(typeof node.data.path === 'string')
    return node.data.path.split('.').at(-1)
  }).sort(), ['mp4', 'png', 'wav'])
  assert.equal(graph().nodes.filter(node => node.typeId === 'convax.creation').length, 1)
  assert.equal(graph().nodes.filter(node => node.typeId === 'convax.chat').length, 2)
  await writeFile(join(process.cwd(), 'creation-report.json'), JSON.stringify({ phase, mediaCount: outputNodes().length,
    deliveryEdges: deliveries.length, submissions: provider.submissions, sourceId, nextThreadId, jobs,
    nativeNodes: true, inheritedTools: true, originalInvocation: true, rendererIndependent: true }))
} finally { await ctx.fiber.dispose() }
