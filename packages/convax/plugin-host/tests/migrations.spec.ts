/** Provider upgrades preserve recoverable durable payloads across unload and restart. */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { CanvasRepository } from '../src/repository.ts'
import { CanvasNodeRegistry } from '../src/registry.ts'
import { CanvasMigrationCoordinator } from '../src/migrations.ts'
import { CanvasDatabase } from '../src/database.ts'
import type { CanvasNodeDefinition } from '../src/registry.ts'
import type { CanvasData, CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId } from '../src/types.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const canvasId = brandString<CanvasId>('canvas')
const nodeId = brandString<CanvasNodeId>('extension')
const typeId = brandString<CanvasNodeTypeId>('example.extension')
const signal = (): AbortSignal => new AbortController().signal
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function definition(dataVersion = 1): CanvasNodeDefinition {
  return { id: typeId, dataVersion, ports: [{ id: 'out', direction: 'output', valueKind: 'resource' }],
    parse(data) { if (typeof data.path !== 'string') throw new Error('path must be a string'); return data } }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'convax-upgrade-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const open = async () => {
    const domain = await CanvasDatabase.open({ path: join(root, 'canvas.sqlite') })
    const failures = vi.fn()
    const registry = new CanvasNodeRegistry(failures)
    const repository = new CanvasRepository(domain, registry, failures)
    const coordinator = new CanvasMigrationCoordinator(repository, failures)
    let closed = false
    const close = async () => {
      if (closed) return
      closed = true
      await coordinator.close()
      repository.close()
      await domain.close()
    }
    cleanup.push(close)
    return { domain, registry, repository, coordinator, failures, close }
  }
  const current = await open()
  const remove = current.registry.register(definition())
  await current.repository.execute({ canvasId, operationId: brandString<CanvasOperationId>('create'), expectedRevision: 0, command: { kind: 'create', title: 'Extensions' } })
  await current.repository.execute({ canvasId, operationId: brandString<CanvasOperationId>('add'), expectedRevision: 1, command: { kind: 'add-node', node: {
    id: nodeId, typeId, dataVersion: 1, data: { path: '/original.txt', retained: { original: true } },
    position: { x: 20, y: 30 }, revision: 0,
  } } })
  await remove()
  return { ...current, open, root }
}
function stored(f: Awaited<ReturnType<typeof fixture>>) {
  return f.repository.snapshot().canvases[0]!.nodes[0]!
}

describe('Convax provider upgrades', () => {
  it('opens the preceding repository generation only after retaining a complete recovery database', async () => {
    const f = await fixture()
    const original = f.repository.snapshot().canvases
    await f.close()
    // Remove tables introduced after version one so the fixture exercises the real upgrade path.
    const predecessor = new DatabaseSync(join(f.root, 'canvas.sqlite'))
    try {
      predecessor.exec("DROP TABLE u_convax_node_migrations; DROP TABLE convax_migration_info; DROP TABLE u_convax_history; DROP TABLE u_convax_node_revisions; DROP TABLE u_convax_retired_connections; DROP TABLE u_convax_restorations; DROP TABLE u_convax_directories; UPDATE units SET version = 1 WHERE name = 'convax'")
    } finally { predecessor.close() }
    const reopened = await f.open()
    expect(reopened.repository.snapshot().canvases).toEqual(original)
    expect([...reopened.domain.table('operations').entries()]).toHaveLength(2)
    expect([...reopened.domain.table('node_migrations').entries()]).toEqual([])
    expect([...reopened.domain.table('directories').entries()]).toEqual([])
    const directory = join(f.root, 'canvas.sqlite.upgrades')
    const copies = await readdir(directory)
    expect(copies).toHaveLength(1)
    const recovery = new DatabaseSync(join(directory, copies[0]!, 'database.sqlite'), { readOnly: true })
    try {
      expect(recovery.prepare("SELECT version FROM units WHERE name = 'convax'").get()?.['version']).toBe(1)
      const graph = recovery.prepare("SELECT value FROM unit_globals WHERE unit = 'convax'").get()?.['value']
      expect(typeof graph).toBe('string')
      expect(JSON.parse(String(graph))).toMatchObject({ canvases: original })
      expect(recovery.prepare("SELECT name FROM sqlite_master WHERE name = 'u_convax_node_migrations'").all()).toEqual([])
      expect(recovery.prepare("SELECT name FROM sqlite_master WHERE name = 'u_convax_directories'").all()).toEqual([])
    } finally { recovery.close() }
  })

  it('commits the original and validated successor together without altering geometry', async () => {
    const f = await fixture()
    const original = structuredClone(stored(f))
    f.registry.register({ ...definition(3), migrations: [
      { fromVersion: 1, migrate: data => ({ ...data, path: '/v2.txt' }) },
      { fromVersion: 2, migrate: data => ({ ...data, extra: 'v3' }) },
    ] })
    await f.coordinator.start()
    expect(stored(f)).toEqual({ ...original, dataVersion: 3, data: { ...original.data, path: '/v2.txt', extra: 'v3' }, revision: 2 })
    expect([...f.domain.table('node_migrations').entries()].map(([, copy]) => copy)).toEqual([{
      canvasId, nodeId, typeId, sourceVersion: 1, targetVersion: 3, sourceRevision: 1, resultRevision: 2,
      sourceData: original.data, resultData: stored(f).data,
    }])
    expect(f.repository.snapshot().nodeIssues).toEqual([])
    await f.close()
    const reopened = await f.open()
    expect(reopened.repository.snapshot().canvases[0]!.nodes[0]).toEqual({ ...original, dataVersion: 3, data: { ...original.data, path: '/v2.txt', extra: 'v3' }, revision: 2 })
    expect([...reopened.domain.table('node_migrations').entries()]).toHaveLength(1)
  })

  it.each(['missing', 'invalid', 'newer', 'throw'] as const)('retains original data and exposes %s migration failures', async (failure) => {
    const f = await fixture()
    const original = structuredClone(stored(f))
    f.registry.register({ ...definition(failure === 'newer' ? 0 : 2), migrations: failure === 'missing' || failure === 'newer' ? [] : [{
      fromVersion: 1, migrate(data) {
        data.retained = 'mutated isolated copy'
        if (failure === 'throw') throw new Error('Provider transform failed')
        return { ...data, path: 42 }
      },
    }] })
    await f.coordinator.start()
    expect(stored(f)).toEqual(original)
    expect([...f.domain.table('node_migrations').entries()]).toEqual([])
    expect(f.repository.snapshot().nodeIssues).toEqual([expect.objectContaining({ nodeId, kind: 'incompatible' })])
    expect(f.failures).not.toHaveBeenCalled()
  })

  it('cancels and drains a removed provider before a late transform can commit, then recovers after restart', async () => {
    const f = await fixture()
    const entered = deferred<AbortSignal>()
    const finish = deferred<CanvasData>()
    const original = structuredClone(stored(f))
    const remove = f.registry.register({ ...definition(2), migrations: [{ fromVersion: 1, migrate(_data, activeSignal) {
      entered.resolve(activeSignal)
      return finish.promise
    } }] })
    const ready = f.coordinator.start()
    const activeSignal = await entered.promise
    const closing = remove()
    expect(activeSignal.aborted).toBe(true)
    let drained = false
    void closing.then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    finish.resolve({ path: '/late.txt' })
    await closing
    await ready
    expect(stored(f)).toEqual(original)
    expect(f.repository.snapshot().nodeIssues).toEqual([])
    expect([...f.domain.table('node_migrations').entries()]).toEqual([])
    await f.close()
    const reopened = await f.open()
    reopened.registry.register({ ...definition(2), migrations: [{ fromVersion: 1, migrate: data => ({ ...data, path: '/recovered.txt' }) }] })
    await reopened.coordinator.start()
    expect(reopened.repository.snapshot().canvases[0]!.nodes[0]!.data.path).toBe('/recovered.txt')
    expect([...reopened.domain.table('node_migrations').entries()]).toHaveLength(1)
  })

  it('rechecks the complete source node before committing asynchronous provider output', async () => {
    const f = await fixture()
    const entered = deferred<undefined>()
    const finish = deferred<CanvasData>()
    const migrate = vi.fn(async (data: CanvasData) => {
      if (migrate.mock.calls.length === 1) { entered.resolve(undefined); return finish.promise }
      return { ...data, path: '/current.txt' }
    })
    f.registry.register({ ...definition(2), migrations: [{ fromVersion: 1, migrate }] })
    const ready = f.coordinator.start()
    await entered.promise
    const result = await f.repository.execute({ canvasId, operationId: brandString<CanvasOperationId>('move'), expectedRevision: 2,
      command: { kind: 'move-nodes', nodes: [{ id: nodeId, position: { x: 70, y: 90 } }] } })
    expect(result.ok).toBe(true)
    finish.resolve({ path: '/stale.txt' })
    await ready
    expect(stored(f)).toMatchObject({ dataVersion: 2, data: { path: '/current.txt' }, position: { x: 70, y: 90 } })
    expect([...f.domain.table('node_migrations').entries()]).toHaveLength(1)
    expect(migrate).toHaveBeenCalledTimes(2)
  })

  it('uses exact provider registration identities when committing a previously validated result', async () => {
    const f = await fixture()
    const remove = f.registry.register(definition(2))
    const previous = f.registry.get(typeId)!
    const original = structuredClone(stored(f))
    await remove()
    f.registry.register(definition(2))
    expect(await f.repository.commitMigration(canvasId, original, previous, { path: '/stale.txt' }, signal())).toBe(false)
    expect(stored(f)).toEqual(original)
  })
})
