/** Graph tools use real Session bindings and commit through the SQLite-backed Host. */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import * as Convax from '../src/index.ts'
import * as DefaultNodes from '../../plugin-inernal-nodes-host/src/index.ts'
import type { CanvasCommand, CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId, CanvasResource } from '../src/types.ts'

const canvasId = 'canvas-a' as CanvasId
const otherCanvasId = 'canvas-b' as CanvasId
const chatId = 'chat-a' as CanvasNodeId
const toolNames = ['convax_graph', 'convax_commit', 'convax_query_canvases', 'convax_add_file', 'convax_connect', 'convax_move_nodes', 'convax_arrange_nodes']
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanups.splice(0).reverse()) await close()
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'convax-tools-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(RemoteAccess)
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions') })
  const fiber = ctx.plugin(Convax, { databasePath: join(root, 'convax-canvas.sqlite'), canvasDirectoryRoot: join(root, 'workspaces'), previewBytes: 1024, documentBytes: 1024, mediaChunkBytes: 1024 })
  await fiber
  await fiber.await()
  const nodesFiber = ctx.plugin(DefaultNodes)
  await nodesFiber
  const host = ctx.convax
  const driver = await mountAgentLoopTestHarness(ctx)
  const owner = await driver.create(SessionId('graph-owner'), {}, { cwd: root })
  const outsider = await driver.create(SessionId('graph-outsider'), {}, { cwd: root })
  const revision = (id = canvasId): number => host.workspace().canvases.find(canvas => canvas.id === id)?.revision ?? 0
  let operation = 0, call = 0
  const execute = async (command: CanvasCommand, id = canvasId) => {
    const result = await host.execute({
      canvasId: id, operationId: `seed-${++operation}` as CanvasOperationId, expectedRevision: revision(id), command,
    })
    expect(result.ok).toBe(true)
    return result
  }
  await execute({ kind: 'create', title: 'Alpha' })
  await execute({ kind: 'add-node', node: {
    id: chatId, typeId: 'convax.chat' as CanvasNodeTypeId, dataVersion: 1, revision: 0,
    data: { title: 'Chat', cwd: root }, position: { x: 10, y: 20 },
  } })
  await execute({ kind: 'create', title: 'Beta' }, otherCanvasId)
  const bindingId = 'bind-owner' as CanvasOperationId
  await host.repository.coordination.reserveThread({
    kind: 'create', canvasId, nodeId: chatId, expectedRevision: revision(), operationId: bindingId,
  }, root)
  expect(await host.repository.coordination.completeThread(bindingId, owner.id, 0)).toBe(true)
  const path = join(root, 'notes.txt')
  await writeFile(path, 'Original contents\n')
  const invoke = (name: string, args: object, options: { agent?: Agent | null; signal?: AbortSignal } = {}) => executeToolFixture(ctx, {
    callId: ToolCallId(`tool-${++call}`), name, arguments: args,
    signal: options.signal ?? new AbortController().signal,
    ...options.agent === null ? {} : { agent: options.agent ?? owner },
  })
  const add = (nodeId = 'file-a', extra: object = {}) => invoke('convax_add_file', {
    nodeId, path, position: { x: 30, y: 40 }, operationId: `add-${nodeId}`, expectedRevision: revision(), ...extra,
  })
  return { ctx, host, owner, outsider, fiber, nodesFiber, root, path, revision, execute, invoke, add }
}

describe('Convax graph tools', () => {
  it('discovers provider schemas and omits unrequested collections explicitly', async () => {
    const f = await fixture()
    const summary = await f.invoke('convax_graph', {})
    expect(summary.isError).toBe(false)
    expect(summary.value).toMatchObject({ canvasId, revision: 3, chatNodeId: chatId, projection: { nodes: false, connections: false } })
    expect(summary.value).not.toHaveProperty('nodes')
    const types = await f.invoke('convax_graph', { include: ['nodeTypes'] })
    expect(types.isError).toBe(false)
    expect(types.value).toHaveProperty('nodeTypes.0.id', 'convax.file')
    expect(types.value).toHaveProperty('nodeTypes.0.dataVersion', 1)
    expect(types.value).toHaveProperty('nodeTypes.0.dataSchema.required', ['path'])
    expect(types.value).toHaveProperty('nodeTypes.0.dataSchema.properties.path.type', 'string')
    expect(types.value).not.toHaveProperty('canvases')
  })

  it('uses a third-party resource provider through the same public capability after default nodes are disabled', async () => {
    const f = await fixture()
    await f.nodesFiber.dispose()
    const typeId = 'thirdparty.document' as CanvasNodeTypeId
    cleanups.push(f.host.registerNodeType({ id: typeId, dataVersion: 2, capabilities: { resourceKind: 'file' },
      ports: [], parse: data => data }))
    const result = await f.add('custom-file')
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ ok: true })
    expect(f.host.workspace().canvases[0]?.nodes.find(node => node.id === 'custom-file')).toMatchObject({ typeId, dataVersion: 2, data: { path: f.path } })
    expect(f.host.repository.bindingOf(f.owner.id)).toMatchObject({ nodeId: chatId })
    expect(f.ctx.agents.get(f.owner.id)).toBe(f.owner)
  })

  it('commits ordered plugin operations once and projects selected incident edges', async () => {
    const f = await fixture()
    const typeId = 'fixture.note' as CanvasNodeTypeId
    cleanups.push(f.host.registerNodeType({ id: typeId, dataVersion: 1, description: 'A titled note.',
      dataSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } }, additionalProperties: false },
      ports: [{ id: 'out', direction: 'output', valueKind: 'resource' }],
      parse(data) { if (typeof data.title !== 'string') throw new Error('title required'); return { title: data.title } },
    }))
    const request = { expectedRevision: f.revision(), operationId: 'ordered', ops: [
      { op: 'node.add', id: 'note', typeId, dataVersion: 1, data: { title: 'Draft' }, position: { x: 0, y: 0 } },
      { op: 'edge.add', id: 'note-chat', source: 'note', sourcePort: 'out', target: chatId, targetPort: 'input', purpose: 'input' },
      { op: 'node.set', id: 'note', ifRevision: 1, dataVersion: 1, data: { title: 'Final' }, position: { x: 320, y: 10 } },
    ] }
    const notifications = vi.fn()
    const unsubscribe = f.host.repository.subscribe(notifications)
    cleanups.push(async () => { unsubscribe() })
    expect((await f.invoke('convax_commit', request)).value).toMatchObject({ ok: true, revision: 4, error: null })
    expect(notifications).toHaveBeenCalledOnce()
    expect((await f.invoke('convax_commit', request)).value).toMatchObject({ ok: true, revision: 4 })
    expect(notifications).toHaveBeenCalledOnce()
    const selected = await f.invoke('convax_graph', { include: ['nodes', 'connections'], selection: { incidentTo: ['note'] },
      fields: { nodes: ['data', 'revision'], connections: ['source', 'target'] } })
    expect(selected.isError).toBe(false)
    expect(selected.value).toMatchObject({ projection: { completeNodes: false, completeConnections: false }, nodes: [
      { id: chatId, revision: 1 }, { id: 'note', revision: 2, data: { title: 'Final' } },
    ], connections: [{ id: 'note-chat', source: 'note', target: chatId }] })
    expect(selected.value).not.toHaveProperty('nodeTypes')
    expect(f.host.workspace().canvases[0]?.nodes.find(node => node.id === 'note')?.position).toEqual({ x: 320, y: 10 })
    expect((await f.invoke('convax_commit', { ...request, ops: request.ops.slice(0, 1) })).value)
      .toMatchObject({ ok: false, error: { code: 'invalid-command' } })
  })

  it('rolls back every staged operation on a late rejection without consuming its identity', async () => {
    const f = await fixture()
    const before = f.host.workspace()
    const first = { op: 'node.add', id: 'file-batch', typeId: 'convax.file', dataVersion: 1, data: { path: f.path }, position: { x: 0, y: 0 } }
    const request = { expectedRevision: f.revision(), operationId: 'late-failure', ops: [first,
      { op: 'edge.add', id: 'bad-port', source: 'file-batch', sourcePort: 'missing', target: chatId, targetPort: 'input', purpose: 'input' },
    ] }
    expect((await f.invoke('convax_commit', request)).value).toMatchObject({ ok: false, revision: 3, error: { code: 'invalid-command', opIndex: 1 } })
    expect(f.host.workspace()).toEqual(before)
    expect((await f.invoke('convax_commit', { ...request, ops: [first] })).value).toMatchObject({ ok: true, revision: 4 })
    await rm(f.path)
    expect((await f.invoke('convax_commit', { ...request, ops: [first] })).value).toMatchObject({ ok: true, revision: 4 })
  })

  it('uses whole data replacement, staged node guards and one history entry per batch', async () => {
    const f = await fixture()
    await f.add('replace')
    const request = { expectedRevision: f.revision(), operationId: 'replace-data', ops: [
      { op: 'node.set', id: 'replace', dataVersion: 1, data: { path: f.path, extra: true } },
      { op: 'node.set', id: 'replace', ifRevision: 2, dataVersion: 1, data: { path: f.path } },
      { op: 'node.set', id: 'replace', ifRevision: 3, position: { x: 111, y: 222 } },
    ] }
    expect((await f.invoke('convax_commit', request)).value).toMatchObject({ ok: true, revision: 5 })
    expect(f.host.workspace().canvases[0]?.nodes.find(node => node.id === 'replace')).toMatchObject({ revision: 4, data: { path: f.path }, position: { x: 111, y: 222 } })
    const undo = { operationId: 'undo-batch', expectedRevision: 5, ops: [{ op: 'history', targetOperationId: 'replace-data', direction: 'undo' }] }
    expect((await f.invoke('convax_commit', undo)).value).toMatchObject({ ok: true, revision: 6 })
    expect(f.host.workspace().canvases[0]?.nodes.find(node => node.id === 'replace')?.position).toEqual({ x: 30, y: 40 })
    expect((await f.invoke('convax_commit', { operationId: 'redo-batch', expectedRevision: 6,
      ops: [{ op: 'history', targetOperationId: 'replace-data', direction: 'redo' }] })).value).toMatchObject({ ok: true, revision: 7 })
    expect((await f.invoke('convax_commit', { ...request, operationId: 'stale' })).value).toMatchObject({ ok: false, error: { code: 'conflict' } })
    expect((await f.invoke('convax_commit', { ...request, operationId: 'bad-node-version', expectedRevision: 7,
      ops: [{ op: 'node.set', id: 'replace', ifRevision: 1, position: { x: 0, y: 0 } }] })).value)
      .toMatchObject({ ok: false, error: { code: 'conflict', opIndex: 0 } })
  })

  it('rejects identity replacement even when a preceding operation temporarily removes the record', async () => {
    const f = await fixture()
    await f.add('identity-file')
    expect((await f.invoke('convax_connect', { connectionId: 'identity-edge', source: 'identity-file', sourcePort: 'output',
      target: chatId, targetPort: 'input', operationId: 'identity-connect', expectedRevision: f.revision() })).value).toMatchObject({ ok: true })
    const before = f.host.workspace()
    const replacements = [
      [{ op: 'node.remove', id: 'identity-file' }, { op: 'node.add', id: 'identity-file', typeId: 'convax.file',
        dataVersion: 1, data: { path: f.path }, position: { x: 1, y: 2 } }],
      [{ op: 'edge.remove', id: 'identity-edge' }, { op: 'edge.add', id: 'identity-edge', source: 'identity-file',
        sourcePort: 'output', target: chatId, targetPort: 'input', purpose: 'input' }],
    ]
    for (const ops of replacements) {
      expect((await f.invoke('convax_commit', { operationId: 'replace-identity', expectedRevision: f.revision(), ops })).value)
        .toMatchObject({ ok: false, error: { code: 'invalid-command', opIndex: 1 } })
      expect(f.host.workspace()).toEqual(before)
    }
  })

  it('undoes and redoes canvas creation and removal using retained version fences', async () => {
    const f = await fixture()
    const target = 'lifecycle-canvas'
    const commit = (operationId: string, expectedRevision: number, ops: object[]) => f.invoke('convax_commit', { canvasId: target, operationId, expectedRevision, ops })
    expect((await commit('new-canvas', 0, [{ op: 'canvas.add', title: 'Created' }])).value).toMatchObject({ ok: true, revision: 1 })
    expect((await commit('undo-create', 1, [{ op: 'history', targetOperationId: 'new-canvas', direction: 'undo' }])).value).toMatchObject({ ok: true, revision: 2 })
    expect(f.host.workspace().canvases.some(canvas => canvas.id === target)).toBe(false)
    expect((await commit('redo-create', 2, [{ op: 'history', targetOperationId: 'new-canvas', direction: 'redo' }])).value).toMatchObject({ ok: true, revision: 3 })
    expect((await commit('remove-canvas', 3, [{ op: 'canvas.remove' }])).value).toMatchObject({ ok: true, revision: 4 })
    expect((await commit('remove-canvas', 3, [{ op: 'canvas.remove' }])).value).toMatchObject({ ok: true, revision: 4 })
    expect((await commit('restore-canvas', 4, [{ op: 'history', targetOperationId: 'remove-canvas', direction: 'undo' }])).value).toMatchObject({ ok: true, revision: 5 })
    expect((await commit('remove-again', 5, [{ op: 'history', targetOperationId: 'remove-canvas', direction: 'redo' }])).value).toMatchObject({ ok: true, revision: 6 })
    expect((await commit('reuse-canvas', 0, [{ op: 'canvas.add', title: 'Reused' }])).value).toMatchObject({ ok: false, error: { code: 'conflict' } })
  })

  it('rejects mixed history, unknown operations and cancelled resource checks without graph changes', async () => {
    const f = await fixture()
    const before = f.host.workspace()
    for (const ops of [[], [{ op: 'node.unknown' }], [{ op: 'history', targetOperationId: 'x', direction: 'undo' }, { op: 'canvas.set', title: 'X' }]]) {
      expect((await f.invoke('convax_commit', { operationId: 'invalid', expectedRevision: 3, ops })).isError).toBe(true)
    }
    expect((await f.invoke('convax_commit', { operationId: 'cancelled', expectedRevision: 3, ops: [
      { op: 'node.add', id: 'cancelled', typeId: 'convax.file', dataVersion: 1, data: { path: f.path }, position: { x: 0, y: 0 } },
    ] }, { signal: AbortSignal.abort() })).isError).toBe(true)
    expect(f.host.workspace()).toEqual(before)
  })

  it('reports organizational archive state without changing the bound Session or restricting graph reads', async () => {
    const f = await fixture()
    await f.execute({ kind: 'set-archived', archived: true })
    const result = await f.invoke('convax_query_canvases', {})
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ canvasId, chatNodeId: chatId, canvas: { archived: true },
      canvases: [{ id: canvasId, archived: true }, { id: otherCanvasId }] })
    expect(f.host.repository.bindingOf(f.owner.id)).toMatchObject({ canvasId, nodeId: chatId })
  })

  it('registers on the Host and resolves the actual Session binding without renderer state', async () => {
    const f = await fixture()
    for (const name of toolNames) expect(f.ctx.tools.get(name, f.owner)).toBeDefined()
    const bound = await f.invoke('convax_query_canvases', {})
    expect(bound.isError).toBe(false)
    expect(bound.value).toMatchObject({
      canvasId, chatNodeId: chatId, canvas: { id: canvasId }, canvases: [{ id: canvasId }, { id: otherCanvasId }],
    })
    const unbound = await f.invoke('convax_query_canvases', {}, { agent: f.outsider })
    expect(unbound.value).toMatchObject({
      canvasId: null, chatNodeId: null, canvas: null, canvases: [{ id: canvasId }, { id: otherCanvasId }],
    })
    const explicit = await f.invoke('convax_query_canvases', { canvasId: otherCanvasId })
    expect(explicit.value).toMatchObject({ canvasId: otherCanvasId, chatNodeId: null, canvas: { title: 'Beta' } })
    await f.fiber.dispose()
    for (const name of toolNames) expect(f.ctx.tools.get(name, f.owner)).toBeUndefined()
  })

  it('presents stable canvas action titles and opens the original resource location for a reference', async () => {
    const f = await fixture()
    const mutation = { expectedRevision: f.revision(), operationId: 'presentation' }
    const cases = [
      ['convax_query_canvases', 'Query canvases', {}],
      ['convax_add_file', 'Add canvas reference', { ...mutation, nodeId: 'reference', path: f.path, position: { x: 30, y: 40 } }],
      ['convax_connect', 'Connect canvas nodes', {
        ...mutation, connectionId: 'connection', source: 'reference', sourcePort: 'output', target: chatId, targetPort: 'input',
      }],
      ['convax_move_nodes', 'Move canvas nodes', { ...mutation, nodes: [{ id: chatId, position: { x: 30, y: 40 } }] }],
      ['convax_arrange_nodes', 'Arrange canvas nodes', {
        ...mutation, nodeIds: [chatId], origin: { x: 30, y: 40 }, columns: 2, columnGap: 400, rowGap: 250,
      }],
    ] as const
    for (const [name, title, args] of cases) {
      const definition = f.ctx.tools.get(name, f.owner)
      expect(definition?.presentCall?.(Object.freeze(args))).toEqual({
        card: 'generic', title, ...name === 'convax_add_file' ? { locations: [{ path: f.path }] } : {},
      })
    }
  })

  it('lists canvases for a detached caller and requires an explicit target before editing', async () => {
    const f = await fixture()
    expect((await f.invoke('convax_query_canvases', {}, { agent: null })).value)
      .toMatchObject({ canvasId: null, chatNodeId: null, canvas: null })
    const args = { nodes: [{ id: chatId, position: { x: 50, y: 60 } }], operationId: 'detached', expectedRevision: f.revision() }
    const rejected = await f.invoke('convax_move_nodes', args, { agent: null })
    expect(rejected).toMatchObject({ isError: true, content: [{ type: 'text', text:
      'Error: canvasId is required for an unbound Session. Use convax_query_canvases to list saved canvases.' }] })
    expect((await f.invoke('convax_move_nodes', { ...args, canvasId }, { agent: null })).value).toMatchObject({ ok: true })
    expect(f.host.workspace().canvases[0]?.nodes[0]?.position).toEqual({ x: 50, y: 60 })
  })

  it.each([
    { expectedRevision: 0, operationId: 'bad-revision', error: 'expectedRevision must be a positive safe integer' },
    { operationId: '', error: 'operationId must be a non-empty identity without surrounding whitespace' },
    { operationId: ' padded ', error: 'operationId must be a non-empty identity without surrounding whitespace' },
  ])('rejects an invalid edit identity or revision with actionable feedback: $operationId', async (input) => {
    const f = await fixture()
    const before = f.host.workspace()
    const { error, ...request } = input
    const result = await f.invoke('convax_move_nodes', {
      nodes: [{ id: chatId, position: { x: 50, y: 60 } }], expectedRevision: f.revision(), ...request,
    })
    expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: `Error: ${error}` }] })
    expect(f.host.workspace()).toEqual(before)
  })

  it('filters incompatible provider diagnostics by the selected canvas and returns all issues when listing canvases', async () => {
    const f = await fixture()
    const typeId = 'fixture.diagnostics' as CanvasNodeTypeId
    const removeProvider = f.host.registerNodeType({ id: typeId, dataVersion: 1, ports: [], parse: data => data })
    cleanups.push(removeProvider)
    for (const [id, target] of [['extension-a', canvasId], ['extension-b', otherCanvasId]] as const) {
      await f.execute({ kind: 'add-node', node: {
        id: id as CanvasNodeId, typeId, dataVersion: 1, revision: 0, data: { label: id }, position: { x: 0, y: 0 },
      } }, target)
    }
    await removeProvider()
    const removeReplacement = f.host.registerNodeType({ id: typeId, dataVersion: 2, ports: [], parse: data => data })
    cleanups.push(removeReplacement)
    await f.host.retryMigrations()
    const selected = await f.invoke('convax_query_canvases', {})
    expect(selected.value).toMatchObject({ nodeIssues: [{ canvasId, nodeId: 'extension-a', kind: 'incompatible' }] })
    const listed = await f.invoke('convax_query_canvases', {}, { agent: f.outsider })
    expect(listed.value).toMatchObject({ nodeIssues: [
      { canvasId, nodeId: 'extension-a', kind: 'incompatible' },
      { canvasId: otherCanvasId, nodeId: 'extension-b', kind: 'incompatible' },
    ] })
  })

  it('rejects unsupported resources and an unavailable file provider before submitting a mutation', async () => {
    const f = await fixture()
    const before = f.host.workspace()
    vi.spyOn(f.host, 'describe').mockResolvedValueOnce({ path: f.path, name: 'device', kind: 'other', size: null })
    expect(await f.add('device')).toMatchObject({ isError: true, content: [{
      type: 'text', text: 'Error: Only regular files and folders can be added as canvas references',
    }] })
    // The tool consumes provider availability through the Host snapshot, including when its provider is absent.
    vi.spyOn(f.host, 'workspace').mockReturnValue({ ...before, nodeTypes: [] })
    const execute = vi.spyOn(f.host, 'execute')
    expect(await f.add('provider-missing')).toMatchObject({ isError: true, content: [{
      type: 'text', text: 'Error: Node provider for file references is unavailable. Enable its provider before adding a reference.',
    }] })
    expect(execute).not.toHaveBeenCalled()
    expect(f.host.repository.snapshot().canvases).toEqual(before.canvases)
  })

  it('requires an explicit canvas for unbound mutations and supports explicit cross-canvas edits', async () => {
    const f = await fixture()
    const before = f.host.workspace()
    const rejected = await f.invoke('convax_add_file', {
      nodeId: 'unbound', path: f.path, position: { x: 0, y: 0 }, expectedRevision: f.revision(), operationId: 'unbound',
    }, { agent: f.outsider })
    expect(rejected.isError).toBe(true)
    expect(f.host.workspace()).toEqual(before)
    const result = await f.add('cross-canvas', { canvasId: otherCanvasId, expectedRevision: f.revision(otherCanvasId) })
    expect(result.value).toMatchObject({ ok: true, canvasId: otherCanvasId, error: null })
    expect(f.host.workspace().canvases[0]?.nodes).toHaveLength(1)
    expect(f.host.workspace().canvases[1]?.nodes).toMatchObject([{ id: 'cross-canvas', data: { path: f.path } }])
  })

  it('adds existing folder references and retains the graph when a resource is unavailable', async () => {
    const f = await fixture()
    expect((await f.add('folder', { path: f.root })).value).toMatchObject({ ok: true })
    expect(f.host.workspace().canvases[0]?.nodes.find(node => node.id === 'folder')).toMatchObject({
      typeId: 'convax.folder', data: { path: f.root },
    })
    const before = f.host.workspace()
    expect((await f.add('missing', { path: join(f.root, 'missing.txt') })).isError).toBe(true)
    expect(f.host.workspace()).toEqual(before)
  })

  it('blocks implicit edits from a deleting Chat while allowing an explicitly named different canvas', async () => {
    const f = await fixture()
    await f.host.repository.coordination.beginDeletion({
      canvasId, expectedRevision: f.revision(), operationId: 'delete-chat' as CanvasOperationId,
      command: { kind: 'remove-nodes', nodeIds: [chatId] }, confirmed: true,
    })
    const before = f.host.workspace()
    expect((await f.add('blocked')).isError).toBe(true)
    expect(f.host.workspace()).toEqual(before)
    expect((await f.add('different', { canvasId: otherCanvasId, expectedRevision: f.revision(otherCanvasId) })).value)
      .toMatchObject({ ok: true, canvasId: otherCanvasId })
  })

  it('adds references idempotently, connects compatible ports, and arranges only named nodes atomically', async () => {
    const f = await fixture()
    const first = { nodeId: 'file-a', path: f.path, position: { x: 30, y: 40 }, operationId: 'add-a', expectedRevision: f.revision() }
    expect((await f.invoke('convax_add_file', first)).value).toMatchObject({ ok: true })
    const committed = f.host.workspace()
    expect((await f.invoke('convax_add_file', first)).value).toMatchObject({ ok: true })
    expect(f.host.workspace()).toEqual(committed)
    expect((await f.invoke('convax_add_file', { ...first, position: { x: 90, y: 40 } })).value).toMatchObject({ ok: false, error: { code: 'invalid-command' } })
    await f.add('untouched')
    const source = f.host.workspace().canvases[0]!.nodes.find(node => node.id === 'untouched')!
    const connect = { connectionId: 'link', source: 'file-a', sourcePort: 'output', target: chatId, targetPort: 'input', operationId: 'connect', expectedRevision: f.revision() }
    expect((await f.invoke('convax_connect', connect)).value).toMatchObject({ ok: true })
    expect(f.owner.inbox.nextTurn).toEqual([])
    expect(f.owner.inbox.nextStep).toEqual([])
    expect((await f.invoke('convax_move_nodes', {
      nodes: [{ id: 'file-a', position: { x: -40, y: 70 } }], expectedRevision: f.revision(), operationId: 'move',
    })).value).toMatchObject({ ok: true })
    expect((await f.invoke('convax_arrange_nodes', {
      nodeIds: [chatId, 'file-a'], origin: { x: 100, y: 200 }, columns: 2, columnGap: 400, rowGap: 250,
      expectedRevision: f.revision(), operationId: 'arrange',
    })).value).toMatchObject({ ok: true })
    const canvas = f.host.workspace().canvases[0]!
    expect(canvas.nodes.find(node => node.id === chatId)?.position).toEqual({ x: 100, y: 200 })
    expect(canvas.nodes.find(node => node.id === 'file-a')?.position).toEqual({ x: 500, y: 200 })
    expect(canvas.nodes.find(node => node.id === 'untouched')).toEqual(source)
    expect(canvas.connections).toMatchObject([{ id: 'link', purpose: 'input' }])
  })

  it('reports stale revisions and invalid connections without changing durable graph state', async () => {
    const f = await fixture()
    await f.add()
    const before = f.host.workspace()
    expect((await f.invoke('convax_move_nodes', {
      nodes: [{ id: 'file-a', position: { x: 90, y: 90 } }], expectedRevision: 1, operationId: 'stale',
    })).value).toMatchObject({ ok: false, error: { code: 'conflict' }, canvas: { revision: f.revision() } })
    expect((await f.invoke('convax_connect', {
      connectionId: 'bad', source: 'file-a', sourcePort: 'input', target: chatId, targetPort: 'input',
      expectedRevision: f.revision(), operationId: 'bad-port',
    })).value).toMatchObject({ ok: false, error: { code: 'invalid-command' } })
    expect((await f.invoke('convax_arrange_nodes', {
      nodeIds: [chatId, 'missing'], origin: { x: 0, y: 0 }, columns: 1, columnGap: 400, rowGap: 250,
      expectedRevision: f.revision(), operationId: 'missing-node',
    })).value).toMatchObject({ ok: false, error: { code: 'not-found' } })
    expect(f.host.workspace()).toEqual(before)
  })

  it('propagates cancellation after an asynchronous resource read without committing its reference', async () => {
    const f = await fixture()
    const ready = Promise.withResolvers<undefined>(), resource = Promise.withResolvers<CanvasResource>()
    const signal = new AbortController()
    vi.spyOn(f.host, 'describe').mockImplementationOnce(async (_path, readSignal) => {
      ready.resolve(undefined)
      const value = await resource.promise
      readSignal?.throwIfAborted()
      return value
    })
    const before = f.host.workspace()
    const pending = f.invoke('convax_add_file', {
      nodeId: 'cancelled', path: f.path, position: { x: 0, y: 0 }, expectedRevision: f.revision(), operationId: 'cancelled',
    }, { signal: signal.signal })
    await ready.promise
    signal.abort(new Error('Cancelled graph edit'))
    resource.resolve({ path: f.path, name: 'notes.txt', kind: 'file', size: 18 })
    expect((await pending).isError).toBe(true)
    expect(f.host.workspace()).toEqual(before)
  })

  it('returns a conflict when the canvas changes during resource resolution', async () => {
    const f = await fixture()
    const ready = Promise.withResolvers<undefined>(), resource = Promise.withResolvers<CanvasResource>()
    vi.spyOn(f.host, 'describe').mockImplementationOnce(async () => { ready.resolve(undefined); return resource.promise })
    const pending = f.add()
    await ready.promise
    await f.execute({ kind: 'rename', title: 'Concurrent edit' })
    resource.resolve({ path: f.path, name: 'notes.txt', kind: 'file', size: 18 })
    expect((await pending).value).toMatchObject({ ok: false, error: { code: 'conflict' }, canvas: { title: 'Concurrent edit' } })
    expect(f.host.workspace().canvases[0]?.nodes).toHaveLength(1)
  })

  it('returns a missing target after concurrent deletion and directs subsequent queries to an existing canvas', async () => {
    const f = await fixture()
    const ready = Promise.withResolvers<undefined>(), resource = Promise.withResolvers<CanvasResource>()
    vi.spyOn(f.host, 'describe').mockImplementationOnce(async () => { ready.resolve(undefined); return resource.promise })
    const pending = f.add('deleted-target', { canvasId: otherCanvasId, expectedRevision: f.revision(otherCanvasId) })
    await ready.promise
    await f.execute({ kind: 'delete' }, otherCanvasId)
    resource.resolve({ path: f.path, name: 'notes.txt', kind: 'file', size: 18 })
    expect((await pending).value).toMatchObject({
      ok: false, canvas: null, error: { code: 'not-found', message: 'Canvas no longer exists' },
    })
    expect(await f.invoke('convax_query_canvases', { canvasId: otherCanvasId })).toMatchObject({ isError: true, content: [{
      type: 'text', text: 'Error: Canvas canvas-b is unavailable. Use convax_query_canvases to choose an existing canvas.',
    }] })
    expect(f.host.workspace().canvases.map(canvas => canvas.id)).toEqual([canvasId])
  })
})
