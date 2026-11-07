/** Canvas-owned terminal models share DSH streaming and explicit process cleanup. */
import type { Context } from '@deepseek-ai/cordis'
import type { CanvasId, CanvasNodeId, CanvasWorkspace } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { TerminalRemoteFor, TerminalView, TerminalViewState } from '@deepseek-ai/dsh-api-terminal-controller/client'
import type { WebTerminalId } from '@deepseek-ai/dsh-api-terminal-controller/types'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-convax-plugin-inernal-nodes-host/remote'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

type Target = { readonly canvasId: CanvasId; readonly nodeId: CanvasNodeId }
interface HeldTerminal {
  readonly target: Target
  lifetime: AbortController
  shellPath: string | undefined
  model: TerminalView<Target>
  readonly state: SnapshotStore<TerminalViewState>
  unsubscribe: () => void
  restarting?: Promise<void>
}

/** Owns models independently of canvas tabs and mounted terminal bodies. */
export class CanvasTerminalCards {
  private disposed = false
  private readonly entries = new Map<string, HeldTerminal>()
  private readonly removed = new Set<string>()
  private readonly pending = new Set<Promise<void>>()
  private readonly transport: TerminalRemoteFor<Target>

  /** @param terminals - Shared DSH model factory. @param remote - Generated terminal and stream transport. */
  constructor(private readonly terminals: Context['webTerminals'], remote: Context['remote']) {
    const api = remote.convaxTerminal
    this.transport = {
      environment: (target, signal) => api.environment(target.canvasId, target.nodeId, signal),
      shells: (target, signal) => api.shells(target.canvasId, target.nodeId, signal),
      list: target => api.list(target.canvasId, target.nodeId),
      create: (target, request, signal) => api.create(target.canvasId, target.nodeId, request, signal),
      attach: (target, id, signal) => api.attach(target.canvasId, target.nodeId, id, signal),
      retain: (target, id, signal) => api.retain(target.canvasId, target.nodeId, id, signal),
      rename: (target, id, title) => api.rename(target.canvasId, target.nodeId, id, title),
      close: (target, id) => api.close(target.canvasId, target.nodeId, id),
    }
  }

  /** @param workspace - Committed graph membership; tab visibility does not affect retention. */
  observe(workspace: CanvasWorkspace): void {
    if (this.disposed) return
    const present = new Set<string>()
    for (const canvas of workspace.canvases) {
      for (const node of canvas.nodes) {
        if (node.typeId !== 'convax.terminal') continue
        present.add(node.id)
        const shellPath = typeof node.data.shellPath === 'string' ? node.data.shellPath : undefined
        const existing = this.entries.get(node.id)
        if (existing !== undefined) { existing.shellPath = shellPath; continue }
        const target = { canvasId: canvas.id, nodeId: node.id }
        const lifetime = new AbortController()
        const model = this.terminals.createView(target, this.transport, randomUUID() as WebTerminalId, lifetime.signal,
          !this.removed.has(node.id), shellPath)
        const state = createSnapshotStore(model.state.getSnapshot())
        const unsubscribe = model.state.subscribe(() => { state.set(model.state.getSnapshot()) })
        this.entries.set(node.id, { target, lifetime, shellPath, model, state, unsubscribe })
      }
    }
    for (const [id, held] of this.entries) {
      if (present.has(id)) continue
      this.entries.delete(id)
      this.removed.add(id)
      held.unsubscribe()
      this.track(held.model.close().finally(() => { held.lifetime.abort() }))
    }
  }

  /** @param id - Existing node. @returns Its shared observable terminal state. */
  state(id: string): HostObservable<TerminalViewState> | undefined { return this.entries.get(id)?.state }
  /** @param id - Existing node. @returns Its terminal commands. */
  model(id: string): TerminalView<Target> | undefined { return this.entries.get(id)?.model }

  /** @param id - Node whose previous terminal ended. @returns After startup settles; failures remain in the card's state. */
  restart(id: string): Promise<void> {
    const previous = this.entries.get(id)
    if (previous === undefined || this.disposed) return Promise.resolve()
    if (previous.restarting !== undefined) return previous.restarting
    const work = this.replace(id, previous).catch((error: unknown) => {
      if (this.entries.get(id) !== previous || this.disposed) return
      const state = previous.model.state.getSnapshot()
      previous.state.set({ ...state, phase: state.phase === 'closed' ? 'closed' : 'failed', writable: false,
        error: error instanceof Error ? error.message : String(error) })
    }).finally(() => { delete previous.restarting })
    previous.restarting = work
    this.track(work)
    return work
  }

  private async replace(id: string, previous: HeldTerminal): Promise<void> {
    await previous.model.close()
    if (this.entries.get(id) !== previous || this.disposed) return
    previous.lifetime.abort()
    previous.unsubscribe()
    const lifetime = new AbortController()
    const model = this.terminals.createView(previous.target, this.transport, randomUUID() as WebTerminalId,
      lifetime.signal, true, previous.shellPath)
    previous.lifetime = lifetime
    previous.model = model
    previous.unsubscribe = model.state.subscribe(() => { previous.state.set(model.state.getSnapshot()) })
    previous.state.set(model.state.getSnapshot())
    await model.refresh()
  }

  private track(work: Promise<void>): void {
    const pending = work.catch((error: unknown) => { console.error('Canvas terminal cleanup failed', error) })
    this.pending.add(pending)
    void pending.then(() => { this.pending.delete(pending) })
  }

  /** @returns After Client streams drain; Host terminals retain their canvas ownership. */
  async dispose(): Promise<void> {
    this.disposed = true
    const entries = [...this.entries.values()]
    this.entries.clear()
    for (const entry of entries) { entry.unsubscribe(); entry.lifetime.abort() }
    await Promise.all([...entries.map(entry => entry.model.dispose()), ...this.pending])
  }
}
