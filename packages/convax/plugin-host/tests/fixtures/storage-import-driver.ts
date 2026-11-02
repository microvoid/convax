/** Production profile driver for the one-time legacy graph handoff. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type {} from '@deepseek-ai/dsh-convax-plugin-host'
import type { CanvasId, CanvasOperationId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { bootProductionProfile } from '../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

const [overlay, phase] = process.argv.slice(2)
if (overlay === undefined || (phase !== 'import' && phase !== 'reopen')) throw new Error('Storage import driver requires overlay and phase')
const ctx = await bootProductionProfile({
  binName: 'convax-storage-import-test', profile: 'headless',
  overlayPaths: [fileURLToPath(new URL('../../../plugin-renderer/cordis.patch.yml', import.meta.url)), overlay],
})
try {
  const entry = [...ctx.loader.entries()].find(value => value.options.id === 'convax-host')
  await entry?.fiber?.await()
  const host = ctx.get('convax')
  assert(host !== undefined, 'Real Loader must activate the Convax Host')
  if (phase === 'import') {
    assert.equal(host.workspace().canvases[0]?.title, 'Legacy saved canvas')
    assert.equal((await host.execute({
      canvasId: 'legacy-canvas' as CanvasId, expectedRevision: 1,
      operationId: 'owned-rename' as CanvasOperationId, command: { kind: 'rename', title: 'Owned canvas' },
    })).ok, true)
  }
  assert.equal(host.workspace().revision, 2)
  assert.equal(host.workspace().canvases[0]?.title, 'Owned canvas')
  assert.equal((await host.execute({
    canvasId: 'legacy-canvas' as CanvasId, expectedRevision: 1,
    operationId: 'owned-rename' as CanvasOperationId, command: { kind: 'rename', title: 'Owned canvas' },
  })).ok, true, 'The original receipt must survive import and a separate process restart')
  await writeFile('convax-storage-import-report.json', JSON.stringify({ phase, workspace: host.workspace() }))
} finally { await ctx.fiber.dispose() }
