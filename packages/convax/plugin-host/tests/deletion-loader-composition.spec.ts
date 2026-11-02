/** Deletion settlement and retry through the shipped Web profile, without a model call. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const driver = fileURLToPath(new URL('./fixtures/deletion-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/chat-composition.patch.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))
interface Report {
  phase: string
  waitedForIdle: boolean
  stopCalls: number
  pendingIssue: string | null
  remainingChats: number
  storedSessions: number
  failingId: string
  archived: string[]
}

it('awaits real Agent cancellation and recovers an already archived failed deletion in a new Web Host', {
  timeout: LOADER_SMOKE_TEST_TIMEOUT_MS * 2, retry: 0,
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'convax-deletion-loader-'))
  try {
    const reports: Report[] = []
    for (const phase of ['stop-failure', 'recover']) {
      await runLoaderSmoke({ label: `Convax deletion ${phase}`, cwd, binScript: driver, libBinScript: driver, configPath,
        binArgs: [configPath, phase], tsconfigPath, env: { DSH_TELEMETRY_DISABLED: '1' },
        inspect: async () => { reports.push(JSON.parse(await readFile(join(cwd, 'convax-deletion-report.json'), 'utf8')) as Report) },
      })
    }
    expect(reports[0]).toMatchObject({ waitedForIdle: true, remainingChats: 1, storedSessions: 2 })
    expect(reports[0]?.pendingIssue).toBeTypeOf('string')
    expect(reports[1]).toMatchObject({ remainingChats: 0, storedSessions: 2, pendingIssue: null })
    expect(reports[1]?.failingId).toBe(reports[0]?.failingId)
    expect(reports[1]?.stopCalls).toBeGreaterThan(0)
    expect(reports[1]?.archived).toEqual(reports[0]?.archived)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})
