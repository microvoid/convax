import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const driver = fileURLToPath(new URL('./fixtures/chat-real-model-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/chat-composition.patch.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../libs/dsh/tsconfig.json', import.meta.url))

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('Convax with a real model', () => {
  it('reads an explicit native reference outside the thread directory and projects the explicitly delivered file', { timeout: 135_000, retry: 0 }, async () => {
    let contents = ''
    let report: { deliveryCount: number } | undefined
    await runLoaderSmoke({
      label: 'Convax explicit-reference real-model delivery', tempDirPrefix: 'convax-chat-real-',
      binScript: driver, libBinScript: driver, configPath, binArgs: [configPath], tsconfigPath,
      processTimeoutMs: 120_000, env: { DSH_TELEMETRY_DISABLED: '1' },
      prepare: async (cwd) => {
        await mkdir(join(cwd, 'source'))
        await mkdir(join(cwd, 'work'))
        await writeFile(join(cwd, 'source', 'input.txt'), 'value=from-connected-input\n')
      },
      inspect: async (cwd) => {
        contents = await readFile(join(cwd, 'work', 'result.txt'), 'utf8')
        report = JSON.parse(await readFile(join(cwd, 'convax-real-report.json'), 'utf8')) as { deliveryCount: number }
      },
    })
    expect(contents).toBe('value=from-connected-input\n')
    expect(report?.deliveryCount).toBe(1)
  })
})
