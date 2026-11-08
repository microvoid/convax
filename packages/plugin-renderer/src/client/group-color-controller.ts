/** Window-owned color sessions isolate previews from durable group changes. */
import type { CanvasDocument, CanvasGroupColor, CanvasGroupId } from '@deepseek-ai/dsh-convax-plugin-host/types'

/** Rendering state for a palette and its window-local preview. */
export interface CanvasGroupColorView {
  readonly groupIds: readonly CanvasGroupId[]
  readonly preview: CanvasGroupColor | null | undefined
  readonly pending: boolean
}

interface ColorSession extends CanvasGroupColorView {
  readonly token: number
  readonly canvasId: CanvasDocument['id']
  readonly revision: number
}

/** Own exactly one color session for the mounted canvas window. */
export class CanvasGroupColorController {
  private session: ColorSession | null = null
  private sequence = 0

  constructor(private readonly options: {
    readonly document: () => CanvasDocument
    readonly available: () => boolean
    readonly setColor: (groupIds: readonly CanvasGroupId[], color: CanvasGroupColor | null) => Promise<boolean>
    readonly changed: (view: CanvasGroupColorView | null) => void
  }) {}

  /** Open only current groups, replacing an idle preview without overlapping a submission. */
  open(groupIds: readonly CanvasGroupId[]): boolean {
    if (!this.options.available() || this.session?.pending === true) return false
    const document = this.options.document()
    const ids = [...new Set(groupIds)]
    if (ids.length === 0 || ids.some(id => !document.groups?.some(group => group.id === id))) return false
    this.session = { token: ++this.sequence, canvasId: document.id, revision: document.revision,
      groupIds: ids, preview: undefined, pending: false }
    this.publish()
    return true
  }

  /** Preview a color without invoking the Host or changing saved group records. */
  preview(color: CanvasGroupColor | null | undefined): void {
    if (this.session === null || this.session.pending) return
    this.session = { ...this.session, preview: color }
    this.publish()
  }

  /** Dismissal always removes the preview, including while an admitted command settles. */
  close(): void {
    if (this.session === null) return
    this.session = null
    this.publish()
  }

  /** Cancel stale targeting before a later color can overwrite another window's edit. */
  reconcile(active: boolean, groupIds: readonly CanvasGroupId[]): void {
    const session = this.session
    if (session === null) return
    const document = this.options.document()
    const sameSelection = groupIds.length === session.groupIds.length && groupIds.every(id => session.groupIds.includes(id))
    if (!active || session.canvasId !== document.id || session.revision !== document.revision || !sameSelection) this.close()
  }

  /** Commit one captured selection; late settlements never dismiss a newer palette. */
  async apply(color: CanvasGroupColor | null): Promise<boolean> {
    const session = this.session
    if (session === null || session.pending || !this.options.available()) return false
    const document = this.options.document()
    if (document.id !== session.canvasId || document.revision !== session.revision) { this.close(); return false }
    this.session = { ...session, preview: color, pending: true }
    this.publish()
    try { return await this.options.setColor(session.groupIds, color) }
    finally { this.closeIfCurrent(session.token) }
  }

  /** Drop the unmounted window's preview without publishing a final rendering update. */
  dispose(): void { this.session = null }

  private closeIfCurrent(token: number): void {
    if (this.session?.token === token) this.close()
  }

  private publish(): void {
    const session = this.session
    this.options.changed(session === null ? null : { groupIds: session.groupIds, preview: session.preview, pending: session.pending })
  }
}
