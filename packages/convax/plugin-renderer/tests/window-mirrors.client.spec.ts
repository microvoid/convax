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
