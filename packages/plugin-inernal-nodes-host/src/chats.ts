/** Recoverable coordination between Convax graph records and DSH Sessions. */
import { sameCanvasRequest } from '@deepseek-ai/dsh-convax-plugin-host'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-fs'
import type { CanvasRepository } from '@deepseek-ai/dsh-convax-plugin-host'
import { archiveCanvasThread } from './archive.ts'
import { CanvasCoordinationError } from '@deepseek-ai/dsh-convax-plugin-host'
import { canvasCommandRequestSchema, threadRequestSchema } from '@deepseek-ai/dsh-convax-plugin-host'
import { CanvasSessionMaterializer } from './session-materializer.ts'
import { openExistingCanvasSession } from './existing-sessions.ts'
import type { CanvasThreadSessions } from './session-materializer.ts'
import type { CanvasCommandRequest, CanvasCommandResult, CanvasNodeId, CanvasOperationId, CanvasThreadRequest, CanvasThreadResult, CanvasOpenSessionRequest, CanvasOpenSessionResult } from '@deepseek-ai/dsh-convax-plugin-host/types'

/** Owns pending coordination while renderer views may come and go. */
export class CanvasChatCoordinator {
  private readonly threads = new Map<CanvasOperationId, { request: CanvasThreadRequest; pending: Promise<CanvasThreadResult> }>()
  private readonly deletions = new Map<CanvasOperationId, { request: CanvasCommandRequest; pending: Promise<CanvasCommandResult> }>()
  private readonly lifetime = new AbortController()
  private readonly openings = new Set<Promise<CanvasOpenSessionResult>>()
  private readonly restorations = new Map<CanvasOperationId, { request: CanvasCommandRequest; pending: Promise<CanvasCommandResult> }>()

  /**
   * @param ctx - Host context with native Session persistence and Workspace archival.
   * @param repository - Exclusive graph transaction owner.
   */
  constructor(private readonly ctx: Context, private readonly repository: CanvasRepository,
    private readonly sessions: CanvasThreadSessions = new CanvasSessionMaterializer(ctx, repository)) {}

  /**
   * Continue durable intentions without repeating prompts or completed creations.
   * @returns Once every pending operation has completed or retained a visible failure.
   */
  async recover(): Promise<void> {
    for (const operationId of this.repository.coordination.pendingThreads()) {
      const intent = this.repository.coordination.thread(operationId)
      if (intent !== undefined) await this.createThread(threadRequestSchema.parse(JSON.parse(intent.request)))
    }
    for (const [, intent] of this.repository.coordination.pendingDeletions()) {
      await this.execute(canvasCommandRequestSchema.parse(JSON.parse(intent.request)))
    }
    for (const [, intent] of this.repository.coordination.pendingRestorations()) {
      await this.execute(canvasCommandRequestSchema.parse(JSON.parse(intent.request)))
    }
  }

  /**
   * Create or fork exactly one DSH Session under a durable retry identity.
   * @param request - Immutable Chat operation.
   * @returns Actual Session identity, or a recoverable rejection.
   */
  createThread(request: CanvasThreadRequest): Promise<CanvasThreadResult> {
    const current = this.threads.get(request.operationId)
    if (current !== undefined) return sameCanvasRequest(current.request, request)
      ? current.pending : Promise.resolve({ ok: false, code: 'invalid-command', message: 'Operation identity belongs to another request', workspace: this.repository.snapshot() })
    request = structuredClone(request)
    const pending = this.create(request)
    this.threads.set(request.operationId, { request, pending })
    void pending.then(() => { this.threads.delete(request.operationId) }, () => { this.threads.delete(request.operationId) })
    return pending
  }

  /**
   * Place a native Session on the graph without creating or resuming an Agent.
   * @param request - Existing Session and caller-retained Chat placement identity.
   * @returns Its unique existing or newly committed Chat location.
   */
  openSession(request: CanvasOpenSessionRequest): Promise<CanvasOpenSessionResult> {
    const pending = openExistingCanvasSession(this.ctx, this.repository, structuredClone(request), this.lifetime.signal)
    this.openings.add(pending)
    void pending.then(() => { this.openings.delete(pending) }, () => { this.openings.delete(pending) })
    return pending
  }

  private async create(request: CanvasThreadRequest): Promise<CanvasThreadResult> {
    try {
      this.lifetime.signal.throwIfAborted()
      const previous = this.repository.coordination.thread(request.operationId)
      const chat = this.repository.getChat(request.canvasId, request.nodeId)
      if (previous === undefined && chat === undefined) throw new CanvasCoordinationError('not-found', 'Chat no longer exists')
      let cwd = previous?.cwd ?? (request.kind === 'create' ? request.cwd ?? chat?.cwd : chat?.cwd)
      if (cwd === undefined || !isAbsolute(cwd)) throw new CanvasCoordinationError('invalid-command', 'A project directory is required for a thread')
      if (previous === undefined && request.kind === 'create') {
        const target = await this.ctx.fs.resolve(cwd, { signal: this.lifetime.signal })
        const stat = await this.ctx.fs.stat(target, this.lifetime.signal)
        if (stat?.type !== 'directory') throw new CanvasCoordinationError('invalid-command', 'Thread project directory is unavailable')
        cwd = this.ctx.fs.processPath(target)
      }
      const intent = await this.repository.coordination.reserveThread(request, cwd)
      if (intent.phase === 'bound' && intent.sessionId !== null) return { ok: true, sessionId: intent.sessionId, workspace: this.repository.snapshot() }
      if (intent.phase === 'suppressed') throw new CanvasCoordinationError('deleting', 'Chat was deleted while its thread was being created')
      const receipt = await this.sessions.materialize(request.operationId)
      this.lifetime.signal.throwIfAborted()
      const bound = await this.repository.coordination.completeThread(request.operationId, receipt.sessionId, receipt.inheritedEventCount)
      if (!bound) {
        await archiveCanvasThread(this.ctx, receipt.sessionId, this.lifetime.signal)
        throw new CanvasCoordinationError('deleting', 'Late-created thread was stopped and archived with its deleted Chat')
      }
      return { ok: true, sessionId: receipt.sessionId, workspace: this.repository.snapshot() }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.repository.coordination.failThread(request.operationId, message)
      return { ok: false, code: error instanceof CanvasCoordinationError && error.code !== 'provider-unavailable' ? error.code : 'operation-pending', message, workspace: this.repository.snapshot() }
    }
  }

  /**
   * Execute graph mutations, coordinating Chat removals with Session ownership.
   * @param request - Revisioned graph command and optional deletion consent.
   * @param signal - Optional caller cancellation; durable deletion intentions remain recoverable.
   * @returns Current committed graph or a retryable failure.
   */
  execute(request: CanvasCommandRequest, signal?: AbortSignal): Promise<CanvasCommandResult> {
    if (request.command.kind === 'history' || request.command.kind === 'batch') return this.executeHistory(request, signal)
    return this.executeMutation(request, signal)
  }

  private async executeHistory(request: CanvasCommandRequest, signal?: AbortSignal): Promise<CanvasCommandResult> {
    const targets = await this.repository.historyTargets(request, signal)
    if (!targets.ok) return targets.result
    if (targets.restored.length === 0) return this.executeMutation(request, signal, targets.removed)
    const current = this.restorations.get(request.operationId)
    if (current !== undefined) return sameCanvasRequest(current.request, request)
      ? current.pending : { ok: false, code: 'invalid-command', message: 'Restoration identity belongs to another request', workspace: this.repository.snapshot() }
    request = structuredClone(request)
    const pending = this.restore(request, signal)
    this.restorations.set(request.operationId, { request, pending })
    void pending.then(() => { this.restorations.delete(request.operationId) }, () => { this.restorations.delete(request.operationId) })
    return pending
  }

  private executeMutation(
    request: CanvasCommandRequest, signal?: AbortSignal, historyRemoved?: CanvasNodeId[],
  ): Promise<CanvasCommandResult> {
    signal?.throwIfAborted()
    const workspace = this.repository.snapshot()
    const canvas = workspace.canvases.find(value => value.id === request.canvasId)
    const ids = historyRemoved ?? (request.command.kind === 'delete' || request.command.kind === 'purge' ? canvas?.nodes.map(value => value.id) ?? []
      : request.command.kind === 'remove-nodes' ? request.command.nodeIds : [])
    const containsChat = workspace.chats.some(chat => chat.canvasId === request.canvasId && ids.includes(chat.nodeId))
    const recorded = this.repository.coordination.pendingDeletions().some(([id]) => id === request.operationId)
    if (!containsChat && !recorded && request.command.kind !== 'purge') return this.repository.execute(request, signal)
    const current = this.deletions.get(request.operationId)
    if (current !== undefined) return sameCanvasRequest(current.request, request)
      ? current.pending : Promise.resolve({ ok: false, code: 'invalid-command', message: 'Operation identity belongs to another request', workspace: this.repository.snapshot() })
    request = structuredClone(request)
    const pending = this.remove(request, signal, historyRemoved)
    this.deletions.set(request.operationId, { request, pending })
    void pending.then(() => { this.deletions.delete(request.operationId) }, () => { this.deletions.delete(request.operationId) })
    return pending
  }

  private async remove(
    request: CanvasCommandRequest, callerSignal?: AbortSignal, historyRemoved?: CanvasNodeId[],
  ): Promise<CanvasCommandResult> {
    const signal = callerSignal === undefined ? this.lifetime.signal : AbortSignal.any([callerSignal, this.lifetime.signal])
    try {
      signal.throwIfAborted()
      const canvas = this.repository.snapshot().canvases.find(value => value.id === request.canvasId)
      const nodeIds = historyRemoved ?? (request.command.kind === 'delete' || request.command.kind === 'purge' ? canvas?.nodes.map(value => value.id) ?? []
        : request.command.kind === 'remove-nodes' ? request.command.nodeIds : [])
      const affected = this.repository.coordination.bindings()
        .some(binding => binding.canvasId === request.canvasId && nodeIds.includes(binding.nodeId))
        || this.repository.coordination.pendingThreads().some((id) => {
          const intent = this.repository.coordination.thread(id)
          return intent?.canvasId === request.canvasId && nodeIds.includes(intent.nodeId)
        })
      if (affected && request.confirmed !== true) return {
        ok: false, code: 'confirmation-required', message: 'Deleting this Chat stops and archives its threads. Confirm before continuing.', workspace: this.repository.snapshot(),
      }
      const intent = await this.repository.coordination.beginDeletion(request, signal)
      if (intent.phase === 'completed') return { ok: true, workspace: this.repository.snapshot() }
      for (const operationId of this.repository.coordination.deletionTargets(intent).operations) {
        const thread = this.repository.coordination.thread(operationId)
        if (thread !== undefined) {
          const result = await this.createThread(threadRequestSchema.parse(JSON.parse(thread.request)))
          if (!result.ok && result.code !== 'deleting') throw new Error(result.message)
        }
      }
      for (const sessionId of this.repository.coordination.deletionTargets(intent).sessions) {
        await archiveCanvasThread(this.ctx, sessionId, signal, id => this.repository.coordination.recordArchive(request.operationId, id))
      }
      signal.throwIfAborted()
      await this.repository.coordination.finishDeletion(request.operationId, signal)
      return { ok: true, workspace: this.repository.snapshot() }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.repository.coordination.failDeletion(request.operationId, message)
      const pending = this.repository.coordination.pendingDeletions().some(([id]) => id === request.operationId)
      return { ok: false, code: pending ? 'operation-pending' : error instanceof CanvasCoordinationError ? error.code : 'operation-pending', message, workspace: this.repository.snapshot() }
    }
  }

  private async restore(request: CanvasCommandRequest, callerSignal?: AbortSignal): Promise<CanvasCommandResult> {
    const signal = callerSignal === undefined ? this.lifetime.signal : AbortSignal.any([callerSignal, this.lifetime.signal])
    try {
      signal.throwIfAborted()
      const intent = await this.repository.coordination.beginRestoration(request, signal)
      if (intent.phase === 'completed') return { ok: true, workspace: this.repository.snapshot() }
      for (const sessionId of intent.sessionIds) {
        signal.throwIfAborted()
        await this.ctx.workspaceRegistry.unarchiveSession(sessionId)
      }
      if (intent.sessionIds.some(id => this.ctx.workspaceRegistry.archivedSessionIds.includes(id))) {
        throw new Error('A Session was archived again while its Chat was being restored; retry restoration')
      }
      signal.throwIfAborted()
      await this.repository.coordination.finishRestoration(request.operationId, signal)
      return { ok: true, workspace: this.repository.snapshot() }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.repository.coordination.failRestoration(request.operationId, message)
      const pending = this.repository.coordination.pendingRestorations().some(([id]) => id === request.operationId)
      return { ok: false, code: pending ? 'operation-pending' : error instanceof CanvasCoordinationError ? error.code : 'operation-pending', message, workspace: this.repository.snapshot() }
    }
  }

  /**
   * Stop new coordination and drain all owned operations before storage teardown.
   * @returns Once pending calls have settled with durable retry records.
   */
  async close(): Promise<void> {
    this.lifetime.abort()
    const pending = [...this.threads.values(), ...this.deletions.values(), ...this.restorations.values()]
    await Promise.allSettled([...pending.map(value => value.pending), ...this.openings])
  }
}
