/**
 * LayoutController: the cross-plugin panel-action face behind ctx.layout.
 * Panel geometry and main-panel selection live in the root layout store;
 * the current-session selection lives with the runtime sessions service, and
 * the per-session active view dissolved into ui-conversation's session store
 * (its only consumer). What remains here is the contract other plugins'
 * apply worlds reach for panel transitions (main-panel selection and sidebar toggle,
 * right-panel show/hide from ui-sidebar-right) — writes stay inside the
 * store's declared action set, shared with the root registration.
 */
import type { BoundActions, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { createLayoutStore } from './stores.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Transient focus and explicit detail-panel requests made within the current workspace. */
export interface WorkspacePresentation {
  readonly active: boolean
  readonly sessionId: SessionId | undefined
  readonly rightbarOpen: boolean
}

/** Identity shared by a sidebar panel entry and its main-slot occupant. */
export type MainPanelId = Branded<'MainPanelId'>

/** Root-scoped navigation state exposed to panel-aware components. */
export interface PanelInfo {
  /** Selected global panel; null displays the registered workspace or current Conversation. */
  readonly activePanelId: MainPanelId | null
}

/** The layout store's bound action set (framework-baked, draft params peeled). */
export type PanelActions = BoundActions<ReturnType<typeof createLayoutStore>>

/** Panel navigation and geometry actions exposed through ctx.layout. */
export interface ILayout {
  /** Workspace focus and explicit panel visibility, independent of saved native panel preferences. */
  readonly workspacePresentation: HostObservable<WorkspacePresentation>
  /**
   * Route native panel actions to the focused workspace occurrence without changing main navigation.
   * @param sessionId - Workspace occurrence receiving keyboard and panel actions.
   */
  focusWorkspaceSession(sessionId: SessionId): void
  /**
   * Show the native details panel for an explicit workspace request.
   * @param sessionId - Workspace occurrence whose native details the user explicitly opens.
   */
  requestWorkspaceRightbar(sessionId: SessionId): void
  /**
   * Hide an explicitly requested workspace panel while preserving its Session focus.
   * @param sessionId - Close only this occurrence's panel; omission closes the current workspace panel.
   */
  closeWorkspaceRightbar(sessionId?: SessionId): void
  /** Selected central panel from the same root store used by `usePanelInfo`. */
  readonly panelInfo: HostObservable<PanelInfo>
  /**
   * Select a global central panel without changing the current Session.
   * @param panelId - registered main key, or null to show the workspace or default Conversation.
   * @throws if the selected main key is not registered; preserves the current selection.
   */
  selectPanel(panelId: MainPanelId | null): void
  /**
   * Start an asynchronous navigation, superseding any earlier pending navigation.
   * @returns a signal aborted by the next navigation or layout disposal; check it before committing UI state.
   */
  beginNavigation(): AbortSignal
  /** Toggle the sidebar panel (closed ⟷ contract default width). */
  toggleSidebar(): void
  /**
   * Report the right panel's presentation without changing its expanded state.
   * @param track - whether the normal panel width reserves a grid track,
   *   including beneath a fullscreen overlay.
   * @param fullscreen - whether the panel covers the frame and hides its outer
   *   resize handle; independent of the underlying grid track.
   */
  openRightbar(track: boolean, fullscreen: boolean): void
  /** Report the right panel as hidden: no track, no handle. */
  closeRightbar(): void
}

/** Cross-plugin panel-action face (ctx.layout). */
export class LayoutController implements ILayout {
  private navigation = new AbortController()
  private readonly workspaceState = createSnapshotStore<WorkspacePresentation>({ active: false, sessionId: undefined, rightbarOpen: false })
  readonly workspacePresentation: HostObservable<WorkspacePresentation> = this.workspaceState

  /**
   * @param panels - actions of the instance shared with the root entry.
   * @param hasMainPanel - checks the live main-slot registry for a panel id.
   * @param panelInfo - root store's shared central-panel selection source.
   */
  constructor(
    private readonly panels: PanelActions,
    private readonly hasMainPanel: (id: MainPanelId) => boolean,
    readonly panelInfo: HostObservable<PanelInfo>,
  ) {}

  /**
   * Reset transient Session focus and panel requests when workspace presentation changes.
   * @internal
   * @param active - Whether the shell currently renders a replacement workspace.
   */
  setWorkspaceActive(active: boolean): void {
    if (this.workspaceState.getSnapshot().active === active) return
    this.workspaceState.set({ active, sessionId: undefined, rightbarOpen: false })
  }

  focusWorkspaceSession(sessionId: SessionId): void {
    const current = this.workspaceState.getSnapshot()
    if (!current.active || current.sessionId === sessionId) return
    this.workspaceState.set({ ...current, sessionId })
  }

  requestWorkspaceRightbar(sessionId: SessionId): void {
    const current = this.workspaceState.getSnapshot()
    if (!current.active || (current.rightbarOpen && current.sessionId === sessionId)) return
    this.workspaceState.set({ active: true, sessionId, rightbarOpen: true })
  }

  closeWorkspaceRightbar(sessionId?: SessionId): void {
    const current = this.workspaceState.getSnapshot()
    if (!current.rightbarOpen || (sessionId !== undefined && current.sessionId !== sessionId)) return
    this.workspaceState.set({ ...current, rightbarOpen: false })
  }

  /** Select a global panel or return to the Conversation. */
  selectPanel(panelId: MainPanelId | null): void {
    if (panelId !== null && !this.hasMainPanel(panelId)) {
      throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`)
    }
    this.navigation.abort()
    this.panels.selectPanel(panelId)
  }

  /** @returns the new pending navigation's cancellation signal. */
  beginNavigation(): AbortSignal {
    this.navigation.abort()
    this.navigation = new AbortController()
    return this.navigation.signal
  }

  /** Invalidate pending navigations when the layout owner is unloaded. */
  dispose(): void {
    this.navigation.abort()
  }

  /** Toggle the sidebar panel (closed ⟷ contract default width). */
  toggleSidebar(): void {
    this.panels.toggleSidebar()
  }

  /** Report the right panel's track and fullscreen presentation. */
  openRightbar(track: boolean, fullscreen: boolean): void {
    this.panels.openRightbar(track, fullscreen)
  }

  /** Report the right panel as hidden: no track, no handle. */
  closeRightbar(): void {
    this.panels.closeRightbar()
  }
}
