// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { CanvasNodeTypeId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { ConvaxRenderer } from '../src/client/node-renderers.tsx'

async function fixture() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  const renderer = new ConvaxRenderer(ctx)
  return { ctx, renderer }
}

describe('public node contributions', () => {
  it('keeps third-party geometry, creation entries and action ownership scoped to their plugin', async () => {
    const { ctx, renderer } = await fixture()
    const changed = vi.fn()
    const unsubscribe = renderer.subscribe(changed)
    const create = vi.fn()
    const fiber = ctx.plugin({
      inject: ['convaxRenderer'],
      apply(scope) {
        scope.effect(() => scope.convaxRenderer.registerNodeRenderer('acme.board' as CanvasNodeTypeId, {
          dataVersion: 1, component: () => null, defaultSize: { width: 420, height: 260 }, dragHandle: '[data-board-heading]',
        }))
        scope.effect(() => scope.convaxRenderer.registerCreation({ id: 'acme.board', label: 'New board',
          defaultSize: { width: 420, height: 260 }, create }))
      },
    })
    await fiber.await()
    expect(renderer.getSnapshot().definitions['acme.board']).toMatchObject({ defaultSize: { width: 420, height: 260 }, dragHandle: '[data-board-heading]' })
    expect(renderer.getSnapshot().creations.map(entry => entry.id)).toEqual(['acme.board'])
    const snapshot = renderer.getSnapshot()
    expect(renderer.getSnapshot()).toBe(snapshot)
    expect(changed).toHaveBeenCalled()
    await fiber.dispose()
    expect(renderer.getSnapshot().definitions).toEqual({})
    expect(renderer.getSnapshot().creations).toEqual([])
    unsubscribe()
  })

  it('does not let disposal of an old owner remove a replacement contribution', async () => {
    const { renderer } = await fixture()
    const remove = renderer.registerCreation({ id: 'new', label: 'New', create: () => {} })
    expect(() => renderer.registerCreation({ id: 'new', label: 'Duplicate', create: () => {} })).toThrow('already registered')
    remove()
    const replacement = renderer.registerCreation({ id: 'new', label: 'Replacement', create: () => {} })
    remove()
    expect(renderer.getSnapshot().creations[0]?.label).toBe('Replacement')
    replacement()
    expect(renderer.getSnapshot().creations).toEqual([])
  })
})
