import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { CanvasChat, CanvasDocument } from '../src/types.ts'

const driver = fileURLToPath(new URL('./fixtures/chat-workflows-driver.ts', import.meta.url))
const overlay = fileURLToPath(new URL('./fixtures/chat-workflows.patch.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../libs/dsh/tsconfig.json', import.meta.url))

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('Convax user workflows with a real model', () => {
  it('builds two projects, delivers a computed result, and prepares an independent conversation fork', { timeout: 345_000, retry: 0 }, async () => {
    await runLoaderSmoke({
      label: 'Convax user skill workflows', tempDirPrefix: 'convax-workflows-',
      binScript: driver, libBinScript: driver, configPath: overlay, tsconfigPath,
      processTimeoutMs: 330_000, env: { DSH_TELEMETRY_DISABLED: '1' },
      inspect: async (cwd) => {
        const report = JSON.parse(await readFile(join(cwd, 'workflow-report.json'), 'utf8')) as {
          rendererDisabled: boolean
          canvas: CanvasDocument
          chats: CanvasChat[]
          calls: string[]
          timings: number[]
        }
        expect(report.rendererDisabled).toBe(true)
        expect(report.timings).toHaveLength(3)
        expect(report.canvas.groups).toHaveLength(2)
        expect(report.chats).toHaveLength(3)
        expect(report.chats.flatMap(chat => chat.threads)).toHaveLength(4)
        expect(report.canvas.connections.filter(edge => edge.purpose === 'delivery')).toHaveLength(1)
        expect(await readFile(join(cwd, 'summary.md'), 'utf8')).toBe('总席位：42\n')
      },
    })
  })
})
