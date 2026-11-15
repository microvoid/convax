/** The shipped Loader graph must connect Creation tools to ordinary Chats and media nodes. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const driver = fileURLToPath(new URL('./fixtures/loader-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/composition.patch.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../libs/dsh/tsconfig.json', import.meta.url))

it('loads the built-in workbench and delivers image, video and audio to native Chat nodes across Thread changes and reopen', {
  timeout: LOADER_SMOKE_TEST_TIMEOUT_MS * 2, retry: 0,
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'convax-creation-loader-'))
  try {
    for (const phase of ['create', 'reopen']) {
      await runLoaderSmoke({ label: `Creation ${phase} through production Loader`, cwd,
        binScript: driver, libBinScript: driver, configPath, binArgs: [configPath, phase], tsconfigPath,
        env: { DSH_TELEMETRY_DISABLED: '1' },
        inspect: async () => {
          const report = JSON.parse(await readFile(join(cwd, 'creation-report.json'), 'utf8')) as {
            sourceId: string
            nextThreadId: string
            jobs: string[]
          }
          expect(report).toMatchObject({ phase, mediaCount: 3, deliveryEdges: 3, submissions: phase === 'create' ? 4 : 0,
            nativeNodes: true, inheritedTools: true, originalInvocation: true, rendererIndependent: true })
          expect(report.sourceId).not.toBe(report.nextThreadId)
          expect(report.jobs).toHaveLength(3)
        },
      })
    }
  } finally { await rm(cwd, { recursive: true, force: true }) }
})
