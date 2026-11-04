/** Durable graph behavior against the real transactional SQLite/domain providers. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { CanvasRepository } from '../src/repository.ts'
import { CanvasNodeRegistry } from '../src/registry.ts'
import { canvasCommandRequestSchema, graphSchema } from '../src/schema.ts'
import { CanvasDatabase } from '../src/database.ts'
import { ConvaxHost, apply as applyHost } from '../src/index.ts'
import { createFileDeliveryOutput } from '../../plugin-inernal-nodes-host/src/file-delivery.ts'
import { apply as applyNodes } from '../../plugin-inernal-nodes-host/src/index.ts'
import { CanvasChatCoordinator } from '../../plugin-inernal-nodes-host/src/chats.ts'
import { CanvasDeliveryCoordinator, canvasDeliveryProjection } from '../../plugin-inernal-nodes-host/src/deliveries.ts'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { DatabaseSync } from 'node:sqlite'
import type { CanvasThreadSessions, CanvasSessionReceipt } from '../../plugin-inernal-nodes-host/src/session-materializer.ts'
import type { OfficeToPdfRequest, OfficeToPdfResult } from '@deepseek-ai/dsh-office-to-pdf'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { CanvasCommand, CanvasCommandRequest, CanvasConnectionId, CanvasId, CanvasNode, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId, CanvasThreadRequest } from '../src/types.ts'


interface TestSessionCreateRequest {
  operationId: CanvasOperationId
  cwd: string
  agentPreset?: string
}

function testMaterializer(
  repository: CanvasRepository, create: (request: TestSessionCreateRequest) => Promise<CanvasSessionReceipt>,
): CanvasThreadSessions {
  return {
    materialize: async (operationId) => {
      const intent = repository.coordination.thread(operationId)
      if (intent === undefined) throw new Error('Missing test thread intention')
      const request = JSON.parse(intent.request) as CanvasThreadRequest
      if (request.kind !== 'create') throw new Error('Test expects ordinary creation')
      return create({ operationId, cwd: intent.cwd, ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }) })
    },
  }
}

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'convax-repository-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const open = async () => {
    const ctx = new Context()
    const domain = await CanvasDatabase.open({ path: join(root, 'canvas.sqlite') })
    const observerFailure = vi.fn()
    const registry = new CanvasNodeRegistry(observerFailure)
    const unregisterType = registry.register({
      id: brandString<CanvasNodeTypeId>('test.resource'), dataVersion: 1,
      ports: [{ id: 'input', direction: 'input', valueKind: 'resource' }, { id: 'output', direction: 'output', valueKind: 'resource' }],
      parse: data => data,
    })
    const repository = new CanvasRepository(domain, registry, observerFailure)
    let closed = false
    const close = async () => {
      if (closed) return
      closed = true
      repository.close()
      await domain.close()
    }
    cleanup.push(close)
    return { ctx, domain, path: join(root, 'canvas.sqlite'), repository, close, unregisterType, registry, observerFailure }
  }
  return { open, ...(await open()) }
}

const canvasId = brandString<CanvasId>('canvas-a')
function request(operation: string, expectedRevision: number, command: CanvasCommand): CanvasCommandRequest {
  return { canvasId, operationId: brandString<CanvasOperationId>(operation), expectedRevision, command }
}
function node(id: string): CanvasNode {
  return {
    id: brandString<CanvasNodeId>(id), typeId: brandString<CanvasNodeTypeId>('test.resource'),
    dataVersion: 1, revision: 0, position: { x: 0, y: 0 }, data: { path: '/original/file.txt', custom: { retained: true } },
  }
}

describe('CanvasRepository', () => {
  it('persists explicit default naming and clears it on a same-text rename, including undo and reopen', async () => {
    const { repository, close, open } = await fixture()
    await repository.execute(request('default', 0, { kind: 'create', title: 'Untitled canvas', defaultTitle: true }))
    expect(repository.snapshot().canvases[0]?.titleFormat).toEqual({ kind: 'default' })
    await repository.execute(request('same-name', 1, { kind: 'rename', title: 'Untitled canvas' }))
    expect(repository.snapshot().canvases[0]?.titleFormat).toBeUndefined()
    await repository.execute(request('undo-name', 2, { kind: 'history', targetOperationId: brandString<CanvasOperationId>('same-name'), direction: 'undo' }))
    expect(repository.snapshot().canvases[0]?.titleFormat).toEqual({ kind: 'default' })
    await repository.execute(request('copy', 3, { kind: 'duplicate', newCanvasId: brandString<CanvasId>('copy'), title: 'Untitled canvas (copy)', localizedCopy: true }))
    expect(repository.snapshot().canvases.find(canvas => canvas.id === 'copy')?.titleFormat).toEqual({ kind: 'copy', source: { kind: 'default' } })
    await close()
    const reopened = await open()
    expect(reopened.repository.snapshot().canvases.find(canvas => canvas.id === 'copy')?.titleFormat).toEqual({ kind: 'copy', source: { kind: 'default' } })
  })

  it('preserves literal legacy titles and captures a literal source when making a localized copy', async () => {
    const { repository } = await fixture()
    await repository.execute(request('literal', 0, { kind: 'create', title: '未命名画布' }))
    expect(repository.snapshot().canvases[0]?.titleFormat).toBeUndefined()
    await repository.execute(request('copy-literal', 1, { kind: 'duplicate', newCanvasId: brandString<CanvasId>('copy-literal'), title: '未命名画布 (copy)', localizedCopy: true }))
    expect(repository.snapshot().canvases.find(canvas => canvas.id === 'copy-literal')?.titleFormat).toEqual({ kind: 'copy', source: { kind: 'literal', value: '未命名画布' } })
  })

  it('returns provider validation failures without committing or consuming the operation identity', async () => {
    const { repository, registry, unregisterType } = await fixture()
    await repository.execute(request('create', 0, { kind: 'create', title: 'Files' }))
    await unregisterType()
    registry.register({
      id: brandString<CanvasNodeTypeId>('test.resource'), dataVersion: 1, ports: [],
      parse(data) { if (typeof data.path !== 'string') throw new Error('path is required'); return data },
    })
    const invalid = node('invalid')
    invalid.data = {}
    const add = request('add', 1, { kind: 'add-node', node: invalid })
    const before = repository.snapshot()
    expect(await repository.execute(add)).toMatchObject({ ok: false, code: 'invalid-command' })
    expect(repository.snapshot()).toEqual(before)
    expect((await repository.execute({ ...add, command: { kind: 'add-node', node: node('invalid') } })).ok).toBe(true)
    const saved = repository.snapshot()
    expect(await repository.execute(request('update', 2, {
      kind: 'update-node', nodeId: invalid.id, dataVersion: 1, data: {},
    }))).toMatchObject({ ok: false, code: 'invalid-command' })
    expect(repository.snapshot()).toEqual(saved)
  })

  it('commits a new node with its initial connections in one revision and one retry receipt', async () => {
    const { repository } = await fixture()
    await repository.execute(request('create', 0, { kind: 'create', title: 'Files' }))
    await repository.execute(request('folder', 1, { kind: 'add-node', node: node('folder') }))
    const connection = { id: 'initial-input' as import('../src/types.ts').CanvasConnectionId,
      source: node('folder').id, sourcePort: 'output', target: node('chat').id, targetPort: 'input', purpose: 'input' as const }
    const add = request('chat-and-folder', 2, { kind: 'add-node', node: node('chat'), initialConnections: [connection] })
    expect(await repository.execute(add)).toMatchObject({ ok: true })
    const committed = repository.snapshot()
    expect(committed.canvases[0]).toMatchObject({ revision: 3, nodes: [{ id: 'folder' }, { id: 'chat' }], connections: [connection] })
    expect(await repository.execute(add)).toMatchObject({ ok: true, workspace: committed })
  })

  it('commits an entire subgraph once and retains its retry receipt after reopening', async () => {
    const f = await fixture()
    await f.repository.execute(request('create', 0, { kind: 'create', title: 'Files' }))
    const nodes = [{ ...node('first'), revision: 73 }, { ...node('last'), revision: 91 }]
    const connection = { id: 'copied-edge' as CanvasConnectionId, source: nodes[1]!.id, sourcePort: 'output',
      target: nodes[0]!.id, targetPort: 'input', purpose: 'input' as const }
    const add = request('copy-subgraph', 1, { kind: 'add-subgraph', nodes, connections: [connection] })
    const notify = vi.fn()
    f.repository.subscribe(notify)
    expect(canvasCommandRequestSchema.parse(add)).toEqual(add)
    expect(await f.repository.execute(add)).toMatchObject({ ok: true })
    const committed = f.repository.snapshot()
    expect(committed.canvases[0]).toEqual({ id: canvasId, title: 'Files', revision: 2,
      nodes: nodes.map(value => ({ ...value, revision: 1 })), connections: [connection] })
    expect(committed.revision).toBe(2)
    expect(nodes.map(value => value.revision)).toEqual([73, 91])
    expect(notify).toHaveBeenCalledOnce()
    expect([...f.domain.table('operations').entries()]).toHaveLength(2)
    await f.close()
    const reopened = await f.open()
    expect(await reopened.repository.execute(add)).toEqual({ ok: true, workspace: committed })
    const changed = structuredClone(add)
    if (changed.command.kind !== 'add-subgraph') throw new Error('Expected a subgraph request')
    changed.command.nodes[0]!.position.x = 20
    expect(await reopened.repository.execute(changed)).toMatchObject({ ok: false, code: 'invalid-command' })
    expect(reopened.repository.snapshot()).toEqual(committed)
  })

  it.each([
    ['provider', 'provider-unavailable'], ['version', 'invalid-command'], ['provider data', 'invalid-command'],
    ['global node identity', 'invalid-command'], ['batch node identity', 'invalid-command'],
    ['global connection identity', 'invalid-command'], ['batch connection identity', 'invalid-command'],
    ['connection port', 'invalid-command'], ['connection endpoint', 'provider-unavailable'],
  ] as const)('rolls back an entire subgraph for an invalid %s and leaves its operation identity reusable', async (invalid, code) => {
    const f = await fixture()
    await f.repository.execute(request('create', 0, { kind: 'create', title: 'Files' }))
    const otherCanvasId = 'other-canvas' as CanvasId
    const other = (operation: string, expectedRevision: number, command: CanvasCommand) => f.repository.execute({
      ...request(operation, expectedRevision, command), canvasId: otherCanvasId,
    })
    await other('other-canvas', 0, { kind: 'create', title: 'Other' })
    await other('other-node', 1, { kind: 'add-node', node: node('global-node') })
    await other('other-edge', 2, { kind: 'add-connection', connection: {
      id: 'global-edge' as CanvasConnectionId, source: node('global-node').id, sourcePort: 'output',
      target: node('global-node').id, targetPort: 'input', purpose: 'input',
    } })
    const nodes = [node('first'), node('last')]
    const connections = [{ id: 'copied-edge' as CanvasConnectionId, source: nodes[0]!.id, sourcePort: 'output',
      target: nodes[1]!.id, targetPort: 'input', purpose: 'input' as const }]
    if (invalid === 'provider') nodes[1]!.typeId = 'missing-provider' as CanvasNodeTypeId
    if (invalid === 'version') nodes[1]!.dataVersion = 9
    if (invalid === 'provider data') {
      f.registry.register({ id: 'strict.resource' as CanvasNodeTypeId, dataVersion: 1, ports: [], parse(data) {
        if (typeof data.path !== 'string') throw new Error('path must be a string')
        return data
      } })
      nodes[1]!.typeId = 'strict.resource' as CanvasNodeTypeId
      nodes[1]!.data = { path: 12 }
    }
    if (invalid === 'global node identity') nodes[1]!.id = node('global-node').id
    if (invalid === 'batch node identity') nodes[1]!.id = nodes[0]!.id
    if (invalid === 'global connection identity') connections[0]!.id = 'global-edge' as CanvasConnectionId
    if (invalid === 'batch connection identity') connections.push({ ...connections[0]! })
    if (invalid === 'connection port') connections[0]!.targetPort = 'missing'
    if (invalid === 'connection endpoint') connections[0]!.target = 'missing' as CanvasNodeId
    const before = f.repository.snapshot()
    const add = request('copy-subgraph', 1, { kind: 'add-subgraph', nodes, connections })
    expect(await f.repository.execute(add)).toMatchObject({ ok: false, code })
    expect(f.repository.snapshot()).toEqual(before)
    expect(f.domain.table('operations').get(add.operationId)).toBeUndefined()
    expect(await f.repository.execute({ ...add, command: { kind: 'add-subgraph', nodes: [node('corrected')], connections: [] } }))
      .toMatchObject({ ok: true })
  })

  it('preserves third-party Session ownership and deletion protection after its provider unloads', async () => {
    const f = await fixture()
    const typeId = brandString<CanvasNodeTypeId>('thirdparty.conversation')
    const remove = f.registry.register({ id: typeId, dataVersion: 1, capabilities: { sessions: true }, ports: [], parse: data => data })
    await f.repository.execute(request('custom-canvas', 0, { kind: 'create', title: 'Third-party Session node' }))
    const sessionNode = { ...node('custom-session'), typeId, data: { title: 'Custom conversation', cwd: '/project' } }
    expect(await f.repository.execute(request('custom-session', 1, { kind: 'add-node', node: sessionNode }))).toMatchObject({ ok: true })
    const operationId = brandString<CanvasOperationId>('custom-thread')
    const sessionId = SessionId('custom-native-session')
    await f.repository.coordination.reserveThread({ kind: 'create', canvasId, nodeId: sessionNode.id, expectedRevision: 2, operationId }, '/project')
    await f.repository.coordination.completeThread(operationId, sessionId, 0)
    const before = f.repository.snapshot().canvases
    await remove()
    expect(f.repository.snapshot().canvases).toEqual(before)
    expect(f.repository.snapshot().chats[0]).toMatchObject({ nodeId: sessionNode.id, threads: [{ sessionId }] })
    expect(f.repository.bindingOf(sessionId)).toMatchObject({ canvasId, nodeId: sessionNode.id })
    expect(await f.repository.execute(request('uncoordinated-removal', 3, { kind: 'remove-nodes', nodeIds: [sessionNode.id] })))
      .toMatchObject({ ok: false, code: 'invalid-command', message: 'Chat deletion requires Session coordination' })
    expect(f.repository.snapshot().canvases).toEqual(before)
  })

  it('connects a new subgraph to compatible existing nodes', async () => {
    const f = await fixture()
    await f.repository.execute(request('create', 0, { kind: 'create', title: 'Files' }))
    await f.repository.execute(request('existing', 1, { kind: 'add-node', node: node('existing') }))
    expect(await f.repository.execute(request('copy-subgraph', 2, { kind: 'add-subgraph', nodes: [node('copy')], connections: [{
      id: 'external-edge' as CanvasConnectionId, source: node('existing').id, sourcePort: 'output',
      target: node('copy').id, targetPort: 'input', purpose: 'input',
    }] }))).toMatchObject({ ok: true })
    expect(f.repository.snapshot().canvases[0]).toMatchObject({ revision: 3, nodes: [{ id: 'existing' }, { id: 'copy' }],
      connections: [{ id: 'external-edge', source: 'existing', target: 'copy' }] })
  })

  it('rejects malformed subgraph requests at the JSON request parser', () => {
    const valid = request('copy-subgraph', 1, { kind: 'add-subgraph', nodes: [node('copy')], connections: [] })
    expect(canvasCommandRequestSchema.safeParse(valid).success).toBe(true)
    expect(canvasCommandRequestSchema.safeParse({ ...valid, command: { kind: 'add-subgraph', nodes: {}, connections: [] } }).success).toBe(false)
    expect(canvasCommandRequestSchema.safeParse({ ...valid, command: { kind: 'add-subgraph', nodes: [node('copy')], connections: [{}] } }).success).toBe(false)
  })

  it.each(['port', 'duplicate connection', 'unrelated connection', 'global connection identity'] as const)(
    'rolls back the entire new-node operation for an invalid initial %s', async (invalid) => {
      const { repository } = await fixture()
      await repository.execute(request('create', 0, { kind: 'create', title: 'Files' }))
      await repository.execute(request('folder', 1, { kind: 'add-node', node: node('folder') }))
      const connection = { id: 'initial-input' as import('../src/types.ts').CanvasConnectionId,
        source: node('folder').id, sourcePort: 'output', target: node('chat').id, targetPort: 'input', purpose: 'input' as const }
      if (invalid === 'global connection identity') {
        const otherId = 'other-canvas' as CanvasId
        const executeOther = (operationId: string, expectedRevision: number, command: CanvasCommand) => repository.execute({
          ...request(operationId, expectedRevision, command), canvasId: otherId,
        })
        await executeOther('other-canvas', 0, { kind: 'create', title: 'Other' })
        await executeOther('other-node', 1, { kind: 'add-node', node: node('other') })
        await executeOther('other-connection', 2, { kind: 'add-connection', connection: {
          ...connection, source: node('other').id, target: node('other').id,
        } })
      }
      const before = repository.snapshot()
      const initialConnections = invalid === 'duplicate connection' ? [connection, connection]
        : invalid === 'port' ? [{ ...connection, sourcePort: 'missing' }]
          : invalid === 'unrelated connection' ? [{ ...connection, target: connection.source }] : [connection]
      const add = request('chat-and-folder', 2, { kind: 'add-node', node: node('chat'), initialConnections })
      expect(await repository.execute(add)).toMatchObject({ ok: false, code: 'invalid-command' })
      expect(repository.snapshot()).toEqual(before)
      const retryConnection = { ...connection, id: 'corrected-input' as import('../src/types.ts').CanvasConnectionId }
      expect(await repository.execute({ ...add, command: { kind: 'add-node', node: node('chat'), initialConnections: [retryConnection] } }))
        .toMatchObject({ ok: true })
    },
  )

  it('publishes provider changes without a graph write and detaches on repository close', async () => {
    const { repository, registry, unregisterType } = await fixture()
    const snapshots: string[][] = []
    repository.subscribe(() => snapshots.push(repository.snapshot().nodeTypes.map(type => type.id)))
    await unregisterType()
    await unregisterType()
    expect(snapshots).toEqual([[]])
    repository.close()
    registry.register({ id: brandString<CanvasNodeTypeId>('later.type'), dataVersion: 1, ports: [], parse: data => data })
    expect(snapshots).toEqual([[]])
  })

  it.each(['canvas identity', 'node identity', 'connection identity', 'dangling endpoint'])('rejects durable graph corruption (%s) without rewriting it', async (corruption) => {
    const f = await fixture()
    await f.repository.execute(request('create', 0, { kind: 'create', title: 'Files' }))
    await f.repository.execute(request('add-a', 1, { kind: 'add-node', node: node('a') }))
    await f.repository.execute(request('add-b', 2, { kind: 'add-node', node: node('b') }))
    const snapshot = f.repository.snapshot()
    const graph = { revision: snapshot.revision, canvases: snapshot.canvases }
    const document = graph.canvases[0]!
    const edge = {
      id: brandString<import('../src/types.ts').CanvasConnectionId>('edge'), source: document.nodes[0]!.id,
      sourcePort: 'output', target: document.nodes[1]!.id, targetPort: 'input', purpose: 'input' as const,
    }
    document.connections.push(edge)
    if (corruption === 'canvas identity') graph.canvases.push(structuredClone(document))
    else if (corruption === 'node identity') document.nodes.push(structuredClone(document.nodes[0]!))
    else if (corruption === 'connection identity') document.connections.push(structuredClone(edge))
    else edge.target = brandString<CanvasNodeId>('missing')
    expect(graphSchema.safeParse(graph).success).toBe(false)
    await f.domain.global.set(graph)
    await f.close()
    const readRaw = (): string => {
      const database = new DatabaseSync(f.path)
      try { return (database.prepare("SELECT value FROM unit_globals WHERE unit = 'convax'").get() as { value: string }).value }
      finally { database.close() }
    }
    const before = readRaw()
    await expect(f.open()).rejects.toMatchObject({ code: 'invalid-record' })
    expect(readRaw()).toBe(before)
  })

  it('restores complete unknown-provider JSON payloads without interpreting their fields', async () => {
    const f = await fixture()
    const unknown = node('unknown')
    unknown.typeId = brandString<CanvasNodeTypeId>('absent.provider')
    unknown.dataVersion = 42
    unknown.data = { extension: { nested: [null, true, 12, { future: 'retained' }] }, opaque: { field: 'value' } }
    await f.domain.global.set({ revision: 1, canvases: [{ id: canvasId, title: 'Restored', revision: 1, nodes: [unknown], connections: [] }] })
    await f.close()
    const reopened = await f.open()
    expect(reopened.repository.snapshot().canvases[0]?.nodes).toEqual([unknown])
  })

  it('recovers committed canvases and operation receipts after reopening SQLite', async () => {
    const f = await fixture()
    const create = request('create', 0, { kind: 'create', title: 'Files' })
    expect((await f.repository.execute(create)).ok).toBe(true)
    await f.repository.execute(request('add', 1, { kind: 'add-node', node: node('file-a') }))
    await f.close()
    const reopened = await f.open()
    expect(reopened.repository.snapshot().canvases[0]).toMatchObject({ title: 'Files', revision: 2, nodes: [{ id: 'file-a' }] })
    expect((await reopened.repository.execute(create)).ok).toBe(true)
    expect(reopened.repository.snapshot().revision).toBe(2)
  })

  it('rejects stale revisions and reused operation identities without changing state', async () => {
    const { repository } = await fixture()
    const create = request('create', 0, { kind: 'create', title: 'Files' })
    await repository.execute(create)
    const before = repository.snapshot()
    expect(await repository.execute(request('rename', 0, { kind: 'rename', title: 'Other' }))).toMatchObject({ ok: false, code: 'conflict' })
    expect(await repository.execute({ ...create, command: { kind: 'create', title: 'Other' } })).toMatchObject({ ok: false, code: 'invalid-command' })
    expect(repository.snapshot()).toEqual(before)
  })

  it('rolls back all node movements when one target is missing', async () => {
    const { repository } = await fixture()
    await repository.execute(request('create', 0, { kind: 'create', title: 'Files' }))
    await repository.execute(request('add', 1, { kind: 'add-node', node: node('a') }))
    const before = repository.snapshot()
    const command: CanvasCommand = { kind: 'move-nodes', nodes: [{ id: brandString<CanvasNodeId>('a'), position: { x: 40, y: 80 } }, { id: brandString<CanvasNodeId>('missing'), position: { x: 1, y: 1 } }] }
    expect(await repository.execute(request('move', 2, command))).toMatchObject({ ok: false, code: 'not-found' })
    expect(repository.snapshot()).toEqual(before)
  })

  it('retains provider payload and permits geometry changes while the provider is absent', async () => {
    const { repository, unregisterType } = await fixture()
    await repository.execute(request('create', 0, { kind: 'create', title: 'Files' }))
    await repository.execute(request('add', 1, { kind: 'add-node', node: node('a') }))
    await unregisterType()
    expect((await repository.execute(request('move', 2, { kind: 'move-nodes', nodes: [{ id: brandString<CanvasNodeId>('a'), position: { x: 12, y: 24 } }] }))).ok).toBe(true)
    const snapshot = repository.snapshot()
    expect(snapshot.nodeTypes).toEqual([])
    expect(snapshot.canvases[0]?.nodes[0]).toMatchObject({ position: { x: 12, y: 24 }, data: { custom: { retained: true } } })
    expect(await repository.execute(request('update', 3, { kind: 'update-node', nodeId: brandString<CanvasNodeId>('a'), dataVersion: 1, data: {} }))).toMatchObject({ ok: false, code: 'provider-unavailable' })
  })

  it('publishes once per commit and contains observer failures after persistence', async () => {
    const { repository, observerFailure } = await fixture()
    const failure = new Error('observer failed')
    const listener = vi.fn(() => { throw failure })
    const off = repository.subscribe(listener)
    const create = request('create', 0, { kind: 'create', title: 'Files' })
    expect((await repository.execute(create)).ok).toBe(true)
    expect((await repository.execute(create)).ok).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(observerFailure).toHaveBeenCalledWith(failure)
    off()
  })

  it('removes incident connections with a reference node while preserving other nodes', async () => {
    const { repository } = await fixture()
    await repository.execute(request('create', 0, { kind: 'create', title: 'Files' }))
    await repository.execute(request('add-a', 1, { kind: 'add-node', node: node('a') }))
    await repository.execute(request('add-b', 2, { kind: 'add-node', node: node('b') }))
    const edge = { id: brandString<import('../src/types.ts').CanvasConnectionId>('edge'), source: brandString<CanvasNodeId>('a'), sourcePort: 'output', target: brandString<CanvasNodeId>('b'), targetPort: 'input', purpose: 'input' as const }
    expect((await repository.execute(request('connect', 3, { kind: 'add-connection', connection: edge }))).ok).toBe(true)
    await repository.execute(request('remove', 4, { kind: 'remove-nodes', nodeIds: [brandString<CanvasNodeId>('a')] }))
    expect(repository.snapshot().canvases[0]).toMatchObject({ connections: [], nodes: [{ id: 'b' }] })
  })
})

describe('Durable graph history', () => {
  it('undoes only the moved fields across Agent edits and replays after reopening the Host', async () => {
    const f = await fixture()
    const current = () => f.repository.snapshot().canvases[0]!
    await f.repository.execute(request('create', 0, { kind: 'create', title: 'History' }))
    await f.repository.execute(request('add', 1, { kind: 'add-node', node: node('resource') }))
    await f.repository.execute(request('move', 2, { kind: 'move-nodes', nodes: [{ id: node('resource').id, position: { x: 80, y: 60 } }] }))
    await f.repository.execute(request('agent-data', 3, { kind: 'update-node', nodeId: node('resource').id, dataVersion: 1, data: { path: '/agent/change.txt' } }))
    const undo = request('undo-move', 4, { kind: 'history', targetOperationId: 'move' as CanvasOperationId, direction: 'undo' })
    expect(await f.repository.execute(undo)).toMatchObject({ ok: true })
    expect(current().nodes[0]).toMatchObject({ position: { x: 0, y: 0 }, data: { path: '/agent/change.txt' }, revision: 4 })
    const saved = f.repository.snapshot()
    expect(await f.repository.execute(undo)).toMatchObject({ ok: true, workspace: saved })
    expect(f.domain.table('history').get('undo-move' as CanvasOperationId)).toBeUndefined()
    await f.close()
    const reopened = await f.open()
    expect(await reopened.repository.execute(request('redo-move', 5, { kind: 'history', targetOperationId: 'move' as CanvasOperationId, direction: 'redo' }))).toMatchObject({ ok: true })
    expect(reopened.repository.snapshot().canvases[0]?.nodes[0]).toMatchObject({ position: { x: 80, y: 60 }, data: { path: '/agent/change.txt' }, revision: 5 })
    expect(reopened.domain.table('history').get('move' as CanvasOperationId)?.applied).toBe(true)
  })

  it('rejects changed fields, missing history and other canvases without consuming retry identities', async () => {
    const f = await fixture()
    await f.repository.execute(request('create', 0, { kind: 'create', title: 'History' }))
    await f.repository.execute(request('add', 1, { kind: 'add-node', node: node('resource') }))
    await f.repository.execute(request('move', 2, { kind: 'move-nodes', nodes: [{ id: node('resource').id, position: { x: 80, y: 60 } }] }))
    await f.repository.execute(request('agent-move', 3, { kind: 'move-nodes', nodes: [{ id: node('resource').id, position: { x: 90, y: 60 } }] }))
    const saved = f.repository.snapshot()
    expect(await f.repository.execute(request('undo', 4, { kind: 'history', targetOperationId: 'move' as CanvasOperationId, direction: 'undo' }))).toMatchObject({ ok: false, code: 'conflict' })
    expect(await f.repository.execute(request('unknown', 4, { kind: 'history', targetOperationId: 'missing' as CanvasOperationId, direction: 'undo' }))).toMatchObject({ ok: false, code: 'not-found' })
    expect(f.repository.snapshot()).toEqual(saved)
    expect(f.domain.table('operations').get('undo' as CanvasOperationId)).toBeUndefined()
    const other = 'other-canvas' as CanvasId
    await f.repository.execute({ ...request('other', 0, { kind: 'create', title: 'Other' }), canvasId: other })
    expect(await f.repository.execute({ ...request('cross-canvas', 1, { kind: 'history', targetOperationId: 'move' as CanvasOperationId, direction: 'undo' }), canvasId: other })).toMatchObject({ ok: false, code: 'not-found' })
  })

  it('restores subgraphs and drawing order without a provider while monotonically advancing restored revisions', async () => {
    const f = await fixture()
    await f.repository.execute(request('create', 0, { kind: 'create', title: 'History' }))
    const edge = { id: 'history-edge' as CanvasConnectionId, source: node('first').id, target: node('second').id,
      sourcePort: 'output', targetPort: 'input', purpose: 'input' as const }
    await f.repository.execute(request('subgraph', 1, { kind: 'add-subgraph', nodes: [node('first'), node('second')], connections: [edge] }))
    await f.repository.execute(request('third', 2, { kind: 'add-node', node: node('third') }))
    await f.repository.execute(request('remove', 3, { kind: 'remove-nodes', nodeIds: [node('first').id, node('second').id] }))
    await f.unregisterType()
    expect(await f.repository.execute(request('restore', 4, { kind: 'history', targetOperationId: 'remove' as CanvasOperationId, direction: 'undo' }))).toMatchObject({ ok: true })
    expect(f.repository.snapshot().canvases[0]).toMatchObject({ nodes: [
      { id: 'first', revision: 2 }, { id: 'second', revision: 2 }, { id: 'third', revision: 1 },
    ], connections: [edge] })
    expect(await f.repository.execute(request('remove-again', 5, { kind: 'history', targetOperationId: 'remove' as CanvasOperationId, direction: 'redo' }))).toMatchObject({ ok: true })
    expect(await f.repository.execute(request('restore-again', 6, { kind: 'history', targetOperationId: 'remove' as CanvasOperationId, direction: 'undo' }))).toMatchObject({ ok: true })
    expect(f.repository.snapshot().canvases[0]?.nodes.slice(0, 2).map(node => node.revision)).toEqual([3, 3])
    await f.repository.execute(request('remove-edge', 7, { kind: 'remove-connections', connectionIds: [edge.id] }))
    expect(await f.repository.execute(request('reuse-edge', 8, { kind: 'add-connection', connection: edge }))).toMatchObject({ ok: false, code: 'invalid-command' })
    await f.repository.execute(request('remove-node', 8, { kind: 'remove-nodes', nodeIds: [node('first').id] }))
    expect(await f.repository.execute(request('reuse-node', 9, { kind: 'add-node', node: node('first') }))).toMatchObject({ ok: false, code: 'invalid-command' })
  })

  it('rolls history state and graph changes back together when the durable receipt cannot commit', async () => {
    const f = await fixture()
    await f.repository.execute(request('create', 0, { kind: 'create', title: 'History' }))
    await f.repository.execute(request('add', 1, { kind: 'add-node', node: node('resource') }))
    const fault = new DatabaseSync(f.path)
    cleanup.push(async () => { fault.close() })
    fault.exec("CREATE TRIGGER history_receipt_fault BEFORE INSERT ON u_convax_operations WHEN NEW.key = 'undo' BEGIN SELECT RAISE(ABORT, 'receipt fault'); END")
    const undo = request('undo', 2, { kind: 'history', targetOperationId: 'add' as CanvasOperationId, direction: 'undo' })
    const before = f.repository.snapshot()
    await expect(f.repository.execute(undo)).rejects.toThrow('receipt fault')
    expect(f.repository.snapshot()).toEqual(before)
    expect(f.domain.table('history').get('add' as CanvasOperationId)?.applied).toBe(true)
    expect(f.domain.table('node_revisions').size).toBe(0)
    fault.exec('DROP TRIGGER history_receipt_fault')
    expect(await f.repository.execute(undo)).toMatchObject({ ok: true })
  })
})

async function chatFixture() {
  const value = await fixture()
  value.registry.register({
    id: 'convax.chat' as CanvasNodeTypeId, dataVersion: 1, capabilities: { sessions: true },
    ports: [{ id: 'input', direction: 'input', valueKind: 'resource' }, { id: 'output', direction: 'output', valueKind: 'resource' }],
    parse: data => data,
  })
  await value.repository.execute(request('create-chat-canvas', 0, { kind: 'create', title: 'Chats' }))
  const chat = { ...node('chat-a'), typeId: 'convax.chat' as CanvasNodeTypeId, data: { title: 'Chat A', cwd: '/project' } }
  await value.repository.execute(request('add-chat', 1, { kind: 'add-node', node: chat }))
  const create: CanvasThreadRequest = { kind: 'create', canvasId, nodeId: chat.id, expectedRevision: 2, operationId: 'thread-a' as CanvasOperationId }
  return { ...value, chat, create }
}

function historyArchives(ctx: Context, archived: Set<SessionId>, headers: SessionHeader[] = []) {
  const archiveSession = vi.fn(async (id: SessionId) => { archived.add(id) })
  const unarchiveSession = vi.fn(async (id: SessionId) => { archived.delete(id) })
  ctx.provide('sessionPersistence', { list: async () => headers.map(header => ({ header })) } as never)
  ctx.provide('sessions', { list: () => [] } as never)
  ctx.provide('agents', { get: () => undefined } as never)
  ctx.provide('workspaceRegistry', {
    get archivedSessionIds() { return [...archived] }, archiveSession, unarchiveSession,
  } as never)
  return { archiveSession, unarchiveSession }
}

describe('Canvas organization', () => {
  it('archives and restores only the canvas organization flag while its bound Session remains untouched', async () => {
    const f = await chatFixture()
    const native = historyArchives(f.ctx, new Set())
    const sessionId = SessionId('organized-thread')
    await f.repository.coordination.reserveThread(f.create, '/project')
    await f.repository.coordination.completeThread(f.create.operationId, sessionId, 0)
    const coordinator = new CanvasChatCoordinator(f.ctx, f.repository)
    cleanup.push(() => coordinator.close())
    const original = f.repository.snapshot()
    const archive = request('archive-canvas', 3, { kind: 'set-archived', archived: true })
    expect(canvasCommandRequestSchema.parse(archive)).toEqual(archive)
    expect(await coordinator.execute(archive)).toMatchObject({ ok: true })
    const archived = f.repository.snapshot()
    expect(archived.canvases[0]).toMatchObject({ archived: true, revision: 4, nodes: original.canvases[0]!.nodes })
    expect(archived.chats).toEqual(original.chats)
    expect(f.domain.table('history').get(archive.operationId)).toBeUndefined()
    expect(await coordinator.execute(archive)).toMatchObject({ ok: true, workspace: archived })
    expect(await coordinator.execute(request('restore-canvas', 4, { kind: 'set-archived', archived: false }))).toMatchObject({ ok: true })
    expect(f.repository.snapshot().canvases[0]).toMatchObject({ archived: false, revision: 5 })
    expect(native.archiveSession).not.toHaveBeenCalled()
    expect(native.unarchiveSession).not.toHaveBeenCalled()
    await f.close()
    const reopened = await f.open()
    expect(reopened.repository.snapshot().canvases[0]).toMatchObject({ archived: false, revision: 5 })
    expect(reopened.repository.bindingOf(sessionId)?.nodeId).toBe(f.chat.id)
  })

  it('duplicates a whole archived graph once with fresh identities and independent empty Chat threads', async () => {
    const f = await chatFixture()
    const sessionId = SessionId('source-thread')
    await f.repository.coordination.reserveThread(f.create, '/project')
    await f.repository.coordination.completeThread(f.create.operationId, sessionId, 0)
    const resource = { ...node('copy-resource'), position: { x: -80, y: 120 } }
    const edge = { id: brandString<CanvasConnectionId>('source-edge'), source: resource.id, sourcePort: 'output',
      target: f.chat.id, targetPort: 'input', purpose: 'input' as const }
    await f.repository.execute(request('resource', 3, { kind: 'add-node', node: resource, initialConnections: [edge] }))
    await f.repository.execute(request('archive-source', 4, { kind: 'set-archived', archived: true }))
    const source = f.repository.snapshot().canvases[0]!
    const pending = { ...f.create, operationId: brandString<CanvasOperationId>('source-pending'), expectedRevision: 5 }
    await f.repository.coordination.reserveThread(pending, '/project')
    await f.unregisterType()
    const copyId = brandString<CanvasId>('copied-canvas')
    const duplicate = request('duplicate-canvas', 5, { kind: 'duplicate', newCanvasId: copyId, title: '  Copy  ' })
    expect(canvasCommandRequestSchema.parse(duplicate)).toEqual(duplicate)
    expect(await f.repository.execute(duplicate)).toMatchObject({ ok: true })
    const saved = f.repository.snapshot()
    const copy = saved.canvases.find(canvas => canvas.id === copyId)!
    expect(saved.canvases[0]).toEqual(source)
    expect(copy).toMatchObject({ id: copyId, title: 'Copy', revision: 1 })
    expect(copy.archived ?? false).toBe(false)
    expect(copy.nodes.map(value => ({ ...value, id: '', revision: 1 }))).toEqual(source.nodes.map(value => ({ ...value, id: '', revision: 1 })))
    expect(copy.nodes.every(value => !source.nodes.some(original => original.id === value.id))).toBe(true)
    expect(copy.connections).toEqual([{ ...edge, id: copy.connections[0]!.id,
      source: copy.nodes[1]!.id, target: copy.nodes[0]!.id }])
    expect(copy.connections[0]!.id).not.toBe(edge.id)
    expect(saved.chats.find(chat => chat.canvasId === copyId)?.threads).toEqual([])
    expect(saved.chats.find(chat => chat.canvasId === canvasId)?.threads).toMatchObject([{ sessionId }])
    expect(f.domain.table('thread_operations').size).toBe(2)
    expect(f.domain.table('history').get(duplicate.operationId)).toBeUndefined()
    expect(await f.repository.execute(duplicate)).toMatchObject({ ok: true, workspace: saved })
    await f.close()
    const reopened = await f.open()
    expect(await reopened.repository.execute(duplicate)).toMatchObject({ ok: true, workspace: reopened.repository.snapshot() })
    expect(reopened.repository.snapshot().canvases.find(canvas => canvas.id === copyId)).toEqual(copy)
    expect(await reopened.repository.execute({ ...duplicate, command: { kind: 'duplicate', newCanvasId: copyId, title: 'Different' } }))
      .toMatchObject({ ok: false, code: 'invalid-command' })
  })

  it('rolls back a duplicate and its generated identities when its durable receipt fails', async () => {
    const f = await fixture()
    await f.repository.execute(request('create', 0, { kind: 'create', title: 'Original' }))
    await f.repository.execute(request('add', 1, { kind: 'add-node', node: node('copy-file') }))
    const duplicate = request('copy-fault', 2, { kind: 'duplicate', newCanvasId: brandString<CanvasId>('copy'), title: 'Copy' })
    const saved = f.repository.snapshot()
    const fault = new DatabaseSync(f.path)
    cleanup.push(async () => { fault.close() })
    fault.exec("CREATE TRIGGER duplicate_fault BEFORE INSERT ON u_convax_operations WHEN NEW.key = 'copy-fault' BEGIN SELECT RAISE(ABORT, 'duplicate fault'); END")
    await expect(f.repository.execute(duplicate)).rejects.toThrow('duplicate fault')
    expect(f.repository.snapshot()).toEqual(saved)
    expect(f.domain.table('operations').get(duplicate.operationId)).toBeUndefined()
    fault.exec('DROP TRIGGER duplicate_fault')
    expect(await f.repository.execute(duplicate)).toMatchObject({ ok: true })
  })

  it('rejects stale revisions, existing destinations and blank duplicate titles without consuming their retry identities', async () => {
    const f = await fixture()
    await f.repository.execute(request('create', 0, { kind: 'create', title: 'Original' }))
    const duplicate = request('copy-rejected', 1, { kind: 'duplicate', newCanvasId: brandString<CanvasId>('copy'), title: 'Copy' })
    const saved = f.repository.snapshot()
    expect(await f.repository.execute({ ...duplicate, expectedRevision: 0 })).toMatchObject({ ok: false, code: 'conflict' })
    expect(await f.repository.execute({ ...duplicate, command: { kind: 'duplicate', newCanvasId: canvasId, title: 'Copy' } }))
      .toMatchObject({ ok: false, code: 'conflict' })
    expect(await f.repository.execute({ ...duplicate, command: { kind: 'duplicate', newCanvasId: brandString<CanvasId>('copy'), title: '  ' } }))
      .toMatchObject({ ok: false, code: 'invalid-command' })
    expect(f.repository.snapshot()).toEqual(saved)
    expect(f.domain.table('operations').get(duplicate.operationId)).toBeUndefined()
    expect(await f.repository.execute(duplicate)).toMatchObject({ ok: true })
  })

  it('purges only after confirmation and archival, removes canvas history, and retains source files and Session logs', async () => {
    const f = await chatFixture()
    const sessionId = SessionId('purged-thread')
    const archived = new Set<SessionId>()
    const native = historyArchives(f.ctx, archived)
    await f.repository.coordination.reserveThread(f.create, '/project')
    await f.repository.coordination.completeThread(f.create.operationId, sessionId, 0)
    const sourcePath = join(dirname(f.path), 'source.txt'), logPath = join(dirname(f.path), 'session.jsonl')
    await writeFile(sourcePath, 'Source remains')
    await writeFile(logPath, 'Session log remains')
    const coordinator = new CanvasChatCoordinator(f.ctx, f.repository)
    cleanup.push(() => coordinator.close())
    const purge = { ...request('purge-canvas', 3, { kind: 'purge' }), confirmed: true }
    expect(await coordinator.execute({ ...purge, confirmed: false })).toMatchObject({ ok: false, code: 'confirmation-required' })
    expect(f.repository.snapshot().canvases).toHaveLength(1)
    expect(await coordinator.execute(purge)).toMatchObject({ ok: true, workspace: { canvases: [], chats: [] } })
    expect(native.archiveSession).toHaveBeenCalledExactlyOnceWith(sessionId, { stopActivity: true })
    expect(f.domain.table('history').size).toBe(0)
    expect(f.repository.bindingOf(sessionId)?.nodeId).toBe(f.chat.id)
    expect(await readFile(sourcePath, 'utf8')).toBe('Source remains')
    expect(await readFile(logPath, 'utf8')).toBe('Session log remains')
    await f.close()
    const reopened = await f.open()
    expect(await reopened.repository.execute(purge)).toMatchObject({ ok: true, workspace: { canvases: [] } })
    expect(await reopened.repository.execute(request('create-chat-canvas', 0, { kind: 'create', title: 'Chats' })))
      .toMatchObject({ ok: true, workspace: { canvases: [] } })
    expect(await reopened.repository.execute(request('add-chat', 1, { kind: 'add-node', node: f.chat })))
      .toMatchObject({ ok: true, workspace: { canvases: [] } })
    expect(await reopened.repository.execute(request('undo-purged', 3, {
      kind: 'history', targetOperationId: brandString<CanvasOperationId>('add-chat'), direction: 'undo',
    }))).toMatchObject({ ok: false, code: 'not-found', workspace: { canvases: [] } })
    expect(await reopened.repository.execute(request('reuse-purged', 0, { kind: 'create', title: 'Replacement' })))
      .toMatchObject({ ok: false, code: 'invalid-command' })
    expect(reopened.domain.table('history').size).toBe(0)
  })

  it('recovers a failed purge after reopening without losing the graph or history before Session archival succeeds', async () => {
    const f = await chatFixture()
    const sessionId = SessionId('purge-recovery-thread')
    const archived = new Set<SessionId>()
    const native = historyArchives(f.ctx, archived)
    native.archiveSession.mockRejectedValueOnce(new Error('Archive temporarily unavailable'))
    await f.repository.coordination.reserveThread(f.create, '/project')
    await f.repository.coordination.completeThread(f.create.operationId, sessionId, 0)
    const coordinator = new CanvasChatCoordinator(f.ctx, f.repository)
    cleanup.push(() => coordinator.close())
    const purge = { ...request('purge-recovery', 3, { kind: 'purge' }), confirmed: true }
    expect(await coordinator.execute(purge)).toMatchObject({ ok: false, code: 'operation-pending' })
    expect(f.repository.snapshot().canvases).toHaveLength(1)
    expect(f.domain.table('history').size).toBe(1)
    expect(f.repository.getChat(canvasId, f.chat.id)?.deleting).toBe(true)
    expect(await coordinator.execute(request('archive-during-purge', 3, { kind: 'set-archived', archived: true })))
      .toMatchObject({ ok: false, code: 'conflict' })
    await coordinator.close()
    await f.close()
    const reopened = await f.open()
    const recoveredNative = historyArchives(reopened.ctx, archived)
    const recovery = new CanvasChatCoordinator(reopened.ctx, reopened.repository)
    cleanup.push(() => recovery.close())
    await recovery.recover()
    expect(recoveredNative.archiveSession).toHaveBeenCalledExactlyOnceWith(sessionId, { stopActivity: true })
    expect(reopened.repository.snapshot().canvases).toEqual([])
    expect(reopened.domain.table('history').size).toBe(0)
    expect(reopened.repository.coordination.pendingDeletions()).toEqual([])
    expect(await recovery.execute(purge)).toMatchObject({ ok: true })
    expect(recoveredNative.archiveSession).toHaveBeenCalledOnce()
  })

  it('settles and archives a pending creation before purging its Chat and keeps its late binding suppressed', async () => {
    const f = await chatFixture()
    const lateSession = SessionId('purge-late-thread')
    const archived = new Set<SessionId>()
    historyArchives(f.ctx, archived)
    await f.repository.coordination.reserveThread(f.create, '/project')
    const materialize = vi.fn(async () => ({ operationId: f.create.operationId, sessionId: lateSession, inheritedEventCount: 0 }))
    const coordinator = new CanvasChatCoordinator(f.ctx, f.repository, testMaterializer(f.repository, materialize))
    cleanup.push(() => coordinator.close())
    expect(await coordinator.execute({ ...request('purge-pending', 2, { kind: 'purge' }), confirmed: true }))
      .toMatchObject({ ok: true, workspace: { canvases: [] } })
    expect(materialize).toHaveBeenCalledOnce()
    expect(archived.has(lateSession)).toBe(true)
    expect(f.repository.coordination.thread(f.create.operationId)?.phase).toBe('suppressed')
    const saved = f.repository.snapshot()
    await f.repository.coordination.projectDelivery(lateSession, 4, [{ path: '/project/late-output.txt' }], createFileDeliveryOutput)
    expect(f.repository.snapshot()).toEqual(saved)
    expect([...f.domain.table('deliveries').entries()].map(([, value]) => value.phase)).toEqual(['suppressed'])
  })

  it('retains the graph and history together after archival when the final purge receipt cannot commit', async () => {
    const f = await chatFixture()
    const sessionId = SessionId('purge-receipt-thread')
    const archived = new Set<SessionId>()
    historyArchives(f.ctx, archived)
    await f.repository.coordination.reserveThread(f.create, '/project')
    await f.repository.coordination.completeThread(f.create.operationId, sessionId, 0)
    const coordinator = new CanvasChatCoordinator(f.ctx, f.repository)
    cleanup.push(() => coordinator.close())
    const fault = new DatabaseSync(f.path)
    cleanup.push(async () => { fault.close() })
    fault.exec("CREATE TRIGGER purge_fault BEFORE INSERT ON u_convax_operations WHEN NEW.key = 'purge-receipt' BEGIN SELECT RAISE(ABORT, 'purge receipt fault'); END")
    const purge = { ...request('purge-receipt', 3, { kind: 'purge' }), confirmed: true }
    expect(await coordinator.execute(purge)).toMatchObject({ ok: false, code: 'operation-pending' })
    expect(archived.has(sessionId)).toBe(true)
    expect(f.repository.snapshot().canvases).toHaveLength(1)
    expect(f.domain.table('history').size).toBe(1)
    expect(f.domain.table('operations').get(purge.operationId)).toBeUndefined()
    expect(f.domain.table('deletions').get(purge.operationId)?.phase).toBe('deleting')
    fault.exec('DROP TRIGGER purge_fault')
    expect(await coordinator.execute(purge)).toMatchObject({ ok: true, workspace: { canvases: [] } })
    expect(f.domain.table('history').size).toBe(0)
    expect(f.domain.table('operations').get(purge.operationId)).toBeDefined()
    expect(f.domain.table('deletions').get(purge.operationId)?.phase).toBe('completed')
  })

  it('purges a file-only canvas through a durable tombstone and retains other canvases and their history', async () => {
    const f = await fixture()
    await f.repository.execute(request('create', 0, { kind: 'create', title: 'Files' }))
    await f.repository.execute(request('file', 1, { kind: 'add-node', node: node('purged-file') }))
    const otherId = brandString<CanvasId>('other')
    await f.repository.execute({ ...request('other-create', 0, { kind: 'create', title: 'Other' }), canvasId: otherId })
    await f.repository.execute({ ...request('other-file', 1, { kind: 'add-node', node: node('retained-file') }), canvasId: otherId })
    const other = f.repository.snapshot().canvases[1]
    const coordinator = new CanvasChatCoordinator(f.ctx, f.repository)
    cleanup.push(() => coordinator.close())
    const purge = request('purge-files', 2, { kind: 'purge' })
    expect(await coordinator.execute(purge)).toMatchObject({ ok: true, workspace: { canvases: [other] } })
    expect([...f.domain.table('history').entries()].map(([id]) => id)).toEqual(['other-file'])
    expect(f.domain.table('deletions').get(purge.operationId)?.phase).toBe('completed')
    expect(await coordinator.execute(purge)).toMatchObject({ ok: true })
    expect(await f.repository.execute({ ...request('copy-into-retired', 2, { kind: 'duplicate', newCanvasId: canvasId, title: 'Replacement' }), canvasId: otherId }))
      .toMatchObject({ ok: false, code: 'invalid-command' })
  })
})

describe('Chat graph history', () => {
  it('validates the complete batch before stopping threads and restores a removed canvas with its original bindings', async () => {
    const f = await chatFixture()
    const sessionId = SessionId('batch-chat-session')
    const archived = new Set<SessionId>()
    const native = historyArchives(f.ctx, archived)
    await f.repository.coordination.reserveThread(f.create, '/project')
    await f.repository.coordination.completeThread(f.create.operationId, sessionId, 0)
    const coordinator = new CanvasChatCoordinator(f.ctx, f.repository)
    cleanup.push(() => coordinator.close())
    const invalid = { ...request('invalid-batch-delete', 3, { kind: 'batch', ops: [
      { op: 'node.remove', id: f.chat.id }, { op: 'node.remove', id: node('missing').id },
    ] }), confirmed: true }
    const original = f.repository.snapshot()
    expect(await coordinator.execute(invalid)).toMatchObject({ ok: false, code: 'not-found', opIndex: 1 })
    expect(native.archiveSession).not.toHaveBeenCalled()
    expect(f.repository.snapshot()).toEqual(original)
    const remove = request('batch-delete-canvas', 3, { kind: 'batch', ops: [{ op: 'canvas.remove' }] })
    expect(await coordinator.execute(remove)).toMatchObject({ ok: false, code: 'confirmation-required' })
    expect(await coordinator.execute({ ...remove, confirmed: true })).toMatchObject({ ok: true, workspace: { canvases: [] } })
    expect(f.repository.revision(canvasId)).toBe(4)
    expect(archived.has(sessionId)).toBe(true)
    const undo = request('undo-batch-delete', 4, { kind: 'history', targetOperationId: remove.operationId, direction: 'undo' })
    expect(await coordinator.execute(undo)).toMatchObject({ ok: true })
    expect(f.repository.revision(canvasId)).toBe(5)
    expect(f.repository.getChat(canvasId, f.chat.id)?.threads).toMatchObject([{ sessionId }])
    expect(f.repository.snapshot().canvases[0]?.nodes[0]?.revision).toBeGreaterThan(original.canvases[0]!.nodes[0]!.revision)
    expect(native.unarchiveSession).toHaveBeenCalledExactlyOnceWith(sessionId)
    expect(await coordinator.execute({ ...request('redo-batch-delete', 5, {
      kind: 'history', targetOperationId: remove.operationId, direction: 'redo',
    }), confirmed: true })).toMatchObject({ ok: true, workspace: { canvases: [] } })
    expect(f.repository.revision(canvasId)).toBe(6)
  })

  it('retains a failed batch deletion and recovers all graph edits together after reopening', async () => {
    const f = await chatFixture()
    const sessionId = SessionId('recover-batch-session')
    const archived = new Set<SessionId>()
    const native = historyArchives(f.ctx, archived)
    await f.repository.coordination.reserveThread(f.create, '/project')
    await f.repository.coordination.completeThread(f.create.operationId, sessionId, 0)
    native.archiveSession.mockRejectedValueOnce(new Error('Archive temporarily unavailable'))
    const coordinator = new CanvasChatCoordinator(f.ctx, f.repository)
    cleanup.push(() => coordinator.close())
    const remove = { ...request('pending-batch', 3, { kind: 'batch', ops: [
      { op: 'canvas.set', title: 'After deletion' }, { op: 'node.remove', id: f.chat.id },
    ] }), confirmed: true }
    expect(await coordinator.execute(remove)).toMatchObject({ ok: false, code: 'operation-pending' })
    expect(f.repository.snapshot().canvases[0]).toMatchObject({ title: 'Chats', revision: 3, nodes: [{ id: f.chat.id }] })
    expect(f.domain.table('operations').get(remove.operationId)).toBeUndefined()
    await coordinator.close()
    await f.close()
    const reopened = await f.open()
    const recoveredNative = historyArchives(reopened.ctx, archived)
    const recovered = new CanvasChatCoordinator(reopened.ctx, reopened.repository)
    cleanup.push(() => recovered.close())
    await recovered.recover()
    expect(recoveredNative.archiveSession).toHaveBeenCalledExactlyOnceWith(sessionId, { stopActivity: true })
    expect(reopened.repository.snapshot().canvases[0]).toMatchObject({ title: 'After deletion', revision: 4, nodes: [] })
    expect(await recovered.execute(remove)).toMatchObject({ ok: true })
    expect(reopened.domain.table('history').get(remove.operationId)).toMatchObject({ applied: true, restoreSessions: [sessionId] })
  })

  it('restores bound threads without exposing a creation suppressed during deletion', async () => {
    const f = await chatFixture()
    resources(f, 'directory')
    const boundSession = 'visible-history-thread' as SessionId
    const lateSession = 'suppressed-history-thread' as SessionId
    const archived = new Set<SessionId>()
    historyArchives(f.ctx, archived)
    await f.repository.coordination.reserveThread(f.create, '/project')
    await f.repository.coordination.completeThread(f.create.operationId, boundSession, 0)
    const late: CanvasThreadRequest = { ...f.create, expectedRevision: 3, operationId: 'late-history-thread' as CanvasOperationId }
    const entered = Promise.withResolvers<undefined>()
    const released = Promise.withResolvers<undefined>()
    const deleting = Promise.withResolvers<undefined>()
    const coordinator = new CanvasChatCoordinator(f.ctx, f.repository, testMaterializer(f.repository, async () => {
      entered.resolve(undefined)
      await released.promise
      return { operationId: late.operationId, sessionId: lateSession, inheritedEventCount: 0 }
    }))
    cleanup.push(() => coordinator.close())
    cleanup.push(async () => { released.resolve(undefined) })
    const off = f.repository.subscribe(() => { if (f.repository.isDeleting(canvasId, f.chat.id)) deleting.resolve(undefined) })
    const creating = coordinator.createThread(late)
    await entered.promise
    const remove = { ...request('remove-with-late-thread', 3, { kind: 'remove-nodes', nodeIds: [f.chat.id] }), confirmed: true }
    const removing = coordinator.execute(remove)
    await deleting.promise
    released.resolve(undefined)
    expect(await creating).toMatchObject({ ok: false, code: 'deleting' })
    expect(await removing).toMatchObject({ ok: true })
    off()
    expect(f.domain.table('history').get(remove.operationId)?.restoreSessions).toEqual([boundSession])
    expect(await coordinator.execute(request('restore-with-late-thread', 4, {
      kind: 'history', targetOperationId: remove.operationId, direction: 'undo',
    }))).toMatchObject({ ok: true })
    expect(f.repository.getChat(canvasId, f.chat.id)?.threads.map(thread => thread.sessionId)).toEqual([boundSession])
    expect(archived).toEqual(new Set([lateSession]))
    expect(f.repository.bindingOf(lateSession)?.nodeId).toBe(f.chat.id)
    const restored = f.repository.snapshot()
    await f.repository.coordination.projectDelivery(lateSession, 2, [{ path: '/project/suppressed-output.txt' }], createFileDeliveryOutput)
    expect(f.repository.snapshot()).toEqual(restored)
    expect([...f.domain.table('deliveries').entries()].map(([, value]) => value.phase)).toEqual(['suppressed'])
    expect(await coordinator.createThread(late)).toMatchObject({ ok: false, code: 'deleting' })
  })

  it('restores the original Chat and Session while retaining pre-existing archives and delivery suppression', async () => {
    const f = await chatFixture()
    const root = 'history-root' as SessionId
    const child = 'history-child' as SessionId
    const alreadyArchived = 'history-archived-child' as SessionId
    const archived = new Set([alreadyArchived])
    const headers: SessionHeader[] = [child, alreadyArchived].map(id => ({
      version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false, cwd: '/project', origin: 'subagent', parentSession: root,
    }))
    const native = historyArchives(f.ctx, archived, headers)
    await f.repository.coordination.reserveThread(f.create, '/project')
    await f.repository.coordination.completeThread(f.create.operationId, root, 0)
    await f.repository.coordination.projectDelivery(root, 2, [{ path: '/project/result.txt' }], createFileDeliveryOutput)
    const before = f.repository.snapshot().canvases[0]!
    const remove = { ...request('delete-for-history', before.revision, { kind: 'remove-nodes', nodeIds: [f.chat.id] }), confirmed: true }
    const coordinator = new CanvasChatCoordinator(f.ctx, f.repository)
    cleanup.push(() => coordinator.close())
    expect(await coordinator.execute(remove)).toMatchObject({ ok: true })
    expect(archived).toEqual(new Set([alreadyArchived, root, child]))
    expect(f.domain.table('history').get(remove.operationId)?.restoreSessions).toEqual([root, child])
    const undo = request('restore-chat', before.revision + 1, { kind: 'history', targetOperationId: remove.operationId, direction: 'undo' })
    expect(await coordinator.execute(undo)).toMatchObject({ ok: true })
    expect(archived).toEqual(new Set([alreadyArchived]))
    expect(native.unarchiveSession.mock.calls.map(([id]) => id)).toEqual([root, child])
    expect(f.repository.getChat(canvasId, f.chat.id)).toMatchObject({ threads: [{ sessionId: root }], deleting: false })
    expect(f.repository.bindingOf(root)).toMatchObject({ canvasId, nodeId: f.chat.id })
    expect(f.repository.snapshot().canvases[0]?.nodes.find(node => node.id === f.chat.id)?.revision).toBe(2)
    const restored = f.repository.snapshot()
    await f.repository.coordination.projectDelivery(root, 2, [{ path: '/project/result.txt' }], createFileDeliveryOutput)
    expect(f.repository.snapshot()).toEqual(restored)
    expect([...f.domain.table('deliveries').entries()].map(([, value]) => value.phase)).toEqual(['suppressed'])
    await f.repository.coordination.projectDelivery(root, 3, [{ path: '/project/new-result.txt' }], createFileDeliveryOutput)
    expect([...f.domain.table('deliveries').entries()].map(([, value]) => value.phase)).toEqual(['suppressed', 'projected'])
    const next = { ...f.create, expectedRevision: f.repository.snapshot().canvases[0]!.revision, operationId: 'post-restore-thread' as CanvasOperationId }
    await expect(f.repository.coordination.reserveThread(next, '/project')).resolves.toMatchObject({ phase: 'pending' })
    await expect(f.repository.coordination.completeThread(next.operationId, 'post-restore-session' as SessionId, 0)).resolves.toBe(true)
  })

  it('keeps a failed native restoration durable and gated until a replacement Host recovers it', async () => {
    const f = await chatFixture()
    const sessionId = 'recovered-history-session' as SessionId
    const archived = new Set<SessionId>()
    const native = historyArchives(f.ctx, archived)
    await f.repository.coordination.reserveThread(f.create, '/project')
    await f.repository.coordination.completeThread(f.create.operationId, sessionId, 0)
    const first = new CanvasChatCoordinator(f.ctx, f.repository)
    cleanup.push(() => first.close())
    const remove = { ...request('remove', 3, { kind: 'remove-nodes', nodeIds: [f.chat.id] }), confirmed: true }
    expect(await first.execute(remove)).toMatchObject({ ok: true })
    native.unarchiveSession.mockRejectedValueOnce(new Error('Native archive write failed'))
    const undo = request('pending-restore', 4, { kind: 'history', targetOperationId: remove.operationId, direction: 'undo' })
    const removed = f.repository.snapshot()
    expect(await first.execute(undo)).toMatchObject({ ok: false, code: 'operation-pending' })
    expect(f.repository.snapshot()).toEqual(removed)
    expect(f.repository.getChat(canvasId, f.chat.id)).toBeUndefined()
    expect(f.domain.table('restorations').get(undo.operationId)).toMatchObject({ phase: 'restoring', error: 'Native archive write failed', sessionIds: [sessionId] })
    expect(await f.repository.execute(request('blocked-edit', 4, { kind: 'add-node', node: node('other') }))).toMatchObject({ ok: false, code: 'conflict' })
    expect(await f.repository.execute({ ...undo, command: { kind: 'rename', title: 'Wrong identity' } })).toMatchObject({ ok: false, code: 'invalid-command' })
    await first.close()
    await f.close()
    const reopened = await f.open()
    const retried = historyArchives(reopened.ctx, archived)
    const retry = new CanvasChatCoordinator(reopened.ctx, reopened.repository)
    cleanup.push(() => retry.close())
    await retry.recover()
    expect(retried.unarchiveSession).toHaveBeenCalledExactlyOnceWith(sessionId)
    expect(reopened.repository.getChat(canvasId, f.chat.id)).toMatchObject({ threads: [{ sessionId }] })
    expect(reopened.domain.table('restorations').get(undo.operationId)?.phase).toBe('completed')
    expect(reopened.domain.table('history').get(remove.operationId)?.applied).toBe(false)
    expect(await retry.execute(undo)).toMatchObject({ ok: true })
    expect(retried.unarchiveSession).toHaveBeenCalledOnce()
  })

  it('confirms stopping a Chat added before its thread and restores that same binding on redo', async () => {
    const f = await chatFixture()
    const sessionId = 'added-chat-session' as SessionId
    const archived = new Set<SessionId>()
    const native = historyArchives(f.ctx, archived)
    await f.repository.coordination.reserveThread(f.create, '/project')
    await f.repository.coordination.completeThread(f.create.operationId, sessionId, 0)
    const coordinator = new CanvasChatCoordinator(f.ctx, f.repository)
    cleanup.push(() => coordinator.close())
    const undo = request('undo-add-chat', 3, { kind: 'history', targetOperationId: 'add-chat' as CanvasOperationId, direction: 'undo' })
    expect(await coordinator.execute(undo)).toMatchObject({ ok: false, code: 'confirmation-required' })
    expect(native.archiveSession).not.toHaveBeenCalled()
    expect(await coordinator.execute({ ...undo, confirmed: true })).toMatchObject({ ok: true })
    expect(f.repository.snapshot().chats).toEqual([])
    expect(archived.has(sessionId)).toBe(true)
    expect(await coordinator.execute(request('redo-add-chat', 4, { kind: 'history', targetOperationId: 'add-chat' as CanvasOperationId, direction: 'redo' }))).toMatchObject({ ok: true })
    expect(f.repository.getChat(canvasId, f.chat.id)?.threads).toEqual([{ sessionId, parentSessionId: null, inheritedEventCount: 0 }])
    expect(archived.size).toBe(0)
    expect(f.domain.table('thread_operations').size).toBe(1)
  })
})

describe('Chat coordination records', () => {
  it('adds multiple copied Chat containers without copying their source Session bindings', async () => {
    const f = await chatFixture()
    const sourceSession = 'source-thread' as SessionId
    await f.repository.coordination.reserveThread(f.create, '/project')
    await f.repository.coordination.completeThread(f.create.operationId, sourceSession, 0)
    const before = f.repository.snapshot()
    const copies = ['chat-copy-a', 'chat-copy-b'].map(id => ({ ...f.chat, id: id as CanvasNodeId }))
    const createSession = vi.fn()
    const coordinator = new CanvasChatCoordinator(f.ctx, f.repository, testMaterializer(f.repository, createSession))
    cleanup.push(() => coordinator.close())
    expect(await coordinator.execute(request('copy-chats', before.canvases[0]!.revision, {
      kind: 'add-subgraph', nodes: copies, connections: [],
    }))).toMatchObject({ ok: true })
    const committed = f.repository.snapshot()
    expect(committed.chats).toHaveLength(3)
    expect(committed.chats[0]?.threads).toEqual(before.chats[0]?.threads)
    expect(committed.chats.slice(1).map(chat => chat.threads)).toEqual([[], []])
    expect(f.repository.coordination.bindings()).toHaveLength(1)
    expect(createSession).not.toHaveBeenCalled()
  })

  it('retains the chosen preset after a failed creation and repository reopen, and rejects a changed retry', async () => {
    const f = await chatFixture()
    const { path: project } = resources(f, 'directory')
    const selected = { ...f.create, agentPreset: 'plan' }
    const createSession = vi.fn(async (_request: TestSessionCreateRequest) => { throw new Error('Creation reply lost') })
    const first = new CanvasChatCoordinator(f.ctx, f.repository, testMaterializer(f.repository, createSession))
    cleanup.push(() => first.close())
    expect(await first.createThread(selected)).toMatchObject({ ok: false, code: 'operation-pending' })
    expect(JSON.parse(f.repository.coordination.thread(selected.operationId)!.request)).toEqual(selected)
    await first.close()
    await f.close()

    const reopened = await f.open()
    reopened.registry.register({ id: 'convax.chat' as CanvasNodeTypeId, dataVersion: 1, capabilities: { sessions: true }, ports: [], parse: data => data })
    const sessionId = SessionId('preset-recovered-thread')
    const recoveredCreate = vi.fn(async (creation: TestSessionCreateRequest) => ({
      phase: 'completed' as const, operationId: creation.operationId, sessionId, inheritedEventCount: 0,
    }))
    const retry = new CanvasChatCoordinator(reopened.ctx, reopened.repository, testMaterializer(reopened.repository, recoveredCreate))
    cleanup.push(() => retry.close())
    expect(await retry.createThread({ ...selected, agentPreset: 'standard' })).toMatchObject({ ok: false, code: 'invalid-command' })
    expect(recoveredCreate).not.toHaveBeenCalled()
    await retry.recover()
    expect(createSession).toHaveBeenCalledExactlyOnceWith({ operationId: selected.operationId, cwd: project, agentPreset: 'plan' })
    expect(recoveredCreate).toHaveBeenCalledExactlyOnceWith({ operationId: selected.operationId, cwd: project, agentPreset: 'plan' })
    expect(await retry.createThread(selected)).toMatchObject({ ok: true, sessionId })
    expect(recoveredCreate).toHaveBeenCalledOnce()
    expect(reopened.repository.snapshot().chats[0]?.threads).toMatchObject([{ sessionId }])
  })

  it('rejects a preset change while the original thread creation is in flight', async () => {
    const f = await chatFixture()
    resources(f, 'directory')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const selected = { ...f.create, agentPreset: 'plan' }
    const createSession = vi.fn(async (creation: TestSessionCreateRequest) => {
      entered.resolve(undefined)
      await release.promise
      return { phase: 'completed' as const, operationId: creation.operationId, sessionId: SessionId('selected-preset'), inheritedEventCount: 0 }
    })
    const coordinator = new CanvasChatCoordinator(f.ctx, f.repository, testMaterializer(f.repository, createSession))
    cleanup.push(() => coordinator.close())
    cleanup.push(async () => { release.resolve(undefined) })
    const pending = coordinator.createThread(selected)
    await entered.promise
    expect(await coordinator.createThread({ ...selected, agentPreset: 'standard' })).toMatchObject({ ok: false, code: 'invalid-command' })
    release.resolve(undefined)
    expect(await pending).toMatchObject({ ok: true })
    expect(createSession).toHaveBeenCalledOnce()
    expect(createSession.mock.calls[0]![0].agentPreset).toBe('plan')
  })

  it('keeps the folder project for new threads after connecting another folder', async () => {
    const f = await chatFixture()
    const { path: project } = resources(f, 'directory')
    const cwdUpdate = await f.repository.execute(request('folder-project', 2, {
      kind: 'update-node', nodeId: f.chat.id, dataVersion: 1, data: { title: 'Folder Chat', cwd: project },
    }))
    expect(cwdUpdate.ok).toBe(true)
    const folder = { ...node('another-folder'), data: { path: join(dirname(project), 'other-project') } }
    expect((await f.repository.execute(request('another-folder', 3, { kind: 'add-node', node: folder,
      initialConnections: [{ id: brandString<import('../src/types.ts').CanvasConnectionId>('another-folder-input'),
        source: folder.id, sourcePort: 'output', target: f.chat.id, targetPort: 'input', purpose: 'input' }],
    }))).ok).toBe(true)
    const createSession = vi.fn(async () => ({ phase: 'completed', operationId: 'folder-thread',
      sessionId: SessionId('folder-thread'), inheritedEventCount: 0 }))
    const coordinator = new CanvasChatCoordinator(f.ctx, f.repository, testMaterializer(f.repository, createSession))
    cleanup.push(() => coordinator.close())
    expect(await coordinator.createThread({ ...f.create, expectedRevision: 4 })).toMatchObject({ ok: true })
    expect(createSession).toHaveBeenCalledExactlyOnceWith({ operationId: f.create.operationId, cwd: project })
    expect(f.repository.getChat(canvasId, f.chat.id)?.cwd).toBe(project)
    expect(f.repository.snapshot().canvases[0]?.nodes.find(value => value.id === folder.id)?.data.path).not.toBe(project)
  })

  it('reserves before external work, binds the actual Session once, and rejects identity reuse', async () => {
    const { repository, create, chat } = await chatFixture()
    expect(repository.snapshot().chats).toMatchObject([{ nodeId: chat.id, cwd: '/project', threads: [], deleting: false }])
    await repository.coordination.reserveThread(create, '/project')
    expect(repository.coordination.pendingThreads()).toEqual([create.operationId])
    const sessionId = 'actual-session' as SessionId
    await repository.coordination.completeThread(create.operationId, sessionId, 0)
    const saved = repository.snapshot()
    expect(saved.chats[0]?.threads).toEqual([{ sessionId, parentSessionId: null, inheritedEventCount: 0 }])
    await repository.coordination.completeThread(create.operationId, sessionId, 0)
    expect(repository.snapshot()).toEqual(saved)
    await expect(repository.coordination.reserveThread({ ...create, cwd: '/other' }, '/other')).rejects.toMatchObject({ code: 'invalid-command' })
    expect(await repository.coordination.reserveThread(create, '/unused-retry-value')).toMatchObject({ cwd: '/project', sessionId, phase: 'bound' })
    const other = { ...create, operationId: 'thread-b' as CanvasOperationId, expectedRevision: saved.canvases[0]!.revision }
    await repository.coordination.reserveThread(other, '/project')
    await expect(repository.coordination.completeThread(other.operationId, 'different-session' as SessionId, 0)).resolves.toBe(true)
    expect(repository.snapshot().chats[0]?.threads).toHaveLength(2)
  })

  it('retires deleted Chat and canvas identities so late deliveries cannot attach to a replacement', async () => {
    const f = await chatFixture()
    const sessionId = 'retired-chat-session' as SessionId
    await f.repository.coordination.reserveThread(f.create, '/project')
    await f.repository.coordination.completeThread(f.create.operationId, sessionId, 0)
    const deleting = request('retire-chat', f.repository.snapshot().canvases[0]!.revision, { kind: 'remove-nodes', nodeIds: [f.chat.id] })
    await f.repository.coordination.beginDeletion({ ...deleting, confirmed: true })
    await f.repository.coordination.finishDeletion(deleting.operationId)
    const canvas = f.repository.snapshot().canvases[0]!
    expect(await f.repository.execute(request('reuse-node', canvas.revision, { kind: 'add-node', node: f.chat })))
      .toMatchObject({ ok: false, code: 'invalid-command' })
    expect(await f.repository.execute(request('reuse-in-batch', canvas.revision, { kind: 'add-subgraph',
      nodes: [node('new-resource'), f.chat], connections: [],
    }))).toMatchObject({ ok: false, code: 'invalid-command' })
    await f.repository.coordination.projectDelivery(sessionId, 4, [{ path: '/project/late.txt' }], createFileDeliveryOutput)
    expect(f.repository.snapshot().canvases[0]?.nodes).toEqual([])
    const removeCanvas = request('retire-canvas', canvas.revision, { kind: 'delete' })
    await f.repository.coordination.beginDeletion({ ...removeCanvas, confirmed: true })
    await f.repository.coordination.finishDeletion(removeCanvas.operationId)
    expect(await f.repository.execute(request('reuse-canvas', 0, { kind: 'create', title: 'Replacement' })))
      .toMatchObject({ ok: false, code: 'invalid-command' })
    expect(f.repository.snapshot().canvases).toEqual([])
  })

  it('retains failed intentions across a close and rejects binding one Session to another Chat', async () => {
    const f = await chatFixture()
    await f.repository.coordination.reserveThread(f.create, '/project')
    await f.repository.coordination.failThread(f.create.operationId, 'Retry the reserved Session operation')
    await f.close()
    const reopened = await f.open()
    expect(reopened.repository.snapshot().chats[0]?.issue).toContain('reserved Session')
    await reopened.repository.coordination.completeThread(f.create.operationId, 'unique-session' as SessionId, 0)
    const canvas = reopened.repository.snapshot().canvases[0]!
    reopened.registry.register({ id: 'convax.chat' as CanvasNodeTypeId, dataVersion: 1, capabilities: { sessions: true }, ports: [], parse: data => data })
    const second = { ...f.chat, id: 'chat-b' as CanvasNodeId }
    await reopened.repository.execute(request('add-second-chat', canvas.revision, { kind: 'add-node', node: second }))
    const create = { ...f.create, nodeId: second.id, operationId: 'thread-other-chat' as CanvasOperationId, expectedRevision: canvas.revision + 1 }
    await reopened.repository.coordination.reserveThread(create, '/project')
    await expect(reopened.repository.coordination.completeThread(create.operationId, 'unique-session' as SessionId, 0)).rejects.toMatchObject({ code: 'invalid-command' })
    expect(reopened.repository.bindingOf('unique-session' as SessionId)?.nodeId).toBe(f.chat.id)
  })

  it('gates new work during deletion and retains a late Session for stop-and-archive', async () => {
    const { repository, create, chat } = await chatFixture()
    await repository.coordination.reserveThread(create, '/project')
    const deletion = await repository.coordination.beginDeletion({ ...request('remove-chat', 2, { kind: 'remove-nodes', nodeIds: [chat.id] }), confirmed: true })
    expect(repository.isDeleting(canvasId, chat.id)).toBe(true)
    await expect(repository.coordination.reserveThread({ ...create, operationId: 'late-new-thread' as CanvasOperationId }, '/project')).rejects.toMatchObject({ code: 'deleting' })
    await expect(repository.coordination.finishDeletion('remove-chat' as CanvasOperationId)).rejects.toMatchObject({ code: 'deleting' })
    expect(await repository.coordination.completeThread(create.operationId, 'late-session' as SessionId, 0)).toBe(false)
    expect(repository.coordination.deletionTargets(deletion)).toEqual({ sessions: ['late-session'], operations: [] })
    await repository.coordination.failDeletion('remove-chat' as CanvasOperationId, 'Stop failed; retry deletion')
    expect(repository.snapshot().chats[0]?.issue).toBe('Stop failed; retry deletion')
    expect(repository.snapshot().canvases[0]?.nodes).toHaveLength(1)
    await repository.coordination.finishDeletion('remove-chat' as CanvasOperationId)
    expect(repository.snapshot().chats).toEqual([])
    expect(repository.bindingOf('late-session' as SessionId)?.nodeId).toBe(chat.id)
  })

  it('atomically projects every file and cursor, preserves removal, and keeps repeated paths distinct', async () => {
    const { repository, create, domain, path } = await chatFixture()
    await repository.coordination.reserveThread(create, '/project')
    const sessionId = 'delivery-session' as SessionId
    await repository.coordination.completeThread(create.operationId, sessionId, 0)
    const before = repository.snapshot()
    const db = new DatabaseSync(path)
    cleanup.push(async () => { db.close() })
    db.exec("CREATE TRIGGER reject_second_delivery BEFORE INSERT ON u_convax_deliveries WHEN json_extract(NEW.value, '$.index') = 1 BEGIN SELECT RAISE(ABORT, 'delivery fault'); END")
    await expect(repository.coordination.projectDelivery(sessionId, 8, [{ path: '/project/result.txt' }, { path: '/project/other.txt' }], createFileDeliveryOutput)).rejects.toThrow()
    expect(repository.snapshot()).toEqual(before)
    expect(domain.table('deliveries').size).toBe(0)
    expect(repository.coordination.bindings()[0]?.deliveryCursor).toBe(-1)
    db.exec('DROP TRIGGER reject_second_delivery')
    await repository.coordination.projectDelivery(sessionId, 8, [{ path: '/project/result.txt' }, { path: '/project/other.txt' }], createFileDeliveryOutput)
    expect(repository.snapshot().canvases[0]?.connections).toHaveLength(2)
    expect(repository.coordination.bindings()[0]?.deliveryCursor).toBe(8)
    const canvas = repository.snapshot().canvases[0]!
    const output = canvas.nodes.find(value => value.typeId === 'convax.file')!
    await repository.execute(request('remove-output', canvas.revision, { kind: 'remove-nodes', nodeIds: [output.id] }))
    await repository.coordination.projectDelivery(sessionId, 8, [{ path: '/project/result.txt' }, { path: '/project/other.txt' }], createFileDeliveryOutput)
    expect(repository.snapshot().canvases[0]?.nodes.some(value => value.id === output.id)).toBe(false)
    expect([...domain.table('deliveries').entries()].map(([, value]) => value.phase)).toContain('removed')
    await repository.coordination.projectDelivery(sessionId, 12, [{ path: '/project/result.txt' }], createFileDeliveryOutput)
    expect(domain.table('deliveries').size).toBe(3)
    expect(repository.snapshot().canvases[0]?.nodes.filter(value => value.typeId === 'convax.file')).toHaveLength(2)
  })

  it('excludes fork history and suppresses deliveries while a Chat is being removed', async () => {
    const { repository, create, chat, domain } = await chatFixture()
    const sessionId = 'fork-deliveries' as SessionId
    await repository.coordination.reserveThread(create, '/project')
    await repository.coordination.completeThread(create.operationId, sessionId, 20)
    await repository.coordination.projectDelivery(sessionId, 4, [{ path: '/old/result.txt' }], createFileDeliveryOutput)
    expect(domain.table('deliveries').size).toBe(0)
    const canvas = repository.snapshot().canvases[0]!
    await repository.coordination.beginDeletion({ ...request('delete-with-output', canvas.revision, { kind: 'remove-nodes', nodeIds: [chat.id] }), confirmed: true })
    await repository.coordination.projectDelivery(sessionId, 24, [{ path: '/new/result.txt' }], createFileDeliveryOutput)
    expect(repository.snapshot().canvases[0]?.nodes).toHaveLength(1)
    expect([...domain.table('deliveries').entries()][0]?.[1].phase).toBe('suppressed')
    const initial = { inheritedEventCount: 20, deliveries: [] }
    const inherited = { type: 'deliverables/presented' as const, seq: SessionSeq(4), time: 1, data: { turn: 1, callId: 'call' as ToolCallId, files: [{ path: '/old/result.txt' }] } }
    expect(canvasDeliveryProjection.apply(initial, inherited)).toBe(initial)
    expect(canvasDeliveryProjection.apply(initial, { ...inherited, seq: SessionSeq(24) }).deliveries).toHaveLength(1)
  })
})

type ResourceFiles = Pick<FileSystem, 'resolve' | 'stat' | 'processPath' | 'listDir' | 'streamText' | 'readBytes' | 'readByteRange' | 'watch'>

function resources(f: Awaited<ReturnType<typeof fixture>>, kind: 'file' | 'directory', overrides: Partial<ResourceFiles> = {}) {
  const path = join(dirname(f.path), kind === 'file' ? 'reference.txt' : 'folder')
  const target = { targetKey: FsTargetKey(path), displayPath: path }
  const files: ResourceFiles = {
    resolve: () => Promise.resolve(target),
    processPath: () => path,
    stat: () => Promise.resolve({ type: kind, version: FsVersion('one') }),
    listDir: () => Promise.resolve([]),
    streamText: () => Promise.resolve((async function* () { yield 'preview' })()),
    readBytes: () => Promise.resolve(new TextEncoder().encode('preview')),
    readByteRange: () => Promise.resolve(new Uint8Array([0])),
    watch: () => Promise.resolve(() => Promise.resolve()),
    ...overrides,
  }
  f.ctx.provide('fs', files as never)
  const service = new ConvaxHost(f.ctx, f.repository, { previewBytes: 1024, documentBytes: 1024, mediaChunkBytes: 1024 })
  cleanup.push(() => service.close())
  return { service, path }
}

describe('ConvaxHost resource ownership', () => {
  it('observes lightweight metadata without loading content and closes its filesystem watcher', async () => {
    const f = await fixture()
    const close = vi.fn(() => Promise.resolve())
    const content = vi.fn(() => Promise.resolve(new Uint8Array([0, 255])))
    let changed: Parameters<FileSystem['watch']>[1] | undefined
    let size = 2
    const { service, path } = resources(f, 'file', {
      stat: () => Promise.resolve({ type: 'file', version: FsVersion(String(size)), size }),
      readBytes: content,
      watch: (_target, callback) => { changed = callback; return Promise.resolve(close) },
    })
    const stream = service.watchResource(path, new AbortController().signal)[Symbol.asyncIterator]()
    expect((await stream.next()).value).toMatchObject({ path, kind: 'file', size: 2 })
    size = 3
    changed?.()
    expect((await stream.next()).value).toMatchObject({ path, size: 3 })
    expect(content).not.toHaveBeenCalled()
    await service.close()
    expect(close).toHaveBeenCalledOnce()
    expect((await stream.next()).done).toBe(true)
  })

  it('allows complete unary reads after metadata invalidation and releases the watcher on cancellation', async () => {
    const f = await fixture()
    const close = vi.fn(() => Promise.resolve())
    let changed: Parameters<FileSystem['watch']>[1] | undefined
    let bytes = new Uint8Array([0, 255])
    const { service, path } = resources(f, 'file', {
      readBytes: () => Promise.resolve(bytes),
      watch: (_target, callback) => { changed = callback; return Promise.resolve(close) },
    })
    const controller = new AbortController()
    const stream = service.watchResource(path, controller.signal)[Symbol.asyncIterator]()
    expect((await stream.next()).value).toMatchObject({ path, kind: 'file' })
    expect(await service.readDocument(path)).toMatchObject({ path, bytes, version: 'one' })
    bytes = new Uint8Array([128, 1, 2])
    changed?.()
    expect((await stream.next()).value).toMatchObject({ path, kind: 'file' })
    expect(await service.readDocument(path)).toMatchObject({ path, bytes })
    controller.abort()
    expect((await stream.next()).done).toBe(true)
    expect(close).toHaveBeenCalledOnce()
  })

  it('cancels and drains an in-flight complete document read before Host close resolves', async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<AbortSignal | undefined>()
    const release = Promise.withResolvers<Uint8Array>()
    const { service, path } = resources(f, 'file', {
      readBytes: (_target, signal) => { entered.resolve(signal); return release.promise },
    })
    cleanup.push(() => { release.resolve(new Uint8Array()); return Promise.resolve() })
    const pending = service.readDocument(path)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const signal = await entered.promise
    let finished = false
    const closing = service.close().then(() => { finished = true })
    expect(signal?.aborted).toBe(true)
    expect(finished).toBe(false)
    release.resolve(new Uint8Array([0, 255]))
    await rejected
    await closing
  })

  it('drains a shared converter source read after its cancelled reader has already rejected', async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<AbortSignal | undefined>()
    const release = Promise.withResolvers<Uint8Array>()
    const { service, path } = resources(f, 'file', {
      processPath: () => '/project/report.docx',
      readBytes: (_target, signal) => { entered.resolve(signal); return release.promise },
    })
    cleanup.push(() => { release.resolve(new Uint8Array()); return Promise.resolve() })
    f.ctx.provide('officeToPdf', {
      convert: (request: OfficeToPdfRequest, signal: AbortSignal): Promise<OfficeToPdfResult> => {
        const source = request.source.read(signal, 1024)
        return new Promise((_resolve, reject) => {
          void source.catch(reject)
          signal.addEventListener('abort', () => {
            const reason: unknown = signal.reason
            reject(reason instanceof Error ? reason : new Error('Converter reader cancelled', { cause: reason }))
          }, { once: true })
        })
      },
    } as never)
    const pending = service.readDocument(path)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const sourceSignal = await entered.promise
    let finished = false
    const closing = service.close().then(() => { finished = true })
    await rejected
    expect(sourceSignal?.aborted).toBe(true)
    expect(finished).toBe(false)
    release.resolve(new Uint8Array([0, 255]))
    await closing
  })

  it('resolves an explicitly requested provider reference without changing graph data or creating a Session', async () => {
    const f = await fixture()
    const { service, path } = resources(f, 'directory')
    await f.unregisterType()
    const prepareInput = vi.fn(async (_source: CanvasNode, _signal: AbortSignal) => ({ path, name: 'folder', kind: 'folder' as const, size: null }))
    const parse = vi.fn((data: import('../src/types.ts').CanvasData) => ({ ...data, normalized: true }))
    const remove = f.registry.register({ id: node('resource').typeId, dataVersion: 1, ports: [], parse, prepareInput })
    cleanup.push(remove)
    await f.repository.execute(request('reference-canvas', 0, { kind: 'create', title: 'References' }))
    await f.repository.execute(request('reference-node', 1, { kind: 'add-node', node: node('resource') }))
    const saved = f.repository.snapshot()
    expect(await service.prepareReference(canvasId, node('resource').id)).toEqual({ path, name: 'folder', kind: 'folder', size: null })
    expect(prepareInput).toHaveBeenCalledOnce()
    expect(prepareInput.mock.calls[0]?.[0].data).toMatchObject({ normalized: true })
    expect(f.repository.snapshot()).toEqual(saved)
  })

  it('requires an active provider and resolves its saved path when no preparation hook is declared', async () => {
    const f = await fixture()
    const { service, path } = resources(f, 'file')
    await f.repository.execute(request('reference-canvas', 0, { kind: 'create', title: 'References' }))
    const source = node('resource')
    await f.repository.execute(request('reference-node', 1, { kind: 'add-node', node: source }))
    expect(await service.prepareReference(canvasId, source.id)).toMatchObject({ path, kind: 'file' })
    await f.unregisterType()
    await expect(service.prepareReference(canvasId, source.id)).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(service.prepareReference(canvasId, node('missing').id)).rejects.toMatchObject({ code: 'gateway/bad-request' })
  })

  it('rejects an incompatible source and a source changed during explicit preparation', async () => {
    const f = await fixture()
    const { service, path } = resources(f, 'file')
    await f.repository.execute(request('reference-canvas', 0, { kind: 'create', title: 'References' }))
    const source = node('resource')
    await f.repository.execute(request('reference-node', 1, { kind: 'add-node', node: source }))
    f.repository.setNodeIssues([{ canvasId, nodeId: source.id, kind: 'incompatible', message: 'Missing migration' }])
    await expect(service.prepareReference(canvasId, source.id)).rejects.toMatchObject({ code: 'gateway/bad-request' })
    f.repository.setNodeIssues([])
    await f.unregisterType()
    const entered = Promise.withResolvers<undefined>()
    const finish = Promise.withResolvers<import('../src/types.ts').CanvasResource>()
    const remove = f.registry.register({ id: source.typeId, dataVersion: 1, ports: [], parse: data => data,
      prepareInput: () => { entered.resolve(undefined); return finish.promise },
    })
    cleanup.push(async () => { finish.resolve({ path, name: 'reference.txt', kind: 'file', size: null }); await remove() })
    const preparing = service.prepareReference(canvasId, source.id)
    const outcome = expect(preparing).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await entered.promise
    await f.repository.execute(request('remove-source', 2, { kind: 'remove-nodes', nodeIds: [source.id] }))
    finish.resolve({ path, name: 'reference.txt', kind: 'file', size: null })
    await outcome
  })

  it('cancels and drains provider preparation before accepting a late reference result', async () => {
    const f = await fixture()
    const { service, path } = resources(f, 'file')
    await f.repository.execute(request('reference-canvas', 0, { kind: 'create', title: 'References' }))
    const source = node('resource')
    await f.repository.execute(request('reference-node', 1, { kind: 'add-node', node: source }))
    await f.unregisterType()
    const entered = Promise.withResolvers<AbortSignal>()
    const finish = Promise.withResolvers<import('../src/types.ts').CanvasResource>()
    const remove = f.registry.register({ id: source.typeId, dataVersion: 1, ports: [], parse: data => data,
      prepareInput: (_source, signal) => { entered.resolve(signal); return finish.promise },
    })
    cleanup.push(async () => { finish.resolve({ path, name: 'reference.txt', kind: 'file', size: null }); await remove() })
    const preparing = service.prepareReference(canvasId, source.id)
    const outcome = expect(preparing).rejects.toThrow('was removed')
    const signal = await entered.promise
    let closed = false
    const closing = remove().then(() => { closed = true })
    expect(signal.aborted).toBe(true)
    expect(closed).toBe(false)
    finish.resolve({ path, name: 'reference.txt', kind: 'file', size: null })
    await outcome
    await closing
    await expect(service.prepareReference(canvasId, source.id, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('publishes provider metadata changes to an already open workspace stream', async () => {
    const f = await fixture()
    const { service } = resources(f, 'directory')
    const stream = service.watch(new AbortController().signal)[Symbol.asyncIterator]()
    const initial = await stream.next()
    if (initial.done) throw new Error('workspace stream ended before its initial snapshot')
    expect(initial.value.nodeTypes).toHaveLength(1)
    await f.unregisterType()
    const changed = await stream.next()
    if (changed.done) throw new Error('workspace stream ended before provider invalidation')
    expect(changed.value.nodeTypes).toEqual([])
    await service.close()
    expect((await stream.next()).done).toBe(true)
  })

  it('closes watchers without requiring a suspended consumer to pull another item', async () => {
    const f = await fixture()
    const closeStarted = Promise.withResolvers<undefined>()
    const releaseClose = Promise.withResolvers<undefined>()
    const { service, path } = resources(f, 'directory', {
      watch: () => Promise.resolve(async () => { closeStarted.resolve(undefined); await releaseClose.promise }),
    })
    cleanup.push(() => { releaseClose.resolve(undefined); return Promise.resolve() })
    const stream = service.watchDirectory(path, new AbortController().signal)[Symbol.asyncIterator]()
    expect((await stream.next()).value).toEqual({ path, entries: [] })
    let finished = false
    const closing = service.close().then(() => { finished = true })
    await closeStarted.promise
    expect(finished).toBe(false)
    releaseClose.resolve(undefined)
    await closing
    await stream.return?.()
  })

  it('waits for in-flight reads and rejects a response that arrives after shutdown', async () => {
    const f = await fixture()
    const readStarted = Promise.withResolvers<AbortSignal | undefined>()
    const releaseRead = Promise.withResolvers<undefined>()
    const { service, path } = resources(f, 'file', {
      streamText: (_target, signal) => Promise.resolve((async function* () {
        readStarted.resolve(signal)
        await releaseRead.promise
        yield 'late response'
      })()),
    })
    cleanup.push(() => { releaseRead.resolve(undefined); return Promise.resolve() })
    const read = service.previewFile(path)
    const rejected = expect(read).rejects.toMatchObject({ name: 'AbortError' })
    const signal = await readStarted.promise
    let finished = false
    const closing = service.close().then(() => { finished = true })
    expect(signal?.aborted).toBe(true)
    expect(finished).toBe(false)
    releaseRead.resolve(undefined)
    await rejected
    await closing
    await expect(service.describe(path)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('cancels pending watcher initialization and closes a watcher that resolves late', async () => {
    const f = await fixture()
    const watchStarted = Promise.withResolvers<AbortSignal>()
    const releaseWatch = Promise.withResolvers<() => Promise<void>>()
    const close = vi.fn(() => Promise.resolve())
    const { service, path } = resources(f, 'directory', {
      watch: (_target, _changed, signal) => { watchStarted.resolve(signal); return releaseWatch.promise },
    })
    cleanup.push(() => { releaseWatch.resolve(close); return Promise.resolve() })
    const stream = service.watchDirectory(path, new AbortController().signal)[Symbol.asyncIterator]()
    const rejected = expect(stream.next()).rejects.toMatchObject({ name: 'AbortError' })
    const signal = await watchStarted.promise
    const closing = service.close()
    expect(signal.aborted).toBe(true)
    releaseWatch.resolve(close)
    await rejected
    await closing
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('Chat Session coordination', () => {
  it('retains an existing operation diagnostic and its category when profile coordination is unavailable', async () => {
    const f = await chatFixture()
    const host = new ConvaxHost(f.ctx, f.repository, { previewBytes: 10, documentBytes: 1024, mediaChunkBytes: 1024 })
    cleanup.push(() => host.close())
    await f.repository.coordination.reserveThread(f.create, '/project')
    await f.repository.coordination.failThread(f.create.operationId, 'Retry the original operation')
    expect(host.workspace().chats[0]).toMatchObject({ issue: 'Retry the original operation', issueCode: 'thread-create' })
  })

  it('reports missing profile coordination consistently in workspace reads and watches', async () => {
    const f = await chatFixture()
    const host = new ConvaxHost(f.ctx, f.repository, { previewBytes: 10, documentBytes: 1024, mediaChunkBytes: 1024 })
    cleanup.push(() => host.close())
    const message = 'Chat creation and deletion are unavailable in this profile'
    expect(host.workspace().chats[0]?.issue).toBe(message)
    expect(host.workspace().chats[0]?.issueCode).toBe('chat-unavailable')
    const abort = new AbortController()
    for await (const snapshot of host.watch(abort.signal)) {
      expect(snapshot.chats[0]?.issue).toBe(message)
      expect(snapshot.chats[0]?.issueCode).toBe('chat-unavailable')
      break
    }
    abort.abort()
    f.ctx.provide('sessionQuery', {} as never)
    f.ctx.provide('workspaceRegistry', {} as never)
    expect(f.ctx.get('sessionController')).toBeUndefined()
    host.registerSessionOperations(new CanvasChatCoordinator(f.ctx, f.repository, testMaterializer(f.repository, async () => { throw new Error('No creation expected') })))
    expect(host.workspace().chats[0]?.issue).toBeNull()
    expect(host.workspace().chats[0]).not.toHaveProperty('issueCode')
    await f.repository.coordination.reserveThread(f.create, '/project')
    await f.repository.coordination.failThread(f.create.operationId, 'Retry the original operation')
    expect(host.workspace().chats[0]?.issue).toBe('Retry the original operation')
    expect(host.workspace().chats[0]?.issueCode).toBe('thread-create')
  })

  it('retries a lost creation acknowledgement with the same identity and does not resend a prompt', async () => {
    const f = await chatFixture()
    resources(f, 'directory')
    const sessionId = 'created-before-reply-loss' as SessionId
    let actualCreations = 0
    const createSession = vi.fn((value: { operationId: string }) => {
      expect(f.repository.coordination.thread(f.create.operationId)?.phase).toBe('pending')
      if (actualCreations === 0) { actualCreations++; return Promise.reject(new Error('Reply lost after durable creation')) }
      return Promise.resolve({ phase: 'completed', operationId: value.operationId, sessionId, inheritedEventCount: 0 })
    })
    const prompt = vi.fn()
    f.ctx.provide('workspaceRegistry', { archiveSession: vi.fn() } as never)
    const first = new CanvasChatCoordinator(f.ctx, f.repository, testMaterializer(f.repository, createSession))
    cleanup.push(() => first.close())
    expect(await first.createThread(f.create)).toMatchObject({ ok: false, code: 'operation-pending' })
    expect(f.repository.snapshot().chats[0]?.issue).toContain('Reply lost')
    const retry = new CanvasChatCoordinator(f.ctx, f.repository, testMaterializer(f.repository, createSession))
    cleanup.push(() => retry.close())
    expect(await retry.createThread(f.create)).toMatchObject({ ok: true, sessionId })
    expect(await retry.createThread(f.create)).toMatchObject({ ok: true, sessionId })
    expect(createSession).toHaveBeenCalledTimes(2)
    expect(actualCreations).toBe(1)
    expect(prompt).not.toHaveBeenCalled()
    expect(f.repository.snapshot().chats[0]?.threads).toHaveLength(1)
  })

  it('keeps a failed deletion visible until every Session stop and archive is confirmed', async () => {
    const f = await chatFixture()
    resources(f, 'directory')
    const sessionId = 'running-owned-session' as SessionId
    await f.repository.coordination.reserveThread(f.create, '/project')
    await f.repository.coordination.completeThread(f.create.operationId, sessionId, 0)
    const archiveSession = vi.fn().mockRejectedValueOnce(new Error('Task has not stopped')).mockResolvedValue(undefined)
    f.ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
    f.ctx.provide('sessions', { list: () => [] } as never)
    f.ctx.provide('agents', { get: () => undefined } as never)
    f.ctx.provide('sessionController', {} as never)
    f.ctx.provide('workspaceRegistry', { archiveSession, archivedSessionIds: [sessionId] } as never)
    const coordinator = new CanvasChatCoordinator(f.ctx, f.repository)
    cleanup.push(() => coordinator.close())
    const removal = request('confirmed-remove', f.repository.snapshot().canvases[0]!.revision, { kind: 'remove-nodes', nodeIds: [f.chat.id] })
    expect(await coordinator.execute(removal)).toMatchObject({ ok: false, code: 'confirmation-required' })
    expect(archiveSession).not.toHaveBeenCalled()
    const confirmed = { ...removal, confirmed: true }
    expect(await coordinator.execute(confirmed)).toMatchObject({ ok: false, code: 'operation-pending' })
    expect(f.repository.snapshot().chats[0]).toMatchObject({ deleting: true, issue: 'Task has not stopped' })
    expect(await coordinator.execute(confirmed)).toMatchObject({ ok: true })
    expect(archiveSession).toHaveBeenCalledTimes(2)
    expect(f.repository.snapshot().canvases[0]?.nodes).toEqual([])
  })

  it('settles a creation already in flight during deletion and archives its late result', async () => {
    const f = await chatFixture()
    resources(f, 'directory')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const gated = Promise.withResolvers<undefined>()
    const sessionId = 'late-result' as SessionId
    const createSession = vi.fn(async () => {
      entered.resolve(undefined)
      await release.promise
      return { phase: 'completed', operationId: f.create.operationId, sessionId, inheritedEventCount: 0 }
    })
    const archiveSession = vi.fn().mockResolvedValue(undefined)
    f.ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
    f.ctx.provide('sessions', { list: () => [] } as never)
    f.ctx.provide('agents', { get: () => undefined } as never)
    f.ctx.provide('workspaceRegistry', { archiveSession, archivedSessionIds: [sessionId] } as never)
    const coordinator = new CanvasChatCoordinator(f.ctx, f.repository, testMaterializer(f.repository, createSession))
    cleanup.push(() => coordinator.close())
    cleanup.push(async () => { release.resolve(undefined) })
    const unsubscribe = f.repository.subscribe(() => { if (f.repository.isDeleting(canvasId, f.chat.id)) gated.resolve(undefined) })
    const creating = coordinator.createThread(f.create)
    await entered.promise
    const removing = coordinator.execute({ ...request('remove-during-create', 2, { kind: 'delete' }), confirmed: true })
    await gated.promise
    release.resolve(undefined)
    expect(await creating).toMatchObject({ ok: false, code: 'deleting' })
    expect(await removing).toMatchObject({ ok: true })
    unsubscribe()
    expect(createSession).toHaveBeenCalledOnce()
    expect(archiveSession).toHaveBeenCalledWith(sessionId, { stopActivity: true })
    expect(f.repository.snapshot().canvases).toEqual([])
    expect(f.repository.bindingOf(sessionId)?.nodeId).toBe(f.chat.id)
  })
})


async function deliveryFixture() {
  const f = await chatFixture()
  cleanup.push(() => f.ctx.fiber.dispose())
  await f.ctx.plugin(SessionStore)
  await f.ctx.plugin(SessionProjectionRegistry)
  const sessionId = SessionId('delivery-observation')
  await f.repository.coordination.reserveThread(f.create, '/project')
  await f.repository.coordination.completeThread(f.create.operationId, sessionId, 0)
  const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, isSeeded: false, cwd: '/project' }
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'deliverables/presented', seq: SessionSeq(1), time: 2,
      data: { turn: 1, callId: 'delivery-present' as ToolCallId, files: [{ path: '/project/result.txt' }] } },
    { type: 'turn/end', seq: SessionSeq(2), time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const close = vi.fn(() => Promise.resolve())
  const handle: SessionHandle = {
    id: sessionId, header, access: 'read', inheritedEventCount: SessionLogOffset(0),
    read: () => Promise.resolve({ events, eventState: 'shared-frozen' }),
    append: () => Promise.reject(new Error('read-only')),
    flush: () => Promise.reject(new Error('read-only')),
    close, [Symbol.asyncDispose]: close,
  }
  const open = vi.fn(() => Promise.resolve(handle))
  f.ctx.provide('sessionPersistence', { open } as never)
  const flushed = vi.fn(() => Promise.resolve())
  f.ctx.on('session/flush', flushed)
  const coordinator = new CanvasDeliveryCoordinator(f.ctx, f.repository)
  cleanup.push(() => coordinator.close())
  return { ...f, coordinator, sessionId, events, header, handle, handleClose: close, open, flushed }
}

describe('Delivery recovery lifetime', () => {
  it('uses a Session resumed while a cold read was in flight without losing its delivery', async () => {
    const f = await deliveryFixture()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    cleanup.push(async () => { release.resolve(undefined) })
    vi.spyOn(f.handle, 'read').mockImplementation(async () => {
      entered.resolve(undefined)
      await release.promise
      return { events: f.events, eventState: 'shared-frozen' }
    })
    const starting = f.coordinator.start()
    await entered.promise
    const live = f.ctx.sessions.create(f.sessionId, { meta: f.header, seed: f.events })
    release.resolve(undefined)
    await starting
    expect(f.flushed).toHaveBeenCalledWith(live)
    expect(f.repository.snapshot().canvases[0]?.nodes.filter(value => value.typeId === 'convax.file')).toHaveLength(1)
    expect(f.repository.snapshot().chats[0]?.issue).toBeNull()
    expect(f.handleClose).toHaveBeenCalledOnce()
  })

  it('drains late registration before close and removes its Session event observer', async () => {
    const f = await deliveryFixture()
    const handle = await f.ctx.sessionProjections.register(canvasDeliveryProjection)
    const release = Promise.withResolvers<typeof handle>()
    cleanup.push(async () => { release.resolve(handle) })
    const dispose = vi.spyOn(handle, 'dispose')
    vi.spyOn(f.ctx.sessionProjections, 'register').mockReturnValueOnce(release.promise)
    const starting = f.coordinator.start()
    const observed = expect(starting).rejects.toThrow()
    let closed = false
    const closing = f.coordinator.close().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    release.resolve(handle)
    await observed
    await closing
    expect(dispose).toHaveBeenCalledOnce()
    const next = new CanvasDeliveryCoordinator(f.ctx, f.repository)
    cleanup.push(() => next.close())
    await next.start()
    const listeners = f.ctx.events._hooks['session/event']?.length ?? 0
    await next.close()
    expect(f.ctx.events._hooks['session/event']?.length ?? 0).toBe(listeners - 1)
  })

  it('projects a delivery queued after a catch-up pass settles but before its task is removed', async () => {
    const f = await deliveryFixture()
    const live = f.ctx.sessions.create(f.sessionId, { meta: f.header })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const projected = Promise.withResolvers<undefined>()
    cleanup.push(async () => { release.resolve(undefined) })
    vi.spyOn(f.repository.coordination, 'deliveryFailure').mockImplementationOnce(() => {
      entered.resolve(undefined)
      return release.promise
    })
    const unsubscribe = f.repository.subscribe(() => {
      if (f.repository.snapshot().canvases[0]?.nodes.some(value => value.typeId === 'convax.file')) projected.resolve(undefined)
    })
    const starting = f.coordinator.start()
    await entered.promise
    release.resolve(undefined)
    queueMicrotask(() => {
      live.append('turn/start', { turn: 1 })
      live.append('deliverables/presented', { turn: 1, callId: 'late-microtask' as ToolCallId, files: [{ path: '/project/later.txt' }] })
      live.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    })
    await starting
    await projected.promise
    unsubscribe()
    expect(f.repository.snapshot().canvases[0]?.nodes.filter(value => value.typeId === 'convax.file')).toHaveLength(1)
  })
})


describe('Host resource acquisition and release', () => {
  it('adds the authenticated media route only while Connection is present and drains its bodies on removal', async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const range = Promise.withResolvers<Uint8Array>()
    cleanup.push(async () => { range.resolve(new Uint8Array([1, 2])); await f.ctx.fiber.dispose() })
    await f.ctx.plugin(SessionStore)
    await f.ctx.plugin(SessionProjectionRegistry)
    const path = join(dirname(f.path), 'movie.mp4')
    const target = { targetKey: FsTargetKey(path), displayPath: path }
    const read = vi.fn<FileSystem['readByteRange']>(async (_target, window) => new Uint8Array(window.length))
    f.ctx.provide('fs', {
      resolve: async () => target, processPath: () => path,
      stat: async () => ({ type: 'file', version: FsVersion('one'), size: 2 }), readByteRange: read,
    } as never)
    vi.spyOn(CanvasDatabase, 'open').mockResolvedValueOnce(f.domain)
    f.ctx.provide('tools', { register: () => f.ctx.effect(() => () => {}) } as never)
    await applyHost(f.ctx, { databasePath: f.path, canvasDirectoryRoot: `${f.path}.workspaces`, previewBytes: 10, documentBytes: 1, mediaChunkBytes: 2 })
    expect(await f.ctx.convax.mediaSource(path)).toMatchObject({ path, version: 'one', size: 2, mimeType: 'video/mp4' })
    const registered = Promise.withResolvers<ConnectionFetchRoute>()
    const unregister = vi.fn()
    const connection = f.ctx.plugin({
      name: 'media-test-connection',
      apply(scope: Context) {
        scope.provide('connection', { fetch: {
          register: (route: ConnectionFetchRoute) => scope.effect(() => { registered.resolve(route); return unregister }),
        } } as never)
      },
    })
    await connection
    const route = await registered.promise
    expect(route).toMatchObject({ path: '/api/convax/media', methods: ['GET', 'HEAD'], requestBody: 'buffered' })
    const response = await route.fetch(new Request(`http://127.0.0.1/api/convax/media?${new URLSearchParams({ path, version: 'one' })}`))
    read.mockImplementationOnce(() => { entered.resolve(undefined); return range.promise })
    const consumption = response.arrayBuffer()
    const failed = expect(consumption).rejects.toMatchObject({ name: 'AbortError' })
    await entered.promise
    let disposed = false
    const closing = connection.dispose().then(() => { disposed = true })
    await failed
    expect(disposed).toBe(false)
    range.resolve(new Uint8Array([1, 2]))
    await closing
    expect(unregister).toHaveBeenCalledOnce()
    expect(await f.ctx.convax.mediaSource(path)).toMatchObject({ path, version: 'one' })
  })

  it('removes node-plugin model-step admission before closing the core database', async () => {
    const f = await fixture()
    await f.ctx.plugin(SessionStore)
    await f.ctx.plugin(SessionProjectionRegistry)
    cleanup.push(() => f.ctx.fiber.dispose())
    vi.spyOn(CanvasDatabase, 'open').mockResolvedValueOnce(f.domain)
    f.ctx.provide('tools', { register: () => f.ctx.effect(() => () => {}) } as never)
    const baseline = f.ctx.events._hooks['agent/pre-step']?.length ?? 0
    const close = f.domain.close.bind(f.domain)
    const closeDatabase = vi.spyOn(f.domain, 'close').mockImplementation(async () => {
      expect(f.ctx.events._hooks['agent/pre-step']?.length ?? 0).toBe(baseline)
      await close()
    })
    await applyHost(f.ctx, { databasePath: f.path, canvasDirectoryRoot: `${f.path}.workspaces`, previewBytes: 10, documentBytes: 1024, mediaChunkBytes: 1024 })
    await applyNodes(f.ctx)
    expect(f.ctx.events._hooks['agent/pre-step']?.length ?? 0).toBe(baseline + 1)
    await f.ctx.fiber.dispose()
    expect(closeDatabase).toHaveBeenCalled()
    expect(() => f.domain.global.get()).toThrow()
  })

  it('releases a domain whose open resolves after its Host owner was removed', async () => {
    const f = await fixture()
    const release = Promise.withResolvers<typeof f.domain>()
    const owner = f.ctx.plugin({ name: 'late-domain-owner', apply() {} })
    await owner
    vi.spyOn(CanvasDatabase, 'open').mockReturnValueOnce(release.promise)
    const starting = applyHost(owner.ctx, { databasePath: f.path, canvasDirectoryRoot: `${f.path}.workspaces`, previewBytes: 10, documentBytes: 1024, mediaChunkBytes: 1024 })
    const observed = expect(starting).rejects.toThrow('inactive context')
    await owner.dispose()
    release.resolve(f.domain)
    await observed
    expect(() => f.domain.global.get()).toThrow()
  })
})
