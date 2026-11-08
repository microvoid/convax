/** Convax owns transaction durability and imports preceding stores without rewriting them. */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CanvasDatabase } from '../src/database.ts'
import { canvasTables, CANVAS_SCHEMA_VERSION } from '../src/schema.ts'
import type { CanvasId, CanvasOperationId } from '../src/types.ts'

const historyTables = ['history', 'node_revisions', 'retired_connections', 'restorations'] as const

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'convax-owned-store-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'convax-canvas.sqlite')
  const legacyPath = join(root, 'convax.sqlite')
  const open = async () => {
    const database = await CanvasDatabase.open({ path, legacyPath })
    cleanups.push(() => database.close())
    return database
  }
  return { path, legacyPath, open }
}

function legacy(path: string, version = 2) {
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE units(name TEXT PRIMARY KEY,version INTEGER NOT NULL); CREATE TABLE unit_globals(unit TEXT PRIMARY KEY,value TEXT NOT NULL)')
  db.prepare("INSERT INTO units VALUES('convax',?)").run(version)
  db.prepare("INSERT INTO unit_globals VALUES('convax',?)").run(JSON.stringify({ revision: 4, canvases: [] }))
  for (const name of Object.keys(canvasTables)) {
    if (version === 1 && name === 'node_migrations') continue
    if (version < 7 && name === 'directories') continue
    if (version < 4 && historyTables.some(table => table === name)) continue
    db.exec(`CREATE TABLE u_convax_${name}(key TEXT PRIMARY KEY,value TEXT NOT NULL)`)
  }
  db.prepare('INSERT INTO u_convax_operations VALUES(?,?)').run('imported', JSON.stringify({
    request: JSON.stringify({ canvasId: 'canvas', expectedRevision: 0, operationId: 'imported', command: { kind: 'create', title: 'Saved' } }), revision: 4,
  }))
  db.exec("CREATE TABLE u_session_operations_operations(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO u_session_operations_operations VALUES('pending','{\"phase\":\"reserved\"}')")
  db.close()
}

describe('Convax-owned database', () => {
  it('refuses a predecessor still owned by an older Host and imports only after its lease is released', async () => {
    const f = await fixture()
    legacy(f.legacyPath)
    const writer = new DatabaseSync(`${f.legacyPath}.writer-lock`)
    writer.exec('PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE')
    try { await expect(f.open()).rejects.toMatchObject({ code: 'storage-in-use' }) } finally { writer.close() }
    expect((await f.open()).global.get().revision).toBe(4)
  })

  it('refuses the same owned and predecessor path before changing its existing records', async () => {
    const f = await fixture()
    legacy(f.legacyPath)
    const original = await readFile(f.legacyPath)
    await expect(CanvasDatabase.open({ path: f.legacyPath, legacyPath: f.legacyPath })).rejects.toMatchObject({ code: 'invalid-record' })
    expect(await readFile(f.legacyPath)).toEqual(original)
  })

  it('merges fixed predecessor Session reservations into the matching thread intention exactly once', async () => {
    const f = await fixture()
    legacy(f.legacyPath)
    const db = new DatabaseSync(f.legacyPath)
    const request = { canvasId: 'canvas', nodeId: 'chat', operationId: 'thread', expectedRevision: 2, kind: 'create', agentPreset: 'standard' }
    try {
      db.exec("INSERT INTO units VALUES('session_operations',1); DELETE FROM u_session_operations_operations")
      db.prepare('INSERT INTO u_convax_thread_operations VALUES(?,?)').run('thread', JSON.stringify({
        request: JSON.stringify(request), canvasId: 'canvas', nodeId: 'chat', cwd: '/project', phase: 'pending',
        sessionId: null, parentSessionId: null, inheritedEventCount: 0, error: 'reply lost',
      }))
      db.prepare('INSERT INTO u_session_operations_operations VALUES(?,?)').run('thread', JSON.stringify({
        request: { kind: 'create', cwd: '/project', agentPreset: 'standard' }, phase: 'completed',
        sessionId: 'fixed-thread', createdAt: 42, cwd: '/project', agentPreset: 'standard',
      }))
      db.prepare('INSERT INTO u_session_operations_operations VALUES(?,?)').run('unmatched', JSON.stringify({
        request: { kind: 'create', cwd: '/other' }, phase: 'reserved', sessionId: 'unmatched-thread', createdAt: 43, cwd: '/other',
      }))
    } finally { db.close() }
    const original = await readFile(f.legacyPath)
    const owned = await f.open()
    expect(owned.table('thread_operations').get('thread' as CanvasOperationId)).toMatchObject({
      phase: 'pending', sessionId: null, session: { phase: 'completed', sessionId: 'fixed-thread', createdAt: 42, cwd: '/project', agentPreset: 'standard' },
    })
    expect(owned.migrationWarnings).toEqual([expect.stringContaining('unmatched')])
    expect(owned.table('thread_operations').size).toBe(1)
    await owned.close()
    expect(await readFile(f.legacyPath)).toEqual(original)
    const reopened = await f.open()
    expect(reopened.table('thread_operations').get('thread' as CanvasOperationId)?.session?.sessionId).toBe('fixed-thread')
    expect(reopened.migrationWarnings).toEqual(owned.migrationWarnings)
  })

  it('upgrades an owned version-two store with predecessor reservations and keeps a pre-upgrade copy', async () => {
    const f = await fixture()
    const owned = await f.open()
    const request = { canvasId: 'canvas', nodeId: 'chat', operationId: 'pending', expectedRevision: 2, kind: 'fork', sourceSessionId: 'source' }
    await owned.table('thread_operations').put('pending' as CanvasOperationId, {
      request: JSON.stringify(request), canvasId: 'canvas' as import('../src/types.ts').CanvasId,
      nodeId: 'chat' as import('../src/types.ts').CanvasNodeId, cwd: '/project', phase: 'pending',
      sessionId: null, parentSessionId: 'source' as import('@deepseek-ai/dsh-session').SessionId, inheritedEventCount: 0, error: null,
    })
    await owned.close()
    const previous = new DatabaseSync(f.path)
    try {
      previous.exec("UPDATE units SET version=2 WHERE name='convax'; DROP TABLE convax_migration_info; DROP TABLE u_convax_directories")
      for (const table of historyTables) previous.exec(`DROP TABLE u_convax_${table}`)
    } finally { previous.close() }
    legacy(f.legacyPath)
    const predecessor = new DatabaseSync(f.legacyPath)
    try {
      predecessor.exec("INSERT INTO units VALUES('session_operations',1); DELETE FROM u_session_operations_operations")
      predecessor.prepare('INSERT INTO u_session_operations_operations VALUES(?,?)').run('pending', JSON.stringify({
        request: { kind: 'fork', sessionId: 'source' }, phase: 'reserved', sessionId: 'fixed-fork', createdAt: 42, cwd: '/source', boundary: 7,
      }))
    } finally { predecessor.close() }
    const upgraded = await f.open()
    expect(upgraded.table('thread_operations').get('pending' as CanvasOperationId)?.session).toMatchObject({ sessionId: 'fixed-fork', boundary: 7, phase: 'reserved' })
    expect(await readdir(`${f.path}.upgrades`)).toHaveLength(1)
  })

  it.each([1, 2, 3])('upgrades a real version-%i store while preserving its graph, receipts, migration report, and backup generation', async (version) => {
    const f = await fixture()
    legacy(f.path, version)
    const previous = new DatabaseSync(f.path)
    const graph = { revision: 8, canvases: [{ id: 'saved-canvas', title: 'Saved files', revision: 3, connections: [], nodes: [{
      id: 'saved-node', typeId: 'custom.resource', revision: 2, dataVersion: 7,
      position: { x: 50, y: -20 }, data: { path: '/project/notes.txt', custom: ['retained'] },
    }] }] }
    try {
      previous.prepare("UPDATE unit_globals SET value=? WHERE unit='convax'").run(JSON.stringify(graph))
      if (version === 3) {
        previous.exec('CREATE TABLE convax_migration_info(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT')
        previous.prepare('INSERT INTO convax_migration_info VALUES(?,?)').run('session_operations', JSON.stringify(['prior-unmatched']))
      }
      for (const table of historyTables) {
        expect(previous.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(`u_convax_${table}`)).toBeUndefined()
      }
    } finally { previous.close() }
    const upgraded = await f.open()
    expect(upgraded.global.get()).toEqual(graph)
    expect(upgraded.table('operations').get('imported' as CanvasOperationId)?.revision).toBe(4)
    for (const table of historyTables) expect(upgraded.table(table).size).toBe(0)
    expect(upgraded.migrationWarnings).toEqual(version === 3 ? [expect.stringContaining('prior-unmatched')] : [])
    await upgraded.close()
    const copies = await readdir(`${f.path}.upgrades`)
    expect(copies).toHaveLength(1)
    const backup = new DatabaseSync(join(`${f.path}.upgrades`, copies[0]!, 'database.sqlite'), { readOnly: true })
    try {
      expect(backup.prepare("SELECT version FROM units WHERE name='convax'").get()?.['version']).toBe(version)
      expect(JSON.parse(String(backup.prepare("SELECT value FROM unit_globals WHERE unit='convax'").get()?.['value']))).toEqual(graph)
      for (const table of historyTables) {
        expect(backup.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(`u_convax_${table}`)).toBeUndefined()
      }
      if (version === 3) expect(backup.prepare("SELECT value FROM convax_migration_info WHERE key='session_operations'").get()?.['value'])
        .toBe(JSON.stringify(['prior-unmatched']))
    } finally { backup.close() }
    const reopened = await f.open()
    expect(reopened.global.get()).toEqual(graph)
    expect(await readdir(`${f.path}.upgrades`)).toEqual(copies)
    expect(reopened.migrationWarnings).toEqual(upgraded.migrationWarnings)
  })

  it.each([4, 5, 6, 7, 8, 9])('upgrades version %i without rewriting graphs or history and preserves the complete previous database', async (version) => {
    const f = await fixture()
    const owned = await f.open()
    await owned.close()
    const previous = new DatabaseSync(f.path)
    const graph = { revision: 8, canvases: [{ id: 'saved-canvas', title: 'Saved', revision: 3,
      nodes: version === 9 ? [{ id: 'saved-node', typeId: 'fixture.note', dataVersion: 1, data: {},
        position: { x: 10, y: 20 }, groupId: 'saved-group', revision: 1 }] : [], connections: [],
      ...(version === 9 ? { groups: [{ id: 'saved-group', title: 'Research' }] } : {}),
    }] }
    const history = { canvasId: 'saved-canvas', delta: { title: { before: 'Original', after: 'Saved' }, nodes: [], connections: [],
      ...(version === 9 ? { groups: [{ kind: 'updated', groupId: 'saved-group', title: { before: 'References', after: 'Research' } }] } : {}),
    },
    applied: true, restoreSessions: [] }
    try {
      previous.prepare("UPDATE units SET version=? WHERE name='convax'").run(version)
      if (version < 7) previous.exec('DROP TABLE u_convax_directories')
      else previous.prepare('INSERT INTO u_convax_directories VALUES(?,?)').run('saved-canvas', JSON.stringify({ path: '/saved/project' }))
      previous.prepare("UPDATE unit_globals SET value=? WHERE unit='convax'").run(JSON.stringify(graph))
      previous.prepare('INSERT INTO u_convax_history VALUES(?,?)').run('rename', JSON.stringify(history))
    } finally { previous.close() }
    const upgraded = await f.open()
    expect(upgraded.global.get()).toEqual(graph)
    expect(upgraded.table('history').get('rename' as CanvasOperationId)).toEqual(history)
    expect(upgraded.table('directories').size).toBe(version < 7 ? 0 : 1)
    if (version >= 7) expect(upgraded.table('directories').get('saved-canvas' as CanvasId)).toEqual({ path: '/saved/project' })
    const copies = await readdir(`${f.path}.upgrades`)
    expect(copies).toHaveLength(1)
    const saved = new DatabaseSync(join(`${f.path}.upgrades`, copies[0]!, 'database.sqlite'), { readOnly: true })
    try {
      expect(saved.prepare("SELECT version FROM units WHERE name='convax'").get()?.['version']).toBe(version)
      expect(saved.prepare("SELECT value FROM unit_globals WHERE unit='convax'").get()?.['value']).toBe(JSON.stringify(graph))
      expect(saved.prepare("SELECT value FROM u_convax_history WHERE key='rename'").get()?.['value']).toBe(JSON.stringify(history))
    } finally { saved.close() }
    await upgraded.close()
    const current = new DatabaseSync(f.path, { readOnly: true })
    try { expect(current.prepare("SELECT version FROM units WHERE name='convax'").get()?.['version']).toBe(CANVAS_SCHEMA_VERSION) } finally { current.close() }
    expect((await f.open()).global.get()).toEqual(graph)
    expect(await readdir(`${f.path}.upgrades`)).toEqual(copies)
  })

  it.each([2, 8, 9])('imports a validated version %i legacy graph once, preserves its ledger, and reopens its own later commits', async (version) => {
    const f = await fixture()
    legacy(f.legacyPath, version)
    const original = await readFile(f.legacyPath)
    const database = await f.open()
    expect(database.global.get()).toEqual({ revision: 4, canvases: [] })
    expect(database.table('operations').get('imported' as CanvasOperationId)).toMatchObject({ revision: 4 })
    await database.global.set({ revision: 5, canvases: [] })
    await database.close()
    expect(await readFile(f.legacyPath)).toEqual(original)
    const reopened = await f.open()
    expect(reopened.global.get()).toEqual({ revision: 5, canvases: [] })
    const old = new DatabaseSync(f.legacyPath, { readOnly: true })
    try { expect(old.prepare('SELECT key FROM u_session_operations_operations').get()?.['key']).toBe('pending') }
    finally { old.close() }
  })

  it('commits graph and operation receipt together, and rolls both back when the mutation fails', async () => {
    const f = await fixture()
    const database = await f.open()
    const id = 'receipt' as CanvasOperationId
    await expect(database.transaction((tx) => {
      tx.global.set({ revision: 1, canvases: [] })
      tx.table('operations').put(id, { request: JSON.stringify({ canvasId: 'canvas', expectedRevision: 0, operationId: id, command: { kind: 'create', title: 'Saved' } }), revision: 1 })
      expect(tx.table('operations').size).toBe(1)
      throw new Error('mutation rejected')
    })).rejects.toThrow('mutation rejected')
    expect(database.global.get()).toEqual({ revision: 0, canvases: [] })
    expect(database.table('operations').get(id)).toBeUndefined()
    await Promise.all([1, 2].map(() => database.transaction((tx) => {
      tx.global.set({ ...tx.global.get(), revision: tx.global.get().revision + 1 })
    })))
    await database.close()
    expect((await f.open()).global.get().revision).toBe(2)
  })

  it('holds one kernel-managed writer until queued work and close complete', async () => {
    const f = await fixture()
    const database = await f.open()
    await expect(f.open()).rejects.toMatchObject({ code: 'storage-in-use' })
    const write = database.global.set({ revision: 1, canvases: [] })
    const close = database.close()
    await expect(database.global.set({ revision: 2, canvases: [] })).rejects.toMatchObject({ code: 'closed' })
    await write
    await close
    expect((await f.open()).global.get().revision).toBe(1)
  })

  it('rejects cancellation before commit and retains the preceding graph', async () => {
    const f = await fixture()
    const database = await f.open()
    const controller = new AbortController()
    await expect(database.transaction((tx) => {
      tx.global.set({ revision: 1, canvases: [] })
      controller.abort()
    }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(database.global.get().revision).toBe(0)
  })

  it('rejects unsupported predecessor versions without modifying the source or leaving a fresh destination', async () => {
    const f = await fixture()
    legacy(f.legacyPath, 99)
    const original = await readFile(f.legacyPath)
    await expect(f.open()).rejects.toMatchObject({ code: 'version-mismatch' })
    expect(await readFile(f.legacyPath)).toEqual(original)
    await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retries a repaired legacy import after a known uncommitted initialization failure', async () => {
    const f = await fixture()
    legacy(f.legacyPath)
    const damaged = new DatabaseSync(f.legacyPath)
    try { damaged.exec("UPDATE unit_globals SET value='not-json' WHERE unit='convax'") }
    finally { damaged.close() }
    await expect(f.open()).rejects.toThrow()
    await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
    const repaired = new DatabaseSync(f.legacyPath)
    try { repaired.prepare("UPDATE unit_globals SET value=? WHERE unit='convax'").run(JSON.stringify({ revision: 4, canvases: [] })) }
    finally { repaired.close() }
    expect((await f.open()).global.get()).toEqual({ revision: 4, canvases: [] })
  })

  it('accepts an empty transitional legacy database but refuses another nonempty SQLite format', async () => {
    const f = await fixture()
    await writeFile(f.legacyPath, '')
    const database = await f.open()
    expect(database.global.get()).toEqual({ revision: 0, canvases: [] })
    await database.close()
    const other = await fixture()
    const invalid = new DatabaseSync(other.legacyPath)
    try { invalid.exec('CREATE TABLE foreign_data(value TEXT)') }
    finally { invalid.close() }
    await expect(other.open()).rejects.toMatchObject({ code: 'invalid-record' })
  })

  it.each(['version', 'graph', 'empty'] as const)('does not recover an invalid owned %s from the old database', async (failure) => {
    const f = await fixture()
    legacy(f.legacyPath)
    const database = await f.open()
    await database.global.set({ revision: 8, canvases: [] })
    await database.close()
    if (failure === 'empty') await writeFile(f.path, '')
    else {
      const db = new DatabaseSync(f.path)
      try {
        if (failure === 'version') db.exec("UPDATE units SET version=99 WHERE name='convax'")
        else db.exec("UPDATE unit_globals SET value='not-json' WHERE unit='convax'")
      } finally { db.close() }
    }
    const original = await readFile(f.path)
    await expect(f.open()).rejects.toMatchObject({ code: failure === 'version' ? 'version-mismatch' : 'invalid-record' })
    expect(await readFile(f.path)).toEqual(original)
  })
})
