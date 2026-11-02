import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { CanvasWorkspace } from '../src/types.ts'

const driver = fileURLToPath(new URL('./fixtures/chat-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/chat-composition.patch.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))
interface Report {
  phase: string
  sourceId: string
  forkId: string
  beforeDeletion: CanvasWorkspace
  rendererDisabled: boolean
  hostRetained: boolean
  storedSessionCount: number
  archived: string[]
  remainingChats: number
}

it('creates, reopens, forks and archives Chat threads through the production Web Loader without repeating deliveries', {
  timeout: LOADER_SMOKE_TEST_TIMEOUT_MS * 2, retry: 0,
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'convax-chat-loader-'))
  try {
    const reports: Report[] = []
    for (const phase of ['create', 'reopen']) {
      await runLoaderSmoke({ label: `Convax Chat ${phase} through Web Loader`, cwd, binScript: driver, libBinScript: driver,
        configPath, binArgs: [configPath, phase], tsconfigPath, env: { DSH_TELEMETRY_DISABLED: '1' },
        inspect: async () => { reports.push(JSON.parse(await readFile(join(cwd, 'convax-chat-report.json'), 'utf8')) as Report) },
      })
    }
    for (const report of reports) {
      expect(report).toMatchObject({ rendererDisabled: true, hostRetained: true, storedSessionCount: 2 })
      expect(report.beforeDeletion.chats[0]?.threads).toHaveLength(2)
      expect(report.beforeDeletion.canvases[0]?.nodes.filter(node => node.typeId === 'convax.file')).toHaveLength(1)
      expect(report.beforeDeletion.canvases[0]?.connections.filter(edge => edge.purpose === 'delivery')).toHaveLength(1)
    }
    expect(reports[1]?.sourceId).toBe(reports[0]?.sourceId)
    expect(reports[1]?.forkId).toBe(reports[0]?.forkId)
    expect(reports[1]).toMatchObject({ remainingChats: 0 })
    expect(reports[1]?.archived).toEqual([reports[0]?.sourceId, reports[0]?.forkId].sort())
  } finally { await rm(cwd, { recursive: true, force: true }) }
})
