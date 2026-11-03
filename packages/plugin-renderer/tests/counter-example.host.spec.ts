/** The shipped example uses the real Host registry and durable graph commands. */
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { ConvaxHost } from '../../plugin-host/src/index.ts'
import { CanvasDatabase } from '../../plugin-host/src/database.ts'
import { CanvasRepository } from '../../plugin-host/src/repository.ts'
import { CanvasNodeRegistry } from '../../plugin-host/src/registry.ts'
import type { CanvasCommand, CanvasCommandRequest, CanvasData, CanvasId, CanvasNode, CanvasNodeId,
  CanvasNodeTypeId, CanvasOperationId } from '../../plugin-host/src/types.ts'

interface ExamplePlugin {
  name: string
  apply(ctx: Context): void
}

// Computed import exercises the example's distributed ESM without treating its JavaScript as repository TS source.
const exampleUrl = new URL('../examples/counter/index.js', import.meta.url).href
const typeId = 'example.convax.counter' as CanvasNodeTypeId
const canvasId = 'example-board' as CanvasId
const nodeId = 'example-counter' as CanvasNodeId

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'convax-counter-example-'))
  const opened: Array<{ ctx: Context; host: ConvaxHost; database: CanvasDatabase }> = []
  const contexts: Context[] = []
  onTestFinished(async () => {
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
    for (const resource of opened.reverse()) {
      await resource.host.close()
      await resource.database.close()
    }
    await rm(root, { recursive: true, force: true })
  })
  const createContext = () => {
    const ctx = new Context()
    contexts.push(ctx)
    return ctx
  }
  const open = async (ctx = createContext()) => {
    const database = await CanvasDatabase.open({ path: join(root, 'canvas.sqlite') })
    const report = vi.fn()
    const registry = new CanvasNodeRegistry(report)
    const repository = new CanvasRepository(database, registry, report)
    const host = new ConvaxHost(ctx, repository, {
      previewBytes: 1024, documentBytes: 1024, mediaChunkBytes: 1024,
    })
    opened.push({ ctx, host, database })
    return { ctx, host, registry, database, report }
  }
  const plugin = await import(exampleUrl) as ExamplePlugin
  return { createContext, open, plugin }
}

function request(operation: string, revision: number, command: CanvasCommand): CanvasCommandRequest {
  return { canvasId, operationId: operation as CanvasOperationId, expectedRevision: revision, command }
}

function counter(data: CanvasData = { value: 2 }): CanvasNode {
  return { id: nodeId, typeId, dataVersion: 1, data, revision: 0, position: { x: 160, y: 120 } }
}

describe('Convax counter example Host', () => {
  it('loads without Convax and registers only while its optional Host service is available', async () => {
    const b = await fixture()
    expect(b.plugin.name).toBe('convax-counter-example')
    const ctx = b.createContext()
    const fiber = ctx.plugin(b.plugin)
    await fiber.await()
    expect(ctx.get('convax')).toBeUndefined()
    const active = await b.open(ctx)
    await vi.waitFor(() => {
      expect(active.registry.list()).toEqual([{ id: typeId, dataVersion: 1, ports: [], description: 'An editable integer counter.',
        dataSchema: { type: 'object', required: ['value'], properties: {
          value: { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
        }, additionalProperties: false },
      }])
    })
    await fiber.dispose()
    expect(active.registry.list()).toEqual([])
    expect(active.report).not.toHaveBeenCalled()
  })

  it('validates saved counter values before graph writes and preserves a rejected add', async () => {
    const b = await fixture()
    const active = await b.open()
    const fiber = active.ctx.plugin(b.plugin)
    await fiber.await()
    const definition = active.registry.get(typeId)
    expect(definition).toBeDefined()
    for (const value of [-1, 0, Number.MAX_SAFE_INTEGER]) {
      expect(definition?.parse({ value, ignored: 'not persisted' })).toEqual({ value })
    }
    const invalid: CanvasData[] = [{}, { value: null }, { value: '2' }, { value: 0.5 }, { value: Number.MAX_SAFE_INTEGER + 1 }]
    for (const data of invalid) expect(() => definition?.parse(data)).toThrow()
    expect(await active.host.execute(request('create', 0, { kind: 'create', title: 'Example board' })))
      .toMatchObject({ ok: true })
    const before = active.host.workspace()
    expect(await active.host.execute(request('invalid-add', 1, { kind: 'add-node', node: counter({ value: '2' }) })))
      .toMatchObject({ ok: false, code: 'invalid-command' })
    expect(active.host.workspace()).toEqual(before)
    expect(active.report).not.toHaveBeenCalled()
  })

  it('commits counter updates once, retains nodes on unload, and reopens their saved values', async () => {
    const b = await fixture()
    const active = await b.open()
    const fiber = active.ctx.plugin(b.plugin)
    await fiber.await()
    expect(await active.host.execute(request('create', 0, { kind: 'create', title: 'Example board' })))
      .toMatchObject({ ok: true })
    expect(await active.host.execute(request('add', 1, { kind: 'add-node', node: counter() })))
      .toMatchObject({ ok: true })
    const update = request('increment', 2, { kind: 'update-node', nodeId, dataVersion: 1, data: { value: 3 } })
    expect(await active.host.execute(update)).toMatchObject({ ok: true })
    const committed = active.host.workspace()
    expect(await active.host.execute(update)).toMatchObject({ ok: true, workspace: committed })
    await fiber.dispose()
    expect(active.host.workspace().canvases[0]?.nodes).toEqual(committed.canvases[0]?.nodes)
    expect(await active.host.execute(request('unavailable-update', 3,
      { kind: 'update-node', nodeId, dataVersion: 1, data: { value: 4 } })))
      .toMatchObject({ ok: false, code: 'provider-unavailable' })
    await active.ctx.fiber.dispose()
    await active.host.close()
    await active.database.close()

    const reopened = await b.open()
    await reopened.ctx.plugin(b.plugin).await()
    expect(reopened.host.workspace().canvases[0]?.nodes).toEqual(committed.canvases[0]?.nodes)
    expect(reopened.host.workspace().canvases[0]?.nodes[0]?.data).toEqual({ value: 3 })
    expect(reopened.report).not.toHaveBeenCalled()
  })
})
