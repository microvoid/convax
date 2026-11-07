/** Real Loader, execution provider and Remote authorization for a canvas-owned terminal. */
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const driver = fileURLToPath(new URL('./fixtures/terminal-driver.ts', import.meta.url))
const overlay = fileURLToPath(new URL('./fixtures/terminals.patch.yml', import.meta.url))
const tsconfig = fileURLToPath(new URL('../../../libs/dsh/tsconfig.json', import.meta.url))

it('runs a user shell through the production composition and closes it after committed card removal', {
  timeout: LOADER_SMOKE_TEST_TIMEOUT_MS, retry: 0,
}, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'convax-terminal-loader-')))
  try {
    await runLoaderSmoke({ label: 'Canvas terminal through production profile', cwd: root, binScript: driver, libBinScript: driver,
      configPath: overlay, binArgs: [overlay], tsconfigPath: tsconfig, env: { DSH_TELEMETRY_DISABLED: '1' },
      inspect: async () => {
        const report: unknown = JSON.parse(await readFile(join(root, 'terminal-report.json'), 'utf8'))
        expect(report).toEqual({ output: 'canvas-owned shell', cwd: join(root, '.dsh', 'canvas-workspaces', 'canvas-terminal-loader-canvas'),
          globalAccessRequired: true, closeAfterRemoval: true, undoRestoresConfig: true, providerDisposed: true })
      },
    })
  } finally { await rm(root, { recursive: true, force: true }) }
})
