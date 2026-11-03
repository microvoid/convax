import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const driver = fileURLToPath(new URL('./fixtures/counter-example-driver.ts', import.meta.url))
const overlay = fileURLToPath(new URL('./fixtures/composition.patch.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../libs/dsh/tsconfig.json', import.meta.url))

it('loads the Counter example through a production profile and preserves its value across provider and Host reloads', {
  timeout: LOADER_SMOKE_TEST_TIMEOUT_MS,
  retry: 0,
}, async () => {
  let report: unknown
  await runLoaderSmoke({
    label: 'Convax Counter example through the production Loader',
    tempDirPrefix: 'convax-counter-example-',
    binScript: driver,
    libBinScript: driver,
    configPath: overlay,
    binArgs: [overlay],
    tsconfigPath,
    env: { DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: undefined },
    inspect: async (cwd) => {
      report = JSON.parse(await readFile(join(cwd, 'counter-example-report.json'), 'utf8'))
    },
  })
  expect(report).toEqual({
    createdValue: 0,
    incrementedValue: 1,
    invalidUpdate: { code: 'invalid-command', value: 1, canvasUnchanged: true },
    disabledProvider: { available: false, value: 1, position: { x: 24, y: 32 } },
    restoredProvider: { available: true, value: 1 },
    reopenedHost: { available: true, value: 1, position: { x: 24, y: 32 } },
  })
})
