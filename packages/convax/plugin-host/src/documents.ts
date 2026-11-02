/** Complete document reads through the composed filesystem and shared Office converter. */
import { basename, extname, isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { OfficeSourceKey, OfficeToPdfError, type OfficeExtension } from '@deepseek-ai/dsh-office-to-pdf'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import mime from 'mime'
import type { CanvasDocumentPreview } from './types.ts'

/**
 * Read one complete versioned document without creating or looking up a Session.
 * @param ctx - Host context owning filesystem policy and the optional Office converter.
 * @param path - Explicit absolute source path.
 * @param limit - Inclusive complete source and rendered-content byte cap.
 * @param scope - Host-owned source namespace, isolated from other execution scopes.
 * @param signal - Host and caller cancellation.
 * @param trackRead - Registers deferred filesystem reads under the Host lifetime, including shared conversions.
 * @returns Independent content bytes; changed sources and partial reads reject.
 */
export async function readCanvasDocument(
  ctx: Context, path: string, limit: number, scope: string, signal: AbortSignal,
  trackRead: (signal: AbortSignal, operation: (readSignal: AbortSignal) => Promise<Uint8Array>) => Promise<Uint8Array>,
): Promise<CanvasDocumentPreview> {
  if (!isAbsolute(path)) throw new RemoteError('gateway/bad-request', 'Resource path must be absolute', {})
  const fs = ctx.fs
  const target = await fs.resolve(path, { signal })
  const info = await fs.stat(target, signal)
  if (info?.type !== 'file') throw new RemoteError('gateway/bad-request', 'Resource is not a regular file', {})
  const source = { path: fs.processPath(target), name: basename(fs.processPath(target)), size: info.size ?? null, version: info.version }
  const tooLarge = (cap: number, cause?: unknown): RemoteError<'canvas-resource/too-large'> =>
    new RemoteError('canvas-resource/too-large', 'The document exceeds the complete-file byte cap', { path: source.path, limit: cap }, { cause })
  if (info.size !== undefined && info.size > limit) throw tooLarge(limit)
  const assertCurrent = async (readSignal: AbortSignal): Promise<void> => {
    const currentTarget = await fs.resolve(source.path, { signal: readSignal })
    const current = await fs.stat(currentTarget, readSignal)
    if (current?.type !== 'file' || current.version !== source.version || currentTarget.targetKey !== target.targetKey) {
      throw new RemoteError('canvas-resource/source-changed', 'The source changed while reading the document', { path: source.path })
    }
  }
  const read = (upstream: AbortSignal, cap: number): Promise<Uint8Array> => trackRead(upstream, async (readSignal) => {
    await assertCurrent(readSignal)
    const bytes = await fs.readBytes(target, readSignal, cap).catch((cause: unknown) => {
      if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'FS_TOO_LARGE') throw tooLarge(cap, cause)
      throw cause
    })
    readSignal.throwIfAborted()
    await assertCurrent(readSignal)
    return bytes
  })
  const extension = extname(source.name).slice(1).toLowerCase()
  if (!isOfficeExtension(extension)) {
    const bytes = await read(signal, limit)
    return { ...source, bytes: new Uint8Array(bytes), mimeType: mime.getType(source.name) ?? 'application/octet-stream' }
  }
  const converter = ctx.get('officeToPdf')
  if (converter === undefined) throw new RemoteError('document-render/failed', 'Office conversion is unavailable', { reason: 'unavailable' })
  await fs.readByteRange(target, { offset: 0, length: 1 }, signal)
  await assertCurrent(signal)
  try {
    const result = await converter.convert({ extension, priority: 'foreground', source: {
      key: OfficeSourceKey(JSON.stringify([scope, target.targetKey])), version: source.version,
      ...(info.size === undefined ? {} : { bytes: info.size }),
      read: async (upstream, maxBytes) => ({ bytes: await read(upstream, Math.min(limit, maxBytes)), version: source.version }),
    } }, signal)
    signal.throwIfAborted()
    await assertCurrent(signal)
    if (result.pdf.byteLength > limit) throw tooLarge(limit)
    return { ...source, bytes: new Uint8Array(result.pdf), mimeType: 'application/pdf',
      renderedAs: 'pdf', missingFonts: [...result.missingFonts] }
  } catch (cause) {
    if (signal.aborted) { signal.throwIfAborted() }
    if (cause instanceof OfficeToPdfError) {
      throw new RemoteError('document-render/failed', 'Office conversion failed', { reason: cause.code }, { cause })
    }
    throw cause
  }
}

function isOfficeExtension(extension: string): extension is OfficeExtension {
  return extension === 'doc' || extension === 'docx' || extension === 'ppt' || extension === 'pptx'
}
