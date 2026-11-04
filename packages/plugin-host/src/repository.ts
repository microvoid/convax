/** Revisioned canvas mutations committed by Convax's SQLite repository. */
import { sameCanvasRequest } from './request-equality.ts'
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { CanvasDatabase, CanvasTransaction } from './database.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CanvasConnection, CanvasChat, CanvasCommandRequest, CanvasCommandResult, CanvasDocument, CanvasWorkspace, CanvasId, CanvasNodeId, CanvasSessionBinding, CanvasNodeIssue, CanvasNode, CanvasMigrationId, CanvasOpenSessionRequest, CanvasOperationId } from './types.ts'
import type { CanvasNodeDefinition, CanvasNodeRegistry } from './registry.ts'
import type { CanvasData } from './types.ts'
import { graphSchema, type CanvasTableValue } from './schema.ts'
import { CanvasCoordinationError as CommandFailure, CanvasCoordinationRepository } from './coordination-repository.ts'
import { applyCanvasDelta, buildCanvasDelta } from './history-delta.ts'
import { createChatProjection } from './chat-projection.ts'
import { layoutGrid } from './layout.ts'

/** One repository publishes complete graph snapshots after its database commits. */
export class CanvasRepository {
  /** Durable operations share the graph transaction owner. */
  readonly coordination: CanvasCoordinationRepository
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribeNodeTypes: () => void
  private nodeIssues: CanvasNodeIssue[] = []

  /**
   * @param domain - Open Convax database.
   * @param nodeTypes - Effect-owned provider definitions.
   * @param reportObserverFailure - Reports a failed observer after a successful durable commit.
   */
  constructor(
    private readonly domain: CanvasDatabase,
    readonly nodeTypes: CanvasNodeRegistry,
    private readonly reportObserverFailure: (error: unknown) => void,
  ) {
    this.coordination = new CanvasCoordinationRepository(domain, () => { this.notify() }, {
      removalTargets: (tx, request) => {
        const canvas = tx.global.get().canvases.find(value => value.id === request.canvasId)
        if (canvas === undefined) throw new CommandFailure('not-found', 'Canvas no longer exists')
        if (request.command.kind === 'history') return this.historyPlan(tx, canvas, request).removed
        if (request.command.kind === 'delete' || request.command.kind === 'purge') return canvas.nodes.map(node => node.id)
        if (request.command.kind === 'remove-nodes') return request.command.nodeIds
        if (request.command.kind === 'batch') {
          const graph = structuredClone(tx.global.get())
          this.applyBatch(tx, graph, request, false, true)
          const retained = new Set(graph.canvases.find(value => value.id === request.canvasId)?.nodes.map(node => node.id) ?? [])
          return canvas.nodes.filter(node => !retained.has(node.id)).map(node => node.id)
        }
        throw new CommandFailure('invalid-command', 'Command is not a deletion')
      },
      restorationTargets: (tx, request) => {
        const canvas = tx.global.get().canvases.find(value => value.id === request.canvasId)
        const plan = this.historyPlan(tx, canvas, request)
        return { nodeIds: plan.restored, sessionIds: plan.restoreSessions }
      },
      revision: (tx, id) => this.canvasRevision(tx, id),
      commit: (tx, request, restoreSessions) => { this.commit(tx, request, true, restoreSessions) },
    })
    this.unsubscribeNodeTypes = nodeTypes.subscribe(() => { this.notify() })
  }

  /**
   * Read committed domain data and the available runtime providers together.
   * @returns A detached snapshot safe for same-process and Remote consumers.
   */
  snapshot(): CanvasWorkspace {
    const graph = this.domain.global.get()
    const projectChat = this.chatProjection()
    const chats: CanvasChat[] = graph.canvases.flatMap(canvas => canvas.nodes.flatMap((node) => {
      const chat = projectChat(canvas, node)
      return chat === undefined ? [] : [chat]
    }))
    return { ...graph, nodeTypes: this.nodeTypes.list(), chats, nodeIssues: structuredClone(this.nodeIssues) }
  }

  /**
   * Publish derived provider compatibility without altering stored payloads.
   * @param issues - Current migration and validation diagnostics.
   */
  setNodeIssues(issues: CanvasNodeIssue[]): void {
    if (isDeepStrictEqual(this.nodeIssues, issues)) return
    this.nodeIssues = structuredClone(issues)
    this.notify()
  }

  /**
   * Atomically retain the original payload and commit its validated successor.
   * @param canvasId - Captured owning canvas.
   * @param source - Exact stored node inspected before asynchronous provider work.
   * @param definition - Exact active provider; replacements invalidate this result.
   * @param data - Provider-validated serialized successor.
   * @param signal - Cancellation checked by the durable transaction before commit.
   * @returns False if the node or provider changed; true after durable publication.
   */
  async commitMigration(
    canvasId: CanvasId, source: CanvasNode, definition: CanvasNodeDefinition, data: CanvasData, signal: AbortSignal,
  ): Promise<boolean> {
    const changed = await this.domain.transaction((tx) => {
      signal.throwIfAborted()
      const graph = structuredClone(tx.global.get())
      const canvas = graph.canvases.find(value => value.id === canvasId)
      const node = canvas?.nodes.find(value => value.id === source.id)
      if (canvas === undefined || node === undefined || this.nodeTypes.get(source.typeId) !== definition || !isDeepStrictEqual(node, source)
        || this.isDeleting(canvasId, source.id)) return false
      node.data = structuredClone(data)
      node.dataVersion = definition.dataVersion
      node.revision += 1
      canvas.revision += 1
      graph.revision += 1
      tx.table('node_migrations').put(brandString<CanvasMigrationId>(randomUUID()), {
        canvasId, nodeId: source.id, typeId: source.typeId,
        sourceVersion: source.dataVersion, targetVersion: node.dataVersion,
        sourceRevision: source.revision, resultRevision: node.revision,
        sourceData: structuredClone(source.data), resultData: structuredClone(data),
      })
      tx.global.set(graphSchema.parse(graph))
      return true
    }, { signal })
    if (changed) this.notify()
    return changed
  }

  /**
   * Resolve unique Session ownership without requiring its node provider.
   * @param sessionId - Actual DSH Session identity.
   * @returns Detached binding, or undefined for an ordinary native Session.
   */
  bindingOf(sessionId: SessionId): CanvasSessionBinding | undefined {
    const binding = this.domain.table('bindings').get(sessionId)
    if (binding === undefined) return undefined
    const { canvasId, nodeId, parentSessionId, inheritedEventCount } = binding
    return { canvasId, nodeId, sessionId, parentSessionId, inheritedEventCount }
  }

  /**
   * Commit a Chat and its existing native Session binding without publishing an empty Chat.
   * @param request - Caller-retained placement identity and expected canvas revision.
   * @param source - Metadata observed from the original Session; prior deliveries are already consumed.
   * @param admit - Recheck native availability immediately inside the serialized transaction.
   * @param signal - Owner cancellation before the durable commit.
   * @returns The unique binding, including an existing Chat on another canvas.
   */
  async openSession(
    request: CanvasOpenSessionRequest,
    source: { cwd: string; title: string; parentSessionId: SessionId | null; inheritedEventCount: number; deliveryCursor: number },
    admit: () => void, signal: AbortSignal,
  ): Promise<CanvasSessionBinding> {
    const result = await this.domain.transaction((tx) => {
      admit()
      const graph = tx.global.get()
      const bound = tx.table('bindings').get(request.sessionId)
      if (bound !== undefined) {
        const node = graph.canvases.find(canvas => canvas.id === bound.canvasId)?.nodes.find(value => value.id === bound.nodeId)
        if (node?.typeId !== 'convax.chat') throw new CommandFailure('not-found', 'The Session belongs to a removed Chat')
        if (this.isDeleting(bound.canvasId, bound.nodeId)) throw new CommandFailure('deleting', 'The Session Chat is stopping and archiving')
        return { binding: bound, changed: false }
      }
      const pending = [...tx.table('thread_operations').entries()].some(([, value]) =>
        value.sessionId === request.sessionId || value.session?.sessionId === request.sessionId)
      if (pending) throw new CommandFailure('conflict', 'The Session already has an unfinished Chat binding; retry after it settles')
      if (graph.canvases.some(canvas => canvas.nodes.some(node => node.id === request.nodeId))) {
        throw new CommandFailure('invalid-command', 'Chat identity already exists')
      }
      const operationId = brandString<CanvasOperationId>(`convax/open-session/${request.nodeId}`)
      if (tx.table('operations').get(operationId) !== undefined) throw new CommandFailure('invalid-command', 'Chat placement identity was already used')
      this.commit(tx, {
        canvasId: request.canvasId, expectedRevision: request.expectedRevision, operationId,
        command: { kind: 'add-node', node: {
          id: request.nodeId, typeId: brandString<CanvasNode['typeId']>('convax.chat'), dataVersion: 1, revision: 0,
          position: request.position, data: { title: source.title, cwd: source.cwd },
        } },
      }, false)
      const binding = {
        canvasId: request.canvasId, nodeId: request.nodeId, sessionId: request.sessionId,
        parentSessionId: source.parentSessionId, inheritedEventCount: source.inheritedEventCount,
      }
      tx.table('bindings').put(request.sessionId, { ...binding, deliveryCursor: source.deliveryCursor, deliveryError: null, ordinal: 0 })
      return { binding, changed: true }
    }, { signal })
    if (result.changed) this.notify()
    return result.binding
  }

  /**
   * Read one Chat and its current threads.
   * @param canvasId - Owning canvas.
   * @param nodeId - Chat node.
   * @returns Chat state, or undefined after deletion.
   */
  getChat(canvasId: CanvasId, nodeId: CanvasNodeId): CanvasChat | undefined {
    const canvas = this.domain.global.get().canvases.find(value => value.id === canvasId)
    const node = canvas?.nodes.find(value => value.id === nodeId)
    return canvas === undefined || node === undefined || node.typeId !== 'convax.chat' ? undefined : this.chatProjection()(canvas, node)
  }

  private chatProjection(): ReturnType<typeof createChatProjection> {
    return createChatProjection({
      bindings: [...this.domain.table('bindings').entries()].map(([, value]) => value),
      threadOperations: [...this.domain.table('thread_operations').entries()].map(([, value]) => value),
      deletions: [...this.domain.table('deletions').entries()].map(([, value]) => value),
    })
  }

  /**
   * Check the durable deletion gate used by creation and input admission.
   * @param canvasId - Target canvas.
   * @param nodeId - Target Chat.
   * @returns Whether stop-and-archive coordination currently owns the target.
   */
  isDeleting(canvasId: CanvasId, nodeId: CanvasNodeId): boolean {
    return [...this.domain.table('deletions').entries()].some(([, deletion]) =>
      deletion.phase === 'deleting' && deletion.canvasId === canvasId && deletion.nodeIds.includes(nodeId))
  }

  /**
   * Observe successful commits.
   * @param listener - Snapshot invalidation callback.
   * @returns Subscription disposer.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Detect retained retry identities before repeating external resource checks.
   * @param operationId - Requested graph or lifecycle identity.
   * @returns Whether execution must consult an existing receipt or intention.
   */
  hasOperation(operationId: CanvasOperationId): boolean {
    return this.domain.table('operations').get(operationId) !== undefined || this.domain.table('deletions').get(operationId) !== undefined
      || this.domain.table('restorations').get(operationId) !== undefined || this.domain.table('thread_operations').get(operationId) !== undefined
  }

  /**
   * Read a canvas version, retaining its last committed fence after deletion.
   * @param canvasId - Existing or removed canvas identity.
   * @returns Current canvas revision or its latest retained history revision; zero if never committed.
   */
  revision(canvasId: CanvasId): number {
    return this.domain.global.get().canvases.find(canvas => canvas.id === canvasId)?.revision
      ?? Math.max(0, ...[...this.domain.table('history').entries()].filter(([, entry]) => entry.canvasId === canvasId).map(([, entry]) => entry.revision ?? 0))
  }

  private canvasRevision(tx: CanvasTransaction, canvasId: CanvasId): number {
    return tx.global.get().canvases.find(canvas => canvas.id === canvasId)?.revision
      ?? Math.max(0, ...[...tx.table('history').entries()].filter(([, entry]) => entry.canvasId === canvasId).map(([, entry]) => entry.revision ?? 0))
  }

  /**
   * Apply one atomic, idempotent graph mutation.
   * @param request - Target identity, revision and command.
   * @param signal - Optional cancellation before the durable commit.
   * @returns Success with current state, or a business rejection without writes.
   */
  async execute(request: CanvasCommandRequest, signal?: AbortSignal): Promise<CanvasCommandResult> {
    try {
      const changed = await this.domain.transaction(tx => this.commit(tx, request, false), signal === undefined ? undefined : { signal })
      if (changed) this.notify()
      return { ok: true, workspace: this.snapshot() }
    } catch (error) {
      if (!(error instanceof CommandFailure)) throw error
      return { ok: false, code: error.code, message: error.message,
        ...(error.opIndex === undefined ? {} : { opIndex: error.opIndex }), workspace: this.snapshot() }
    }
  }

  /**
   * Resolve the external Chat work required by a guarded history transition.
   * @param request - Captured transition and retry identity.
   * @param signal - Optional caller cancellation.
   * @returns Removed and restored Chat identities, or a rejection without graph writes.
   */
  async historyTargets(request: CanvasCommandRequest, signal?: AbortSignal): Promise<
    { ok: true; removed: CanvasNodeId[]; restored: CanvasNodeId[] } | { ok: false; result: CanvasCommandResult }
  > {
    try {
      return await this.domain.transaction((tx) => {
        const receipt = tx.table('operations').get(request.operationId)
        if (receipt !== undefined) {
          if (!sameCanvasRequest(receipt.request, request)) throw new CommandFailure('invalid-command', 'Operation identity belongs to another request')
          return { ok: true as const, removed: [], restored: [] }
        }
        const canvas = tx.global.get().canvases.find(value => value.id === request.canvasId)
        if (request.command.kind === 'batch') {
          const graph = structuredClone(tx.global.get())
          this.applyBatch(tx, graph, request, false, true)
          const retained = new Set(graph.canvases.find(value => value.id === request.canvasId)?.nodes.map(node => node.id) ?? [])
          return { ok: true as const, removed: (canvas?.nodes ?? []).filter(node => node.typeId === 'convax.chat' && !retained.has(node.id)).map(node => node.id), restored: [] }
        }
        const plan = this.historyPlan(tx, canvas, request)
        return { ok: true as const,
          removed: plan.removed.filter(id => canvas?.nodes.some(node => node.id === id && node.typeId === 'convax.chat')),
          restored: plan.restored.filter(id => plan.canvas?.nodes.some(node => node.id === id && node.typeId === 'convax.chat')),
        }
      }, signal === undefined ? undefined : { signal })
    } catch (error) {
      if (!(error instanceof CommandFailure)) throw error
      return { ok: false, result: { ok: false, code: error.code, message: error.message,
        ...(error.opIndex === undefined ? {} : { opIndex: error.opIndex }), workspace: this.snapshot() } }
    }
  }

  private historyPlan(tx: CanvasTransaction, canvas: CanvasDocument | undefined, request: CanvasCommandRequest): {
    canvas: CanvasDocument | undefined
    removed: CanvasNodeId[]
    restored: CanvasNodeId[]
    restoreSessions: SessionId[]
    history: CanvasTableValue<'history'>
  } {
    if (request.command.kind !== 'history') throw new CommandFailure('invalid-command', 'Command is not a history transition')
    const history = tx.table('history').get(request.command.targetOperationId)
    if (history === undefined || history.canvasId !== request.canvasId) throw new CommandFailure('not-found', 'Graph history is unavailable for this canvas')
    if (history.applied !== (request.command.direction === 'undo')) throw new CommandFailure('conflict', 'Graph history was already applied in this direction')
    if (history.lifecycle !== undefined) {
      const from = request.command.direction === 'undo' ? history.lifecycle.after : history.lifecycle.before
      const to = request.command.direction === 'undo' ? history.lifecycle.before : history.lifecycle.after
      const content = (value: CanvasDocument | null | undefined) => value == null ? null
        : { ...value, revision: 0, nodes: value.nodes.map(node => ({ ...node, revision: 0 })) }
      if (!isDeepStrictEqual(content(canvas), content(from))) {
        throw new CommandFailure('conflict', 'Canvas lifecycle changed after this edit')
      }
      const result = to === null ? undefined : structuredClone(to)
      for (const node of result?.nodes ?? []) {
        node.revision = Math.max(node.revision, tx.table('node_revisions').get(node.id)?.revision ?? 0) + 1
      }
      const beforeIds = new Set(canvas?.nodes.map(node => node.id) ?? [])
      const afterIds = new Set(result?.nodes.map(node => node.id) ?? [])
      return { canvas: result, removed: [...beforeIds].filter(id => !afterIds.has(id)),
        restored: [...afterIds].filter(id => !beforeIds.has(id)),
        restoreSessions: history.restoreSessions, history }
    }
    if (canvas === undefined) throw new CommandFailure('not-found', 'Canvas no longer exists')
    const revisions = new Map([...tx.table('node_revisions').entries()].map(([id, value]) => [id, value.revision]))
    const result = applyCanvasDelta(canvas, history.delta, request.command.direction, revisions)
    if (!result.ok) throw new CommandFailure('conflict', result.message)
    const before = new Set(canvas.nodes.map(node => node.id))
    const after = new Set(result.canvas.nodes.map(node => node.id))
    return { canvas: result.canvas, history, removed: canvas.nodes.filter(node => !after.has(node.id)).map(node => node.id),
      restored: result.canvas.nodes.filter(node => !before.has(node.id)).map(node => node.id), restoreSessions: history.restoreSessions }
  }

  private commit(tx: CanvasTransaction, request: CanvasCommandRequest, settled: boolean, restoreSessions?: SessionId[]): boolean {
    if (tx.table('thread_operations').get(request.operationId) !== undefined) {
      throw new CommandFailure('invalid-command', 'Operation identity belongs to a thread request')
    }
    const lifecycle = tx.table('deletions').get(request.operationId) ?? tx.table('restorations').get(request.operationId)
    if (lifecycle !== undefined && !sameCanvasRequest(lifecycle.request, request)) {
      throw new CommandFailure('invalid-command', 'Operation identity belongs to another lifecycle request')
    }
    const receipt = tx.table('operations').get(request.operationId)
    if (receipt !== undefined) {
      if (!sameCanvasRequest(receipt.request, request)) {
        throw new CommandFailure('invalid-command', 'Operation identity was already used for a different request')
      }
      return false
    }
    const graph = structuredClone(tx.global.get())
    const existing = graph.canvases.find(c => c.id === request.canvasId)
    const before = existing === undefined ? undefined : structuredClone(existing)
    if (request.command.kind === 'batch') {
      this.applyBatch(tx, graph, request, settled)
    } else if (request.command.kind === 'history') {
      const plan = this.historyPlan(tx, existing, request)
      if (!settled && this.canvasRevision(tx, request.canvasId) !== request.expectedRevision) {
        throw new CommandFailure('conflict', 'Canvas changed; refresh and retry')
      }
      if (!settled && [...tx.table('deletions').entries(), ...tx.table('restorations').entries()]
        .some(([id, intent]) => id !== request.operationId && intent.canvasId === request.canvasId && intent.phase !== 'completed')) {
        throw new CommandFailure('conflict', 'Canvas lifecycle work is still settling')
      }
      const touchesChat = (existing?.nodes.some(node => plan.removed.includes(node.id) && node.typeId === 'convax.chat') ?? false)
        || (plan.canvas?.nodes.some(node => plan.restored.includes(node.id) && node.typeId === 'convax.chat') ?? false)
      if (!settled && touchesChat) throw new CommandFailure('invalid-command', 'Chat history requires Session coordination')
      const revision = this.canvasRevision(tx, request.canvasId) + 1
      const index = graph.canvases.findIndex(canvas => canvas.id === request.canvasId)
      if (plan.canvas === undefined) { if (index >= 0) graph.canvases.splice(index, 1) }
      else if (index < 0) graph.canvases.push({ ...plan.canvas, revision })
      else graph.canvases[index] = { ...plan.canvas, revision }
      tx.table('history').put(request.command.targetOperationId, { ...plan.history, applied: request.command.direction === 'redo',
        revision, restoreSessions: restoreSessions ?? plan.history.restoreSessions })
    } else if (request.command.kind === 'create') {
      if ([...this.domain.table('deletions').entries()].some(([, value]) => value.canvasId === request.canvasId)) {
        throw new CommandFailure('invalid-command', 'Deleted canvas identities cannot be reused')
      }
      if (existing !== undefined || request.expectedRevision !== 0) throw new CommandFailure('conflict', 'Canvas already exists')
      const title = request.command.title.trim()
      if (title.length === 0) throw new CommandFailure('invalid-command', 'Canvas title is required')
      graph.canvases.push({ id: request.canvasId, title, revision: 1, nodes: [], connections: [],
        ...(request.command.defaultTitle === true ? { titleFormat: { kind: 'default' as const } } : {}) })
    } else {
      if (existing === undefined) throw new CommandFailure('not-found', 'Canvas no longer exists')
      if (!settled && ([...tx.table('deletions').entries()].some(([, deletion]) => deletion.canvasId === existing.id && deletion.phase === 'deleting')
        || [...tx.table('restorations').entries()].some(([, restoration]) => restoration.canvasId === existing.id && restoration.phase === 'restoring'))) {
        throw new CommandFailure('conflict', 'Canvas deletion is still stopping and archiving its threads')
      }
      if (!settled && existing.revision !== request.expectedRevision) throw new CommandFailure('conflict', 'Canvas changed; refresh and retry')
      if (request.command.kind === 'delete' || request.command.kind === 'purge') {
        if (!settled && (request.command.kind === 'purge' || existing.nodes.some(node => node.typeId === 'convax.chat'))) {
          throw new CommandFailure('invalid-command', 'Canvas deletion requires Session coordination')
        }
        graph.canvases = graph.canvases.filter(c => c.id !== existing.id)
        if (request.command.kind === 'purge') {
          for (const [id, entry] of tx.table('history').entries()) {
            if (entry.canvasId === existing.id) tx.table('history').delete(id)
          }
        }
      } else if (request.command.kind === 'duplicate') {
        const { newCanvasId, title } = request.command
        if (graph.canvases.some(canvas => canvas.id === newCanvasId)) throw new CommandFailure('conflict', 'Canvas already exists')
        if ([...tx.table('deletions').entries()].some(([, value]) => value.canvasId === newCanvasId)) {
          throw new CommandFailure('invalid-command', 'Deleted canvas identities cannot be reused')
        }
        const copyTitle = title.trim()
        if (copyTitle.length === 0) throw new CommandFailure('invalid-command', 'Canvas title is required')
        const ids = new Map<CanvasNodeId, CanvasNodeId>()
        const sourceDirectory = tx.table('directories').get(existing.id)?.path
        const copiedDirectory = tx.table('directories').get(newCanvasId)?.path
        const nodes = existing.nodes.map((node) => {
          const id = brandString<CanvasNodeId>(randomUUID())
          ids.set(node.id, id)
          const copied = { ...structuredClone(node), id, revision: 1 }
          if (copied.typeId === 'convax.chat' && sourceDirectory !== undefined
            && copiedDirectory !== undefined && copied.data.cwd === sourceDirectory) {
            copied.data.cwd = copiedDirectory
          }
          return copied
        })
        const copiedId = (id: CanvasNodeId): CanvasNodeId => {
          const copied = ids.get(id)
          if (copied === undefined) throw new Error('Validated canvas connection has no copied endpoint')
          return copied
        }
        graph.canvases.push({
          id: newCanvasId, title: copyTitle, revision: 1,
          ...(request.command.localizedCopy === true ? { titleFormat: {
            kind: 'copy' as const, source: structuredClone(existing.titleFormat ?? { kind: 'literal' as const, value: existing.title }),
          } } : {}),
          nodes,
          connections: existing.connections.map(edge => ({ ...edge, id: brandString<CanvasConnection['id']>(randomUUID()),
            source: copiedId(edge.source), target: copiedId(edge.target) })),
        })
      } else {
        const addedNodes = request.command.kind === 'add-node' ? [request.command.node]
          : request.command.kind === 'add-subgraph' ? request.command.nodes : []
        if (addedNodes.length > 0) {
          const retired = new Set([
            ...[...this.domain.table('bindings').entries()].map(([, value]) => value.nodeId),
            ...[...this.domain.table('deletions').entries()].flatMap(([, value]) => value.nodeIds),
          ])
          const identities = new Set(graph.canvases.flatMap(canvas => canvas.nodes.map(node => node.id)))
          for (const node of addedNodes) {
            if (tx.table('node_revisions').get(node.id) !== undefined) throw new CommandFailure('invalid-command', 'Removed node identities can only be restored through their graph history')
            if (retired.has(node.id)) throw new CommandFailure('invalid-command', 'Deleted Chat and deletion target identities cannot be reused')
            if (identities.has(node.id)) throw new CommandFailure('invalid-command', 'Node identity already exists')
            identities.add(node.id)
          }
        }
        const addedConnections = request.command.kind === 'add-connection' ? [request.command.connection]
          : request.command.kind === 'add-node' ? request.command.initialConnections ?? []
            : request.command.kind === 'add-subgraph' ? request.command.connections : []
        if (addedConnections.length > 0) {
          const identities = new Set(graph.canvases.flatMap(canvas => canvas.connections.map(connection => connection.id)))
          for (const connection of addedConnections) {
            if (tx.table('retired_connections').get(connection.id) !== undefined) throw new CommandFailure('invalid-command', 'Removed connection identities can only be restored through their graph history')
            if (identities.has(connection.id)) throw new CommandFailure('invalid-command', 'Connection identity already exists')
            identities.add(connection.id)
          }
        }
        this.mutate(existing, request, settled)
        existing.revision += 1
      }
    }
    graph.revision += 1
    const validated = graphSchema.safeParse(graph)
    if (!validated.success) throw new CommandFailure('invalid-command', 'Command would create an invalid canvas graph', { cause: validated.error })
    tx.global.set(validated.data)
    if (before !== undefined) {
      const after = graph.canvases.find(canvas => canvas.id === before.id)
      const retainedNodes = new Set(after?.nodes.map(node => node.id) ?? [])
      const retainedConnections = new Set(after?.connections.map(connection => connection.id) ?? [])
      const removed = new Set(before.nodes.filter(node => !retainedNodes.has(node.id)).map(node => node.id))
      for (const node of before.nodes) {
        if (removed.has(node.id)) tx.table('node_revisions').put(node.id, {
          revision: Math.max(node.revision, tx.table('node_revisions').get(node.id)?.revision ?? 0),
        })
      }
      for (const connection of before.connections) {
        if (!retainedConnections.has(connection.id)) tx.table('retired_connections').put(connection.id, { retired: true })
      }
      if (after !== undefined && request.command.kind !== 'history'
        && request.command.kind !== 'set-archived' && request.command.kind !== 'duplicate') {
        tx.table('history').put(request.operationId, {
          canvasId: before.id, delta: buildCanvasDelta(before, after), applied: true,
          restoreSessions: restoreSessions ?? [], revision: after.revision,
        })
      }
      const retained = new Set(graph.canvases.flatMap(canvas => canvas.nodes.map(node => node.id)))
      for (const [key, receipt] of this.domain.table('deliveries').entries()) {
        if (removed.has(receipt.nodeId)) {
          tx.table('deliveries').put(key, { ...receipt, phase: 'suppressed' })
        } else if (receipt.phase === 'projected' && !retained.has(receipt.outputId)) {
          tx.table('deliveries').put(key, { ...receipt, phase: 'removed' })
        }
      }
    }
    const after = graph.canvases.find(canvas => canvas.id === request.canvasId)
    if (request.command.kind === 'batch' && (before === undefined || after === undefined)) {
      tx.table('history').put(request.operationId, {
        canvasId: request.canvasId, delta: { nodes: [], connections: [] }, applied: true,
        restoreSessions: restoreSessions ?? [], revision: request.expectedRevision + 1,
        lifecycle: { before: before ?? null, after: after ?? null },
      })
    }
    tx.table('operations').put(request.operationId, { request: JSON.stringify(request), revision: graph.revision })
    return true
  }

  /** Detach provider observation and release snapshot subscribers before domain teardown. */
  close(): void {
    this.unsubscribeNodeTypes()
    this.listeners.clear()
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try { listener() } catch (error) { this.reportObserverFailure(error) }
    }
  }

  private applyBatch(
    tx: CanvasTransaction, graph: { revision: number; canvases: CanvasDocument[] },
    request: CanvasCommandRequest, settled: boolean, planning = false,
  ): void {
    if (request.command.kind !== 'batch') throw new CommandFailure('invalid-command', 'An ordered graph batch is required')
    const original = graph.canvases.find(canvas => canvas.id === request.canvasId)
    if (!settled && this.canvasRevision(tx, request.canvasId) !== request.expectedRevision) throw new CommandFailure('conflict', 'Canvas changed; refresh and retry')
    if (!settled && [...tx.table('deletions').entries(), ...tx.table('restorations').entries()]
      .some(([id, intent]) => id !== request.operationId && intent.canvasId === request.canvasId && intent.phase !== 'completed')) {
      throw new CommandFailure('conflict', 'Canvas lifecycle work is still settling')
    }
    if (request.command.ops.length === 0) throw new CommandFailure('invalid-command', 'A graph batch must contain an operation')
    const addedNodes = new Set<CanvasNodeId>()
    const usedNodes = new Set(graph.canvases.flatMap(canvas => canvas.nodes.map(node => node.id)))
    const usedEdges = new Set(graph.canvases.flatMap(canvas => canvas.connections.map(edge => edge.id)))
    for (const [opIndex, op] of request.command.ops.entries()) {
      try {
        const canvas = graph.canvases.find(value => value.id === request.canvasId)
        if (op.op === 'canvas.add') {
          if (canvas !== undefined || opIndex !== 0 || original !== undefined || request.expectedRevision !== 0) {
            throw new CommandFailure('conflict', 'Canvas creation requires a new identity and revision zero')
          }
          if (this.canvasRevision(tx, request.canvasId) > 0 || [...tx.table('deletions').entries()].some(([, value]) => value.canvasId === request.canvasId)) {
            throw new CommandFailure('invalid-command', 'Deleted canvas identities cannot be reused')
          }
          const title = op.title.trim()
          if (title.length === 0) throw new CommandFailure('invalid-command', 'Canvas title is required')
          graph.canvases.push({ id: request.canvasId, title, revision: 0, nodes: [], connections: [] })
          continue
        }
        if (canvas === undefined) throw new CommandFailure('not-found', 'Canvas no longer exists')
        switch (op.op) {
          case 'canvas.set':
            this.mutate(canvas, { ...request, command: { kind: 'rename', title: op.title } }, settled)
            break
          case 'canvas.remove':
            if (!settled && !planning && canvas.nodes.some(node => node.typeId === 'convax.chat' && !addedNodes.has(node.id))) {
              throw new CommandFailure('invalid-command', 'Chat deletion requires Session coordination')
            }
            graph.canvases = graph.canvases.filter(value => value.id !== canvas.id)
            break
          case 'node.add': {
            const retired = [...tx.table('bindings').entries()].some(([, value]) => value.nodeId === op.id)
              || [...tx.table('deletions').entries()].some(([, value]) => value.nodeIds.includes(op.id))
            if (usedNodes.has(op.id) || retired || tx.table('node_revisions').get(op.id) !== undefined) {
              throw new CommandFailure('invalid-command', 'Node identity already exists or was removed')
            }
            addedNodes.add(op.id)
            usedNodes.add(op.id)
            canvas.nodes.push(this.prepareNode({ id: op.id, typeId: op.typeId, dataVersion: op.dataVersion,
              data: op.data, position: op.position, revision: 0 }))
            break
          }
          case 'node.set': {
            const node = canvas.nodes.find(value => value.id === op.id)
            if (node === undefined) throw new CommandFailure('not-found', 'Node no longer exists')
            if (op.ifRevision !== undefined && node.revision !== op.ifRevision) {
              throw new CommandFailure('conflict', 'Node changed before this operation')
            }
            if (op.data === undefined && op.position === undefined) throw new CommandFailure('invalid-command', 'Node update requires data or position')
            if (op.data === undefined && op.dataVersion !== undefined) throw new CommandFailure('invalid-command', 'Data version requires replacement data')
            if (op.data !== undefined) {
              const definition = this.nodeTypes.get(node.typeId)
              if (definition === undefined) throw new CommandFailure('provider-unavailable', 'Node provider is unavailable')
              if (op.dataVersion === undefined || op.dataVersion !== definition.dataVersion
                || node.dataVersion !== definition.dataVersion) {
                throw new CommandFailure('invalid-command', 'Replacement data requires the compatible provider data version')
              }
              node.data = this.parseNodeData(definition, op.data)
            }
            if (op.position !== undefined) node.position = structuredClone(op.position)
            node.revision += 1
            break
          }
          case 'node.remove':
            if (!canvas.nodes.some(node => node.id === op.id)) throw new CommandFailure('not-found', 'Node no longer exists')
            this.mutate(canvas, { ...request, command: { kind: 'remove-nodes', nodeIds: [op.id] } }, settled || planning || addedNodes.has(op.id))
            break
          case 'edge.add':
            if (usedEdges.has(op.id) || tx.table('retired_connections').get(op.id) !== undefined) {
              throw new CommandFailure('invalid-command', 'Connection identity already exists or was removed')
            }
            usedEdges.add(op.id)
            this.addConnection(canvas, { id: op.id, source: op.source, sourcePort: op.sourcePort,
              target: op.target, targetPort: op.targetPort, purpose: op.purpose })
            break
          case 'edge.remove':
            if (!canvas.connections.some(edge => edge.id === op.id)) throw new CommandFailure('not-found', 'Connection no longer exists')
            canvas.connections = canvas.connections.filter(edge => edge.id !== op.id)
            break
          case 'history':
            throw new CommandFailure('invalid-command', 'History must be submitted alone through the history coordinator')
          default: assertNever(op)
        }
      } catch (error) {
        if (!(error instanceof CommandFailure)) throw error
        throw new CommandFailure(error.code, error.message, { cause: error }, opIndex)
      }
    }
    const result = graph.canvases.find(canvas => canvas.id === request.canvasId)
    if (result !== undefined) result.revision = (original?.revision ?? 0) + 1
  }

  private parseNodeData(definition: CanvasNodeDefinition, data: CanvasData): CanvasData {
    try {
      return definition.parse(structuredClone(data))
    } catch (cause) {
      throw new CommandFailure('invalid-command', 'Node data was rejected by its provider', { cause })
    }
  }

  private prepareNode(source: CanvasNode): CanvasNode {
    const definition = this.nodeTypes.get(source.typeId)
    if (definition === undefined) throw new CommandFailure('provider-unavailable', 'Node provider is unavailable')
    if (definition.dataVersion !== source.dataVersion) throw new CommandFailure('invalid-command', 'Node data version is incompatible')
    const node = structuredClone(source)
    node.data = this.parseNodeData(definition, node.data)
    node.revision = 1
    return node
  }

  private mutate(canvas: CanvasDocument, request: CanvasCommandRequest, settled: boolean): void {
    const command = request.command
    switch (command.kind) {
      case 'set-archived':
        canvas.archived = command.archived
        return
      case 'rename': {
        const title = command.title.trim()
        if (title.length === 0) throw new CommandFailure('invalid-command', 'Canvas title is required')
        canvas.title = title
        delete canvas.titleFormat
        return
      }
      case 'add-node': {
        if (canvas.nodes.some(n => n.id === command.node.id)) throw new CommandFailure('invalid-command', 'Node identity already exists')
        const node = this.prepareNode(command.node)
        canvas.nodes.push(node)
        for (const connection of command.initialConnections ?? []) {
          if (connection.source !== node.id && connection.target !== node.id) {
            throw new CommandFailure('invalid-command', 'Initial connections must touch the new node')
          }
          this.addConnection(canvas, connection)
        }
        return
      }
      case 'add-subgraph': {
        const nodes = command.nodes.map(node => this.prepareNode(node))
        canvas.nodes.push(...nodes)
        for (const connection of command.connections) this.addConnection(canvas, connection)
        return
      }
      case 'move-nodes':
        for (const move of command.nodes) {
          const node = canvas.nodes.find(n => n.id === move.id)
          if (node === undefined) throw new CommandFailure('not-found', 'Node no longer exists')
          node.position = move.position
          node.revision += 1
        }
        return
      case 'arrange-nodes': {
        if (!Number.isInteger(command.columns) || command.columns < 1 || !Number.isFinite(command.columnGap)
          || command.columnGap <= 0 || !Number.isFinite(command.rowGap) || command.rowGap <= 0) {
          throw new CommandFailure('invalid-command', 'Arrangement requires positive spacing and a positive integer column count')
        }
        if (new Set(command.nodeIds).size !== command.nodeIds.length) throw new CommandFailure('invalid-command', 'Arrangement node identities must be unique')
        const positions = layoutGrid(command.nodeIds.map(id => ({ id, width: 0, height: 0 })), command)
        for (const { id, position } of positions) {
          const node = canvas.nodes.find(value => value.id === id)
          if (node === undefined) throw new CommandFailure('not-found', 'Node no longer exists')
          node.position = position
          node.revision += 1
        }
        return
      }
      case 'remove-nodes': {
        const removed = new Set(command.nodeIds)
        if (!settled && canvas.nodes.some(node => removed.has(node.id) && node.typeId === 'convax.chat')) {
          throw new CommandFailure('invalid-command', 'Chat deletion requires Session coordination')
        }
        canvas.nodes = canvas.nodes.filter(n => !removed.has(n.id))
        canvas.connections = canvas.connections.filter(c => !removed.has(c.source) && !removed.has(c.target))
        return
      }
      case 'update-node': {
        const node = canvas.nodes.find(n => n.id === command.nodeId)
        if (node === undefined) throw new CommandFailure('not-found', 'Node no longer exists')
        const definition = this.nodeTypes.get(node.typeId)
        if (definition === undefined) throw new CommandFailure('provider-unavailable', 'Node provider is unavailable')
        if (definition.dataVersion !== command.dataVersion || node.dataVersion !== definition.dataVersion) throw new CommandFailure('invalid-command', 'Node data version is incompatible; complete its migration before editing')
        node.data = this.parseNodeData(definition, command.data)
        node.dataVersion = command.dataVersion
        node.revision += 1
        return
      }
      case 'add-connection':
        this.addConnection(canvas, command.connection)
        return
      case 'remove-connections': {
        const removed = new Set(command.connectionIds)
        canvas.connections = canvas.connections.filter(c => !removed.has(c.id))
        return
      }
      case 'create':
      case 'delete':
      case 'purge':
      case 'duplicate':
      case 'history':
      case 'batch':
        throw new CommandFailure('invalid-command', 'Canvas lifecycle command cannot mutate a node')
      default:
        return assertNever(command)
    }
  }

  private addConnection(canvas: CanvasDocument, connection: CanvasConnection): void {
    if (canvas.connections.some(c => c.id === connection.id)) throw new CommandFailure('invalid-command', 'Connection identity already exists')
    const source = canvas.nodes.find(n => n.id === connection.source)
    const target = canvas.nodes.find(n => n.id === connection.target)
    if (source === undefined || target === undefined || this.nodeTypes.get(source.typeId)?.dataVersion !== source.dataVersion
      || this.nodeTypes.get(target.typeId)?.dataVersion !== target.dataVersion) {
      throw new CommandFailure('provider-unavailable', 'Connection nodes require compatible active providers')
    }
    const output = this.nodeTypes.get(source.typeId)?.ports.find(p => p.id === connection.sourcePort && p.direction === 'output')
    const input = this.nodeTypes.get(target.typeId)?.ports.find(p => p.id === connection.targetPort && p.direction === 'input')
    if (output === undefined || input === undefined || output.valueKind !== input.valueKind) {
      throw new CommandFailure('invalid-command', 'Connection ports are unavailable or incompatible')
    }
    canvas.connections.push(structuredClone(connection))
  }

}
