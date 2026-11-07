/** Canvas-owned browser coordination; React owns only the retained presentation. */
import type { CanvasId, CanvasNodeId, CanvasWorkspace } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { BrowserViews, BrowserViewId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/client'

interface BrowserCard {
  readonly canvasId: CanvasId
  readonly lifetime: AbortController
}

/** Owns independent browser identities until graph removal or renderer shutdown. */
export class CanvasBrowserCards {
  private readonly removed = new Set<CanvasNodeId>()
  private readonly cards = new Map<CanvasNodeId, BrowserCard>()
  private workspace: CanvasWorkspace | undefined
  private closed = false

  constructor(private readonly views: Pick<BrowserViews, 'create' | 'close'>,
    private readonly ensureDirectory: (canvasId: CanvasId, signal: AbortSignal) => Promise<string>,
    private readonly openRequested: (canvasId: CanvasId, sourceNodeId: CanvasNodeId, url: string) => void) {}

  /** Observe committed graphs, including closed canvas tabs. @param workspace - Current authoritative canvas membership. */
  reconcile(workspace: CanvasWorkspace): void {
    this.workspace = workspace
    const live = new Set(workspace.canvases.flatMap(canvas => canvas.nodes.filter(node => node.typeId === 'convax.browser').map(node => node.id)))
    for (const [id, card] of this.cards) {
      if (live.has(id)) continue
      this.cards.delete(id)
      this.removed.add(id)
      void this.views.close(String(id) as BrowserViewId).catch((error: unknown) => { console.error('Browser card cleanup failed', error) })
      card.lifetime.abort()
    }
    for (const canvas of workspace.canvases) for (const node of canvas.nodes) {
      if (node.typeId === 'convax.browser') this.ensure(canvas.id, node.id)
    }
  }

  /** Register an idle card. @param canvasId - Owning canvas. @param nodeId - Browser node whose graph membership owns its lifetime. */
  ensure(canvasId: CanvasId, nodeId: CanvasNodeId): void {
    if (this.closed || this.cards.has(nodeId)) return
    const node = this.workspace?.canvases.find(canvas => canvas.id === canvasId)?.nodes.find(item => item.id === nodeId)
    if (node?.typeId !== 'convax.browser') return
    const lifetime = new AbortController()
    this.cards.set(nodeId, { canvasId, lifetime })
    this.views.create({ id: String(nodeId) as BrowserViewId, signal: lifetime.signal,
      ...(this.removed.has(nodeId) && typeof node.data.url === 'string' ? { restoreUrl: node.data.url } : {}),
      workspace: async signal => `cwd:${await this.ensureDirectory(canvasId, signal)}`,
      openRequested: (url) => { this.openRequested(canvasId, nodeId, url) } })
  }

  /** Release this window's pages while preserving normal restart checkpoints. */
  dispose(): void {
    this.closed = true
    for (const card of this.cards.values()) card.lifetime.abort()
    this.cards.clear()
  }
}
