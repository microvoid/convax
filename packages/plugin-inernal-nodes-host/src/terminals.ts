/** Canvas-owned user terminals; graph deletion closes processes independently of mounted views. */
import { dirname, isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService, type RemoteStream } from '@deepseek-ai/dsh-typert-protocol'
import { type UserTerminalOwner } from '@deepseek-ai/dsh-api-terminal-controller'
import type { TerminalCreateRequest, TerminalEnvironment, TerminalFrame, TerminalInput, TerminalRetentionFrame, TerminalShell, WebTerminalId, WebTerminalInfo } from '@deepseek-ai/dsh-api-terminal-controller/types'
import type { CanvasDocument, CanvasId, CanvasNode, CanvasNodeId } from '@deepseek-ai/dsh-convax-plugin-host'
import type {} from '@deepseek-ai/dsh-subprocess'

interface CanvasTerminal {
  readonly owner: UserTerminalOwner
  readonly canvasId: CanvasId
  readonly nodeId: CanvasNodeId
  id?: WebTerminalId
  creating?: Promise<WebTerminalInfo>
  removed: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** User terminals owned by canvas cards, independently of Chat Sessions. */
    convaxTerminal: CanvasTerminalController
  }
}

/** Typed terminal operations using committed canvas nodes as their resource owner. */
export class CanvasTerminalController extends TypertRemoteService {
  private readonly terminals = new Map<CanvasNodeId, CanvasTerminal>()
  private readonly closing = new Set<Promise<void>>()
  private readonly lifetime = new AbortController()

  /**
   * @param ctx - Feature scope with the canvas repository and shared user-terminal runtime.
   */
  constructor(ctx: Context) {
    super(ctx, 'convaxTerminal')
    ctx.effect(() => ctx.convax.repository.subscribe(() => { this.reconcile() }), 'convax terminal: graph ownership')
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('Canvas terminals disposed'))
      const results = await Promise.allSettled([...this.terminals.values()].map(entry => entry.owner.dispose()))
      await Promise.allSettled(this.closing)
      const errors = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
      if (errors.length > 0) throw new AggregateError(errors, 'Canvas terminal cleanup failed')
      this.terminals.clear()
    }, 'convax terminal: processes')
  }

  /**
   * Read the card's launch directory and shared terminal limits.
   * @param canvasId - Owning canvas identity.
   * @param nodeId - Terminal card identity.
   * @param signal - Request cancellation.
   * @returns Current launch directory and terminal limits; running shells retain their own directory.
   */
  @Remote
  async environment(canvasId: CanvasId, nodeId: CanvasNodeId, signal: AbortSignal): Promise<TerminalEnvironment> {
    signal.throwIfAborted()
    const entry = this.entry(canvasId, nodeId)
    const current = entry.removed ? undefined : entry.owner.list()[0]
    return entry.owner.environment(current?.cwd ?? await this.directory(canvasId, nodeId, signal))
  }

  /**
   * Discover shells without allocating a terminal process.
   * @param canvasId - Owning canvas identity.
   * @param nodeId - Terminal card identity.
   * @param signal - Request cancellation.
   * @returns Installed shell choices in the canvas execution environment.
   */
  @Remote
  shells(canvasId: CanvasId, nodeId: CanvasNodeId, signal: AbortSignal): Promise<TerminalShell[]> {
    return this.entry(canvasId, nodeId).owner.shells(signal)
  }

  /**
   * List the card's retained process without creating a Session or shell.
   * @param canvasId - Owning canvas identity.
   * @param nodeId - Terminal card identity.
   * @returns At most one retained process, including its exited screen.
   */
  @Remote
  list(canvasId: CanvasId, nodeId: CanvasNodeId): WebTerminalInfo[] {
    this.requireNode(canvasId, nodeId)
    const entry = this.terminals.get(nodeId)
    return entry === undefined || entry.removed ? [] : entry.owner.list()
  }

  /**
   * Start a shell for this card, sharing the current instance across windows and retries.
   * @param canvasId - Owning canvas identity.
   * @param nodeId - Terminal card identity.
   * @param request - New runtime identity, shell choice and initial dimensions.
   * @param signal - Cancellation before allocation commits.
   * @returns Existing or newly committed process metadata; its id may belong to another window's first create.
   */
  @Remote
  async create(canvasId: CanvasId, nodeId: CanvasNodeId, request: TerminalCreateRequest, signal: AbortSignal): Promise<WebTerminalInfo> {
    const entry = this.entry(canvasId, nodeId)
    if (entry.creating !== undefined) return entry.creating
    if (!entry.removed) {
      const existing = entry.owner.list()[0]
      if (existing !== undefined) return existing
    }
    const creating = (async () => {
      if (entry.removed && entry.id !== undefined) await entry.owner.close(entry.id)
      this.requireNode(canvasId, nodeId)
      entry.id = request.id
      entry.removed = false
      const node = this.requireNode(canvasId, nodeId).node
      const shellPath = request.shellPath ?? (typeof node.data.shellPath === 'string' ? node.data.shellPath : undefined)
      return entry.owner.create({ ...request, ...(shellPath === undefined ? {} : { shellPath }) },
        AbortSignal.any([signal, this.lifetime.signal]))
    })()
    entry.creating = creating
    try { return await creating }
    finally { if (entry.creating === creating) delete entry.creating }
  }

  /**
   * Hold an existing process without taking input control; cards also retain their process on the Host.
   * @param canvasId - Owning canvas identity.
   * @param nodeId - Terminal card identity.
   * @param id - Retained runtime identity.
   * @param signal - Physical stream lifetime.
   * @returns Hold acknowledgement followed by its lifetime stream.
   */
  @Remote({ mode: 'stream' })
  retain(canvasId: CanvasId, nodeId: CanvasNodeId, id: WebTerminalId, signal: AbortSignal): AsyncIterable<TerminalRetentionFrame> {
    return this.entry(canvasId, nodeId).owner.retain(id, signal)
  }

  /**
   * Attach screen and input to the card's current process.
   * @param canvasId - Owning canvas identity.
   * @param nodeId - Terminal card identity.
   * @param id - Retained runtime identity.
   * @param signal - Attachment cancellation, which preserves the process.
   * @returns Screen recovery, output, writable state and command acknowledgements.
   */
  @Remote({ mode: 'stream' })
  attach(canvasId: CanvasId, nodeId: CanvasNodeId, id: WebTerminalId, signal: AbortSignal): RemoteStream<TerminalFrame, TerminalInput> {
    const invocation = this.ctx.invocation
    if (invocation === undefined) throw new Error('Terminal attachment requires a Remote invocation')
    return this.entry(canvasId, nodeId).owner.attach(id, invocation.uplink<TerminalInput>(), signal, invocation.uplinkWindow)
  }

  /**
   * Rename the running instance without changing its launch configuration.
   * @param canvasId - Owning canvas identity.
   * @param nodeId - Terminal card identity.
   * @param id - Retained runtime identity.
   * @param title - Nonempty display title.
   */
  @Remote
  rename(canvasId: CanvasId, nodeId: CanvasNodeId, id: WebTerminalId, title: string): void {
    this.entry(canvasId, nodeId).owner.rename(id, title)
  }

  /**
   * Terminate the runtime identity using the shared terminal close path, including after card deletion.
   * @param canvasId - Original owning canvas identity.
   * @param nodeId - Original terminal card identity.
   * @param id - Runtime identity to close; a later replacement remains independent.
   * @returns After provider process cleanup and output drainage settle.
   */
  @Remote
  async close(canvasId: CanvasId, nodeId: CanvasNodeId, id: WebTerminalId): Promise<void> {
    const entry = this.terminals.get(nodeId)
    if (entry === undefined) return
    if (entry.canvasId !== canvasId) throw new RemoteError('terminal/unavailable', 'Terminal does not belong to this canvas', {})
    await entry.owner.close(id)
  }

  private entry(canvasId: CanvasId, nodeId: CanvasNodeId): CanvasTerminal {
    this.lifetime.signal.throwIfAborted()
    this.requireNode(canvasId, nodeId)
    let entry = this.terminals.get(nodeId)
    if (entry === undefined) {
      entry = { canvasId, nodeId, removed: false, owner: this.ctx.terminalController.createOwner(() => ({
        subprocess: this.ctx.subprocess,
        ensureCwd: signal => this.directory(canvasId, nodeId, signal),
        env: { CONVAX_CANVAS_ID: canvasId, CONVAX_NODE_ID: nodeId },
      }), 0) }
      this.terminals.set(nodeId, entry)
    }
    return entry
  }

  private requireNode(canvasId: CanvasId, nodeId: CanvasNodeId): { canvas: CanvasDocument; node: CanvasNode } {
    const canvas = this.ctx.convax.repository.snapshot().canvases.find(value => value.id === canvasId)
    const node = canvas?.nodes.find(value => value.id === nodeId)
    if (canvas === undefined || node?.typeId !== 'convax.terminal') {
      throw new RemoteError('terminal/unavailable', 'Terminal card no longer exists in this canvas', {})
    }
    return { canvas, node }
  }

  private async directory(canvasId: CanvasId, nodeId: CanvasNodeId, signal: AbortSignal): Promise<string> {
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    combined.throwIfAborted()
    const { canvas } = this.requireNode(canvasId, nodeId)
    const edge = canvas.connections.findLast(value => value.target === nodeId && value.purpose === 'input'
      && canvas.nodes.some(node => node.id === value.source && (node.typeId === 'convax.file' || node.typeId === 'convax.folder')))
    const source = edge === undefined ? undefined : canvas.nodes.find(node => node.id === edge.source)
    let path: string
    if (source === undefined) path = await this.ctx.convax.ensureCanvasDirectory(canvasId, combined)
    else {
      if (typeof source.data.path !== 'string' || !isAbsolute(source.data.path)) throw new Error('Terminal directory source requires an absolute resource path')
      path = source.typeId === 'convax.folder' ? source.data.path : dirname(source.data.path)
      const directory = await this.ctx.fs.stat(await this.ctx.fs.resolve(path), combined)
      if (directory?.type !== 'directory') throw new Error('Terminal working directory is unavailable')
    }
    combined.throwIfAborted()
    this.requireNode(canvasId, nodeId)
    return path
  }

  private reconcile(): void {
    const canvases = this.ctx.convax.repository.snapshot().canvases
    for (const entry of this.terminals.values()) {
      if (entry.removed || canvases.some(canvas => canvas.id === entry.canvasId
        && canvas.nodes.some(node => node.id === entry.nodeId && node.typeId === 'convax.terminal'))) continue
      entry.removed = true
      if (entry.id === undefined) continue
      const cleanup = entry.owner.close(entry.id).catch((error: unknown) => {
        this.ctx.logger.error('Canvas terminal cleanup failed', { canvasId: entry.canvasId, nodeId: entry.nodeId, error })
      }).finally(() => { this.closing.delete(cleanup) })
      this.closing.add(cleanup)
    }
  }
}
