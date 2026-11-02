import { readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { graphSchema } from '../src/schema.ts'

const driver = fileURLToPath(new URL('./fixtures/graph-real-model-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/chat-composition.patch.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('Convax graph tools with a real model', () => {
  it('commits graph edits to SQLite through the production Web profile after renderer unload', { timeout: 195_000, retry: 0 }, async () => {
    await runLoaderSmoke({
      label: 'Convax real-model graph tools', tempDirPrefix: 'convax-graph-real-',
      binScript: driver, libBinScript: driver, configPath, binArgs: [configPath], tsconfigPath,
      processTimeoutMs: 180_000, env: { DSH_TELEMETRY_DISABLED: '1' },
      prepare: async (cwd) => { await writeFile(join(cwd, 'input.txt'), 'Unchanged graph reference\n') },
      inspect: async (cwd) => {
        const report: unknown = JSON.parse(await readFile(join(cwd, 'graph-real-report.json'), 'utf8'))
        expect(report).toMatchObject({ rendererDisabled: true, hostRetained: true })
        const database = new DatabaseSync(join(cwd, '.dsh', 'storages', 'convax-canvas.sqlite'), { readOnly: true })
        try {
          const row = database.prepare('SELECT value FROM unit_globals WHERE unit = ?').get('convax')
          if (typeof row?.value !== 'string') throw new Error('The real model left no durable graph')
          const graph = graphSchema.parse(JSON.parse(row.value)).canvases.find(canvas => canvas.id === 'model-graph')
          expect(graph?.nodes.find(node => node.id === 'model-chat')?.position).toEqual({ x: 100, y: 200 })
          expect(graph?.nodes.find(node => node.id === 'model-file')).toMatchObject({
            position: { x: 500, y: 200 }, data: { path: await realpath(join(cwd, 'input.txt')) },
          })
          expect(graph?.nodes.find(node => node.id === 'model-extension')).toMatchObject({
            position: { x: 900, y: 600 }, data: { label: 'Keep this extension payload' },
          })
          expect(graph?.connections).toMatchObject([{ id: 'model-link', source: 'model-file', target: 'model-chat', purpose: 'input' }])
        } finally { database.close() }
        expect(await readFile(join(cwd, 'input.txt'), 'utf8')).toBe('Unchanged graph reference\n')
      },
    })
  })
})
