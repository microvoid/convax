/** Window-owned activity rows retain read state independently from canvas navigation. */
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { CanvasId, CanvasNodeId, CanvasWorkspace } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Latest observed activity for one canvas-bound Session during this client lifetime. */
export interface CanvasActivityItem {
  readonly sessionId: SessionId
  readonly canvasId: CanvasId
  readonly nodeId: CanvasNodeId
  readonly title: string
  readonly defaultTitle?: true
  readonly canvasTitle: string
  readonly kind: 'attention' | 'completed'
  readonly occurredAt: number
  readonly unread: boolean
}

interface ObservedStatus {
  readonly completionUnread: boolean
  readonly interactionKey: string | undefined
}

function literalTitle(item: CanvasActivityItem): CanvasActivityItem {
  const { defaultTitle: _defaultTitle, ...rest } = item
  return rest
}

function sameItem(left: CanvasActivityItem, right: CanvasActivityItem): boolean {
  return left.sessionId === right.sessionId && left.canvasId === right.canvasId && left.nodeId === right.nodeId
    && left.title === right.title && left.defaultTitle === right.defaultTitle
    && left.canvasTitle === right.canvasTitle && left.kind === right.kind
    && left.occurredAt === right.occurredAt && left.unread === right.unread
}

/** Keeps the latest activity per Session and leaves read attention rows until their request resolves. */
export class CanvasActivity {
  private readonly rows = new Map<SessionId, CanvasActivityItem>()
  private readonly observed = new Map<SessionId, ObservedStatus>()
  private readonly listeners = new Set<() => void>()
  private snapshot: readonly CanvasActivityItem[] = []
  private disposed = false

  /**
   * Read detached activity for framework-generated hooks.
   * @returns The stable activity list, ordered by attention and then recency.
   */
  readonly getSnapshot = (): readonly CanvasActivityItem[] => this.snapshot

  /**
   * Observe activity publications until explicitly released or this owner is disposed.
   * @param listener - State observer.
   * @returns Observer release.
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    if (!this.disposed) this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Reconcile canvas bindings and native Session activity without activating any Session.
   * Unknown statuses preserve existing rows; removed bindings discard their activity and read state.
   * @param workspace - Current authoritative canvas and Chat bindings.
   * @param statuses - Native pending interactions and completion acknowledgement state.
   * @param summaries - Session titles and durable update times when available.
   */
  observe(workspace: CanvasWorkspace, statuses: SessionStatusSnapshot, summaries: Readonly<Record<string, SessionSummary>>): void {
    if (this.disposed) return
    const canvases = new Map(workspace.canvases.map(canvas => [canvas.id, canvas]))
    const present = new Set<SessionId>()
    for (const chat of workspace.chats) {
      const canvas = canvases.get(chat.canvasId)
      if (canvas === undefined) continue
      for (const thread of chat.threads) {
        const id = thread.sessionId
        if (present.has(id)) continue
        present.add(id)
        const summary = summaries[id]
        const metadata = { sessionId: id, canvasId: chat.canvasId, nodeId: chat.nodeId,
          ...(!summary?.displayTitle && chat.defaultTitle === true ? { defaultTitle: true as const } : {}),
          title: summary?.displayTitle || chat.title, canvasTitle: canvas.title }
        const recorded = this.rows.get(id)
        // A Session title replaces the system-name marker, even when only metadata changes.
        const prior = recorded === undefined ? undefined
          : metadata.defaultTitle === true ? recorded : literalTitle(recorded)
        const status = statuses.get(id)
        if (status === undefined) {
          if (prior !== undefined) this.rows.set(id, { ...prior, ...metadata })
          continue
        }
        const previous = this.observed.get(id)
        const interactionKey = status.pendingInteraction?.key
        if (interactionKey !== undefined) {
          this.rows.set(id, prior?.kind === 'attention' && previous?.interactionKey === interactionKey
            ? { ...prior, ...metadata }
            : { ...metadata, kind: 'attention', occurredAt: Date.now(), unread: true })
        } else if (status.completionUnread && (previous?.completionUnread !== true || prior?.kind === 'attention')) {
          this.rows.set(id, { ...metadata, kind: 'completed', occurredAt: summary?.updatedAt ?? Date.now(), unread: true })
        } else if (prior?.kind === 'attention') {
          this.rows.delete(id)
        } else if (prior !== undefined) {
          this.rows.set(id, { ...prior, ...metadata, unread: prior.unread && status.completionUnread })
        }
        this.observed.set(id, { completionUnread: status.completionUnread, interactionKey })
      }
    }
    for (const id of this.rows.keys()) if (!present.has(id)) this.rows.delete(id)
    for (const id of this.observed.keys()) if (!present.has(id)) this.observed.delete(id)
    this.publish()
  }

  /**
   * Acknowledge visible activity without resolving its native interaction or removing its row.
   * @param sessionIds - Current activity rows explicitly acknowledged by the user.
   */
  markRead(sessionIds: readonly SessionId[]): void {
    if (this.disposed) return
    for (const id of sessionIds) {
      const row = this.rows.get(id)
      if (row?.unread) this.rows.set(id, { ...row, unread: false })
    }
    this.publish()
  }

  /** Release activity history and observers; later source updates are ignored. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.rows.clear()
    this.observed.clear()
    this.snapshot = []
    this.listeners.clear()
  }

  private publish(): void {
    const next = [...this.rows.values()].sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'attention' ? -1 : 1
      return right.occurredAt - left.occurredAt || left.sessionId.localeCompare(right.sessionId)
    })
    if (next.length === this.snapshot.length && next.every((row, index) => {
      const previous = this.snapshot[index]
      return previous !== undefined && sameItem(row, previous)
    })) return
    this.snapshot = next
    notifySubscribers(this.listeners, '[convax] Activity')
  }
}
