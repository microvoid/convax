/** A snapshot-only Provider exposes capabilities but refuses every generation request. */
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-convax-plugin-creation-host'
import type { CanvasConnectionId, CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { ConnectionInspection, ProviderSnapshot } from '../../src/types.ts'
import { FixtureCreationProvider } from './provider.ts'

/** Fixture identity; loaded as an ordinary scenario patch in the shipped headless profile. */
export const name = 'creation-approval-context-fixture'
/** All graph, connection and Session changes retain their production service owners. */
export const inject = ['convax', 'convaxCreation', 'agents', 'tools']

class ContextProvider extends FixtureCreationProvider {
  override async describe(): Promise<ConnectionInspection> {
    const inspection = await super.describe()
    assert(inspection.state === 'ready')
    return { ...inspection, capabilities: inspection.capabilities.filter(capability => capability.kind === 'image') }
  }
  override async submit(): Promise<ProviderSnapshot> { throw new Error('This context snapshot must never start generation') }
}

/** Bind the actual headless recipient to a configured workbench without another Agent or entrypoint. */
export async function apply(ctx: Context): Promise<void> {
  const host = ctx.convax, creation = ctx.convaxCreation
  const provider = new ContextProvider()
  ctx.effect(() => creation.registerProvider(provider), 'Creation snapshot: isolated capability Provider')
  const canvasId = 'creation-context-canvas' as CanvasId
  const nodeId = 'creation-context-chat' as CanvasNodeId
  const workbenchId = 'creation-context-workbench' as CanvasNodeId
  const ref = { canvasId, nodeId: workbenchId }
  const revision = () => host.workspace().canvases.find(canvas => canvas.id === canvasId)?.revision ?? 0
  const execute = async (id: string, command: Parameters<typeof host.execute>[0]['command']) => {
    const result = await host.execute({ canvasId, expectedRevision: revision(), operationId: id as CanvasOperationId, command })
    assert(result.ok, JSON.stringify(result))
  }
  await execute('seed-canvas', { kind: 'create', title: 'Creation approval context' })
  for (const [id, typeId, data, x] of [
    [workbenchId, 'convax.creation', { title: 'Creation', routes: {} }, 0],
    [nodeId, 'convax.chat', { title: 'Creation Chat', cwd: process.cwd() }, 400],
  ] as const) await execute(`seed-${id}`, { kind: 'add-node', node: {
    id, typeId: typeId as CanvasNodeTypeId, dataVersion: 1, data, position: { x, y: 0 }, revision: 0,
  } })
  const connected = await creation.connectAndApply({ ref, expectedRevision: revision(), operationId: 'seed-connection' as CanvasOperationId,
    connection: { providerId: provider.descriptor.id, label: 'Snapshot images', settings: {} } })
  assert(connected.ok, JSON.stringify(connected))
  await execute('seed-capability', { kind: 'add-connection', connection: { id: 'creation-capability' as CanvasConnectionId,
    source: workbenchId, sourcePort: 'output', target: nodeId, targetPort: 'input', purpose: 'capability' } })
  ctx.on('agent/created', async ({ agent }) => {
    if (host.repository.bindingOf(agent.session.id) !== undefined) return undefined
    const operationId = 'seed-binding' as CanvasOperationId
    await host.repository.coordination.reserveThread({ kind: 'create', canvasId, nodeId,
      expectedRevision: revision(), operationId, cwd: process.cwd() }, process.cwd())
    assert(await host.repository.coordination.completeThread(operationId, agent.session.id, 0))
    const toolSet = await ctx.tools.resolve({ agent, signal: new AbortController().signal,
      modelSelection: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } })
    try {
      assert(ctx.tools.get('creation_describe', agent, toolSet))
      assert(ctx.tools.get('creation_generate', agent, toolSet))
      assert.equal(ctx.tools.get('creation_approve', agent, toolSet), undefined)
      assert.equal(ctx.tools.get('approveGeneration', agent, toolSet), undefined)
    } finally { toolSet.dispose() }
  })
}
