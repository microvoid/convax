/** Local, canvas-owned working directories are retained independently of graph deletion. */
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-fs'
import type { CanvasDatabase } from './database.ts'
import type { CanvasRepository } from './repository.ts'
import type { CanvasCommandRequest, CanvasId } from './types.ts'

/** Persist one local working directory per canvas, including unused creation reservations. */
export class CanvasWorkingDirectories {
  /**
   * @param ctx - Owner context with the filesystem used by Chat Sessions.
   * @param database - Convax's serialized directory assignments.
   * @param repository - Current graph existence and operation receipts.
   * @param root - Absolute local parent for newly assigned directories.
   */
  constructor(private readonly ctx: Context, private readonly database: CanvasDatabase,
    private readonly repository: CanvasRepository, private readonly root: string) {}

  /**
   * Create a directory before publishing a new canvas; failed graph commands may retain an empty directory.
   * @param request - Graph command with its retry identity.
   * @param signal - Host/caller cancellation.
   * @returns Creation preparation, or undefined for other commands and committed retries.
   */
  prepare(request: CanvasCommandRequest, signal: AbortSignal): Promise<void> | undefined {
    if (this.repository.hasOperation(request.operationId)) return
    const command = request.command
    const canvasId = command.kind === 'duplicate' ? command.newCanvasId
      : command.kind === 'create' || (command.kind === 'batch' && command.ops.some(op => op.op === 'canvas.add')) ? request.canvasId : undefined
    return canvasId === undefined ? undefined : this.materialize(canvasId, signal).then(() => {})
  }

  /**
   * Return a usable directory for a current canvas, allocating older canvases lazily.
   * @param canvasId - Existing canvas identity; absent canvases cause no filesystem changes.
   * @param signal - Host/caller cancellation.
   * @returns Stable absolute working directory validated by the composed filesystem.
   */
  async ensure(canvasId: CanvasId, signal: AbortSignal): Promise<string> {
    this.requireCanvas(canvasId)
    const path = await this.materialize(canvasId, signal)
    this.requireCanvas(canvasId)
    return path
  }

  private requireCanvas(canvasId: CanvasId): void {
    if (!this.repository.snapshot().canvases.some(canvas => canvas.id === canvasId)) {
      throw new RemoteError('gateway/bad-request', 'Canvas no longer exists', {})
    }
  }

  private async materialize(canvasId: CanvasId, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    const assigned = await this.database.transaction((tx) => {
      const existing = tx.table('directories').get(canvasId)
      if (existing !== undefined) return existing.path
      const path = join(this.root, `canvas-${encodeURIComponent(canvasId)}`)
      tx.table('directories').put(canvasId, { path })
      return path
    }, { signal })
    try {
      signal.throwIfAborted()
      await mkdir(assigned, { recursive: true, mode: 0o700 })
      signal.throwIfAborted()
      const local = await realpath(assigned)
      const target = await this.ctx.fs.resolve(local, { signal })
      const info = await this.ctx.fs.stat(target, signal)
      if (info?.type !== 'directory') throw new Error('Configured filesystem cannot access the local canvas directory')
      const path = this.ctx.fs.processPath(target)
      await this.database.transaction((tx) => { tx.table('directories').put(canvasId, { path }) }, { signal })
      return path
    } catch (error) {
      signal.throwIfAborted()
      throw new RemoteError('canvas-directory/unavailable', 'The canvas working directory is unavailable; check its location and permissions, then retry', {}, { cause: error })
    }
  }
}
