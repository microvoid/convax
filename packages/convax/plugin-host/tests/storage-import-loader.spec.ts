/** One-time graph import survives a real profile restart and preserves the old Session ledger. */
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { canvasTables } from '../src/schema.ts'

const driver = fileURLToPath(new URL('./fixtures/storage-import-driver.ts', import.meta.url))
const overlay = fileURLToPath(new URL('./fixtures/composition.patch.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

it('hands the legacy graph to Convax through the production Loader and never imports it again', {
  timeout: LOADER_SMOKE_TEST_TIMEOUT_MS * 2, retry: 0,
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'convax-storage-import-loader-'))
  const home = join(cwd, '.dsh')
  const path = join(home, 'storages', 'convax.sqlite')
  try {
    await mkdir(join(home, 'storages'), { recursive: true })
    const legacy = new DatabaseSync(path)
    try {
      legacy.exec('PRAGMA journal_mode=WAL; PRAGMA user_version=1; CREATE TABLE units(name TEXT PRIMARY KEY,version INTEGER NOT NULL) STRICT; CREATE TABLE unit_globals(unit TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT')
      legacy.exec("INSERT INTO units VALUES('convax',2); INSERT INTO units VALUES('session_operations',1)")
      legacy.prepare("INSERT INTO unit_globals VALUES('convax',?)").run(JSON.stringify({
        revision: 1, canvases: [{ id: 'legacy-canvas', revision: 1, title: 'Legacy saved canvas', nodes: [], connections: [] }],
      }))
      for (const name of Object.keys(canvasTables)) legacy.exec(`CREATE TABLE u_convax_${name}(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT`)
      legacy.exec('CREATE TABLE u_session_operations_operations(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT')
      legacy.prepare('INSERT INTO u_session_operations_operations VALUES(?,?)').run('preserve-session-ledger', JSON.stringify({
        request: { kind: 'create', cwd }, phase: 'reserved', sessionId: 'unmatched-predecessor-session', createdAt: 1, cwd,
      }))
    } finally { legacy.close() }
    for (const phase of ['import', 'reopen']) {
      if (phase === 'reopen') {
        const predecessor = new DatabaseSync(path)
        try { predecessor.prepare("UPDATE unit_globals SET value=? WHERE unit='convax'").run(JSON.stringify({ revision: 99, canvases: [] })) }
        finally { predecessor.close() }
      }
      const before = await readFile(path)
      await runLoaderSmoke({
        label: `Convax owned storage ${phase} through production Loader`, cwd,
        binScript: driver, libBinScript: driver, configPath: overlay, binArgs: [overlay, phase], tsconfigPath,
        env: { DSH_TELEMETRY_DISABLED: '1' },
        inspect: async () => {
          const report: unknown = JSON.parse(await readFile(join(cwd, 'convax-storage-import-report.json'), 'utf8'))
          expect(report).toMatchObject({ phase, workspace: { revision: 2, canvases: [{ title: 'Owned canvas' }] } })
        },
      })
      expect(await readFile(path)).toEqual(before)
    }
    const retained = new DatabaseSync(path, { readOnly: true })
    try { expect(retained.prepare('SELECT key FROM u_session_operations_operations').get()?.['key']).toBe('preserve-session-ledger') }
    finally { retained.close() }
  } finally { await rm(cwd, { recursive: true, force: true }) }
})
