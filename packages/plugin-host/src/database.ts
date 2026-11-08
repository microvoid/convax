/** Convax-owned SQLite records, atomic mutations, and legacy graph import. */
import { DatabaseSync, backup } from 'node:sqlite'
import { mkdir, mkdtemp, open, realpath, stat, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { CANVAS_SCHEMA_VERSION, canvasTables, graphSchema } from './schema.ts'
import type { CanvasTableKeys, CanvasTableValue } from './schema.ts'
import type { z } from 'zod'
import { mergeLegacySessions } from './legacy-sessions.ts'

type TableName = keyof typeof canvasTables
type Graph = z.infer<typeof graphSchema>

/** Storage failure with an explicit retry or repair category. */
export class CanvasDatabaseError extends Error {
  /** @param code - Stable failure category. @param message - Repair context. @param options - Original failure. */
  constructor(readonly code: 'storage-in-use' | 'version-mismatch' | 'invalid-record' | 'closed' | 'unknown-state', message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/** Read access shared by transaction and committed table handles. */
export interface CanvasTableRead<N extends TableName> {
  /** @param key - Branded record identity. @returns Current record, or undefined. */
  get(key: CanvasTableKeys[N]): CanvasTableValue<N> | undefined
  /** @returns Detached records in stable key order. */
  entries(): IterableIterator<[CanvasTableKeys[N], CanvasTableValue<N>]>
  /** @returns Detached keys in stable order. */
  keys(): IterableIterator<CanvasTableKeys[N]>
  /** Number of persisted records. */
  readonly size: number
}

/** Synchronous writes available only during one SQLite transaction. */
export interface CanvasTransactionTable<N extends TableName> extends CanvasTableRead<N> {
  /** @param key - Record identity. @param value - Complete replacement record. */
  put(key: CanvasTableKeys[N], value: CanvasTableValue<N>): void
  /** @param key - Record identity. @returns Whether a record was removed. */
  delete(key: CanvasTableKeys[N]): boolean
}

/** Explicit transaction-local records; handles expire when the callback returns. */
export interface CanvasTransaction {
  /** Graph document in the same transaction as its operation receipts. */
  readonly global: { get(): Graph; set(value: Graph): void }
  /** @param name - Declared table. @returns Synchronous transaction-local access. */
  table<N extends TableName>(name: N): CanvasTransactionTable<N>
}

/** Committed table access; writes join the repository's serial queue. */
export interface CanvasTable<N extends TableName> extends CanvasTableRead<N> {
  /** @param key - Record identity. @param value - Complete record. @returns After durable commit. */
  put(key: CanvasTableKeys[N], value: CanvasTableValue<N>): Promise<void>
  /** @param key - Record identity. @returns Whether a committed record was removed. */
  delete(key: CanvasTableKeys[N]): Promise<boolean>
  /** @param keys - Records to remove together. @returns Number removed. */
  deleteMany(keys: readonly CanvasTableKeys[N][]): Promise<number>
  /** @param key - Existing identity. @param update - Pure transformation. @returns Committed replacement. */
  update(key: CanvasTableKeys[N], update: (value: CanvasTableValue<N>) => CanvasTableValue<N>): Promise<CanvasTableValue<N>>
}

/** Database path and optional one-time source owned by an earlier Convax build. */
export interface CanvasDatabaseOptions {
  path: string
  legacyPath?: string | undefined
}

/** Single writer of Convax graph and coordination records, independent of DSH storage. */
export class CanvasDatabase {
  private tail: Promise<void> = Promise.resolve()
  private closing: Promise<void> | undefined
  private failure: CanvasDatabaseError | undefined
  private closed = false
  private initializationCommitStarted = false
  private warnings: string[] = []

  /** Predecessor records retained for explicit recovery instead of attached to an invented Chat. */
  get migrationWarnings(): readonly string[] { return [...this.warnings] }

  /** Graph access; writes share the queue with record transactions. */
  readonly global = {
    get: (): Graph => { this.assertReadable(); return this.readGraph() },
    set: (value: Graph): Promise<void> => this.transaction((tx) => { tx.global.set(value) }),
  }

  private constructor(
    private readonly db: DatabaseSync,
    private readonly writer: DatabaseSync | undefined,
    private readonly predecessorWriter: DatabaseSync | undefined,
  ) {}

  /**
   * Acquire the writer, validate saved records and import an earlier graph exactly once.
   * @param options - Owned path and optional read-only predecessor.
   * @returns Ready database; incompatible or damaged existing state is never replaced.
   */
  static async open(options: CanvasDatabaseOptions): Promise<CanvasDatabase> {
    const path = options.path === ':memory:' ? options.path : resolve(options.path)
    if (options.legacyPath !== undefined && path !== ':memory:') {
      const predecessor = resolve(options.legacyPath)
      if (predecessor === path) throw new CanvasDatabaseError('invalid-record', 'Owned and predecessor Convax databases must use different files')
      const existing = await existingRealpath(path)
      const legacy = await existingRealpath(predecessor)
      if (existing !== undefined && existing === legacy) throw new CanvasDatabaseError('invalid-record', 'Owned and predecessor Convax databases resolve to the same file')
    }
    const { writer, created } = await acquireCanvasWriter(path)
    let db: DatabaseSync | undefined
    let owner: CanvasDatabase | undefined
    let predecessorWriter: DatabaseSync | undefined
    try {
      predecessorWriter = await acquirePredecessorWriter(options.legacyPath)
      db = new DatabaseSync(path)
      const version = db.prepare('PRAGMA user_version').get()?.['user_version']
      if (version !== 0 && version !== 1) throw new CanvasDatabaseError('version-mismatch', `Unsupported Convax database format: ${String(version)}`)
      owner = new CanvasDatabase(db, writer, predecessorWriter)
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      if (tables.length === 0) {
        if (!created) throw new CanvasDatabaseError('invalid-record', 'Existing Convax database is empty; restore or repair it before retrying')
        db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL')
        await owner.initialize(options.legacyPath)
      } else {
        db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL')
        await owner.upgrade(path, options.legacyPath)
      }
      owner.validate()
      return owner
    } catch (error) {
      try {
        db?.close()
        if (created && path !== ':memory:' && owner?.initializationCommitStarted !== true) await unlink(path)
      } finally { try { predecessorWriter?.close() } finally { writer?.close() } }
      throw error
    }
  }

  /**
   * Read committed records and enqueue writes through this database's serial queue.
   * @param name - Declared table.
   * @returns Committed access owned by this database.
   */
  table<N extends TableName>(name: N): CanvasTable<N> {
    const read = this.readTable(name, () => { this.assertReadable() })
    return {
      ...read,
      get size() { return read.size },
      put: (key, value) => this.transaction((tx) => { tx.table(name).put(key, value) }),
      delete: key => this.transaction(tx => tx.table(name).delete(key)),
      deleteMany: keys => this.transaction(tx => keys.reduce((count, key) => count + Number(tx.table(name).delete(key)), 0)),
      update: (key, update) => this.transaction((tx) => {
        const current = tx.table(name).get(key)
        if (current === undefined) throw new CanvasDatabaseError('invalid-record', `Missing Convax ${name} record: ${key}`)
        const value = update(current)
        tx.table(name).put(key, value)
        return value
      }),
    }
  }

  /**
   * Commit a synchronous callback atomically; external operations belong outside it.
   * @param body - Transaction-local record changes.
   * @param options - Cancellation checked before the commit.
   * @returns Callback result only after durable commit.
   */
  transaction<R>(body: (transaction: CanvasTransaction) => R, options?: { readonly signal?: AbortSignal }): Promise<R> {
    return this.enqueue(() => {
      options?.signal?.throwIfAborted()
      this.db.exec('BEGIN IMMEDIATE')
      let active = true
      const assertActive = (): void => {
        if (!active) throw new CanvasDatabaseError('closed', 'Convax transaction is no longer active')
      }
      try {
        const result = body({
          global: {
            get: () => { assertActive(); return this.readGraph() },
            set: (value) => {
              assertActive()
              this.db.prepare("INSERT INTO unit_globals(unit,value) VALUES('convax',?) ON CONFLICT(unit) DO UPDATE SET value=excluded.value").run(JSON.stringify(value))
            },
          },
          table: <N extends TableName>(name: N): CanvasTransactionTable<N> => {
            const read = this.readTable(name, assertActive)
            return {
              ...read,
              get size() { return read.size },
              put: (key, value) => {
                assertActive()
                this.db.prepare(`INSERT INTO u_convax_${name}(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, JSON.stringify(value))
              },
              delete: (key) => {
                assertActive()
                return this.db.prepare(`DELETE FROM u_convax_${name} WHERE key=?`).run(key).changes > 0
              },
            }
          },
        })
        options?.signal?.throwIfAborted()
        active = false
        this.db.exec('COMMIT')
        return result
      } catch (error) {
        active = false
        try { this.db.exec('ROLLBACK') } catch (rollback) {
          this.failure = new CanvasDatabaseError('unknown-state', 'Convax transaction outcome cannot be established; reopen the database before retrying', { cause: new AggregateError([error, rollback]) })
          throw this.failure
        }
        throw error
      }
    })
  }

  /**
   * Drain queued work and release the database and its writer locks.
   * @returns After queued work drains and both database and writer are released.
   */
  close(): Promise<void> {
    return this.closing ??= this.tail.then(() => {
      this.closed = true
      try { this.db.close() } finally { try { this.predecessorWriter?.close() } finally { this.writer?.close() } }
    })
  }

  private enqueue<R>(body: () => R): Promise<R> {
    if (this.closing !== undefined) return Promise.reject(new CanvasDatabaseError('closed', 'Convax database is closing'))
    const result = this.tail.then(() => { this.assertReadable(); return body() })
    this.tail = result.then(() => {}, () => {})
    return result
  }

  private assertReadable(): void {
    if (this.failure !== undefined) throw this.failure
    if (this.closed) throw new CanvasDatabaseError('closed', 'Convax database is closed')
  }

  private readGraph(): Graph {
    return graphSchema.parse(parseJson(this.db.prepare("SELECT value FROM unit_globals WHERE unit='convax'").get()?.['value'], 'graph'))
  }

  private readTable<N extends TableName>(name: N, assert: () => void): CanvasTableRead<N> {
    const db = this.db
    const parse = (value: unknown): CanvasTableValue<N> => canvasTables[name].parse(parseJson(value, name)) as CanvasTableValue<N>
    return {
      get(key) { assert(); const row = db.prepare(`SELECT value FROM u_convax_${name} WHERE key=?`).get(key); return row === undefined ? undefined : parse(row['value']) },
      *entries() {
        assert()
        for (const row of db.prepare(`SELECT key,value FROM u_convax_${name} ORDER BY key`).all()) {
          const key = row['key']
          if (typeof key !== 'string' || key.length === 0) throw new CanvasDatabaseError('invalid-record', `Invalid Convax ${name} identity`)
          yield [key as CanvasTableKeys[N], parse(row['value'])]
        }
      },
      *keys() { for (const [key] of this.entries()) yield key },
      get size() { assert(); return Number(db.prepare(`SELECT count(*) AS count FROM u_convax_${name}`).get()?.['count']) },
    }
  }

  private validate(): void {
    try {
      this.readGraph()
      for (const name of Object.keys(canvasTables) as TableName[]) Array.from(this.readTable(name, () => {}).entries())
    } catch (cause) { throw new CanvasDatabaseError('invalid-record', 'Convax database contains invalid graph or coordination records; restore or repair the existing database', { cause }) }
  }

  private async initialize(legacyPath: string | undefined): Promise<void> {
    const snapshot = await readLegacy(legacyPath, true)
    const legacy = snapshot.graph
    const sessions = snapshot.sessions
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.exec('CREATE TABLE units(name TEXT PRIMARY KEY,version INTEGER NOT NULL) STRICT; CREATE TABLE unit_globals(unit TEXT PRIMARY KEY REFERENCES units(name),value TEXT NOT NULL) STRICT')
      this.db.prepare("INSERT INTO units(name,version) VALUES('convax',?)").run(CANVAS_SCHEMA_VERSION)
      this.db.prepare("INSERT INTO unit_globals(unit,value) VALUES('convax',?)").run(legacy?.global ?? JSON.stringify({ revision: 0, canvases: [] }))
      for (const name of Object.keys(canvasTables) as TableName[]) {
        this.db.exec(`CREATE TABLE u_convax_${name}(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT`)
        for (const [key, value] of legacy?.tables[name] ?? []) this.db.prepare(`INSERT INTO u_convax_${name}(key,value) VALUES(?,?)`).run(key, value)
      }
      this.importSessionReservations(sessions)
      this.validate()
      this.db.exec('PRAGMA user_version = 1')
      this.initializationCommitStarted = true
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch (rollback) {
        this.initializationCommitStarted = true
        throw new CanvasDatabaseError('unknown-state', 'Convax initialization outcome cannot be established; inspect the existing database before retrying', { cause: new AggregateError([error, rollback]) })
      }
      throw error
    }
  }

  private async upgrade(path: string, legacyPath: string | undefined): Promise<void> {
    const version = this.db.prepare("SELECT version FROM units WHERE name='convax'").get()?.['version']
    if (version === CANVAS_SCHEMA_VERSION) { this.readMigrationWarnings(); return }
    if (version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5 && version !== 6 && version !== 7 && version !== 8) throw new CanvasDatabaseError('version-mismatch', `Unsupported Convax repository version: ${String(version)}`)
    const sessions = version < 3 ? (await readLegacy(legacyPath, false)).sessions : []
    if (path !== ':memory:') {
      await mkdir(`${path}.upgrades`, { recursive: true, mode: 0o700 })
      const copy = await mkdtemp(`${path}.upgrades/upgrade-`)
      await backup(this.db, `${copy}/database.sqlite`)
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (version === 1) this.db.exec('CREATE TABLE u_convax_node_migrations(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT')
      if (version < 3) this.importSessionReservations(sessions)
      else this.readMigrationWarnings()
      if (version < 4) {
        for (const name of ['history', 'node_revisions', 'retired_connections', 'restorations']) {
          this.db.exec(`CREATE TABLE u_convax_${name}(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT`)
        }
      }
      if (version < 7) this.db.exec('CREATE TABLE u_convax_directories(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT')
      this.db.prepare("UPDATE units SET version=? WHERE name='convax'").run(CANVAS_SCHEMA_VERSION)
      this.validate()
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private importSessionReservations(rows: readonly [string, string][]): void {
    const result = mergeLegacySessions([...this.readTable('thread_operations', () => {}).entries()], rows)
    for (const [key, value] of result.threads) this.db.prepare('UPDATE u_convax_thread_operations SET value=? WHERE key=?').run(JSON.stringify(value), key)
    this.db.exec('CREATE TABLE convax_migration_info(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT')
    this.db.prepare("INSERT INTO convax_migration_info(key,value) VALUES('session_operations',?)").run(JSON.stringify(result.unmatched))
    this.readMigrationWarnings()
  }

  private readMigrationWarnings(): void {
    const value = parseJson(this.db.prepare("SELECT value FROM convax_migration_info WHERE key='session_operations'").get()?.['value'], 'legacy Session import')
    if (!Array.isArray(value) || value.some(id => typeof id !== 'string')) throw new CanvasDatabaseError('invalid-record', 'Invalid legacy Session import report')
    this.warnings = value.length === 0 ? [] : [`Legacy Session operations without matching Chat intentions remain in the predecessor database: ${value.join(', ')}`]
  }
}

async function existingRealpath(path: string): Promise<string | undefined> {
  try { return await realpath(path) } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== 'string') throw new CanvasDatabaseError('invalid-record', `Missing Convax ${label} JSON`)
  return JSON.parse(value)
}

interface LegacyGraph {
  global: string
  tables: Partial<Record<TableName, [string, string][]>>
}

async function readLegacy(path: string | undefined, includeGraph: boolean): Promise<{ graph?: LegacyGraph; sessions: [string, string][] }> {
  if (path === undefined) return { sessions: [] }
  try { await stat(path) } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return { sessions: [] }
    throw error
  }
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec('BEGIN')
    if (db.prepare("SELECT name FROM sqlite_master WHERE name='units'").get() === undefined) {
      const version = db.prepare('PRAGMA user_version').get()?.['user_version']
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      if (version === 0 && tables.length === 0) return { sessions: [] }
      throw new CanvasDatabaseError('invalid-record', 'Legacy Convax database has no unit directory')
    }
    const sessions: [string, string][] = []
    const sessionVersion = db.prepare("SELECT version FROM units WHERE name='session_operations'").get()?.['version']
    if (sessionVersion !== undefined) {
      if (sessionVersion !== 1) throw new CanvasDatabaseError('version-mismatch', `Unsupported predecessor Session ledger version: ${String(sessionVersion)}`)
      for (const row of db.prepare('SELECT key,value FROM u_session_operations_operations ORDER BY key').all()) {
        if (typeof row['key'] !== 'string' || typeof row['value'] !== 'string') throw new CanvasDatabaseError('invalid-record', 'Invalid predecessor Session operation')
        sessions.push([row['key'], row['value']])
      }
    }
    if (!includeGraph) return { sessions }
    const version = db.prepare("SELECT version FROM units WHERE name='convax'").get()?.['version']
    if (version === undefined) return { sessions }
    if (version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5 && version !== 6 && version !== 7 && version !== 8 && version !== CANVAS_SCHEMA_VERSION) throw new CanvasDatabaseError('version-mismatch', `Unsupported legacy Convax repository version: ${String(version)}`)
    const global = db.prepare("SELECT value FROM unit_globals WHERE unit='convax'").get()?.['value']
    if (typeof global !== 'string') throw new CanvasDatabaseError('invalid-record', 'Legacy Convax graph is absent')
    graphSchema.parse(JSON.parse(global))
    const tables: Partial<Record<TableName, [string, string][]>> = {}
    for (const name of Object.keys(canvasTables) as TableName[]) {
      if (version < 7 && name === 'directories') continue
      if (version === 1 && name === 'node_migrations') continue
      if (version < 4 && ['history', 'node_revisions', 'retired_connections', 'restorations'].includes(name)) continue
      tables[name] = db.prepare(`SELECT key,value FROM u_convax_${name}`).all().map((row) => {
        if (typeof row['key'] !== 'string' || row['key'].length === 0 || typeof row['value'] !== 'string') throw new CanvasDatabaseError('invalid-record', `Invalid legacy Convax ${name} record`)
        canvasTables[name].parse(JSON.parse(row['value']))
        return [row['key'], row['value']]
      })
    }
    return { graph: { global, tables }, sessions }
  } finally { db.close() }
}

async function acquirePredecessorWriter(path: string | undefined): Promise<DatabaseSync | undefined> {
  if (path === undefined) return undefined
  try { await stat(path) } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
  return acquireWriterLease(await realpath(path))
}

async function acquireCanvasWriter(path: string): Promise<{ writer: DatabaseSync | undefined; created: boolean }> {
  if (path === ':memory:') return { writer: undefined, created: true }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  let created = false
  try {
    const handle = await open(path, 'wx', 0o600)
    created = true
    await handle.close()
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'EEXIST') throw error
  }
  const canonical = await realpath(path)
  if ((await stat(canonical)).nlink > 1) throw new CanvasDatabaseError('storage-in-use', 'Convax does not support hard-linked database paths')
  return { writer: await acquireWriterLease(canonical), created }
}

async function acquireWriterLease(canonical: string): Promise<DatabaseSync> {
  const file = await open(`${canonical}.writer-lock`, 'a', 0o600)
  await file.close()
  const writer = new DatabaseSync(`${canonical}.writer-lock`)
  try {
    writer.exec('PRAGMA journal_mode = DELETE; PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE')
    return writer
  } catch (cause) {
    writer.close()
    if (typeof cause === 'object' && cause !== null && 'errcode' in cause && (cause.errcode === 5 || cause.errcode === 6)) throw new CanvasDatabaseError('storage-in-use', 'Another Host owns the Convax database; close it before retrying', { cause })
    throw cause
  }
}
