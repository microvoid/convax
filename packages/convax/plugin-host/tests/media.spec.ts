/** Media responses stream bounded version-pinned reads without document caps or Session state. */
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FsError, FsTargetKey, FsVersion, type FileSystem } from '@deepseek-ai/dsh-fs'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { CanvasMediaResponses, readCanvasMediaSource } from '../src/media.ts'
import { Config } from '../src/index.ts'

async function resolveConfig(input: Partial<Config>): Promise<unknown> {
  const result = await Config['~standard'].validate({ databasePath: resolve('convax-config-test.sqlite'), ...input })
  if (result.issues !== undefined) throw new Error('Invalid media configuration')
  return result.value
}

function fixture(options: { size?: number | null; chunkBytes?: number; extension?: string } = {}) {
  const ctx = new Context()
  const path = resolve('media-fixture', `clip.${options.extension ?? 'mp4'}`)
  const content = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  const size = options.size === undefined ? content.length : options.size
  let version = FsVersion('one')
  let key = FsTargetKey(path)
  const target = () => ({ targetKey: key, displayPath: path })
  const fs: Pick<FileSystem, 'resolve' | 'stat' | 'processPath' | 'readByteRange' | 'readBytes'> = {
    resolve: vi.fn(async () => target()),
    stat: vi.fn(async () => ({ type: 'file' as const, version, ...(size === null ? {} : { size }) })),
    processPath: () => path,
    readByteRange: vi.fn<FileSystem['readByteRange']>(async (_target, range) => content.slice(range.offset, range.offset + range.length)),
    readBytes: vi.fn(async () => { throw new Error('Complete media reads are forbidden') }),
  }
  ctx.provide('fs', fs as never)
  const responses = new CanvasMediaResponses(ctx, options.chunkBytes ?? 4)
  onTestFinished(async () => { await responses.close(); await ctx.fiber.dispose() })
  const url = (sourcePath = path, sourceVersion = version) => {
    const url = new URL('http://127.0.0.1/api/convax/media')
    url.searchParams.set('path', sourcePath)
    url.searchParams.set('version', sourceVersion)
    return url
  }
  const call = (init?: RequestInit) => responses.fetch(new Request(url(), init))
  return { ctx, path, content, fs, responses, url, call,
    change: () => { version = FsVersion('two') },
    replace: () => { key = FsTargetKey('another-target') },
  }
}

describe('Convax media content', () => {
  it('authorizes metadata with one byte through fs without a complete content read or Session', async () => {
    const f = fixture({ extension: 'mp3' })
    const source = await readCanvasMediaSource(f.ctx, f.path, new AbortController().signal)
    expect(source).toEqual({ path: f.path, name: 'clip.mp3', version: 'one', size: 10, mimeType: 'audio/mpeg' })
    expect(f.fs.readByteRange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ displayPath: f.path }),
      { offset: 0, length: 1 }, expect.any(AbortSignal))
    expect(f.fs.readBytes).not.toHaveBeenCalled()
    expect(f.ctx.get('sessionController')).toBeUndefined()
  })

  it('requires absolute paths and regular files, propagating composed filesystem access failures', async () => {
    const f = fixture()
    await expect(readCanvasMediaSource(f.ctx, 'relative.mp4', new AbortController().signal))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
    vi.mocked(f.fs.stat).mockResolvedValueOnce({ type: 'directory', version: FsVersion('one') })
    await expect(readCanvasMediaSource(f.ctx, f.path, new AbortController().signal))
      .rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
    const denied = new FsError('Read denied', 'FS_PERMISSION_DENIED')
    vi.mocked(f.fs.readByteRange).mockRejectedValueOnce(denied)
    await expect(readCanvasMediaSource(f.ctx, f.path, new AbortController().signal)).rejects.toBe(denied)
  })

  it('rejects metadata that changes during the content-access probe', async () => {
    const f = fixture()
    vi.mocked(f.fs.readByteRange).mockImplementationOnce(async () => { f.change(); return new Uint8Array([0]) })
    await expect(readCanvasMediaSource(f.ctx, f.path, new AbortController().signal))
      .rejects.toMatchObject({ code: 'canvas-resource/source-changed' })
  })

  it('streams full content only as the response consumer pulls and bounds every read', async () => {
    const f = fixture()
    const response = await f.call()
    expect(response.status).toBe(200)
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(response.headers.get('content-length')).toBe('10')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(f.fs.readByteRange).toHaveBeenCalledTimes(1)
    const reader = response.body!.getReader()
    expect((await reader.read()).value).toEqual(new Uint8Array([0, 1, 2, 3]))
    expect(f.fs.readByteRange).toHaveBeenCalledTimes(2)
    expect((await reader.read()).value).toEqual(new Uint8Array([4, 5, 6, 7]))
    expect((await reader.read()).value).toEqual(new Uint8Array([8, 9]))
    expect((await reader.read()).done).toBe(true)
    expect(vi.mocked(f.fs.readByteRange).mock.calls.map(call => call[1].length)).toEqual([1, 4, 4, 2])
    expect(f.fs.readBytes).not.toHaveBeenCalled()
  })

  it.each([
    ['bytes=2-7', [2, 3, 4, 5, 6, 7], 'bytes 2-7/10'],
    ['bytes=7-', [7, 8, 9], 'bytes 7-9/10'],
    ['bytes=-3', [7, 8, 9], 'bytes 7-9/10'],
    ['bytes=8-100', [8, 9], 'bytes 8-9/10'],
    ['bytes=-100', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'bytes 0-9/10'],
  ])('serves the single range %s with exact inclusive boundaries', async (range, expected, contentRange) => {
    const f = fixture()
    const response = await f.call({ headers: { Range: range } })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe(contentRange)
    expect(response.headers.get('content-length')).toBe(String(expected.length))
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual(expected)
  })

  it.each(['bytes=10-', 'bytes=-0', 'bytes=7-2', 'bytes=-', 'bytes=abc', 'bytes=0-1,4-5', 'bytes=9007199254740992-'])
  ('answers an unsatisfiable or unsupported byte-range request with 416: %s', async (range) => {
    const f = fixture()
    const response = await f.call({ headers: { Range: range } })
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe('bytes */10')
    expect(f.fs.readByteRange).toHaveBeenCalledTimes(1)
    expect(await response.text()).not.toContain(f.path)
  })

  it('ignores an unknown range unit and evaluates If-Range using the source ETag', async () => {
    const f = fixture()
    const head = await f.call({ method: 'HEAD', headers: { Range: 'bytes=2-4' } })
    expect(head.status).toBe(200)
    expect(head.body).toBeNull()
    expect(head.headers.get('content-length')).toBe('10')
    expect(head.headers.get('content-range')).toBeNull()
    const etag = head.headers.get('etag')!
    const same = await f.call({ headers: { Range: 'bytes=2-4', 'If-Range': etag } })
    expect(same.status).toBe(206)
    expect([...new Uint8Array(await same.arrayBuffer())]).toEqual([2, 3, 4])
    for (const headers of [{ Range: 'items=0-1' }, { Range: 'bytes=invalid', 'If-Range': '"old"' },
      { Range: 'bytes=2-4', 'If-Range': 'Wed, 21 Oct 2015 07:28:00 GMT' }]) {
      const response = await f.call({ headers })
      expect(response.status).toBe(200)
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(f.content)
    }
  })

  it('reads a small range of a file larger than the document cap without reading its prefix', async () => {
    const size = 5 * 1024 * 1024 * 1024
    const f = fixture({ size })
    vi.mocked(f.fs.readByteRange).mockImplementation(async (_target, range) => new Uint8Array(range.length))
    const response = await f.call({ headers: { Range: `bytes=${size - 3}-` } })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe(`bytes ${size - 3}-${size - 1}/${size}`)
    expect(new Uint8Array(await response.arrayBuffer())).toHaveLength(3)
    expect(vi.mocked(f.fs.readByteRange).mock.calls.map(call => call[1])).toEqual([
      { offset: 0, length: 1 }, { offset: size - 3, length: 3 },
    ])
  })

  it('streams size-unknown files sequentially without claiming range support or a length', async () => {
    const f = fixture({ size: null })
    const source = await readCanvasMediaSource(f.ctx, f.path, new AbortController().signal)
    expect(source.size).toBeNull()
    const response = await f.call({ headers: { Range: 'bytes=4-7' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('accept-ranges')).toBe('none')
    expect(response.headers.get('content-length')).toBeNull()
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(f.content)
  })

  it('serves empty files and rejects a range over an empty representation', async () => {
    const f = fixture({ size: 0 })
    vi.mocked(f.fs.readByteRange).mockResolvedValue(new Uint8Array())
    expect(new Uint8Array(await (await f.call()).arrayBuffer())).toHaveLength(0)
    const response = await f.call({ headers: { Range: 'bytes=0-' } })
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe('bytes */0')
  })

  it('refuses a stale URL and a changed resolved target instead of redirecting to new content', async () => {
    const f = fixture()
    const request = new Request(f.url())
    f.change()
    expect((await f.responses.fetch(request)).status).toBe(409)
    const response = await f.call()
    f.replace()
    await expect(response.arrayBuffer()).rejects.toMatchObject({ code: 'canvas-resource/source-changed' })
  })

  it('detects version changes and short reads before enqueueing a mixed-version chunk', async () => {
    const f = fixture()
    const response = await f.call()
    vi.mocked(f.fs.readByteRange).mockImplementationOnce(async () => { f.change(); return new Uint8Array([1, 2, 3, 4]) })
    await expect(response.arrayBuffer()).rejects.toMatchObject({ code: 'canvas-resource/source-changed' })
    const short = await f.call()
    vi.mocked(f.fs.readByteRange).mockResolvedValueOnce(new Uint8Array([1]))
    await expect(short.arrayBuffer()).rejects.toMatchObject({ code: 'canvas-resource/source-changed' })
  })

  it.each([
    ['FS_NOT_FOUND', 404], ['FS_NOT_REGULAR_FILE', 403], ['FS_PERMISSION_DENIED', 403],
    ['FS_SANDBOX_DENIED', 403], ['FS_TOO_LARGE', 413], ['FS_ABORTED', 499], ['FS_IO_ERROR', 500],
  ] as const)('maps %s to a path-free HTTP %s response', async (code, status) => {
    const f = fixture()
    vi.mocked(f.fs.resolve).mockRejectedValueOnce(new FsError(`Secret path ${f.path}`, code))
    const response = await f.call()
    expect(response.status).toBe(status)
    expect(await response.text()).toBe('Media is unavailable')
  })

  it('validates query fields and method without file access and honors pre-aborted requests', async () => {
    const f = fixture()
    for (const query of ['', '?path=relative.mp4&version=one', '?path=%00&version=one', '?path=a&path=b&version=one', '?path=a&version=']) {
      const response = await f.responses.fetch(new Request(`http://127.0.0.1/api/convax/media${query}`))
      expect(response.status).toBe(400)
    }
    const method = await f.call({ method: 'POST' })
    expect(method.status).toBe(405)
    expect(method.headers.get('allow')).toBe('GET, HEAD')
    expect((await f.call({ signal: AbortSignal.abort() })).status).toBe(499)
    expect(f.fs.resolve).not.toHaveBeenCalled()
  })

  it('cancels an idle response on request abort and stops new requests on owner close', async () => {
    const f = fixture()
    const abort = new AbortController()
    const response = await f.call({ signal: abort.signal })
    abort.abort()
    await expect(response.arrayBuffer()).rejects.toMatchObject({ name: 'AbortError' })
    await f.responses.close()
    expect((await f.call()).status).toBe(503)
    expect(f.fs.readByteRange).toHaveBeenCalledTimes(1)
  })

  it('drains a real pending range read after abort before owner close resolves', async () => {
    const f = fixture()
    const response = await f.call()
    const entered = Promise.withResolvers<undefined>(), read = Promise.withResolvers<Uint8Array>()
    vi.mocked(f.fs.readByteRange).mockImplementationOnce((_target, _range, signal) => {
      expect(signal).toBeDefined()
      entered.resolve(undefined)
      return read.promise
    })
    const consuming = response.arrayBuffer()
    const failed = expect(consuming).rejects.toMatchObject({ name: 'AbortError' })
    await entered.promise
    let closed = false
    const closing = f.responses.close().then(() => { closed = true })
    await failed
    expect(closed).toBe(false)
    read.resolve(new Uint8Array([0, 1, 2, 3]))
    await closing
    expect(closed).toBe(true)
    expect(f.fs.readByteRange).toHaveBeenCalledTimes(2)
  })

  it('cancels and drains only the response being cancelled, without waiting for another player', async () => {
    const f = fixture()
    const first = await f.call(), second = await f.call()
    const entered = Promise.withResolvers<undefined>(), read = Promise.withResolvers<Uint8Array>()
    vi.mocked(f.fs.readByteRange).mockImplementationOnce(() => { entered.resolve(undefined); return read.promise })
    const reader = first.body!.getReader()
    const reading = reader.read()
    const failed = expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    await entered.promise
    await second.body!.cancel()
    const closing = f.responses.close()
    await failed
    read.resolve(new Uint8Array([0, 1, 2, 3]))
    await closing
  })

  it('defaults a configurable bounded media chunk without applying the complete document limit', async () => {
    expect(await resolveConfig({})).toMatchObject({ mediaChunkBytes: 256 * 1024, documentBytes: 50 * 1024 * 1024 })
    await expect(resolveConfig({ mediaChunkBytes: 0 })).rejects.toThrow()
    await expect(resolveConfig({ mediaChunkBytes: 1.5 })).rejects.toThrow()
  })
})
