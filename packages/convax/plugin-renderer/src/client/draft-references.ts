/** One-shot graph gestures add native draft reference cards independently of saved edges. */
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { formatFileMention } from '@deepseek-ai/dsh-file-reference/grammar'
import type { CanvasNodeId, CanvasResource } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ReferenceInsert } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { CanvasWindowReference } from './window-reference.ts'
import { encodeWindowReference, WINDOW_REFERENCE_SOURCE } from './window-reference.ts'

/** Window-owned selection and native draft access for deliberate connection gestures. */
export class CanvasDraftReferences {
  private readonly targets = new Map<CanvasNodeId, { sessionId: SessionId | undefined }>()

  /** @param sessions - Retained native Session owner. @param conversation - Native input facade. @param signal - Renderer lifetime. */
  constructor(private readonly sessions: Pick<ISessions, 'retain' | 'binding'>, private readonly conversation: Pick<IConversation, 'input'>, private readonly signal: AbortSignal) {}

  /**
   * Register a Chat's selected input until its occurrence changes.
   * @param nodeId - Chat node.
   * @param sessionId - Its selected thread.
   * @returns Releases only this selection registration.
   */
  bind(nodeId: CanvasNodeId, sessionId: SessionId | undefined): () => void {
    const target = { sessionId }
    this.targets.set(nodeId, target)
    return () => { if (this.targets.get(nodeId) === target) this.targets.delete(nodeId) }
  }

  /**
   * Capture the selected input independently of later navigation.
   * @param nodeId - Chat receiving a new connection.
   * @returns The thread selected at the start of the gesture.
   */
  capture(nodeId: CanvasNodeId): SessionId | undefined { return this.targets.get(nodeId)?.sessionId }

  /**
   * Add one native reference card without changing the retained editor's text or chips.
   * @param sessionId - Captured target thread, independent of later navigation.
   * @param resource - Host-prepared file or folder.
   * @returns Whether the native draft accepted the reference; a locked input remains unchanged.
   */
  async insert(sessionId: SessionId, resource: CanvasResource): Promise<boolean> {
    this.signal.throwIfAborted()
    const directory = resource.kind === 'folder'
    if (!directory && resource.kind !== 'file') return false
    const path = directory ? `${resource.path.replace(/[\\/]+$/u, '')}/` : resource.path
    const mention = formatFileMention({ path, kind: 'file' }, false)
    if (mention === undefined) return false
    return await this.add(sessionId, {
      source: 'reference', ref: mention, clipboardText: mention,
      label: directory ? `${resource.name}/` : resource.name, appearance: directory ? 'folder' : 'file',
    })
  }

  /**
   * Insert an exact window reference without capturing image bytes or changing edges.
   * @param sessionId - Thread captured at the connection gesture.
   * @param reference - Source node and binding generation.
   * @param name - Source window display name.
   * @returns Whether the native draft accepted the reference.
   */
  async insertWindow(sessionId: SessionId, reference: CanvasWindowReference, name: string): Promise<boolean> {
    return await this.add(sessionId, { source: WINDOW_REFERENCE_SOURCE,
      ref: encodeWindowReference(reference), clipboardText: name, label: name })
  }

  private async add(sessionId: SessionId, value: ReferenceInsert): Promise<boolean> {
    this.signal.throwIfAborted()
    const reference = this.sessions.retain(sessionId, { source: 'convaxChat', signal: this.signal })
    try {
      await reference.ready
      this.signal.throwIfAborted()
      const binding = this.sessions.binding(sessionId)
      if (binding === undefined) return false
      const input = this.conversation.input.for(binding.ctx)
      return input.addReferences([value])
    } finally { reference.release() }
  }
}
