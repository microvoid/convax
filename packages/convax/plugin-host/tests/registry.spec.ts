/** Exact registrations own cancellation and drain work before removal completes. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { describe, expect, it, vi } from 'vitest'
import { CanvasNodeRegistry } from '../src/registry.ts'
import type { CanvasData, CanvasNodeTypeId } from '../src/types.ts'

const id = brandString<CanvasNodeTypeId>('example.node')
const definition = { id, dataVersion: 1, ports: [], parse: (data: CanvasData) => data }

describe('CanvasNodeRegistry', () => {
  it('removes an effect-owned registration and allows a fresh provider without inheriting its revision', async () => {
    const ctx = new Context()
    const registry = new CanvasNodeRegistry((error) => { throw error })
    const provider = ctx.plugin({ name: 'example-provider', apply(scope: Context) { scope.effect(() => registry.register(definition)) } })
    await provider
    try {
      expect(registry.list()).toEqual([{ id, dataVersion: 1, ports: [] }])
      const revision = registry.revisionOf(id)
      await provider.dispose()
      expect(registry.list()).toEqual([])
      expect(registry.revisionOf(id)).toBeGreaterThan(revision)
      const remove = registry.register(definition)
      expect(registry.revisionOf(id)).toBeGreaterThan(revision + 1)
      await remove()
    } finally { await ctx.fiber.dispose() }
  })

  it('aborts a removed registration synchronously and awaits its work on repeated disposal', async () => {
    const registry = new CanvasNodeRegistry((error) => { throw error })
    const remove = registry.register(definition)
    const entered = Promise.withResolvers<AbortSignal>()
    const finish = Promise.withResolvers<string>()
    const pending = registry.use(registry.get(id)!, new AbortController().signal, async (signal) => {
      entered.resolve(signal)
      return finish.promise
    })
    const observed = expect(pending).rejects.toThrow('was removed')
    try {
      const signal = await entered.promise
      const closing = remove()
      expect(remove()).toBe(closing)
      expect(signal.aborted).toBe(true)
      expect(registry.get(id)).toBeUndefined()
      finish.resolve('discard late value')
      await closing
      await observed
    } finally { finish.resolve('cleanup'); await remove() }
  })

  it('rejects duplicate active identities and invalid migration declarations before publication', async () => {
    const registry = new CanvasNodeRegistry((error) => { throw error })
    const remove = registry.register(definition)
    try { expect(() => registry.register(definition)).toThrow('already registered') } finally { await remove() }
    const migrate = () => ({})
    for (const migrations of [[{ fromVersion: 1, migrate }], [{ fromVersion: -1, migrate }],
      [{ fromVersion: 0, migrate }, { fromVersion: 0, migrate }]]) {
      expect(() => registry.register({ ...definition, migrations })).toThrow('invalid or duplicate')
      expect(registry.list()).toEqual([])
    }
  })

  it('contains observer failures after registration and removal without dropping other observers', async () => {
    const report = vi.fn()
    const registry = new CanvasNodeRegistry(report)
    const later = vi.fn()
    const first = registry.subscribe(() => { throw new Error('Observer failed') })
    const second = registry.subscribe(later)
    try {
      const remove = registry.register(definition)
      await remove()
      expect(later).toHaveBeenCalledTimes(2)
      expect(report).toHaveBeenCalledTimes(2)
    } finally { first(); second() }
  })
})
