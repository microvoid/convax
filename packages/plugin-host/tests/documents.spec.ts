/** Complete document reads preserve binary data and share bounded Office conversion. */
import { Context } from '@deepseek-ai/cordis'
import { FsError, FsTargetKey, FsVersion, type FileSystem } from '@deepseek-ai/dsh-fs'
import { OfficeToPdfError, OfficeToPdfGeneration, OfficeToPdfKey, type OfficeToPdfRequest, type OfficeToPdfResult } from '@deepseek-ai/dsh-office-to-pdf'
import { describe, expect, it, vi } from 'vitest'
import { readCanvasDocument } from '../src/documents.ts'

function fixture(path = '/project/image.png', size: number | null = 3) {
  const ctx = new Context()
  const target = { targetKey: FsTargetKey(path), displayPath: path }
  const bytes = new Uint8Array([0, 255, 128])
  let version = FsVersion('one')
  const fs: Pick<FileSystem, 'resolve' | 'stat' | 'processPath' | 'readBytes' | 'readByteRange'> = {
    resolve: vi.fn(() => Promise.resolve(target)), processPath: () => path,
    stat: vi.fn(() => Promise.resolve({ type: 'file' as const, version, ...(size === null ? {} : { size }) })),
    readBytes: vi.fn(() => Promise.resolve(bytes)),
    readByteRange: vi.fn(() => Promise.resolve(bytes.slice(0, 1))),
  }
  ctx.provide('fs', fs as never)
  const read = (limit = 10, signal = new AbortController().signal) =>
    readCanvasDocument(ctx, path, limit, 'host-scope', signal, (upstream, operation) => operation(upstream))
  const result: OfficeToPdfResult = { pdf: new Uint8Array([37, 80, 68, 70]), missingFonts: ['Missing font'],
    generation: OfficeToPdfGeneration('converter-one'), cacheKey: OfficeToPdfKey('document-one') }
  const converter = (convert: (request: OfficeToPdfRequest, signal?: AbortSignal) => Promise<OfficeToPdfResult>) => {
    ctx.provide('officeToPdf', { convert } as never)
  }
  return { ctx, fs, target, bytes, read, result, converter, change: () => { version = FsVersion('two') } }
}

describe('Canvas document content', () => {
  it('returns complete binary bytes, source metadata, and an independently transferable buffer', async () => {
    const f = fixture()
    const first = await f.read()
    expect(first).toEqual({ path: '/project/image.png', name: 'image.png', size: 3, version: 'one',
      bytes: f.bytes, mimeType: 'image/png' })
    expect(f.fs.readBytes).toHaveBeenCalledWith(f.target, expect.any(AbortSignal), 10)
    structuredClone(first.bytes, { transfer: [first.bytes.buffer] })
    expect(first.bytes.byteLength).toBe(0)
    expect((await f.read()).bytes).toEqual(new Uint8Array([0, 255, 128]))
    expect(f.bytes.byteLength).toBe(3)
  })

  it('does not invent a source size or media type when the filesystem and extension provide none', async () => {
    const f = fixture('/project/content.unknown', null)
    expect(await f.read()).toMatchObject({ size: null, mimeType: 'application/octet-stream', version: 'one' })
  })

  it('rejects a known oversized source before loading it and maps bounded-read overflow', async () => {
    const f = fixture()
    await expect(f.read(2)).rejects.toMatchObject({ code: 'canvas-resource/too-large', details: { path: '/project/image.png', limit: 2 } })
    expect(f.fs.readBytes).not.toHaveBeenCalled()
    vi.mocked(f.fs.readBytes).mockRejectedValueOnce(new FsError('File grew', 'FS_TOO_LARGE'))
    await expect(f.read()).rejects.toMatchObject({ code: 'canvas-resource/too-large', details: { limit: 10 } })
  })

  it('rejects a source changed during the read instead of pairing new bytes with an old version', async () => {
    const f = fixture()
    vi.mocked(f.fs.readBytes).mockImplementationOnce(() => { f.change(); return Promise.resolve(f.bytes) })
    await expect(f.read()).rejects.toMatchObject({ code: 'canvas-resource/source-changed' })
  })

  it('requires a regular absolute file and retains filesystem access failures', async () => {
    const f = fixture('relative.txt')
    await expect(f.read()).rejects.toMatchObject({ code: 'gateway/bad-request' })
    const directory = fixture('/project')
    vi.mocked(directory.fs.stat).mockResolvedValueOnce({ type: 'directory', version: FsVersion('one') })
    await expect(directory.read()).rejects.toMatchObject({ code: 'gateway/bad-request' })
    const denied = fixture()
    const error = new FsError('Denied', 'FS_PERMISSION_DENIED')
    vi.mocked(denied.fs.resolve).mockRejectedValueOnce(error)
    await expect(denied.read()).rejects.toBe(error)
  })

  it('defers Office bytes until shared converter admission and preserves original source identity', async () => {
    const f = fixture('/project/report.DOCX')
    const convert = vi.fn(async (request: OfficeToPdfRequest, signal?: AbortSignal) => {
      expect(f.fs.readBytes).not.toHaveBeenCalled()
      expect(request).toMatchObject({ extension: 'docx', priority: 'foreground', source: { version: 'one', bytes: 3 } })
      expect(request.source.key).toBe(JSON.stringify(['host-scope', f.target.targetKey]))
      const input = await request.source.read(signal!, 5)
      expect(input).toEqual({ version: 'one', bytes: f.bytes })
      return f.result
    })
    f.converter(convert)
    const preview = await f.read()
    expect(f.fs.readBytes).toHaveBeenCalledWith(f.target, expect.any(AbortSignal), 5)
    expect(preview).toEqual({ path: '/project/report.DOCX', name: 'report.DOCX', size: 3, version: 'one',
      bytes: f.result.pdf, mimeType: 'application/pdf', renderedAs: 'pdf', missingFonts: ['Missing font'] })
    preview.missingFonts?.push('Other font')
    structuredClone(preview.bytes, { transfer: [preview.bytes.buffer] })
    expect(f.result.pdf.byteLength).toBe(4)
    expect(f.result.missingFonts).toEqual(['Missing font'])
    expect(convert).toHaveBeenCalledOnce()
  })

  it('keeps the Canvas byte cap during deferred Office reads and rejects oversized rendered output', async () => {
    const f = fixture('/project/slides.pptx')
    f.converter(async (request, signal) => {
      await request.source.read(signal!, 100)
      return f.result
    })
    await f.read(4)
    expect(f.fs.readBytes).toHaveBeenCalledWith(f.target, expect.any(AbortSignal), 4)
    await expect(f.read(3)).rejects.toMatchObject({ code: 'canvas-resource/too-large', details: { limit: 3 } })
  })

  it('rejects a converted or cached PDF when its source changed before delivery', async () => {
    const f = fixture('/project/report.doc')
    f.converter(() => { f.change(); return Promise.resolve(f.result) })
    await expect(f.read()).rejects.toMatchObject({ code: 'canvas-resource/source-changed' })
    expect(f.fs.readBytes).not.toHaveBeenCalled()
  })

  it('checks filesystem content access before returning a converter cache hit', async () => {
    const f = fixture('/project/report.docx')
    const convert = vi.fn(() => Promise.resolve(f.result))
    f.converter(convert)
    const denied = new FsError('Read denied', 'FS_PERMISSION_DENIED')
    vi.mocked(f.fs.readByteRange).mockRejectedValueOnce(denied)
    await expect(f.read()).rejects.toBe(denied)
    expect(convert).not.toHaveBeenCalled()
    expect(f.fs.readBytes).not.toHaveBeenCalled()
  })

  it.each(['xls', 'xlsx'])('returns original %s bytes for the browser spreadsheet renderer', async (extension) => {
    const f = fixture(`/project/sheet.${extension}`)
    const convert = vi.fn(() => Promise.resolve(f.result))
    f.converter(convert)
    const result = await f.read()
    expect(result.bytes).toEqual(f.bytes)
    expect(result.renderedAs).toBeUndefined()
    expect(result.mimeType).not.toBe('application/pdf')
    expect(convert).not.toHaveBeenCalled()
    expect(f.fs.readByteRange).not.toHaveBeenCalled()
  })

  it('reports missing and classified Office failures while preserving caller cancellation', async () => {
    const f = fixture('/project/report.docx')
    await expect(f.read()).rejects.toMatchObject({ code: 'document-render/failed', details: { reason: 'unavailable' } })
    f.converter(() => Promise.reject(new OfficeToPdfError('busy', 'Converter capacity')))
    await expect(f.read()).rejects.toMatchObject({ code: 'document-render/failed', details: { reason: 'busy' } })
    const controller = new AbortController()
    const cancelled = fixture('/project/report.docx')
    cancelled.converter(() => { controller.abort(); return Promise.reject(new OfficeToPdfError('failed', 'Stopped converter')) })
    await expect(cancelled.read(10, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
