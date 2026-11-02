/** Seed one bound Chat while the production Host owns every model-requested graph mutation. */
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-convax-plugin-host'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId } from '@deepseek-ai/dsh-convax-plugin-host/types'

/** Scenario-owned fixture identity. */
export const name = 'convax-graph-tools-fixture'
/** The real Host and Agent creation lifecycle provide all scenario setup. */
export const inject = ['convax', 'agents']

/**
 * Seed a Chat and bind the actual headless recipient without driving another Session.
 * @param ctx - Loader-owned fixture lifetime.
 */
export async function apply(ctx: Context): Promise<void> {
  const canvasId = brandString<CanvasId>('graph-canvas')
  const nodeId = brandString<CanvasNodeId>('graph-chat')
  const repository = ctx.convax.repository
  const created = await ctx.convax.execute({
    canvasId, expectedRevision: 0, operationId: brandString<CanvasOperationId>('seed-canvas'),
    command: { kind: 'create', title: 'Graph tools' },
  })
  assert(created.ok, JSON.stringify(created))
  const chat = await ctx.convax.execute({
    canvasId, expectedRevision: 1, operationId: brandString<CanvasOperationId>('seed-chat'),
    command: { kind: 'add-node', node: {
      id: nodeId, typeId: brandString<CanvasNodeTypeId>('convax.chat'), dataVersion: 1,
      data: { title: 'Graph Chat', cwd: process.cwd() }, position: { x: 0, y: 0 }, revision: 0,
    } },
  })
  assert(chat.ok, JSON.stringify(chat))
  ctx.on('agent/created', async ({ agent }) => {
    if (repository.bindingOf(agent.session.id) !== undefined) return undefined
    const operationId = brandString<CanvasOperationId>('seed-binding')
    await repository.coordination.reserveThread({
      kind: 'create', canvasId, nodeId, expectedRevision: 2, operationId, cwd: process.cwd(),
    }, process.cwd())
    assert(await repository.coordination.completeThread(operationId, agent.session.id, 0))
  })
}
