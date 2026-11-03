/** Existing Session placement remains unique across real Host restarts without changing reminder records. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const driver = fileURLToPath(new URL('./fixtures/open-session-driver.ts', import.meta.url))
const overlay = fileURLToPath(new URL('./fixtures/chat-composition.patch.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../libs/dsh/tsconfig.json', import.meta.url))
const reportSchema = z.object({
  phase: z.string(), sessionId: z.string(), canvasId: z.string(), nodeId: z.string(),
  storedSessionCount: z.number(), scheduleSessionId: z.string(), chatCount: z.number(), outputCount: z.number(),
})

it('opens a scheduled original Session on one Chat through production Web Loader creation and reopening', {
  timeout: LOADER_SMOKE_TEST_TIMEOUT_MS * 2, retry: 0,
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'convax-open-session-loader-'))
  try {
    for (const phase of ['create', 'reopen']) {
      await runLoaderSmoke({ label: `Original Session placement ${phase}`, cwd, binScript: driver, libBinScript: driver,
        configPath: overlay, binArgs: [overlay, phase], tsconfigPath, env: { DSH_TELEMETRY_DISABLED: '1' },
        inspect: async () => {
          const report = reportSchema.parse(JSON.parse(await readFile(join(cwd, 'open-session-report.json'), 'utf8')))
          expect(report).toEqual({ phase, sessionId: 'original-automation-session', canvasId: 'original-session-canvas', nodeId: 'original-session-chat',
            storedSessionCount: 1, scheduleSessionId: 'original-automation-session', chatCount: 1, outputCount: 0 })
        },
      })
    }
  } finally { await rm(cwd, { recursive: true, force: true }) }
})
