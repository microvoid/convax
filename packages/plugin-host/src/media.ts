/** Version-pinned media responses through the composed filesystem and authenticated Connection routes. */
import { basename, isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { FsError, type FileSystem, type FsTarget } from '@deepseek-ai/dsh-fs'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import mime from 'mime'
import type { CanvasMediaSource } from './types.ts'

interface LocatedMedia {
  readonly source: CanvasMediaSource
  readonly target: FsTarget
}

interface ByteWindow {
  readonly offset: number
  readonly length: number
}

interface MediaResponseLease {
  stop(reason: unknown): void
}

class MediaHttpFailure extends Error {
  constructor(readonly status: number, readonly size?: number) { super('Media request failed') }
}

const BASE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "sandbox; default-src 'none'",
}

function changed(path: string): RemoteError<'canvas-resource/source-changed'> {
  return new RemoteError('canvas-resource/source-changed', 'The media source changed', { path })
}

async function current(fs: FileSystem, located: LocatedMedia, signal: AbortSignal): Promise<void> {
  const target = await fs.resolve(located.source.path, { signal })
  const info = await fs.stat(target, signal)
  signal.throwIfAborted()
  if (target.targetKey !== located.target.targetKey || info?.type !== 'file' || info.version !== located.source.version
    || (info.size ?? null) !== located.source.size) throw changed(located.source.path)
}

async function locate(fs: FileSystem, path: string, signal: AbortSignal): Promise<LocatedMedia> {
  if (!isAbsolute(path) || path.includes('\0')) throw new MediaHttpFailure(400)
  const target = await fs.resolve(path, { signal })
  const info = await fs.stat(target, signal)
  if (info === undefined) throw new FsError('Media source is unavailable', 'FS_NOT_FOUND')
  if (info.type !== 'file') throw new FsError('Media source is not a regular file', 'FS_NOT_REGULAR_FILE')
  const processPath = fs.processPath(target)
  const source: CanvasMediaSource = {
    path: processPath, name: basename(processPath), size: info.size ?? null, version: info.version,
    mimeType: mime.getType(processPath) ?? 'application/octet-stream',
  }
  // Metadata alone does not establish content-read access, including for HEAD and empty files.
  await fs.readByteRange(target, { offset: 0, length: 1 }, signal)
  signal.throwIfAborted()
  const located = { target, source }
  await current(fs, located, signal)
  return located
}

/**
 * Authorize a complete-file media URL without reading complete content or creating a Session.
 * @param ctx - Context owning the composed filesystem policy.
 * @param path - Absolute source path.
 * @param signal - Caller and Host lifetime.
 * @returns Metadata for constructing the version-pinned media route URL.
 */
export async function readCanvasMediaSource(ctx: Context, path: string, signal: AbortSignal): Promise<CanvasMediaSource> {
  try { return (await locate(ctx.fs, path, signal)).source }
  catch (error) {
    if (error instanceof MediaHttpFailure) throw new RemoteError('gateway/bad-request', 'An absolute media path is required', {})
    throw error
  }
}

function byteWindow(value: string | null, size: number): ByteWindow | undefined {
  if (value === null || !value.startsWith('bytes=')) return undefined
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value)
  if (match === null || (match[1] === '' && match[2] === '') || size === 0) throw new MediaHttpFailure(416, size)
  const first = match[1] === '' ? undefined : Number(match[1])
  const last = match[2] === '' ? undefined : Number(match[2])
  if ((first !== undefined && !Number.isSafeInteger(first)) || (last !== undefined && !Number.isSafeInteger(last))) {
    throw new MediaHttpFailure(416, size)
  }
  if (first === undefined) {
    if (last === undefined || last === 0) throw new MediaHttpFailure(416, size)
    const offset = Math.max(0, size - last)
    return { offset, length: size - offset }
  }
  if (first >= size || (last !== undefined && last < first)) throw new MediaHttpFailure(416, size)
  return { offset: first, length: Math.min(size - 1, last ?? size - 1) - first + 1 }
}

function failureStatus(error: unknown): number {
  if (error instanceof MediaHttpFailure) return error.status
  if (error instanceof RemoteError && error.code === 'canvas-resource/source-changed') return 409
  if (error instanceof FsError) {
    const statuses: Partial<Record<FsError['code'], number>> = {
      FS_NOT_FOUND: 404, FS_NOT_REGULAR_FILE: 403, FS_PERMISSION_DENIED: 403, FS_SANDBOX_DENIED: 403,
      FS_TOO_LARGE: 413, FS_ABORTED: 499,
    }
    return statuses[error.code] ?? 500
  }
  return error instanceof Error && error.name === 'AbortError' ? 499 : 500
}

/** Owns streaming response bodies independently from request-header completion. */
export class CanvasMediaResponses {
  private readonly lifetime = new AbortController()
  private readonly requests = new Set<MediaResponseLease>()
  private readonly reads = new Set<Promise<unknown>>()
  private closing: Promise<void> | undefined

  /** @param ctx - Filesystem provider retained through response cleanup. @param chunkBytes - Per-pull byte bound. */
  constructor(private readonly ctx: Context, private readonly chunkBytes: number) {}

  /**
   * Serve an authenticated version-pinned request with bounded reads and response backpressure.
   * @param request - Connection-admitted GET or HEAD request.
   * @returns A media stream, metadata response, or path-free HTTP failure.
   */
  async fetch(request: Request): Promise<Response> {
    const controller = new AbortController()
    const signal = AbortSignal.any([request.signal, this.lifetime.signal, controller.signal])
    const pendingReads = new Set<Promise<unknown>>()
    let body: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>> | undefined
    let finished = false
    const release = (): void => {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', aborted)
      this.requests.delete(lease)
    }
    const lease: MediaResponseLease = {
      stop: (reason) => {
        if (finished) return
        release()
        body?.error(reason)
        controller.abort(reason)
      },
    }
    const aborted = (): void => { lease.stop(signal.reason) }
    this.requests.add(lease)
    signal.addEventListener('abort', aborted, { once: true })
    try {
      return await this.read(signal, async () => {
        if (request.method !== 'GET' && request.method !== 'HEAD') throw new MediaHttpFailure(405)
        const params = new URL(request.url).searchParams
        const path = params.get('path'), version = params.get('version')
        if (params.getAll('path').length !== 1 || params.getAll('version').length !== 1
          || path === null || version === null || version === '') throw new MediaHttpFailure(400)
        const located = await locate(this.ctx.fs, path, signal)
        const size = located.source.size
        if (version !== located.source.version) throw changed(located.source.path)
        const etag = `"${Buffer.from(version).toString('base64url')}"`
        const ifRange = request.headers.get('if-range')
        let window: ByteWindow | undefined
        if (request.method === 'GET' && size !== null && (ifRange === null || ifRange === etag)) {
          window = byteWindow(request.headers.get('range')?.trim() ?? null, size)
        }
        const headers: Record<string, string> = {
          ...BASE_HEADERS, 'Content-Type': located.source.mimeType, ETag: etag,
          'Accept-Ranges': size === null ? 'none' : 'bytes',
        }
        if (size !== null) headers['Content-Length'] = String(window?.length ?? size)
        if (window !== undefined) headers['Content-Range'] = `bytes ${window.offset}-${window.offset + window.length - 1}/${size}`
        if (request.method === 'HEAD') { release(); return new Response(null, { headers }) }
        const start = window?.offset ?? 0
        const end = window === undefined ? size : start + window.length
        let offset = start
        const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
          start: (value) => { body = value },
          pull: async (output) => {
            try {
              signal.throwIfAborted()
              if (end !== null && offset === end) { release(); output.close(); return }
              const length = Math.min(this.chunkBytes, end === null ? this.chunkBytes : end - offset)
              const bytes = await this.read(signal, async () => {
                await current(this.ctx.fs, located, signal)
                const value = await this.ctx.fs.readByteRange(located.target, { offset, length }, signal)
                signal.throwIfAborted()
                await current(this.ctx.fs, located, signal)
                if (end !== null && value.byteLength !== length) throw changed(located.source.path)
                return value
              }, pendingReads)
              signal.throwIfAborted()
              if (bytes.byteLength > 0) { offset += bytes.byteLength; output.enqueue(new Uint8Array(bytes)) }
              if ((end !== null && offset === end) || bytes.byteLength < length) { release(); output.close() }
            } catch (error) { lease.stop(error) }
          },
          cancel: (reason: unknown) => { lease.stop(reason); return Promise.allSettled([...pendingReads]).then(() => {}) },
        }, { highWaterMark: 0 })
        signal.throwIfAborted()
        return new Response(stream, { status: window === undefined ? 200 : 206, headers })
      }, pendingReads)
    } catch (error) {
      release()
      const status = this.lifetime.signal.aborted ? 503 : failureStatus(error)
      const headers: Record<string, string> = { ...BASE_HEADERS }
      if (error instanceof MediaHttpFailure && error.status === 416 && error.size !== undefined) {
        headers['Content-Range'] = `bytes */${error.size}`
      }
      if (status === 405) headers.Allow = 'GET, HEAD'
      return new Response(request.method === 'HEAD' ? null : 'Media is unavailable', { status, headers })
    }
  }

  /** Stop response admission, cancel every body, and drain the actual filesystem operations. @returns Quiescent cleanup. */
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.lifetime.abort()
      for (const request of this.requests) request.stop(this.lifetime.signal.reason)
      await Promise.allSettled([...this.reads])
    })()
  }

  private read<T>(signal: AbortSignal, operation: () => Promise<T>, owner: Set<Promise<unknown>>): Promise<T> {
    const pending = Promise.resolve().then(() => { signal.throwIfAborted(); return operation() })
      .then((value) => { signal.throwIfAborted(); return value })
    this.reads.add(pending)
    owner.add(pending)
    const release = (): void => { this.reads.delete(pending); owner.delete(pending) }
    void pending.then(release, release)
    return pending
  }
}
