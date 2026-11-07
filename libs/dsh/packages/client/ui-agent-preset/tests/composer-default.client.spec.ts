import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { AgentPresetSeatController } from '../src/client/seat-store.ts'
import { AgentPresetDefaultController } from '../src/client/default-store.ts'

function bench(options: { refuse?: boolean; failSave?: boolean; started?: boolean; current?: string } = {}) {
  const session: Pick<SessionSummary, 'id' | 'blank' | 'projectionValues'> = {
    id: SessionId('composer-default'), blank: !options.started,
    projectionValues: { agentPreset: options.current ?? 'standard' },
  }
  let saved = 'standard'
  const saveGate = Promise.withResolvers<undefined>()
  const saveStarted = Promise.withResolvers<undefined>()
  const select = vi.fn(async (_id: string, preset: string) => {
    if (options.refuse) return { ok: false, error: { message: 'Already started', details: {} } }
    session.projectionValues = { agentPreset: preset }
    return { ok: true, value: preset }
  })
  const update = vi.fn(async (_ns: string, value: { selectedDefault: string }) => {
    saveStarted.resolve(undefined)
    await saveGate.promise
    if (options.failSave) return { ok: false, error: { message: 'Disk full' } }
    saved = value.selectedDefault
    return { ok: true, value: {} }
  })
  const ctx = { remote: { settings: { update }, agentPresets: {
    select,
    list: async () => ({ ok: true, value: { presets: ['standard', 'ptc'].map(id => ({ id, isDefault: id === saved })) } }),
  } } } as unknown as Context
  const defaults = new AgentPresetDefaultController(ctx)
  const controller = new AgentPresetSeatController(ctx, () => session, undefined, defaults)
  return { controller, defaults, ctx, select, update, saveGate, saveStarted: saveStarted.promise, session }
}

describe('composer mode defaults', () => {
  it('waits for durable settings before completing a choice, and a fresh controller reads it', async () => {
    const b = bench()
    const pending = b.controller.selectDefault('ptc')
    await b.saveStarted
    expect(b.defaults.store.getSnapshot().saving).toBe(true)
    b.saveGate.resolve(undefined)
    expect(await pending).toEqual({ kind: 'applied' })
    const next = new AgentPresetSeatController(b.ctx, () => undefined)
    await next.load()
    expect(next.store.getSnapshot().current).toBe('ptc')
  })

  it('does not remember a refused switch or a started Session', async () => {
    for (const options of [{ refuse: true }, { started: true }]) {
      const b = bench(options)
      await b.controller.selectDefault('ptc')
      expect(b.update).not.toHaveBeenCalled()
    }
  })

  it('keeps an applied mode after a failed save and retries by choosing the same mode', async () => {
    const b = bench({ failSave: true })
    b.saveGate.resolve(undefined)
    await b.controller.selectDefault('ptc')
    expect(b.controller.store.getSnapshot()).toMatchObject({ current: 'ptc', busy: false })
    expect(b.defaults.store.getSnapshot()).toEqual({ error: 'Disk full', saving: false })
    await b.controller.selectDefault('ptc')
    expect(b.select).toHaveBeenCalledOnce()
    expect(b.update).toHaveBeenCalledTimes(2)
  })

  it('remembers a new Session mode only after creation succeeds', async () => {
    const b = bench({ started: true })
    b.saveGate.resolve(undefined)
    await expect(b.controller.startSession('ptc', async () => { throw new Error('Create failed') })).rejects.toThrow('Create failed')
    expect(b.update).not.toHaveBeenCalled()
    const create = vi.fn(async () => { expect(b.update).not.toHaveBeenCalled() })
    await b.controller.startSession('ptc', create)
    expect(create).toHaveBeenCalledWith('ptc')
    expect(b.update).toHaveBeenCalledWith('agent-preset-registry', { selectedDefault: 'ptc' }, undefined)
  })

  it('clears an old save error when a new creation fails before saving', async () => {
    const b = bench({ started: true })
    b.defaults.store.set({ saving: false, error: 'Old save failure' })
    await expect(b.controller.startSession('ptc', async () => { throw new Error('Create failed') })).rejects.toThrow('Create failed')
    expect(b.defaults.store.getSnapshot()).toEqual({ saving: false, error: null })
    expect(b.update).not.toHaveBeenCalled()
  })

  it('clears an old save error when the next mode switch is refused', async () => {
    const b = bench({ refuse: true })
    b.defaults.store.set({ saving: false, error: 'Old save failure' })
    await expect(b.controller.selectDefault('ptc')).resolves.toEqual({ kind: 'refused', reason: 'Already started' })
    expect(b.defaults.store.getSnapshot().error).toBeNull()
  })

  it.each(['selection', 'creation'] as const)('excludes a second composer throughout %s and its default write', async (operation) => {
    const b = bench()
    const other = new AgentPresetSeatController(b.ctx, () => ({
      id: SessionId('other-composer'), blank: true, projectionValues: { agentPreset: 'standard' },
    }), undefined, b.defaults)
    const gate = Promise.withResolvers<undefined>()
    const create = vi.fn(async () => { await gate.promise })
    if (operation === 'selection') b.select.mockImplementationOnce(async (_id, preset) => {
      await gate.promise
      b.session.projectionValues = { agentPreset: preset }
      return { ok: true, value: preset }
    })
    const pending = operation === 'selection'
      ? b.controller.selectDefault('ptc') : b.controller.startSession('ptc', create)
    const competingCreate = vi.fn(async () => {})
    try {
      expect(b.defaults.store.getSnapshot()).toEqual({ saving: true, error: null })
      await expect(other.selectDefault('standard')).resolves.toEqual({ kind: 'unchanged' })
      await expect(other.startSession('standard', competingCreate)).resolves.toBeUndefined()
      expect(competingCreate).not.toHaveBeenCalled()
      expect(b.select).toHaveBeenCalledTimes(operation === 'selection' ? 1 : 0)
      expect(b.update).not.toHaveBeenCalled()
      expect(b.defaults.store.getSnapshot()).toEqual({ saving: true, error: null })

      gate.resolve(undefined)
      await b.saveStarted
      await expect(other.selectDefault('standard')).resolves.toEqual({ kind: 'unchanged' })
      await expect(other.startSession('standard', competingCreate)).resolves.toBeUndefined()
      expect(competingCreate).not.toHaveBeenCalled()
      expect(b.update).toHaveBeenCalledExactlyOnceWith('agent-preset-registry', { selectedDefault: 'ptc' }, undefined)
      expect(b.defaults.store.getSnapshot().saving).toBe(true)

      b.saveGate.resolve(undefined)
      await pending
      expect(b.defaults.store.getSnapshot()).toEqual({ saving: false, error: null })
      await other.selectDefault('standard')
      expect(b.update).toHaveBeenCalledTimes(2)
      expect(b.update).toHaveBeenLastCalledWith('agent-preset-registry', { selectedDefault: 'standard' }, undefined)
    } finally {
      gate.resolve(undefined)
      b.saveGate.resolve(undefined)
      await pending
    }
  })

  it('retains a direct default-save failure and retries through the same shared owner', async () => {
    const b = bench()
    b.saveGate.resolve(undefined)
    b.update.mockRejectedValueOnce(new Error('Disconnected'))
    await b.defaults.save('ptc')
    expect(b.defaults.store.getSnapshot()).toEqual({ saving: false, error: 'Disconnected' })
    await b.defaults.save('ptc')
    expect(b.defaults.store.getSnapshot()).toEqual({ saving: false, error: null })
    expect(b.update).toHaveBeenCalledTimes(2)
  })
})
