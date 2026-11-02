/** Load the distributed Counter example through isolated shipped-profile composition. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {} from '@deepseek-ai/dsh-convax-plugin-host'
import type {
  CanvasCommand, CanvasCommandResult, CanvasId, CanvasNode, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId,
} from '@deepseek-ai/dsh-convax-plugin-host/types'
import { bootProductionProfile } from '../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

const overlay = process.argv[2]
if (overlay === undefined) throw new Error('Counter example fixture requires a production profile overlay')
const exampleUrl = new URL('../../../plugin-renderer/examples/counter/index.js', import.meta.url).href
const exampleOverlay = join(process.cwd(), 'counter-example.patch.yml')
await writeFile(exampleOverlay, `- insert:\n    - id: convax-counter-example\n      name: ${JSON.stringify(exampleUrl)}\n`)

const canvasId = 'counter-example-canvas' as CanvasId
const nodeId = 'counter-example-node' as CanvasNodeId
const typeId = 'example.convax.counter' as CanvasNodeTypeId
const ctx = await bootProductionProfile({
  binName: 'convax-counter-example-test',
  profile: 'headless',
  overlayPaths: [
    fileURLToPath(new URL('../../../plugin-renderer/cordis.patch.yml', import.meta.url)),
    overlay,
    exampleOverlay,
  ],
})

try {
  const exampleRow = [...ctx.loader.entries()].find(entry => entry.options.id === 'convax-counter-example')
  const hostRow = [...ctx.loader.entries()].find(entry => entry.options.id === 'convax-host')
  assert(exampleRow?.fiber !== undefined && hostRow?.fiber !== undefined)
  await hostRow.fiber.await()
  await exampleRow.fiber.await()
  await ctx.loader.await()
  const providerAvailable = (): boolean => ctx.convax.workspace().nodeTypes.some(type => type.id === typeId)
  const node = (): CanvasNode => {
    const saved = ctx.convax.workspace().canvases.find(canvas => canvas.id === canvasId)?.nodes.find(value => value.id === nodeId)
    assert(saved !== undefined)
    return saved
  }
  const execute = async (operationId: string, command: CanvasCommand): Promise<CanvasCommandResult> => {
    const revision = ctx.convax.workspace().canvases.find(canvas => canvas.id === canvasId)?.revision ?? 0
    return ctx.convax.execute({ canvasId, expectedRevision: revision, operationId: operationId as CanvasOperationId, command })
  }
  assert(providerAvailable())
  const create = await execute('counter-create-canvas', { kind: 'create', title: 'Counter example' })
  assert(create.ok, JSON.stringify(create))
  const add = await execute('counter-add-node', {
    kind: 'add-node',
    node: { id: nodeId, typeId, dataVersion: 1, data: { value: 0 }, position: { x: 24, y: 32 }, revision: 0 },
  })
  assert(add.ok, JSON.stringify(add))
  const createdValue = node().data.value
  const update = await execute('counter-increment', { kind: 'update-node', nodeId, dataVersion: 1, data: { value: 1 } })
  assert(update.ok, JSON.stringify(update))
  const incrementedValue = node().data.value
  const beforeInvalid = ctx.convax.workspace().canvases.find(canvas => canvas.id === canvasId)
  const invalid = await execute('counter-fractional-value', { kind: 'update-node', nodeId, dataVersion: 1, data: { value: 1.5 } })
  assert(!invalid.ok)
  assert.equal(invalid.code, 'invalid-command')
  assert.deepEqual(ctx.convax.workspace().canvases.find(canvas => canvas.id === canvasId), beforeInvalid)
  const invalidUpdate = { code: invalid.code, value: node().data.value, canvasUnchanged: true }

  await exampleRow.update({ disabled: true })
  await ctx.loader.await()
  const disabledProvider = { available: providerAvailable(), value: node().data.value, position: node().position }
  await exampleRow.update({ disabled: false })
  await ctx.loader.await()
  assert(exampleRow.fiber !== undefined)
  await exampleRow.fiber.await()
  const restoredProvider = { available: providerAvailable(), value: node().data.value }

  await hostRow.update({ disabled: true })
  await ctx.loader.await()
  assert.equal(ctx.get('convax'), undefined)
  await hostRow.update({ disabled: false })
  await ctx.loader.await()
  assert(hostRow.fiber !== undefined)
  await hostRow.fiber.await()
  const reopenedHost = { available: providerAvailable(), value: node().data.value, position: node().position }
  await writeFile(join(process.cwd(), 'counter-example-report.json'), JSON.stringify({
    createdValue, incrementedValue, invalidUpdate, disabledProvider, restoredProvider, reopenedHost,
  }))
} finally {
  await ctx.fiber.dispose()
}
