// @vitest-environment jsdom
/** Capture ownership stays independent of view lifetime, graph copies, and mutable drafts. */
import { randomUUID } from 'node:crypto'
import type { DesktopCaptureLeaseId, DesktopWindowCapture, DesktopWindowSourceId } from '@deepseek-ai/dsh-util-desktop-capture'
import type { CanvasNode, CanvasNodeId, CanvasNodeTypeId, CanvasWindowBindingId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { CanvasWindowMirrors, type WindowMirrorPlatform } from '../src/client/window-mirrors.ts'

class TestTrack extends EventTarget {
  readyState: MediaStreamTrackState = 'live'
  readonly stop = vi.fn(() => { this.readyState = 'ended' })
}

const NODE = 'window-node' as CanvasNodeId
const SOURCE = 'window:101:0' as DesktopWindowSourceId
const BINDING = '53fa415e-0bf2-4d9c-8e93-c91a544bb89c' as CanvasWindowBindingId

function fixture() {
  const tracks: TestTrack[] = []
  const bridge: DesktopWindowCapture = {
    list: vi.fn(async () => [{ id: SOURCE, name: 'Test window' }]),
    prepare: vi.fn<DesktopWindowCapture['prepare']>(async sourceId => ({ id: randomUUID() as DesktopCaptureLeaseId,
      source: { id: sourceId, name: 'Test window' } })),
    validate: vi.fn(async () => true), release: vi.fn(async () => {}),
  }
  const platform: WindowMirrorPlatform = {
    acquire: vi.fn(async () => {
      const track = new TestTrack()
      tracks.push(track)
      const nativeTrack: Pick<MediaStreamTrack, 'readyState' | 'stop' | 'addEventListener' | 'removeEventListener'> = track
      return { getTracks: () => [nativeTrack as MediaStreamTrack], getVideoTracks: () => [nativeTrack as MediaStreamTrack] } as MediaStream
    }),
    image: vi.fn(async () => ({ data: 'ZnJlc2g=', width: 320, height: 180 })),
  }
  const failures = vi.fn()
  const mirrors = new CanvasWindowMirrors(bridge, platform, failures)
  onTestFinished(async () => { await mirrors.dispose() })
  return { mirrors, bridge, platform, tracks, failures }
}

function node(id = NODE, bindingId = BINDING): CanvasNode {
  return { id, typeId: 'convax.window' as CanvasNodeTypeId, dataVersion: 1, data: { bindingId, name: 'Test window' }, position: { x: 0, y: 0 }, revision: 0 }
}

function disconnect(track: TestTrack): void {
  track.readyState = 'ended'
  track.dispatchEvent(new Event('ended'))
}

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren() })

it('takes a fresh immutable image per attempt and verifies the exact native source twice', async () => {
  const b = fixture()
  await b.mirrors.bind(NODE, BINDING, SOURCE)
  b.mirrors.reconcile([node()])
  vi.mocked(b.bridge.validate).mockClear()
  const first = await b.mirrors.prepare({ nodeId: NODE, bindingId: BINDING }, new AbortController().signal)
  vi.mocked(b.platform.image).mockResolvedValueOnce({ data: 'bmV3', width: 640, height: 360 })
  const second = await b.mirrors.prepare({ nodeId: NODE, bindingId: BINDING }, new AbortController().signal)
  expect(first.attachments[0]).toMatchObject({ type: 'image', mediaType: 'image/png', data: 'ZnJlc2g=' })
  expect(second.attachments[0]?.data).toBe('bmV3')
  expect(first.text).toContain('320 × 180')
  expect(second.text).toContain('640 × 360')
  expect(b.bridge.validate).toHaveBeenCalledTimes(4)
  expect(b.platform.image).toHaveBeenCalledTimes(2)
})

it('keeps capture alive when a mirror view unmounts, and does not lend its binding to a copy', async () => {
  const b = fixture()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  await b.mirrors.bind(NODE, BINDING, SOURCE)
  const viewport = document.createElement('div')
  viewport.id = 'window-view'
  document.body.append(viewport)
  const release = b.mirrors.mount(NODE, BINDING, viewport.id)
  expect(viewport.querySelector('video')).not.toBeNull()
  release()
  expect(viewport.children).toHaveLength(0)
  expect(b.tracks[0]?.stop).not.toHaveBeenCalled()
  await expect(b.mirrors.prepare({ nodeId: NODE, bindingId: BINDING }, new AbortController().signal)).resolves.toHaveProperty('attachments')
  await expect(b.mirrors.prepare({ nodeId: 'copy' as CanvasNodeId, bindingId: BINDING }, new AbortController().signal)).rejects.toThrow('disconnected')
})

it('releases a removed or rebound node and never automatically reacquires its source', async () => {
  const b = fixture()
  await b.mirrors.bind(NODE, BINDING, SOURCE)
  b.mirrors.reconcile([node()])
  b.mirrors.reconcile([node(NODE, randomUUID() as CanvasWindowBindingId)])
  expect(b.tracks[0]?.stop).toHaveBeenCalledOnce()
  await vi.waitFor(() => { expect(b.bridge.release).toHaveBeenCalledOnce() })
  await expect(b.mirrors.prepare({ nodeId: NODE, bindingId: BINDING }, new AbortController().signal)).rejects.toThrow('disconnected')
  b.mirrors.reconcile([node()])
  expect(b.platform.acquire).toHaveBeenCalledOnce()
})

it('rejects a minimized source even when Chromium keeps its video track live, and releases its capture', async () => {
  const b = fixture()
  await b.mirrors.bind(NODE, BINDING, SOURCE)
  vi.mocked(b.bridge.validate).mockResolvedValue(false)
  await expect(b.mirrors.prepare({ nodeId: NODE, bindingId: BINDING }, new AbortController().signal)).rejects.toThrow('unavailable')
  expect(b.platform.image).not.toHaveBeenCalled()
  expect(b.tracks[0]?.stop).toHaveBeenCalledOnce()
  expect(b.mirrors.getSnapshot()[BINDING]?.status).toBe('disconnected')
  expect(b.bridge.release).toHaveBeenCalledOnce()
})

it('discards a captured image if the source closes or is rebound before preparation settles', async () => {
  const b = fixture()
  await b.mirrors.bind(NODE, BINDING, SOURCE)
  const image = Promise.withResolvers<{ data: string; width: number; height: number }>()
  vi.mocked(b.platform.image).mockReturnValueOnce(image.promise)
  const capture = b.mirrors.prepare({ nodeId: NODE, bindingId: BINDING }, new AbortController().signal)
  const rejected = expect(capture).rejects.toThrow()
  await vi.waitFor(() => { expect(b.platform.image).toHaveBeenCalledOnce() })
  await b.mirrors.release(BINDING)
  image.resolve({ data: 'late', width: 100, height: 100 })
  await rejected
})

it('honors submit cancellation without consuming the capture or admitting a late image', async () => {
  const b = fixture()
  await b.mirrors.bind(NODE, BINDING, SOURCE)
  const image = Promise.withResolvers<{ data: string; width: number; height: number }>()
  vi.mocked(b.platform.image).mockReturnValueOnce(image.promise)
  const signal = new AbortController()
  const capture = b.mirrors.prepare({ nodeId: NODE, bindingId: BINDING }, signal.signal)
  const rejected = expect(capture).rejects.toThrow()
  await vi.waitFor(() => { expect(b.platform.image).toHaveBeenCalledOnce() })
  signal.abort()
  image.resolve({ data: 'late', width: 100, height: 100 })
  await rejected
  expect(b.tracks[0]?.stop).not.toHaveBeenCalled()
})

it('serializes prepare/getDisplayMedia pairs so concurrent nodes cannot receive each other’s source', async () => {
  const b = fixture()
  const firstStream = Promise.withResolvers<MediaStream>()
  const acquire = vi.mocked(b.platform.acquire).getMockImplementation()!
  vi.mocked(b.platform.acquire).mockImplementationOnce(() => firstStream.promise)
  const first = b.mirrors.bind(NODE, BINDING, SOURCE)
  const second = b.mirrors.bind('second' as CanvasNodeId, randomUUID() as CanvasWindowBindingId, 'window:102:0' as DesktopWindowSourceId)
  await vi.waitFor(() => { expect(b.platform.acquire).toHaveBeenCalledOnce() })
  expect(b.bridge.prepare).toHaveBeenCalledTimes(1)
  firstStream.resolve(await acquire())
  await first
  await second
  expect(b.bridge.prepare).toHaveBeenNthCalledWith(2, 'window:102:0')
})

it('drains an in-flight acquisition on disposal and immediately stops a late stream', async () => {
  const b = fixture()
  const stream = Promise.withResolvers<MediaStream>()
  const acquire = vi.mocked(b.platform.acquire).getMockImplementation()!
  vi.mocked(b.platform.acquire).mockReturnValueOnce(stream.promise)
  const binding = b.mirrors.bind(NODE, BINDING, SOURCE)
  const rejected = expect(binding).rejects.toThrow()
  await vi.waitFor(() => { expect(b.platform.acquire).toHaveBeenCalledOnce() })
  const closing = b.mirrors.dispose()
  stream.resolve(await acquire())
  await rejected
  await closing
  expect(b.tracks[0]?.stop).toHaveBeenCalledOnce()
  expect(b.bridge.release).toHaveBeenCalledOnce()
  expect(b.mirrors.getSnapshot()).toEqual({})
})

it('stops native frame capture before draining its consumer, then releases the lease', async () => {
  const b = fixture()
  await b.mirrors.bind(NODE, BINDING, SOURCE)
  const image = Promise.withResolvers<{ data: string; width: number; height: number }>()
  vi.mocked(b.platform.image).mockReturnValueOnce(image.promise)
  const captured = b.mirrors.prepare({ nodeId: NODE, bindingId: BINDING }, new AbortController().signal)
  const rejected = expect(captured).rejects.toThrow()
  await vi.waitFor(() => { expect(b.platform.image).toHaveBeenCalledOnce() })
  const stop = b.tracks[0]!.stop.getMockImplementation()!
  b.tracks[0]!.stop.mockImplementation(() => { stop(); image.reject(new Error('Native capture stopped')) })
  const closing = b.mirrors.dispose()
  expect(b.tracks[0]?.stop).toHaveBeenCalledOnce()
  expect(b.bridge.release).not.toHaveBeenCalled()
  await rejected
  await closing
  expect(b.bridge.release).toHaveBeenCalledOnce()
})

it('reconnects the same occurrence and lets its existing draft reference capture a fresh image', async () => {
  const b = fixture()
  await b.mirrors.bind(NODE, BINDING, SOURCE)
  b.mirrors.reconcile([node()])
  const reference = { nodeId: NODE, bindingId: BINDING }
  disconnect(b.tracks[0]!)
  expect(b.mirrors.getSnapshot()[BINDING]?.status).toBe('disconnected')
  await expect(b.mirrors.reconnect(NODE, BINDING)).resolves.toBe('connected')
  expect(b.bridge.prepare).toHaveBeenNthCalledWith(2, SOURCE)
  expect(b.mirrors.getSnapshot()[BINDING]).toEqual({ nodeId: NODE, name: 'Test window', status: 'live' })
  vi.mocked(b.platform.image).mockResolvedValueOnce({ data: 'cmVjb25uZWN0ZWQ=', width: 640, height: 480 })
  const prepared = await b.mirrors.prepare(reference, new AbortController().signal)
  expect(prepared.attachments[0]?.data).toBe('cmVjb25uZWN0ZWQ=')
  expect(b.platform.image).toHaveBeenCalledWith(b.tracks[1])
  expect(b.bridge.release).toHaveBeenCalledOnce()
})

it('requires user selection after restart, for a copied occurrence, or after an explicit release', async () => {
  const b = fixture()
  await expect(b.mirrors.reconnect(NODE, BINDING)).resolves.toBe('selection-required')
  expect(b.bridge.list).not.toHaveBeenCalled()
  await b.mirrors.bind(NODE, BINDING, SOURCE)
  b.mirrors.reconcile([node()])
  await expect(b.mirrors.reconnect('copy' as CanvasNodeId, BINDING)).resolves.toBe('selection-required')
  expect(b.platform.acquire).toHaveBeenCalledOnce()
  disconnect(b.tracks[0]!)
  await b.mirrors.release(BINDING)
  await expect(b.mirrors.reconnect(NODE, BINDING)).resolves.toBe('selection-required')
  expect(b.bridge.list).not.toHaveBeenCalled()
  expect(b.mirrors.getSnapshot()).toEqual({})
})

it.each([
  { id: 'window:202:0' as DesktopWindowSourceId, name: 'Test window' },
  { id: SOURCE, name: 'Different window' },
])('does not replace an unavailable source with $id / $name', async (source) => {
  const b = fixture()
  await b.mirrors.bind(NODE, BINDING, SOURCE)
  b.mirrors.reconcile([node()])
  disconnect(b.tracks[0]!)
  vi.mocked(b.bridge.list).mockResolvedValueOnce([source])
  await expect(b.mirrors.reconnect(NODE, BINDING)).resolves.toBe('unavailable')
  expect(b.mirrors.getSnapshot()[BINDING]?.status).toBe('failed')
  expect(b.bridge.prepare).toHaveBeenCalledOnce()
  expect(b.platform.acquire).toHaveBeenCalledOnce()
})

it.each(['NotAllowedError', 'AbortError'])('retains the exact candidate for retry after %s', async (name) => {
  const b = fixture()
  await b.mirrors.bind(NODE, BINDING, SOURCE)
  disconnect(b.tracks[0]!)
  vi.mocked(b.platform.acquire).mockRejectedValueOnce(new DOMException('Capture was declined', name))
  await expect(b.mirrors.reconnect(NODE, BINDING)).resolves.toBe('unavailable')
  expect(b.mirrors.getSnapshot()[BINDING]?.status).toBe('failed')
  expect(b.bridge.release).toHaveBeenCalledTimes(2)
  await expect(b.mirrors.reconnect(NODE, BINDING)).resolves.toBe('connected')
  expect(b.bridge.prepare).toHaveBeenNthCalledWith(3, SOURCE)
  expect(b.mirrors.getSnapshot()[BINDING]?.status).toBe('live')
})

it('settles enumeration failure and refuses a source changed between enumeration and reservation', async () => {
  const b = fixture()
  await b.mirrors.bind(NODE, BINDING, SOURCE)
  disconnect(b.tracks[0]!)
  vi.mocked(b.bridge.list).mockRejectedValueOnce(new Error('Native permissions unavailable'))
  await expect(b.mirrors.reconnect(NODE, BINDING)).resolves.toBe('unavailable')
  expect(b.mirrors.getSnapshot()[BINDING]?.status).toBe('failed')
  vi.mocked(b.bridge.prepare).mockResolvedValueOnce({ id: 'changed-lease' as DesktopCaptureLeaseId,
    source: { id: SOURCE, name: 'Different window' } })
  await expect(b.mirrors.reconnect(NODE, BINDING)).resolves.toBe('unavailable')
  expect(b.bridge.release).toHaveBeenCalledWith('changed-lease')
  expect(b.platform.acquire).toHaveBeenCalledOnce()
})

it('shares reconnect clicks and serializes the new grant with other window selections', async () => {
  const b = fixture()
  await b.mirrors.bind(NODE, BINDING, SOURCE)
  disconnect(b.tracks[0]!)
  const entered = Promise.withResolvers<undefined>()
  const stream = Promise.withResolvers<MediaStream>()
  const acquire = vi.mocked(b.platform.acquire).getMockImplementation()!
  vi.mocked(b.platform.acquire).mockImplementationOnce(() => { entered.resolve(undefined); return stream.promise })
  const first = b.mirrors.reconnect(NODE, BINDING)
  const second = b.mirrors.reconnect(NODE, BINDING)
  let other: ReturnType<CanvasWindowMirrors['bind']> | undefined
  try {
    expect(first).toBe(second)
    expect(b.mirrors.getSnapshot()[BINDING]?.status).toBe('connecting')
    await entered.promise
    other = b.mirrors.bind('other' as CanvasNodeId, randomUUID() as CanvasWindowBindingId,
      'window:202:0' as DesktopWindowSourceId)
    expect(b.bridge.prepare).toHaveBeenCalledTimes(2)
    stream.resolve(await acquire())
    await expect(first).resolves.toBe('connected')
    await other
    expect(b.bridge.prepare).toHaveBeenCalledTimes(3)
    expect(b.platform.acquire).toHaveBeenCalledTimes(3)
  } finally {
    stream.reject(new Error('Reconnect acquisition fixture finished'))
    await Promise.allSettled([stream.promise, first, second, other])
  }
})

it('shares reconnect work when a state observer requests the same occurrence', async () => {
  const b = fixture()
  await b.mirrors.bind(NODE, BINDING, SOURCE)
  disconnect(b.tracks[0]!)
  let observed = false
  let duplicate: ReturnType<CanvasWindowMirrors['reconnect']> | undefined
  const release = b.mirrors.subscribe(() => {
    if (b.mirrors.getSnapshot()[BINDING]?.status !== 'connecting' || observed) return
    observed = true
    duplicate = b.mirrors.reconnect(NODE, BINDING)
  })
  try {
    const first = b.mirrors.reconnect(NODE, BINDING)
    expect(duplicate).toBe(first)
    await expect(first).resolves.toBe('connected')
    expect(b.platform.acquire).toHaveBeenCalledTimes(2)
  } finally { release() }
})

it.each(['enumeration', 'reservation'] as const)('retires a reconnect waiting for native %s without admitting its late grant', async (phase) => {
  const b = fixture()
  await b.mirrors.bind(NODE, BINDING, SOURCE)
  b.mirrors.reconcile([node()])
  disconnect(b.tracks[0]!)
  const entered = Promise.withResolvers<undefined>()
  const resume = Promise.withResolvers<undefined>()
  if (phase === 'enumeration') {
    const list = vi.mocked(b.bridge.list).getMockImplementation()!
    vi.mocked(b.bridge.list).mockImplementationOnce(async () => { entered.resolve(undefined); await resume.promise; return await list() })
  } else {
    const prepare = vi.mocked(b.bridge.prepare).getMockImplementation()!
    vi.mocked(b.bridge.prepare).mockImplementationOnce(async (id) => {
      entered.resolve(undefined)
      await resume.promise
      return await prepare(id)
    })
  }
  const reconnect = b.mirrors.reconnect(NODE, BINDING)
  try {
    await entered.promise
    b.mirrors.reconcile([])
    resume.resolve(undefined)
    await expect(reconnect).resolves.toBe('unavailable')
    expect(b.platform.acquire).toHaveBeenCalledOnce()
    expect(b.bridge.release).toHaveBeenCalledTimes(phase === 'reservation' ? 2 : 1)
    expect(b.mirrors.getSnapshot()).toEqual({})
  } finally {
    resume.resolve(undefined)
    await Promise.allSettled([reconnect])
  }
})

it.each(['removed', 'rebound', 'released', 'disposed'] as const)('releases a late reconnect stream after its owner is %s', async (retirement) => {
  const b = fixture()
  await b.mirrors.bind(NODE, BINDING, SOURCE)
  b.mirrors.reconcile([node()])
  disconnect(b.tracks[0]!)
  const entered = Promise.withResolvers<undefined>()
  const stream = Promise.withResolvers<MediaStream>()
  const acquire = vi.mocked(b.platform.acquire).getMockImplementation()!
  vi.mocked(b.platform.acquire).mockImplementationOnce(() => { entered.resolve(undefined); return stream.promise })
  const reconnect = b.mirrors.reconnect(NODE, BINDING)
  let closing: Promise<void> | undefined
  try {
    await entered.promise
    if (retirement === 'removed') b.mirrors.reconcile([])
    else if (retirement === 'rebound') b.mirrors.reconcile([node(NODE, randomUUID() as CanvasWindowBindingId)])
    else if (retirement === 'released') await b.mirrors.release(BINDING)
    else closing = b.mirrors.dispose()
    stream.resolve(await acquire())
    await expect(reconnect).resolves.toBe('unavailable')
    await closing
    expect(b.tracks[1]?.stop).toHaveBeenCalledOnce()
    expect(b.bridge.release).toHaveBeenCalledTimes(2)
    expect(b.mirrors.getSnapshot()).toEqual({})
    await expect(b.mirrors.reconnect(NODE, BINDING)).resolves.toBe(retirement === 'disposed' ? 'unavailable' : 'selection-required')
  } finally {
    stream.reject(new Error('Retired reconnect acquisition fixture finished'))
    await Promise.allSettled([stream.promise, reconnect, closing])
  }
})

it('does not let a retired validation disconnect the new capture after reconnect', async () => {
  const b = fixture()
  await b.mirrors.bind(NODE, BINDING, SOURCE)
  const validation = Promise.withResolvers<boolean>()
  vi.mocked(b.bridge.validate).mockReturnValueOnce(validation.promise)
  const validating = b.mirrors.validate(NODE, BINDING)
  try {
    disconnect(b.tracks[0]!)
    await expect(b.mirrors.reconnect(NODE, BINDING)).resolves.toBe('connected')
    validation.resolve(false)
    await validating
    expect(b.mirrors.getSnapshot()[BINDING]?.status).toBe('live')
    expect(b.tracks[1]?.stop).not.toHaveBeenCalled()
  } finally {
    validation.resolve(false)
    await Promise.allSettled([validating])
  }
})

it('rejects a frame from the old stream even when the same occurrence has already reconnected', async () => {
  const b = fixture()
  await b.mirrors.bind(NODE, BINDING, SOURCE)
  const entered = Promise.withResolvers<undefined>()
  const image = Promise.withResolvers<{ data: string; width: number; height: number }>()
  vi.mocked(b.platform.image).mockImplementationOnce(() => { entered.resolve(undefined); return image.promise })
  const captured = b.mirrors.prepare({ nodeId: NODE, bindingId: BINDING }, new AbortController().signal)
  const rejected = expect(captured).rejects.toThrow('disconnected')
  try {
    await entered.promise
    disconnect(b.tracks[0]!)
    await b.mirrors.reconnect(NODE, BINDING)
    image.resolve({ data: 'old-image', width: 10, height: 10 })
    await rejected
    expect(b.mirrors.getSnapshot()[BINDING]?.status).toBe('live')
  } finally {
    image.reject(new Error('Retired frame fixture finished'))
    await Promise.allSettled([image.promise, captured, rejected])
  }
})

it('retries a failed revocation before permitting another native capture', async () => {
  const b = fixture()
  await b.mirrors.bind(NODE, BINDING, SOURCE)
  const revoked = Promise.withResolvers<unknown>()
  b.failures.mockImplementationOnce((error: unknown) => { revoked.resolve(error) })
  vi.mocked(b.bridge.release).mockRejectedValueOnce(new Error('Native revoke failed'))
  disconnect(b.tracks[0]!)
  await revoked.promise
  vi.mocked(b.bridge.release).mockRejectedValueOnce(new Error('Native revoke still failed'))
  await expect(b.mirrors.reconnect(NODE, BINDING)).resolves.toBe('unavailable')
  expect(b.mirrors.getSnapshot()[BINDING]?.status).toBe('failed')
  expect(b.bridge.prepare).toHaveBeenCalledOnce()
  expect(b.platform.acquire).toHaveBeenCalledOnce()
  await expect(b.mirrors.reconnect(NODE, BINDING)).resolves.toBe('connected')
  expect(b.bridge.prepare).toHaveBeenCalledTimes(2)
  const lease = vi.mocked(b.bridge.release).mock.calls[0]![0]
  expect(vi.mocked(b.bridge.release).mock.calls.slice(0, 3)).toEqual([[lease], [lease], [lease]])
})

it('retains a retired late grant for disposal when its first revocation fails', async () => {
  const b = fixture()
  await b.mirrors.bind(NODE, BINDING, SOURCE)
  b.mirrors.reconcile([node()])
  disconnect(b.tracks[0]!)
  const entered = Promise.withResolvers<undefined>()
  const stream = Promise.withResolvers<MediaStream>()
  const acquire = vi.mocked(b.platform.acquire).getMockImplementation()!
  vi.mocked(b.platform.acquire).mockImplementationOnce(() => { entered.resolve(undefined); return stream.promise })
  const reconnect = b.mirrors.reconnect(NODE, BINDING)
  try {
    await entered.promise
    b.mirrors.reconcile([])
    vi.mocked(b.bridge.release).mockRejectedValueOnce(new Error('Late native revoke failed'))
    stream.resolve(await acquire())
    await expect(reconnect).resolves.toBe('unavailable')
    expect(b.mirrors.getSnapshot()).toEqual({})
    expect(b.failures).toHaveBeenCalledOnce()
    await b.mirrors.dispose()
    const calls = vi.mocked(b.bridge.release).mock.calls
    expect(calls).toHaveLength(3)
    expect(calls[2]).toEqual(calls[1])
  } finally {
    stream.reject(new Error('Late grant fixture finished'))
    await Promise.allSettled([stream.promise, reconnect])
  }
})

it('keeps capture alive when a view unmounts before its play request rejects', async () => {
  const b = fixture()
  await b.mirrors.bind(NODE, BINDING, SOURCE)
  const playing = Promise.withResolvers<undefined>()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockReturnValueOnce(playing.promise)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  const viewport = document.createElement('div')
  viewport.id = 'retired-window-view'
  document.body.append(viewport)
  try {
    b.mirrors.mount(NODE, BINDING, viewport.id)()
    playing.reject(new Error('Detached video'))
    await playing.promise.catch((_error: unknown) => { /* The view already relinquished its playback request. */ })
    expect(b.mirrors.getSnapshot()[BINDING]?.status).toBe('live')
    expect(b.tracks[0]?.stop).not.toHaveBeenCalled()
  } finally {
    playing.resolve(undefined)
    await Promise.allSettled([playing.promise])
  }
})
