/** Display ownership and user choices survive refreshes, competing windows and Host restarts. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ClientGuidanceItem, ClientGuidanceSnapshot, ClientPolicySnapshot } from '@convax/api-contracts/notices'
import { afterEach, describe, expect, it } from 'vitest'
import { NoticeCoordinator, type NoticeSource, type NoticeSourceResult } from '../src/notices/coordinator.ts'
import { NoticeFilePersistence } from '../src/notices/persistence.ts'
import type { NoticeClientId, NoticeCoordinatorConfig, NoticeDisplayContext } from '../src/notices/types.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

const config: NoticeCoordinatorConfig = {
  idleMs: 5000, pollIntervalMs: 5000, failureRetryMs: 60_000, leaseMs: 30_000,
  modalCooldownMs: 86_400_000, maxModalPerLaunch: 1, messageHoldMs: 10_000,
}
const available: NoticeDisplayContext = { available: true, busy: false, capabilities: ['cloud.chat.send', 'canvas.resources'] }
const start = Date.parse('2026-11-08T08:00:00Z')
const client = (): NoticeClientId => randomUUID() as NoticeClientId
const metadata = { schemaVersion: 1 as const, revision: '1', serverTime: new Date(start).toISOString(), nextCheckAfterSeconds: 1 }
const policy = (required = false): ClientPolicySnapshot => ({ ...metadata,
  update: required ? { required, minSupportedVersion: '0.2.0', targetVersion: '0.2.1', releaseId: 'convax-release' } : { required }, maintenance: [],
})
const item = (id = 'feature'): ClientGuidanceItem => ({
  id, revision: '1', kind: 'feature', surface: 'modal', startsAt: new Date(start - 1000).toISOString(),
  expiresAt: new Date(start + 10 * 86_400_000).toISOString(), requiresCapabilities: ['canvas.resources'],
  frequency: { scope: 'installation', maxImpressions: 1, cooldownSeconds: 0 },
  content: { title: 'Feature title', body: 'Feature description' }, actions: [{ id: 'close', label: 'Close', type: 'dismiss' }],
})
const guidance = (...items: ClientGuidanceItem[]): ClientGuidanceSnapshot => ({ ...metadata, items })

async function fixture(initial: NoticeSourceResult, overrides: Partial<NoticeCoordinatorConfig> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'convax-notices-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'notices.json')
  const clock = { value: start }
  let snapshot = initial
  let reads = 0
  const source: NoticeSource = { read: async () => { reads++; return snapshot }, dispose: () => {} }
  const open = (supplied: NoticeSource | undefined = source) => {
    const ctx = new Context()
    const coordinator = new NoticeCoordinator(ctx, {
      source: supplied, persistence: new NoticeFilePersistence(path), config: { ...config, ...overrides }, now: () => clock.value,
    })
    cleanups.push(async () => { await coordinator.dispose(); await ctx.fiber.dispose() })
    return coordinator
  }
  return { path, directory, clock, open, source, set: (value: NoticeSourceResult) => { snapshot = value }, reads: () => reads,
    read: async () => JSON.parse(await readFile(path, 'utf8')) as ReturnType<NoticeFilePersistence['load']> }
}

describe('Convax notice scheduling', () => {
  it('keeps an unconfigured source disabled without inventing notifications', async () => {
    const f = await fixture({})
    const ctx = new Context()
    const coordinator = new NoticeCoordinator(ctx, { persistence: new NoticeFilePersistence(f.path), config, now: () => start })
    cleanups.push(async () => { await coordinator.dispose(); await ctx.fiber.dispose() })
    expect(coordinator.configuration()).toEqual({ enabled: false, pollIntervalMs: 5000, idleMs: 5000 })
    expect(await coordinator.poll(client(), available)).toBeNull()
    expect(f.reads()).toBe(0)
  })

  it('coalesces a refresh and grants exactly one competing window before any exposure is counted', async () => {
    const f = await fixture({})
    let resolveRead!: (value: NoticeSourceResult) => void
    let reads = 0
    const source: NoticeSource = { read: () => { reads++; return new Promise((resolve) => { resolveRead = resolve }) }, dispose: () => {} }
    const coordinator = f.open(source)
    const first = client()
    const second = client()
    const pending = [coordinator.poll(first, available), coordinator.poll(second, available)]
    await Promise.resolve()
    expect(reads).toBe(1)
    resolveRead({ policy: policy(), guidance: guidance(item()) })
    const [firstView, secondView] = await Promise.all(pending)
    expect(firstView?.noticeId).toBe('feature')
    expect(secondView).toBeNull()
    expect((await f.read()).records).toEqual({})
    if (firstView === null || firstView === undefined) throw new Error('Expected an owned notice')
    expect(() => { coordinator.presented(second, firstView.id) }).toThrow('no longer owned')
    coordinator.release(second)
    expect((await coordinator.poll(first, available))?.id).toBe(firstView.id)
    coordinator.presented(first, firstView.id)
    coordinator.presented(first, firstView.id)
    expect((await f.read()).records['guidance:feature']?.impressions).toBe(1)
  })

  it('lets another window reclaim an expired unseen lease without losing the campaign', async () => {
    const f = await fixture({ guidance: guidance(item()) })
    const coordinator = f.open()
    const previous = await coordinator.poll(client(), available)
    f.clock.value += config.leaseMs
    const next = await coordinator.poll(client(), available)
    expect(next?.noticeId).toBe('feature')
    expect(next?.id).not.toBe(previous?.id)
    expect((await f.read()).records).toEqual({})
  })

  it('does not let another window revoke a lease using its own different capabilities', async () => {
    const f = await fixture({ guidance: guidance(item()) })
    const coordinator = f.open()
    const owner = client()
    const view = await coordinator.poll(owner, available)
    expect(await coordinator.poll(client(), { ...available, capabilities: [] })).toBeNull()
    expect((await coordinator.poll(owner, available))?.id).toBe(view?.id)
  })

  it('retains dismissal through content revisions and applies the global modal budget after a restart', async () => {
    const f = await fixture({ guidance: guidance(item()) })
    const id = client()
    const first = f.open()
    const shown = await first.poll(id, available)
    if (shown === null) throw new Error('Expected a notice')
    first.finish(id, shown.id, 'dismissed')
    await first.dispose()
    f.set({ guidance: guidance({ ...item(), revision: '2' }, item('other')) })
    f.clock.value += 2000
    const second = f.open()
    expect(await second.poll(client(), available)).toBeNull()
    f.clock.value += config.modalCooldownMs
    const secondClient = client()
    const next = await second.poll(secondClient, available)
    expect(next?.noticeId).toBe('other')
    if (next === null) throw new Error('Expected the next campaign')
    second.presented(secondClient, next.id)
    expect((await f.read()).records['guidance:feature']?.dismissed).toBe(true)
  })

  it('honors a configured snooze even after its first impression limit is reached', async () => {
    const upgraded: ClientGuidanceItem = { ...item(), kind: 'upgrade', releaseId: 'release', actions: [
      { id: 'later', label: 'Later', type: 'snooze', snoozeSeconds: 3600 },
    ] }
    const f = await fixture({ guidance: guidance(upgraded) }, { maxModalPerLaunch: 5, modalCooldownMs: 0 })
    const coordinator = f.open()
    const id = client()
    const shown = await coordinator.poll(id, available)
    if (shown === null) throw new Error('Expected upgrade notice')
    expect(() => { coordinator.finish(id, shown.id, 'snoozed') }).toThrow('configured snooze')
    coordinator.finish(id, shown.id, 'snoozed', 'later')
    expect(await coordinator.poll(id, available)).toBeNull()
    f.clock.value += 3_600_000
    expect((await coordinator.poll(id, available))?.noticeId).toBe('feature')
  })

  it('renders maintenance as a transient message and reminds again only for its next state', async () => {
    const maintenance = { id: 'cloud-chat', revision: '1', status: 'scheduled' as const,
      startsAt: new Date(start + 3600_000).toISOString(), estimatedEndsAt: null,
      affectedCapabilities: ['cloud.chat.send'], title: 'Maintenance', body: 'Cloud chat will be unavailable' }
    const f = await fixture({ policy: { ...policy(), maintenance: [maintenance] } })
    const coordinator = f.open()
    const id = client()
    const view = await coordinator.poll(id, available)
    expect(view).toMatchObject({ surface: 'message', kind: 'maintenance', holdMs: 10_000 })
    if (view === null) throw new Error('Expected maintenance message')
    coordinator.finish(id, view.id, 'expired')
    f.set({ policy: { ...policy(), maintenance: [{ ...maintenance, revision: '2' }] } })
    f.clock.value += 2000
    expect(await coordinator.poll(id, available)).toBeNull()
    f.set({ policy: { ...policy(), maintenance: [{ ...maintenance, status: 'active' }] } })
    f.clock.value += 2000
    expect((await coordinator.poll(id, available))?.noticeId).toBe('maintenance:cloud-chat:active')
  })

  it('preempts ordinary content for required updates and retains the restriction after a policy fetch fails', async () => {
    const f = await fixture({ policy: policy(), guidance: guidance(item()) })
    const coordinator = f.open()
    const id = client()
    expect((await coordinator.poll(id, available))?.kind).toBe('feature')
    f.set({ policy: policy(true) })
    f.clock.value += 2000
    const mandatory = await coordinator.poll(id, { ...available, busy: true })
    expect(mandatory).toMatchObject({ kind: 'mandatory-update', dismissible: false })
    if (mandatory === null) throw new Error('Expected required update')
    expect(() => { coordinator.finish(id, mandatory.id, 'dismissed') }).toThrow('cannot be dismissed')
    expect(() => { coordinator.finish(id, mandatory.id, 'expired') }).toThrow('cannot be dismissed')
    coordinator.presented(id, mandatory.id)
    coordinator.finish(id, mandatory.id, 'action', 'update')
    f.set({ guidance: guidance(item('new-feature')), errors: ['policy'] })
    f.clock.value += 2000
    expect((await coordinator.poll(id, available))?.id).toBe(mandatory.id)
    f.set({ policy: policy() })
    f.clock.value += 2000
    expect(await coordinator.poll(id, available)).toBeNull()
  })

  it('still offers a known required update to a new window after an unexpected source failure', async () => {
    const f = await fixture({})
    let fail = false
    const source: NoticeSource = { read: async () => {
      if (fail) throw new Error('source unavailable')
      return { policy: policy(true) }
    }, dispose: () => {} }
    const coordinator = f.open(source)
    const first = client()
    expect((await coordinator.poll(first, available))?.kind).toBe('mandatory-update')
    coordinator.release(first)
    fail = true
    f.clock.value += 2000
    expect((await coordinator.poll(client(), available))?.kind).toBe('mandatory-update')
  })

  it('waits for enabled capabilities and idle display conditions, and withdraws expired content', async () => {
    const f = await fixture({ guidance: guidance(item()) })
    const coordinator = f.open()
    const id = client()
    expect(await coordinator.poll(id, { ...available, available: false })).toBeNull()
    expect(await coordinator.poll(id, { ...available, busy: true })).toBeNull()
    expect(await coordinator.poll(id, { ...available, capabilities: [] })).toBeNull()
    expect((await coordinator.poll(id, available))?.kind).toBe('feature')
    f.clock.value += 11 * 86_400_000
    expect(await coordinator.poll(id, available)).toBeNull()
  })

  it('does not commit exposure when persistence fails and allows an owned retry', async () => {
    const f = await fixture({ guidance: guidance(item()) })
    const file = new NoticeFilePersistence(f.path)
    let rejectSave = true
    const ctx = new Context()
    const coordinator = new NoticeCoordinator(ctx, { source: f.source, config, now: () => f.clock.value,
      persistence: { load: () => file.load(), save: (history) => { if (rejectSave) throw new Error('disk failure'); file.save(history) } } })
    cleanups.push(async () => { await coordinator.dispose(); await ctx.fiber.dispose() })
    const id = client()
    const view = await coordinator.poll(id, available)
    if (view === null) throw new Error('Expected notice')
    expect(() => { coordinator.presented(id, view.id) }).toThrow('disk failure')
    expect((await f.read()).records).toEqual({})
    rejectSave = false
    coordinator.presented(id, view.id)
    expect((await f.read()).records['guidance:feature']?.impressions).toBe(1)
  })

  it('aborts and drains pending source work before disposal settles', async () => {
    const f = await fixture({})
    let aborted = false
    let disposed = false
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    const source: NoticeSource = { read: signal => new Promise((_, reject) => {
      signal?.addEventListener('abort', () => { aborted = true; reject(new Error('Source aborted')) }, { once: true })
      started()
    }), dispose: () => { disposed = true } }
    const coordinator = f.open(source)
    const polling = coordinator.poll(client(), available)
    const rejected = expect(polling).rejects.toThrow('disposed')
    await ready
    await coordinator.dispose()
    await rejected
    expect(aborted && disposed).toBe(true)
    await expect(coordinator.poll(client(), available)).rejects.toThrow('disposed')
  })
})

describe('Convax notice history files', () => {
  it('preserves a stable installation identity and rejects malformed history without rewriting it', async () => {
    const f = await fixture({})
    const file = new NoticeFilePersistence(f.path)
    const first = file.load()
    expect(file.load().installationId).toBe(first.installationId)
    const invalid = '{"version":99,"records":{}}'
    await writeFile(f.path, invalid)
    expect(() => file.load()).toThrow()
    expect(await readFile(f.path, 'utf8')).toBe(invalid)
    expect((await readdir(f.directory)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('rejects oversized history and leaves the preceding valid file intact on invalid saves', async () => {
    const f = await fixture({})
    const file = new NoticeFilePersistence(f.path)
    const history = file.load()
    const before = await readFile(f.path, 'utf8')
    expect(() => { file.save({ ...history, installationId: 'invalid' }) }).toThrow()
    expect(await readFile(f.path, 'utf8')).toBe(before)
    await writeFile(f.path, ' '.repeat(1024 * 1024 + 1))
    expect(() => file.load()).toThrow('size limit')
    expect((await readdir(f.directory)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })
})
