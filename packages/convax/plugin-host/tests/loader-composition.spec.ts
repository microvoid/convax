import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { CanvasWorkspace } from '@deepseek-ai/dsh-convax-plugin-host/types'

const driver = fileURLToPath(new URL('./fixtures/loader-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/composition.patch.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

interface LoaderReport {
  phase: 'create' | 'reopen'
  workspace: CanvasWorkspace
  rendererDisabled: boolean
  hostRetained: boolean
  functionExports: boolean
  sqliteUnits: string[]
  defaultProbe: string
  writerRejected: boolean
  directory: string
  resource: { kind: string; text: string; truncated: boolean }
}

it('loads independent Host and renderer rows, keeps Host writable after renderer disposal, and reopens committed canvases', {
  timeout: LOADER_SMOKE_TEST_TIMEOUT_MS * 2,
  retry: 0,
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'convax-loader-'))
  try {
    await writeFile(join(cwd, 'input.txt'), 'Convax Loader resource\n')
    const reports: LoaderReport[] = []
    for (const phase of ['create', 'reopen']) {
      await runLoaderSmoke({
        label: `Convax ${phase} through production profile Loader`,
        cwd,
        binScript: driver,
        libBinScript: driver,
        configPath,
        binArgs: [configPath, phase],
        tsconfigPath,
        env: { DSH_TELEMETRY_DISABLED: '1' },
        inspect: async () => {
          reports.push(JSON.parse(await readFile(join(cwd, 'convax-loader-report.json'), 'utf8')) as LoaderReport)
        },
      })
    }
    for (const report of reports) {
      expect(report).toMatchObject({
        rendererDisabled: true,
        hostRetained: true,
        functionExports: true,
        sqliteUnits: ['convax'],
        defaultProbe: 'native JSON route',
        writerRejected: true,
        resource: { kind: 'file', text: 'Convax Loader resource\n', truncated: false },
      })
      expect(report.workspace.canvases).toHaveLength(1)
      expect(report.directory).toBe(await realpath(join(cwd, '.dsh', 'canvas-workspaces', 'canvas-loader-canvas')))
      expect(report.workspace.canvases[0]).toMatchObject({
        id: 'loader-canvas', title: 'Loader canvas',
        nodes: [
          { id: 'loader-file', typeId: 'convax.file', dataVersion: 1 },
          { id: 'loader-window', typeId: 'convax.window', dataVersion: 1,
            data: { bindingId: 'bcb746ca-2b66-4ca6-97ef-215df25e638a', name: 'Mirror test window' } },
          { id: 'loader-folder', typeId: 'convax.folder', dataVersion: 1 },
        ],
      })
    }
    expect(reports[0]).toMatchObject({ phase: 'create', workspace: { revision: 4, canvases: [{ revision: 4 }] } })
    expect(reports[1]).toMatchObject({ phase: 'reopen', workspace: { revision: 5, canvases: [{ revision: 5 }] } })
    expect(reports[1]?.workspace.canvases[0]?.nodes[0]?.position).toEqual({ x: 300, y: 200 })
    const defaultMedium: unknown = JSON.parse(await readFile(join(cwd, '.dsh', 'storages', 'convax_loader_default_probe.json'), 'utf8'))
    expect(defaultMedium).toMatchObject({ global: 'native JSON route' })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
