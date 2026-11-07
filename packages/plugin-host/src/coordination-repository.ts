/** Durable intents, unique Session bindings, deletion gates and delivery receipts. */
import { sameCanvasRequest } from './request-equality.ts'
import { randomUUID } from 'node:crypto'
import type { CanvasDatabase, CanvasTransaction } from './database.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { z } from 'zod'
import { canvasCommandRequestSchema, graphSchema, type threadOperationSchema, type deletionSchema, type sessionReservationSchema, type restorationSchema } from './schema.ts'
import type {
  CanvasCommandRequest, CanvasDeliveryId, CanvasId, CanvasNodeId,
  CanvasConnectionId, CanvasOperationId, CanvasSessionBinding, CanvasThreadRequest, CanvasNode, CanvasDocument, CanvasConnection,
} from './types.ts'

/** Durable state of one Session creation request. */
export type CanvasThreadIntent = z.infer<typeof threadOperationSchema>
/** Reserved Session metadata, independent of its eventual Chat binding. */
export type CanvasSessionReservation = z.infer<typeof sessionReservationSchema>
/** Durable deletion coordinator state. */
export type CanvasDeletionIntent = z.infer<typeof deletionSchema>
/** Durable native archive restoration state. */
export type CanvasRestorationIntent = z.infer<typeof restorationSchema>

/** A pure feature-owned delivery projection inside the graph transaction. */
export type CanvasDeliveryOutputFactory = (input: {
  canvas: CanvasDocument
  source: CanvasNode
  file: { path: string; description?: string | undefined }
  index: number
  nodeId: CanvasNodeId
  connectionId: CanvasConnectionId
}) => { node: CanvasNode; connection: CanvasConnection }

/** Graph commits remain with the repository while coordination owns external work. */
export interface CanvasCoordinationGraph {
  /** @param node - Graph envelope. @returns Whether registered semantics or durable ownership identify a Session container. */
  isSessionNode(node: CanvasNode): boolean
  /** @param tx - Active transaction. @param canvasId - Existing or removed canvas. @returns Its retained version fence. */
  revision(tx: CanvasTransaction, canvasId: CanvasId): number
  /** @param tx - Active transaction. @param request - History or removal request. @returns Nodes removed by this request. */
  removalTargets(tx: CanvasTransaction, request: CanvasCommandRequest): CanvasNodeId[]
  /** @param tx - Active transaction. @param request - History replay. @returns Restored nodes and native archives to undo. */
  restorationTargets(tx: CanvasTransaction, request: CanvasCommandRequest): { nodeIds: CanvasNodeId[]; sessionIds: SessionId[] }
  /** @param tx - Active transaction. @param request - Settled request. @param restoreSessions - Archives caused by a removal. */
  commit(tx: CanvasTransaction, request: CanvasCommandRequest, restoreSessions?: SessionId[]): void
}

/** Business rejection that leaves pending external work recoverable. */
export class CanvasCoordinationError extends Error {
  /**
   * @param code - Client-safe failure category.
   * @param message - Diagnostic retained for an explicit retry.
   * @param options - Original failure when available.
   * @param opIndex - Zero-based failing operation within an ordered batch, when applicable.
   */
  constructor(readonly code: 'conflict' | 'not-found' | 'invalid-command' | 'deleting' | 'provider-unavailable', message: string, options?: ErrorOptions,
    readonly opIndex?: number) { super(message, options) }
}

/** Cross-store coordination records share the graph's exclusive transaction owner. */
export class CanvasCoordinationRepository {
  /**
   * @param domain - Open exclusive Convax domain.
   * @param publish - Publish a complete committed repository snapshot.
   * @param graph - Repository-owned validation and final graph commits.
   */
  constructor(
    private readonly domain: CanvasDatabase, private readonly publish: () => void, private readonly graph: CanvasCoordinationGraph,
  ) {}

  /**
   * Read an existing retry identity without performing external work.
   * @param operationId - Original creation identity.
   * @returns Detached intent, or undefined before reservation.
   */
  thread(operationId: CanvasOperationId): CanvasThreadIntent | undefined {
    const value = this.domain.table('thread_operations').get(operationId)
    return value === undefined ? undefined : structuredClone(value)
  }

  /**
   * Persist a fixed Session identity before any Session or Workspace write.
   * @param operationId - Existing Chat creation intention.
   * @param candidate - Resolved directory, agent and permission defaults, and immutable fork cut.
   * @returns Original reservation when a retry already owns one.
   */
  reserveSession(operationId: CanvasOperationId, candidate: CanvasSessionReservation): Promise<CanvasSessionReservation> {
    return this.domain.transaction((tx) => {
      const intent = tx.table('thread_operations').get(operationId)
      if (intent === undefined) throw new CanvasCoordinationError('not-found', 'Thread intent is absent')
      if (intent.session !== undefined) return intent.session
      tx.table('thread_operations').put(operationId, { ...intent, session: candidate })
      return candidate
    })
  }

  /**
   * Retain Session and Workspace completion before publishing the Chat binding.
   * @param operationId - Existing reserved operation.
   * @returns Confirmed materialization receipt; graph binding is a separate commit.
   */
  completeSession(operationId: CanvasOperationId): Promise<CanvasSessionReservation> {
    return this.domain.transaction((tx) => {
      const intent = tx.table('thread_operations').get(operationId)
      if (intent?.session === undefined) throw new CanvasCoordinationError('not-found', 'Session reservation is absent')
      const session = { ...intent.session, phase: 'completed' as const }
      tx.table('thread_operations').put(operationId, { ...intent, session })
      return session
    })
  }

  /**
   * List creation intentions that activation must resume.
   * @returns Unfinished creation identities.
   */
  pendingThreads(): CanvasOperationId[] {
    return [...this.domain.table('thread_operations').entries()].filter(([, value]) => value.phase === 'pending').map(([id]) => id)
  }

  /**
   * Reserve a Chat operation before calling DSH's durable Session operation.
   * @param request - Immutable client retry request.
   * @param cwd - Resolved working directory captured for this operation.
   * @returns The existing or newly durable intent.
   */
  async reserveThread(request: CanvasThreadRequest, cwd: string): Promise<CanvasThreadIntent> {
    const intent = await this.domain.transaction((tx) => {
      const existing = tx.table('thread_operations').get(request.operationId)
      if (existing !== undefined) {
        if (!sameCanvasRequest(existing.request, request)) throw new CanvasCoordinationError('invalid-command', 'Operation identity belongs to a different thread request')
        return existing
      }
      if (tx.table('operations').get(request.operationId) !== undefined || tx.table('deletions').get(request.operationId) !== undefined) {
        throw new CanvasCoordinationError('invalid-command', 'Operation identity belongs to a graph request')
      }
      const graph = tx.global.get()
      const canvas = graph.canvases.find(value => value.id === request.canvasId)
      const node = canvas?.nodes.find(value => value.id === request.nodeId && this.graph.isSessionNode(value))
      if (canvas === undefined || node === undefined) throw new CanvasCoordinationError('not-found', 'Chat no longer exists')
      if (this.deleting(request.canvasId, request.nodeId)) throw new CanvasCoordinationError('deleting', 'Chat is stopping and archiving its threads')
      if (canvas.revision !== request.expectedRevision) throw new CanvasCoordinationError('conflict', 'Canvas changed before thread creation')
      const value: CanvasThreadIntent = {
        request: JSON.stringify(request), canvasId: request.canvasId, nodeId: request.nodeId, cwd,
        phase: 'pending', sessionId: null, inheritedEventCount: 0,
        parentSessionId: request.kind === 'fork' ? request.sourceSessionId : null, error: null,
      }
      tx.table('thread_operations').put(request.operationId, value)
      return value
    })
    return structuredClone(intent)
  }

  /**
   * Atomically bind the actual durable Session result, or retain it for deletion.
   * @param operationId - Reserved creation identity.
   * @param sessionId - Actual DSH Session identity.
   * @param inheritedEventCount - Durable fork prefix length.
   * @returns True when bound; false when deletion owns the late result.
   */
  async completeThread(operationId: CanvasOperationId, sessionId: SessionId, inheritedEventCount: number): Promise<boolean> {
    const bound = await this.domain.transaction((tx) => {
      const intent = tx.table('thread_operations').get(operationId)
      if (intent === undefined) throw new CanvasCoordinationError('not-found', 'Thread intent is absent')
      if (intent.phase !== 'pending') {
        if (intent.sessionId !== sessionId) throw new CanvasCoordinationError('invalid-command', 'Creation receipt returned a different Session')
        return intent.phase === 'bound'
      }
      const graph = tx.global.get()
      const canvas = graph.canvases.find(value => value.id === intent.canvasId)
      const node = canvas?.nodes.find(value => value.id === intent.nodeId)
      const suppressed = node === undefined || this.deleting(intent.canvasId, intent.nodeId)
      const existing = tx.table('bindings').get(sessionId)
      if (existing !== undefined && (existing.canvasId !== intent.canvasId || existing.nodeId !== intent.nodeId)) {
        throw new CanvasCoordinationError('invalid-command', 'Session is already bound to another Chat')
      }
      tx.table('thread_operations').put(operationId, { ...intent, sessionId, inheritedEventCount, phase: suppressed ? 'suppressed' : 'bound', error: null })
      tx.table('bindings').put(sessionId, {
        canvasId: intent.canvasId, nodeId: intent.nodeId, sessionId,
        inheritedEventCount, parentSessionId: intent.parentSessionId, deliveryCursor: inheritedEventCount - 1, deliveryError: null,
        ordinal: Math.max(-1, ...[...this.domain.table('bindings').entries()].filter(([, value]) => value.canvasId === intent.canvasId && value.nodeId === intent.nodeId).map(([, value]) => value.ordinal)) + 1,
      })
      if (!suppressed && canvas !== undefined) {
        canvas.revision += 1
        graph.revision += 1
        tx.global.set(graph)
      }
      return !suppressed
    })
    this.publish()
    return bound
  }

  /**
   * Retain an actionable failure while preserving the original retry identity.
   * @param operationId - Pending creation request.
   * @param error - Failure to display alongside the Chat.
   * @returns Once the failure is durable.
   */
  async failThread(operationId: CanvasOperationId, error: string): Promise<void> {
    await this.domain.transaction((tx) => {
      const value = tx.table('thread_operations').get(operationId)
      if (value?.phase === 'pending') tx.table('thread_operations').put(operationId, { ...value, error })
    })
    this.publish()
  }

  /**
   * Mark deletion before settling any existing or late Session operations.
   * @param request - Confirmed graph removal request.
   * @param signal - Optional cancellation before recording the intention.
   * @returns Durable deletion intent, including every removed node.
   */
  async beginDeletion(request: CanvasCommandRequest, signal?: AbortSignal): Promise<CanvasDeletionIntent> {
    const intent = await this.domain.transaction((tx) => {
      const previous = tx.table('deletions').get(request.operationId)
      if (previous !== undefined) {
        if (!sameCanvasRequest(previous.request, request)) throw new CanvasCoordinationError('invalid-command', 'Deletion identity belongs to a different request')
        return previous
      }
      if (tx.table('operations').get(request.operationId) !== undefined || tx.table('thread_operations').get(request.operationId) !== undefined) {
        throw new CanvasCoordinationError('invalid-command', 'Operation identity belongs to another request')
      }
      const canvas = tx.global.get().canvases.find(value => value.id === request.canvasId)
      if (canvas === undefined) throw new CanvasCoordinationError('not-found', 'Canvas no longer exists')
      if (canvas.revision !== request.expectedRevision) throw new CanvasCoordinationError('conflict', 'Canvas changed before deletion')
      if ([...this.domain.table('deletions').entries()].some(([, value]) => value.canvasId === canvas.id && value.phase === 'deleting')) {
        throw new CanvasCoordinationError('deleting', 'Another deletion is still settling this canvas')
      }
      if (this.pendingRestorations().some(([, value]) => value.canvasId === canvas.id)) throw new CanvasCoordinationError('deleting', 'Canvas restoration is still settling')
      const nodeIds = this.graph.removalTargets(tx, request)
      const value: CanvasDeletionIntent = { request: JSON.stringify(request), canvasId: canvas.id, nodeIds, phase: 'deleting', error: null, restoreSessions: [] }
      tx.table('deletions').put(request.operationId, value)
      return value
    }, signal === undefined ? undefined : { signal })
    this.publish()
    return structuredClone(intent)
  }

  /**
   * Remember an archive owned by this deletion before issuing its external write.
   * @param operationId - Active deletion identity.
   * @param sessionId - Previously unarchived Session.
   * @returns After the restoration target is durable.
   */
  recordArchive(operationId: CanvasOperationId, sessionId: SessionId): Promise<void> {
    return this.domain.transaction((tx) => {
      const intent = tx.table('deletions').get(operationId)
      if (intent === undefined || intent.phase !== 'deleting') throw new CanvasCoordinationError('not-found', 'Deletion intent is absent')
      if (!intent.restoreSessions.includes(sessionId)) tx.table('deletions').put(operationId, { ...intent, restoreSessions: [...intent.restoreSessions, sessionId] })
    })
  }

  /**
   * List deletion intentions that activation must resume.
   * @returns Unfinished deletions with their immutable requests.
   */
  pendingDeletions(): [CanvasOperationId, CanvasDeletionIntent][] {
    return [...this.domain.table('deletions').entries()].filter(([, value]) => value.phase === 'deleting')
      .map(([id, value]) => [id, structuredClone(value)])
  }

  /**
   * Find Session bindings and unfinished creation operations owned by a removal.
   * @param deletion - Durable target list.
   * @returns Actual Sessions and pending creation identities.
   */
  deletionTargets(deletion: CanvasDeletionIntent): { sessions: SessionId[]; operations: CanvasOperationId[] } {
    return {
      sessions: [...this.domain.table('bindings').entries()].filter(([, value]) => value.canvasId === deletion.canvasId && deletion.nodeIds.includes(value.nodeId)).map(([id]) => id),
      operations: [...this.domain.table('thread_operations').entries()].filter(([, value]) => value.canvasId === deletion.canvasId && deletion.nodeIds.includes(value.nodeId) && value.phase === 'pending').map(([id]) => id),
    }
  }

  /**
   * Remove the graph only after the caller has confirmed all Session stops and archives.
   * @param operationId - Durable deletion identity.
   * @param signal - Optional cancellation before committing graph removal.
   * @returns Once graph removal and tombstones are atomically durable.
   */
  async finishDeletion(operationId: CanvasOperationId, signal?: AbortSignal): Promise<void> {
    await this.domain.transaction((tx) => {
      const deletion = tx.table('deletions').get(operationId)
      if (deletion === undefined) throw new CanvasCoordinationError('not-found', 'Deletion intent is absent')
      if (deletion.phase === 'completed') return
      if (this.deletionTargets(deletion).operations.length > 0) {
        throw new CanvasCoordinationError('deleting', 'Thread creation is still settling')
      }
      const request = canvasCommandRequestSchema.parse(JSON.parse(deletion.request))
      this.graph.commit(tx, request, deletion.restoreSessions)
      tx.table('deletions').put(operationId, { ...deletion, phase: 'completed', error: null })
    }, signal === undefined ? undefined : { signal })
    this.publish()
  }

  /**
   * Reserve native archive restoration before publishing a restored Chat.
   * @param request - Immutable history transition.
   * @param signal - Optional caller cancellation.
   * @returns Existing or newly durable restoration intent.
   */
  async beginRestoration(request: CanvasCommandRequest, signal?: AbortSignal): Promise<CanvasRestorationIntent> {
    const intent = await this.domain.transaction((tx) => {
      const previous = tx.table('restorations').get(request.operationId)
      if (previous !== undefined) {
        if (!sameCanvasRequest(previous.request, request)) throw new CanvasCoordinationError('invalid-command', 'Restoration identity belongs to another request')
        return previous
      }
      if (tx.table('operations').get(request.operationId) !== undefined || tx.table('thread_operations').get(request.operationId) !== undefined
        || tx.table('deletions').get(request.operationId) !== undefined) throw new CanvasCoordinationError('invalid-command', 'Restoration identity belongs to another request')
      if (this.graph.revision(tx, request.canvasId) !== request.expectedRevision) throw new CanvasCoordinationError('conflict', 'Canvas changed before restoration')
      if (this.pendingRestorations().some(([, value]) => value.canvasId === request.canvasId)
        || this.pendingDeletions().some(([, value]) => value.canvasId === request.canvasId)) throw new CanvasCoordinationError('deleting', 'Canvas lifecycle work is still settling')
      const targets = this.graph.restorationTargets(tx, request)
      const value: CanvasRestorationIntent = { request: JSON.stringify(request), canvasId: request.canvasId, ...targets, phase: 'restoring', error: null }
      tx.table('restorations').put(request.operationId, value)
      return value
    }, signal === undefined ? undefined : { signal })
    this.publish()
    return intent
  }

  /**
   * List unfinished restorations that activation must resume.
   * @returns Restorations that must settle before admitting restored Chats.
   */
  pendingRestorations(): [CanvasOperationId, CanvasRestorationIntent][] {
    return [...this.domain.table('restorations').entries()].filter(([, value]) => value.phase === 'restoring')
  }

  /**
   * Publish graph restoration after native unarchive writes have completed.
   * @param operationId - Durable restoration identity.
   * @param signal - Optional caller cancellation.
   * @returns After the graph, history state, and receipt commit atomically.
   */
  async finishRestoration(operationId: CanvasOperationId, signal?: AbortSignal): Promise<void> {
    await this.domain.transaction((tx) => {
      const intent = tx.table('restorations').get(operationId)
      if (intent === undefined) throw new CanvasCoordinationError('not-found', 'Restoration intent is absent')
      if (intent.phase === 'completed') return
      this.graph.commit(tx, canvasCommandRequestSchema.parse(JSON.parse(intent.request)))
      tx.table('restorations').put(operationId, { ...intent, phase: 'completed', error: null })
    }, signal === undefined ? undefined : { signal })
    this.publish()
  }

  /**
   * Keep an unfinished archive restoration available for retry.
   * @param operationId - Durable restoration identity.
   * @param error - Actionable failure.
   * @returns After retaining the failure without publishing a partial graph.
   */
  async failRestoration(operationId: CanvasOperationId, error: string): Promise<void> {
    await this.domain.transaction((tx) => {
      const intent = tx.table('restorations').get(operationId)
      if (intent?.phase === 'restoring') tx.table('restorations').put(operationId, { ...intent, error })
    })
    this.publish()
  }

  /**
   * Retain a failed deletion for explicit retry and activation recovery.
   * @param operationId - Original deletion identity.
   * @param error - Actionable failure.
   * @returns Once failure is durable.
   */
  async failDeletion(operationId: CanvasOperationId, error: string): Promise<void> {
    await this.domain.transaction((tx) => {
      const value = tx.table('deletions').get(operationId)
      if (value?.phase === 'deleting') tx.table('deletions').put(operationId, { ...value, error })
    })
    this.publish()
  }

  /**
   * Read durable Session ownership for delivery recovery.
   * @returns Bindings with their continuous delivery replay cursors.
   */
  bindings(): (CanvasSessionBinding & { deliveryCursor: number })[] {
    return [...this.domain.table('bindings').entries()].map(([, value]) => structuredClone(value))
  }

  /**
   * Project a complete durable delivery event without replaying its task.
   * @param sessionId - Actual producing Session.
   * @param seq - Durable event sequence.
   * @param files - Absolute paths recorded by DSH's present tool.
   * @param createOutput - Pure provider-owned node and connection construction.
   * @returns Once every file receipt and the event cursor commit together.
   */
  async projectDelivery(
    sessionId: SessionId, seq: number, files: readonly { path: string; description?: string | undefined }[],
    createOutput: CanvasDeliveryOutputFactory,
  ): Promise<void> {
    const preparedFiles = files.map(file => ({ file, node: randomUUID() as CanvasNodeId, edge: randomUUID() as CanvasConnectionId }))
    const changed = await this.domain.transaction((tx) => {
      const binding = tx.table('bindings').get(sessionId)
      if (binding === undefined || seq < binding.inheritedEventCount || seq <= binding.deliveryCursor) return false
      const graph = tx.global.get()
      const canvas = graph.canvases.find(value => value.id === binding.canvasId)
      const chat = canvas?.nodes.find(value => value.id === binding.nodeId)
      const suppressed = chat === undefined || this.deleting(binding.canvasId, binding.nodeId)
        || [...tx.table('thread_operations').entries()].some(([, value]) => value.sessionId === sessionId && value.phase === 'suppressed')
      preparedFiles.forEach(({ file, node: outputId, edge }, index) => {
        const key = `${sessionId}:${seq}:${index}` as CanvasDeliveryId
        if (tx.table('deliveries').get(key) !== undefined) return
        if (canvas !== undefined && chat !== undefined && !suppressed) {
          const output = createOutput({ canvas, source: chat, file, index, nodeId: outputId, connectionId: edge })
          if (output.node.id !== outputId || output.connection.id !== edge
            || output.connection.source !== chat.id || output.connection.target !== outputId) {
            throw new CanvasCoordinationError('invalid-command', 'Delivery projection changed its reserved graph identities')
          }
          canvas.nodes.push(output.node)
          canvas.connections.push(output.connection)
        }
        tx.table('deliveries').put(key, { sessionId, seq, index, canvasId: binding.canvasId, nodeId: binding.nodeId, outputId, phase: suppressed ? 'suppressed' : 'projected' })
      })
      tx.table('bindings').put(sessionId, { ...binding, deliveryCursor: seq, deliveryError: null })
      if (!suppressed && canvas !== undefined) { canvas.revision += 1; graph.revision += 1; tx.global.set(graphSchema.parse(graph)) }
      return true
    })
    if (changed) this.publish()
  }

  /**
   * Retain a delivery recovery failure without discarding its replay cursor.
   * @param sessionId - Producing Session.
   * @param error - Failure, or null after successful catch-up.
   * @returns Once the report is durable.
   */
  async deliveryFailure(sessionId: SessionId, error: string | null): Promise<void> {
    const changed = await this.domain.transaction((tx) => {
      const binding = tx.table('bindings').get(sessionId)
      if (binding === undefined || binding.deliveryError === error) return false
      tx.table('bindings').put(sessionId, { ...binding, deliveryError: error })
      return true
    })
    if (changed) this.publish()
  }

  private deleting(canvasId: CanvasId, nodeId: CanvasNodeId): boolean {
    return [...this.domain.table('deletions').entries()].some(([, value]) => value.phase === 'deleting' && value.canvasId === canvasId && value.nodeIds.includes(nodeId))
      || [...this.domain.table('restorations').entries()].some(([, value]) => value.phase === 'restoring' && value.canvasId === canvasId && value.nodeIds.includes(nodeId))
  }
}
