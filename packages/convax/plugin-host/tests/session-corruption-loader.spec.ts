/** Corrupt native Session data is never repaired through private files or replaced silently. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'

const driver = fileURLToPath(new URL('./fixtures/session-corruption-driver.ts', import.meta.url))
const overlay = fileURLToPath(new URL('./fixtures/chat-composition.patch.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

it('retains a damaged fork under its original operation and Session identities through the real Web Loader', {
  timeout: LOADER_SMOKE_TEST_TIMEOUT_MS, retry: 0,
}, async () => {
  let report: unknown
  await runLoaderSmoke({ label: 'Convax corrupt fork refusal', tempDirPrefix: 'convax-corrupt-session-',
    binScript: driver, libBinScript: driver, configPath: overlay, binArgs: [overlay], tsconfigPath,
    env: { DSH_TELEMETRY_DISABLED: '1' },
    inspect: async (cwd) => { report = JSON.parse(await readFile(join(cwd, 'corruption-report.json'), 'utf8')) },
  })
  expect(report).toEqual({ retained: true, stored: 2, bound: 1 })
})
