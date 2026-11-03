/** Window-owned first-thread requests shared by Chat initialization and linked references. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CanvasId, CanvasThreadRequest, CanvasThreadResult, CanvasWorkspace } from '@deepseek-ai/dsh-convax-plugin-host/types'

interface InitialThread {
  request?: CanvasThreadRequest
  readonly result: Promise<CanvasThreadResult>
  readonly stages: Set<(request: CanvasThreadRequest) => void>
}

/** Keeps one initial creation identity per Chat while its canvas views mount and update. */
export class CanvasInitialThreads {
  private readonly entries = new Map<string, InitialThread>()
  private readonly lanes = new Map<CanvasId, Promise<void>>()
  private workspace: CanvasWorkspace | undefined
  private disposed = false

  /**
   * @param create - Create a durable thread and refresh native Session summaries.
   * @param isArchived - Read the native archive owner before selecting a reusable thread.
   */
  constructor(private readonly create: (request: CanvasThreadRequest) => Promise<CanvasThreadResult>,
    private readonly isArchived: (sessionId: SessionId) => boolean = () => false) {}

  /**
   * Retain the latest committed workspace and release requests for removed Chats.
   * @param workspace - Authoritative Host snapshot.
   */
  observe(workspace: CanvasWorkspace): void {
    if (this.disposed || this.workspace !== undefined && workspace.revision < this.workspace.revision) return
    this.workspace = workspace
    const live = new Set(workspace.chats.map(chat => JSON.stringify([chat.canvasId, chat.nodeId])))
    for (const [key, entry] of this.entries) {
      if (live.has(key)) continue
      entry.stages.clear()
      this.entries.delete(key)
    }
  }

  /**
   * Reuse the first unarchived thread or share its original creation attempt, including failures.
   * @param request - Initial creation request for a Chat without an unarchived thread.
   * @param stage - Persist the actual shared request before awaiting its outcome.
   * @returns The first thread's result. Unreserved revision conflicts use the newer snapshot;
   * other failures require an explicit retry.
   */
  ensure(request: CanvasThreadRequest, stage?: (request: CanvasThreadRequest) => void): Promise<CanvasThreadResult> {
    if (this.disposed) return Promise.reject(new Error('Canvas initial thread owner is disposed'))
    const chat = this.workspace?.chats.find(chat => chat.canvasId === request.canvasId && chat.nodeId === request.nodeId)
    const first = chat?.threads.find(thread => !this.isArchived(thread.sessionId))
    if (first !== undefined && this.workspace !== undefined) {
      stage?.(request)
      return Promise.resolve({ ok: true, sessionId: first.sessionId, workspace: this.workspace })
    }
    const key = JSON.stringify([request.canvasId, request.nodeId])
    const current = this.entries.get(key)
    if (current !== undefined) {
      if (stage !== undefined) {
        current.stages.add(stage)
        if (current.request !== undefined) stage(current.request)
        void current.result.then(() => { current.stages.delete(stage) }, () => { current.stages.delete(stage) })
      }
      return current.result
    }
    const entry: InitialThread = {
      stages: new Set(stage === undefined ? [] : [stage]),
      result: (this.lanes.get(request.canvasId) ?? Promise.resolve()).then(async () => {
        try {
          while (true) {
            if (this.disposed) throw new Error('Canvas initial thread owner is disposed')
            if (this.entries.get(key) !== entry) throw new Error('Chat no longer exists')
            const observed = this.workspace
            const revision = observed?.canvases.find(canvas => canvas.id === request.canvasId)?.revision
            entry.request = revision === undefined ? request : { ...request, expectedRevision: revision }
            for (const persist of entry.stages) persist(entry.request)
            const first = observed?.chats.find(chat => chat.canvasId === request.canvasId && chat.nodeId === request.nodeId)
              ?.threads.find(thread => !this.isArchived(thread.sessionId))
            if (first !== undefined && observed !== undefined) return { ok: true, sessionId: first.sessionId, workspace: observed }
            const result = await this.create(entry.request)
            this.observe(result.workspace)
            const currentRevision = this.workspace?.canvases.find(canvas => canvas.id === request.canvasId)?.revision
            // A revision conflict precedes the Host's durable reservation, so the operation has allocated no Session.
            if (!result.ok && result.code === 'conflict' && currentRevision !== undefined && currentRevision > entry.request.expectedRevision) continue
            return result
          }
        } finally { entry.stages.clear() }
      }),
    }
    this.entries.set(key, entry)
    const lane = entry.result.then(() => {}, () => {})
    this.lanes.set(request.canvasId, lane)
    void lane.then(() => {
      const bound = this.workspace?.chats.some(chat =>
        chat.canvasId === request.canvasId && chat.nodeId === request.nodeId
        && chat.threads.some(thread => !this.isArchived(thread.sessionId)))
      if (bound && this.entries.get(key) === entry) this.entries.delete(key)
      if (this.lanes.get(request.canvasId) === lane) this.lanes.delete(request.canvasId)
    })
    return entry.result
  }

  /** Release cached attempts and prevent further initialization after the plugin unloads. */
  dispose(): void {
    this.disposed = true
    for (const entry of this.entries.values()) entry.stages.clear()
    this.entries.clear()
    this.lanes.clear()
    this.workspace = undefined
  }
}
