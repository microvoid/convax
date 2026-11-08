/** Bound identity uses real graph ownership and DSH's runtime-context registry. */
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import { afterEach, describe, expect, it } from 'vitest'
import { CanvasDatabase } from '../src/database.ts'
import { CanvasNodeRegistry } from '../src/registry.ts'
import { CanvasRepository } from '../src/repository.ts'
import { registerCanvasChatContext } from '../src/chat-context.ts'
import { registerDefaultNodes } from '../../plugin-inernal-nodes-host/src/definitions.ts'
import type { CanvasCommand, CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId } from '../src/types.ts'

const canvasId = 'context-canvas' as CanvasId
const nodeId = 'context-chat' as CanvasNodeId
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture(beforeDependencies = false) {
  const root = await mkdtemp(join(tmpdir(), 'convax-chat-context-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const sessionDirectory = join(root, '{{session-project}}')
  await mkdir(sessionDirectory)
  const domain = await CanvasDatabase.open({ path: join(root, 'canvas.sqlite') })
  const registry = new CanvasNodeRegistry((error) => { throw error })
  const repository = new CanvasRepository(domain, registry, (error) => { throw error })
  cleanup.push(async () => { repository.close(); await domain.close() })
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin({ name: 'context-node-provider', apply(scope: Context) {
    registerDefaultNodes(definition => scope.effect(() => registry.register(definition)))
  } })
  const mountContext = () => ctx.plugin({ name: 'bound-context', apply(scope: Context) { registerCanvasChatContext(scope, repository) } })
  const owner = beforeDependencies ? mountContext() : undefined
  if (owner !== undefined) await owner
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  const contextOwner = owner ?? mountContext()
  await contextOwner
  await contextOwner.await()
  const driver = await mountAgentLoopTestHarness(ctx)
  const agent = await driver.create(SessionId('bound-session'), {}, { cwd: sessionDirectory })
  const outsider = await driver.create(SessionId('unbound-session'), {}, { cwd: root })
  let operation = 0
  const revision = () => repository.snapshot().canvases.find(value => value.id === canvasId)?.revision ?? 0
  const execute = async (command: CanvasCommand) => {
    const result = await repository.execute({ canvasId, expectedRevision: revision(), operationId: `context-${++operation}` as CanvasOperationId, command })
    expect(result.ok).toBe(true)
  }
  await execute({ kind: 'create', title: 'Private canvas title' })
  await execute({ kind: 'add-node', node: { id: nodeId, typeId: 'convax.chat' as CanvasNodeTypeId, dataVersion: 1, revision: 0,
    data: { title: 'Private Chat title', cwd: root }, position: { x: 987, y: 654 } } })
  await repository.coordination.reserveThread({ kind: 'create', canvasId, nodeId, expectedRevision: revision(), operationId: 'context-binding' as CanvasOperationId }, root)
  expect(await repository.coordination.completeThread('context-binding' as CanvasOperationId, agent.id, 0)).toBe(true)
  const assembly = (target?: Agent) => ctx.systemPrompt.assemble(target === undefined ? {} : assembleContextFor(target))
  const text = async (target?: Agent) => (await assembly(target)).contexts.find(value => value.name === 'convax:chat')?.text ?? ''
  return { ctx, domain, repository, agent, outsider, contextOwner, root, sessionDirectory, revision, assembly, text }
}

describe('Convax Chat runtime context', () => {
  it('routes bound canvas work with Session identity and its own project directory', async () => {
    const f = await fixture()
    expect(await f.text(f.agent)).toBe([
      `Convax Chat identity: ${JSON.stringify({ canvasId, chatNodeId: nodeId, sessionId: f.agent.id, projectDirectory: f.sessionDirectory })}`,
      'For work involving the canvas, its resources, or Chat threads, load the `convax` skill when available. Convax tools default to this bound canvas, independently of the open tab.',
    ].join('\n'))
    expect(renderContextSnapshot(await f.assembly(f.agent))).toContain('{{session-project}}')
    expect(await f.text(f.agent)).not.toContain('Private canvas title')
    expect(await f.text(f.agent)).not.toContain('987')
    expect(await f.text(f.outsider)).toBe('')
    expect(await f.text()).toBe('')
  })

  it('clears a captured snapshot when deletion owns the bound Chat', async () => {
    const f = await fixture()
    const previous = await f.assembly(f.agent)
    expect(await f.text(f.agent)).not.toBe('')
    await f.repository.coordination.beginDeletion({ canvasId, expectedRevision: f.revision(), operationId: 'context-delete' as CanvasOperationId,
      command: { kind: 'remove-nodes', nodeIds: [nodeId] }, confirmed: true })
    expect(await f.text(f.agent)).toBe('')
    expect(renderContextSnapshot(f.ctx.systemPrompt.refreshContext(previous, assembleContextFor(f.agent)))).not.toContain('Convax Chat identity')
  })

  it('removes stale bound identity after its graph node is removed', async () => {
    const f = await fixture()
    await f.domain.transaction(tx => {
      const graph = tx.global.get()
      graph.canvases[0]!.nodes = []
      tx.global.set(graph)
    })
    expect(f.repository.bindingOf(f.agent.id)).toBeDefined()
    expect(await f.text(f.agent)).toBe('')
  })

  it('respects optional runtime-context suppression and removes registration with its owner', async () => {
    const f = await fixture(true)
    await expect.poll(() => f.text(f.agent)).not.toBe('')
    const restore = f.agent.ctx.systemPrompt.suppressRuntimeContext()
    try { expect(await f.text(f.agent)).toBe('') } finally { restore() }
    await f.contextOwner.dispose()
    expect((await f.assembly(f.agent)).contexts.some(value => value.name === 'convax:chat')).toBe(false)
  })
})
