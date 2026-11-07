/** Window-owned browser instances independent of Sidebar and Session selection. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import { createSnapshotStore, type BoundActions, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { BrowserController, type BrowserControllerState } from './BrowserController.ts'
import type { BrowserPageFactory } from './BrowserPage.ts'
import { browserAddressCheckpoint, type BrowserTabState } from './BrowserPersistence.ts'
import { parseBrowserAddress } from './url.ts'
import type { BrowserStore } from './store.ts'

/** Stable identity supplied by the owner of an independent browser view. */
export type BrowserViewId = Branded<'BrowserViewId'>

/** One browser's owner-supplied storage and lifetime. */
export interface BrowserViewOptions {
  readonly id: BrowserViewId
  readonly signal: AbortSignal
  readonly workspace: (signal: AbortSignal) => Promise<string>
  /** A restored configuration offers its URL for explicit user restoration without starting navigation. */
  readonly restoreUrl?: string | undefined
  readonly openRequested: (url: string) => void
}

interface HeldView {
  readonly options: BrowserViewOptions
  readonly abort: () => void
  controller?: BrowserController
  unsubscribe?: () => void
}

/** Browser-controller snapshots; null denotes a registered page awaiting its first mount. */
export type BrowserViewStates = Readonly<Record<string, BrowserControllerState | null>>

/** Owns pages until explicit removal or owner shutdown; mounted UI owns only attachment. */
export class BrowserViews {
  /** Detached navigation state for independently mounted browser views. */
  readonly states: SnapshotStore<BrowserViewStates> = createSnapshotStore<BrowserViewStates>({})
  private readonly pending = new Set<Promise<void>>()
  private closed = false
  private actions: BoundActions<BrowserStore> | undefined
  private readonly views = new Map<BrowserViewId, HeldView>()

  constructor(private readonly pageFactory: (workspace: BrowserViewOptions['workspace']) => BrowserPageFactory) {}

  /**
   * Register an idle view; an aborted owner or repeated identity creates nothing.
   * @param options - View identity and owner callbacks.
   */
  create(options: BrowserViewOptions): void {
    if (this.closed || options.signal.aborted || this.views.has(options.id)) return
    const abort = (): void => {
      void this.release(options.id, false).catch((error: unknown) => { console.error('Browser cleanup failed', error) })
    }
    this.views.set(options.id, { options, abort })
    options.signal.addEventListener('abort', abort, { once: true })
    this.publish(options.id, null)
  }

  /**
   * Bind checkpoint writes while views are hidden.
   * @param actions - Current root-store writer.
   */
  rebind(actions: BoundActions<BrowserStore>): void { this.actions = actions }

  /**
   * Attach the retained page; saved checkpoints wait for explicit restoration.
   * @param id - Registered view identity.
   * @param viewportId - Stable, committed DOM container.
   * @param initialUrl - Address supplied when creating a fresh view.
   * @param initial - Persisted checkpoint from the root view store.
   * @param actions - Root checkpoint writer.
   * @returns physical attachment cleanup; removing the DOM can release the live guest.
   */
  mount(id: BrowserViewId, viewportId: string, initialUrl: string | undefined, initial: BrowserTabState | undefined,
    actions: BoundActions<BrowserStore>): () => void {
    const held = this.views.get(id)
    if (held === undefined) return () => {}
    this.rebind(actions)
    if (held.controller === undefined) {
      const restored = held.options.restoreUrl === undefined ? undefined
        : parseBrowserAddress(held.options.restoreUrl, window.location.origin)
      const checkpoint = initial
        ?? (restored?.ok ? browserAddressCheckpoint(restored.target, 0) : undefined)
      const controller = new BrowserController({ tabId: String(id) as TabId, signal: held.options.signal,
        applicationOrigin: window.location.origin, initial: checkpoint,
        actions: { replace: (tabId, state) => {
          this.actions?.replace(tabId, state)
        }, forget: (tabId) => { this.actions?.forget(tabId) } },
        createPage: this.pageFactory(held.options.workspace), openTab: held.options.openRequested })
      held.controller = controller
      held.unsubscribe = controller.subscribe(() => { this.publish(id, controller.getSnapshot()) })
      this.publish(id, controller.getSnapshot())
      const unmount = controller.mount(viewportId)
      controller.start(checkpoint === undefined ? initialUrl : undefined)
      return unmount
    }
    return held.controller.mount(viewportId)
  }

  /**
   * Load an explicit address.
   * @param id - Owned view.
   * @param url - User-supplied HTTP(S) address.
   */
  loadUrl(id: BrowserViewId, url: string): void { this.views.get(id)?.controller?.loadUrl(url) }
  /**
   * Restore a saved address after user activation.
   * @param id - Owned view.
   */
  restore(id: BrowserViewId): void { this.views.get(id)?.controller?.restore() }
  /**
   * Move backward in retained history.
   * @param id - Owned view.
   */
  goBack(id: BrowserViewId): void { this.views.get(id)?.controller?.goBack() }
  /**
   * Move forward in retained history.
   * @param id - Owned view.
   */
  goForward(id: BrowserViewId): void { this.views.get(id)?.controller?.goForward() }
  /**
   * Reload the current page or restore its checkpoint.
   * @param id - Owned view.
   */
  reload(id: BrowserViewId): void { this.views.get(id)?.controller?.reload() }
  /**
   * Set the Web sandbox policy.
   * @param id - Owned view.
   * @param enabled - Whether sandbox restrictions apply.
   */
  setSandbox(id: BrowserViewId, enabled: boolean): void { this.views.get(id)?.controller?.setSandbox(enabled) }
  /**
   * Close like a Sidebar tab and forget its checkpoint.
   * @param id - Owned view.
   * @returns after page cleanup.
   */
  close(id: BrowserViewId): Promise<void> { return this.release(id, true) }
  /**
   * Preserve checkpoints and reject new admissions during shutdown.
   * @returns after every owned cleanup settles.
   */
  async dispose(): Promise<void> {
    this.closed = true
    const releasing = [...this.views.keys()].map(id => this.release(id, false))
    const results = await Promise.allSettled([...releasing, ...this.pending])
    const errors: unknown[] = []
    for (const result of results) if (result.status === 'rejected') errors.push(result.reason)
    if (errors.length > 0) throw new AggregateError(errors, 'Browser cleanup failed')
  }

  private async release(id: BrowserViewId, forget: boolean): Promise<void> {
    const held = this.views.get(id)
    if (held === undefined) return
    this.views.delete(id)
    held.options.signal.removeEventListener('abort', held.abort)
    held.unsubscribe?.()
    if (forget) this.actions?.forget(String(id) as TabId)
    const next: Record<string, BrowserControllerState | null> = {}
    for (const [key, state] of Object.entries(this.states.getSnapshot())) if (key !== id) next[key] = state
    this.states.set(next)
    const disposal = held.controller?.dispose() ?? Promise.resolve()
    this.pending.add(disposal)
    try { await disposal } finally { this.pending.delete(disposal) }
  }

  private publish(id: BrowserViewId, state: BrowserControllerState | null): void {
    if (this.views.has(id)) this.states.set({ ...this.states.getSnapshot(), [id]: state })
  }
}
