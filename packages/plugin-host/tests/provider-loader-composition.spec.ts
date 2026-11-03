import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const driver = fileURLToPath(new URL('./fixtures/provider-driver.ts', import.meta.url))
const overlay = fileURLToPath(new URL('./fixtures/composition.patch.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../libs/dsh/tsconfig.json', import.meta.url))

it('upgrades an extension through the production Loader, preserving nodes across provider and Host replacement', {
  timeout: LOADER_SMOKE_TEST_TIMEOUT_MS, retry: 0,
}, async () => {
  let report: unknown
  await runLoaderSmoke({ label: 'Convax provider lifecycle and upgrades', tempDirPrefix: 'convax-provider-',
    binScript: driver, libBinScript: driver,
    configPath: overlay, binArgs: [overlay], tsconfigPath, env: { DSH_TELEMETRY_DISABLED: '1' },
    inspect: async (cwd) => { report = JSON.parse(await readFile(join(cwd, 'provider-report.json'), 'utf8')) },
  })
  expect(report).toEqual({ providerRemoved: true, geometryRetained: true, connectionRetained: true,
    dataVersion: 2, originalPath: 'original', currentPath: 'upgraded',
    hostReopened: true, copies: 1, rendererDisabled: true, unsupportedRetained: true })
})
