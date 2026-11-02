/** Exercise Convax's installed rows over the production headless profile. */

import assert from 'node:assert/strict'
import { realpath, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import type { FiberState } from '@deepseek-ai/cordis'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { CanvasDatabase } from '../../src/database.ts'
import { z } from 'zod'
import type {
  CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId,
} from '@deepseek-ai/dsh-convax-plugin-host/types'
import type {} from '@deepseek-ai/dsh-convax-plugin-host'
import { bootProductionProfile } from '../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

const [overlay, phase] = process.argv.slice(2)
if (overlay === undefined || (phase !== 'create' && phase !== 'reopen')) {
  throw new Error('Convax Loader fixture requires an overlay and create/reopen phase')
}
const home = process.env['DSH_HOME']
if (home === undefined) throw new Error('Convax Loader fixture requires an isolated DSH_HOME')
const active = 2 as FiberState.ACTIVE
const canvasId = 'loader-canvas' as CanvasId
const fileId = 'loader-file' as CanvasNodeId
const folderId = 'loader-folder' as CanvasNodeId
const windowId = 'loader-window' as CanvasNodeId
const windowData = { bindingId: 'bcb746ca-2b66-4ca6-97ef-215df25e638a', name: 'Mirror test window' }
const sqlitePath = join(home, 'storages', 'convax-canvas.sqlite')
const defaultDomain = defineDomain({
  name: 'convax_loader_default_probe', version: 1,
  global: { schema: z.string(), initial: '' }, tables: {},
})

const ctx = await bootProductionProfile({
  binName: 'convax-loader-test',
  profile: 'headless',
  overlayPaths: [fileURLToPath(new URL('../../../plugin-renderer/cordis.patch.yml', import.meta.url)), overlay],
})
try {
  const hostEntry = [...ctx.loader.entries()].find(entry => entry.options.id === 'convax-host')
  const rendererEntry = [...ctx.loader.entries()].find(entry => entry.options.id === 'convax-renderer')
  assert(hostEntry?.fiber !== undefined, 'Host row must import through Loader')
  assert(rendererEntry?.fiber !== undefined, 'renderer row must import through Loader')
  await hostEntry.fiber.await()
  await rendererEntry.fiber.await()
  assert.equal(hostEntry.fiber.state, active)
  assert.equal(rendererEntry.fiber.state, active)
  for (const entry of [hostEntry, rendererEntry]) {
    const namespace = entry.moduleNamespace
    assert(typeof namespace === 'object' && namespace !== null && 'apply' in namespace)
    assert.equal(typeof namespace.apply, 'function')
    assert(!('default' in namespace), 'function plugins must preserve their namespace exports')
  }
  const host = ctx.get('convax')
  assert(host !== undefined, 'Host must publish its service under the actual Loader injections')
  const hostFiber = hostEntry.fiber
  const initial = host.workspace()
  if (phase === 'create') {
    assert.deepEqual(initial.canvases, [])
    assert.equal((await host.execute({
      canvasId, expectedRevision: 0, operationId: 'loader-create' as CanvasOperationId,
      command: { kind: 'create', title: 'Loader canvas' },
    })).ok, true)
    assert.equal((await host.execute({
      canvasId, expectedRevision: 1, operationId: 'loader-add-file' as CanvasOperationId,
      command: { kind: 'add-node', node: {
        id: fileId, typeId: 'convax.file' as CanvasNodeTypeId, dataVersion: 1,
        data: { path: join(process.cwd(), 'input.txt') }, position: { x: 10, y: 20 }, revision: 0,
      } },
    })).ok, true)
    const definition = host.workspace().nodeTypes.find(type => type.id === 'convax.window')
    assert.equal(definition?.dataVersion, 1)
    const invalid = await host.execute({
      canvasId, expectedRevision: 2, operationId: 'loader-invalid-window' as CanvasOperationId,
      command: { kind: 'add-node', node: {
        id: windowId, typeId: 'convax.window' as CanvasNodeTypeId, dataVersion: 1,
        data: { ...windowData, sourceId: 'window:123:0' }, position: { x: 500, y: 80 }, revision: 0,
      } },
    })
    assert.equal(invalid.ok, false, 'native capture identities do not belong in persisted window payloads')
    assert.equal(host.workspace().canvases[0]?.revision, 2)
    assert.equal((await host.execute({
      canvasId, expectedRevision: 2, operationId: 'loader-add-window' as CanvasOperationId,
      command: { kind: 'add-node', node: {
        id: windowId, typeId: 'convax.window' as CanvasNodeTypeId, dataVersion: 1,
        data: windowData, position: { x: 500, y: 80 }, revision: 0,
      } },
    })).ok, true)
  } else {
    assert.equal(initial.revision, 4, 'reopened Host must read the previous process commit')
    assert.equal(initial.canvases[0]?.revision, 4)
    assert.deepEqual(initial.canvases[0]?.nodes.map(node => node.id), [fileId, windowId, folderId])
    assert.deepEqual(initial.canvases[0]?.nodes.find(node => node.id === windowId)?.data, windowData)
  }

  const rendererFiber = rendererEntry.fiber
  await rendererEntry.update({ disabled: true })
  await rendererFiber.dispose()
  await ctx.loader.await()
  assert.equal(rendererEntry.disabled, true)
  assert.equal(hostEntry.fiber, hostFiber, 'disabling renderer must retain the same Host fiber')
  assert.equal(ctx.get('convax')?.repository, host.repository, 'disabling renderer must retain the Host repository')
  assert.equal(hostEntry.fiber.state, active)
  if (phase === 'create') {
    assert.equal((await host.execute({
      canvasId, expectedRevision: 3, operationId: 'loader-add-folder-after-renderer' as CanvasOperationId,
      command: { kind: 'add-node', node: {
        id: folderId, typeId: 'convax.folder' as CanvasNodeTypeId, dataVersion: 1,
        data: { path: process.cwd() }, position: { x: 100, y: 80 }, revision: 0,
      } },
    })).ok, true)
  } else {
    assert.equal((await host.execute({
      canvasId, expectedRevision: 4, operationId: 'loader-move-after-reopen' as CanvasOperationId,
      command: { kind: 'move-nodes', nodes: [{ id: fileId, position: { x: 300, y: 200 } }] },
    })).ok, true)
  }

  const storageDomain = ctx.get('storageDomain')
  assert(storageDomain !== undefined, 'production storage domain facility must remain mounted')
  const probe = await storageDomain.open(defaultDomain)
  try { await probe.global.set('native JSON route') } finally { await probe.close() }
  await assert.rejects(CanvasDatabase.open({ path: sqlitePath }), { code: 'storage-in-use' })
  const medium = new DatabaseSync(sqlitePath, { readOnly: true })
  let sqliteUnits: string[]
  try {
    sqliteUnits = medium.prepare('SELECT name FROM units ORDER BY name').all().map((row) => {
      assert.equal(typeof row['name'], 'string')
      return String(row['name'])
    })
  } finally { medium.close() }
  assert.deepEqual(sqliteUnits, ['convax'], 'only the routed Convax domain belongs to its database')
  const resource = await host.describe(join(process.cwd(), 'input.txt'))
  const preview = await host.previewFile(resource.path)
  const directory = await host.ensureCanvasDirectory(canvasId)
  assert.equal(directory, await realpath(join(home, 'canvas-workspaces', 'canvas-loader-canvas')))
  assert.equal((await stat(directory)).isDirectory(), true)
  await writeFile('convax-loader-report.json', JSON.stringify({
    phase, workspace: host.workspace(),
    rendererDisabled: rendererEntry.disabled, hostRetained: ctx.get('convax')?.repository === host.repository,
    functionExports: true, sqliteUnits, defaultProbe: 'native JSON route', writerRejected: true,
    directory,
    resource: { kind: resource.kind, text: preview.text, truncated: preview.truncated },
  }))
} finally {
  await ctx.fiber.dispose()
}

const released = await CanvasDatabase.open({ path: sqlitePath })
await released.close()
