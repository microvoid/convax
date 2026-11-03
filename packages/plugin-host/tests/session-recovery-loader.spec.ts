/** Recover completed native Session writes without a DSH operation-ledger extension. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const driver = fileURLToPath(new URL('./fixtures/session-recovery-driver.ts', import.meta.url))
const overlay = fileURLToPath(new URL('./fixtures/chat-composition.patch.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../libs/dsh/tsconfig.json', import.meta.url))
const reportSchema = z.object({ phase: z.string(), sourceId: z.string(), forkId: z.string(), stored: z.number() })

it('imports predecessor reservations and recovers lost binding and fork replies through real Web Loader restarts', {
  timeout: LOADER_SMOKE_TEST_TIMEOUT_MS * 2, retry: 0,
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'convax-session-recovery-'))
  const reports: { phase: string; sourceId: string; forkId: string; stored: number }[] = []
  try {
    for (const phase of ['create', 'reopen']) {
      await runLoaderSmoke({ label: `Convax Session recovery ${phase}`, cwd, binScript: driver, libBinScript: driver,
        configPath: overlay, binArgs: [overlay, phase], tsconfigPath, env: { DSH_TELEMETRY_DISABLED: '1' },
        inspect: async () => { reports.push(reportSchema.parse(JSON.parse(await readFile(join(cwd, 'session-recovery-report.json'), 'utf8')))) },
      })
    }
    expect(reports[0]).toMatchObject({ phase: 'create', stored: 2 })
    expect(reports[1]).toMatchObject({ phase: 'reopen', sourceId: reports[0]?.sourceId, forkId: reports[0]?.forkId, stored: 2 })
  } finally { await rm(cwd, { recursive: true, force: true }) }
})
