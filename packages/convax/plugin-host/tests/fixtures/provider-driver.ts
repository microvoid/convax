/** Test-only provider contributions exercise ordinary Convax registration through the Loader. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-convax-plugin-host'
import type { CanvasNodeDefinition } from '@deepseek-ai/dsh-convax-plugin-host'
import type { CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId, CanvasConnectionId, CanvasCommand } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { bootProductionProfile } from '../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

const overlay = process.argv[2]
if (overlay === undefined) throw new Error('Provider fixture requires a production profile overlay')
const typeId = 'test.extension.resource' as CanvasNodeTypeId
const canvasId = 'provider-canvas' as CanvasId
const nodeId = 'extension-node' as CanvasNodeId
const peerId = 'peer-node' as CanvasNodeId
function provider(version: number) {
  return { name: `test-extension-v${version}`, inject: ['convax'], apply(ctx: Context) {
    const definition: CanvasNodeDefinition = { id: typeId, dataVersion: version,
      ports: [{ id: 'out', direction: 'output', valueKind: 'resource' }],
      parse(data) { assert.equal(typeof data.path, 'string'); return data },
      migrations: version === 2 ? [{ fromVersion: 1, migrate: data => ({ ...data, path: 'upgraded' }) }] : [],
    }
    ctx.effect(() => ctx.convax.registerNodeType(definition))
  } }
}
const ctx = await bootProductionProfile({ binName: 'convax-provider-test', profile: 'headless',
  overlayPaths: [fileURLToPath(new URL('../../../plugin-renderer/cordis.patch.yml', import.meta.url)), overlay],
})
try {
  const hostRow = [...ctx.loader.entries()].find(entry => entry.options.id === 'convax-host')
  const rendererRow = [...ctx.loader.entries()].find(entry => entry.options.id === 'convax-renderer')
  assert(hostRow?.fiber !== undefined && rendererRow?.fiber !== undefined)
  await hostRow.fiber.await()
  const host = ctx.convax
  const execute = async (operationId: string, command: CanvasCommand): Promise<void> => {
    const revision = ctx.convax.workspace().canvases.find(canvas => canvas.id === canvasId)?.revision ?? 0
    const result = await ctx.convax.execute({ canvasId, expectedRevision: revision,
      operationId: operationId as CanvasOperationId, command })
    assert(result.ok, JSON.stringify(result))
  }
  const v1 = ctx.plugin(provider(1))
  await v1
  await execute('create', { kind: 'create', title: 'Extension provider' })
  await execute('extension', { kind: 'add-node', node: { id: nodeId, typeId, dataVersion: 1,
    data: { path: 'original', fields: { retained: true } }, position: { x: 10, y: 20 }, revision: 0 } })
  await execute('peer', { kind: 'add-node', node: { id: peerId, typeId: 'convax.file' as CanvasNodeTypeId, dataVersion: 1,
    data: { path: join(process.cwd(), 'peer.txt') }, position: { x: 300, y: 20 }, revision: 0 } })
  await execute('connect', { kind: 'add-connection', connection: { id: 'extension-edge' as CanvasConnectionId,
    source: nodeId, sourcePort: 'out', target: peerId, targetPort: 'input', purpose: 'input' } })
  await rendererRow.update({ disabled: true })
  await ctx.loader.await()
  await v1.dispose()
  assert(!host.workspace().nodeTypes.some(type => type.id === typeId))
  const absent = host.workspace().canvases[0]!
  assert.equal(absent.nodes[0]!.data.path, 'original')
  assert.equal(absent.connections.length, 1)
  const incompatible = ctx.plugin(provider(3))
  await incompatible
  await host.retryMigrations()
  assert.equal(host.workspace().nodeIssues[0]?.kind, 'incompatible')
  assert.equal(host.workspace().canvases[0]?.nodes[0]?.data.path, 'original')
  await incompatible.dispose()
  const v2 = ctx.plugin(provider(2))
  await v2
  await host.retryMigrations()
  assert.deepEqual(host.workspace().nodeIssues, [])
  const upgraded = host.workspace().canvases[0]!.nodes[0]!
  assert.equal(upgraded.dataVersion, 2)
  assert.equal(upgraded.data.path, 'upgraded')
  assert.deepEqual(upgraded.position, { x: 10, y: 20 })
  await v2.dispose()
  await hostRow.update({ disabled: true })
  await ctx.loader.await()
  assert.equal(ctx.get('convax'), undefined)
  await hostRow.update({ disabled: false })
  await ctx.loader.await()
  await hostRow.fiber?.await()
  const reopened = ctx.convax
  assert.notEqual(reopened.repository, host.repository)
  const reloaded = ctx.plugin(provider(2))
  await reloaded
  await reopened.retryMigrations()
  const result = reopened.workspace().canvases[0]!
  assert.deepEqual(result.nodes[0], upgraded)
  assert.equal(result.connections.length, 1)
  const home = process.env['DSH_HOME']
  assert(home !== undefined)
  const database = new DatabaseSync(join(home, 'storages', 'convax-canvas.sqlite'), { readOnly: true })
  let copies: number
  try {
    const records = database.prepare('SELECT value FROM u_convax_node_migrations').all()
    assert.equal(records.length, 1)
    const text = records[0]?.['value']
    assert.equal(typeof text, 'string')
    const record: unknown = JSON.parse(String(text))
    assert.deepEqual(record, { canvasId, nodeId, typeId, sourceVersion: 1, targetVersion: 2,
      sourceRevision: 1, resultRevision: 2, sourceData: { path: 'original', fields: { retained: true } },
      resultData: { path: 'upgraded', fields: { retained: true } } })
    copies = records.length
  } finally { database.close() }
  await writeFile(join(process.cwd(), 'provider-report.json'), JSON.stringify({
    providerRemoved: true, geometryRetained: true, connectionRetained: true, dataVersion: result.nodes[0].dataVersion,
    originalPath: 'original', currentPath: result.nodes[0].data.path,
    hostReopened: true, copies, rendererDisabled: rendererRow.disabled, unsupportedRetained: true,
  }))
  await reloaded.dispose()
} finally { await ctx.fiber.dispose() }
