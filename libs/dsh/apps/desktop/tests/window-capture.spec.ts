/** Native source grants stay with one document and never authorize camera devices. */
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, DesktopCapturer, DesktopCapturerSource, IpcMainInvokeEvent, Session, WebContents, WebFrameMain } from 'electron'
import type { DesktopCaptureLease } from '@deepseek-ai/dsh-util-desktop-capture'
import { DESKTOP_IPC } from '../src/ipc.ts'
import { installDesktopWindowCapture } from '../src/window-capture.ts'

/** Electron returns null when icons are not requested, including for window sources. */
type NativeSource = Omit<DesktopCapturerSource, 'appIcon'> & { readonly appIcon: Electron.NativeImage | null }

const native = vi.hoisted(() => ({
  sources: vi.fn<(options: Parameters<DesktopCapturer['getSources']>[0]) => Promise<NativeSource[]>>(),
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>(),
}))
vi.mock('electron', () => ({ desktopCapturer: { getSources: native.sources }, ipcMain: {
  handle: (channel: string, callback: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
    native.handlers.set(channel, callback)
  },
  removeHandler: (channel: string) => { native.handlers.delete(channel) },
} }))

const releases = new Set<() => Promise<void>>()
afterEach(async () => {
  await Promise.all([...releases].map(release => release()))
  releases.clear()
  native.handlers.clear()
  native.sources.mockReset()
})
function fixture() {
  const frame = { url: 'dsh-app://app/' } as WebFrameMain
  const emitter = Object.assign(new EventEmitter(), { mainFrame: frame, isDestroyed: () => false })
  const contents = emitter as WebContents
  const primary = { webContents: contents } as BrowserWindow
  const setDisplayMediaRequestHandler = vi.fn<Session['setDisplayMediaRequestHandler']>()
  const owner = installDesktopWindowCapture({ setDisplayMediaRequestHandler }, () => primary, (event) => {
    if (event.sender !== contents || event.senderFrame !== contents.mainFrame) throw new Error('unowned frame')
    return primary
  })
  releases.add(() => owner.dispose())
  const event = { sender: contents, senderFrame: frame } as IpcMainInvokeEvent
  const invoke = (channel: string, ...args: unknown[]): unknown => native.handlers.get(channel)!(event, ...args)
  const grant = (overrides: Partial<Electron.DisplayMediaRequestHandlerHandlerRequest> = {}) => {
    const callback = vi.fn()
    setDisplayMediaRequestHandler.mock.calls[0]![0]!({ frame, securityOrigin: 'dsh-app://app/', videoRequested: true, audioRequested: false, userGesture: true, ...overrides }, callback)
    return callback
  }
  return { owner, contents, emitter, frame, event, invoke, grant, setDisplayMediaRequestHandler }
}
function source(id = 'window:12:0', name = 'Test window'): NativeSource {
  const image = {} as Electron.NativeImage
  return { id, name, display_id: '', thumbnail: image, appIcon: null }
}

describe('Desktop window capture', () => {
  it('rejects IPC from a different document before enumerating native windows', async () => {
    const f = fixture()
    await expect(native.handlers.get(DESKTOP_IPC.captureList)!({ ...f.event, senderFrame: null })).rejects.toThrow('unowned frame')
    expect(native.sources).not.toHaveBeenCalled()
  })
  it('enumerates windows without capturing thumbnails', async () => {
    const f = fixture()
    native.sources.mockResolvedValue([source(), source('screen:1:0', 'Screen')])
    await expect(f.invoke(DESKTOP_IPC.captureList)).resolves.toEqual([{ id: 'window:12:0', name: 'Test window' }])
    expect(native.sources).toHaveBeenCalledExactlyOnceWith({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: true })
  })

  it('includes a small application icon without a window thumbnail and omits empty icons', async () => {
    const f = fixture(), appIcon = 'data:image/png;base64,dGVzdA=='
    const resized = { toDataURL: () => appIcon } as Electron.NativeImage
    const resize = vi.fn(() => resized)
    const image = Object.assign(source().thumbnail, { isEmpty: () => false, resize })
    const empty = { isEmpty: () => true } as Electron.NativeImage
    native.sources.mockResolvedValue([
      { ...source(), appIcon: image },
      { ...source('window:empty:0', 'Empty icon'), appIcon: empty },
      source('window:absent:0', 'Absent icon'),
    ])
    await expect(f.invoke(DESKTOP_IPC.captureList)).resolves.toEqual([
      { id: 'window:12:0', name: 'Test window', appIcon },
      { id: 'window:empty:0', name: 'Empty icon' },
      { id: 'window:absent:0', name: 'Absent icon' },
    ])
    expect(resize).toHaveBeenCalledExactlyOnceWith({ width: 32, height: 32 })
  })

  it('requests application icons for selection without fetching them during capture validation', async () => {
    const f = fixture()
    native.sources.mockResolvedValue([source()])
    await f.invoke(DESKTOP_IPC.captureList)
    const lease = await f.invoke(DESKTOP_IPC.capturePrepare, source().id) as DesktopCaptureLease
    f.grant()
    await expect(f.invoke(DESKTOP_IPC.captureValidate, lease.id)).resolves.toBe(true)
    expect(native.sources.mock.calls.map(([options]) => options.fetchWindowIcons)).toEqual([true, false, false])
  })

  it('grants only the exact selected source once and validates against fresh enumeration', async () => {
    const f = fixture(), selected = source()
    native.sources.mockResolvedValue([source('window:other:0'), selected])
    const lease = await f.invoke(DESKTOP_IPC.capturePrepare, selected.id) as DesktopCaptureLease
    expect(lease.source).toEqual({ id: selected.id, name: selected.name })
    expect(f.owner.request(f.contents, 'dsh-app://app/', true)).toBe(true)
    expect(f.grant().mock.calls).toEqual([[{ video: selected }]])
    expect(f.grant().mock.calls).toEqual([[null]])
    expect(f.owner.request(f.contents, 'dsh-app://app/', true)).toBe(false)
    await expect(f.invoke(DESKTOP_IPC.captureValidate, lease.id)).resolves.toBe(true)
    native.sources.mockResolvedValue([])
    await expect(f.invoke(DESKTOP_IPC.captureValidate, lease.id)).resolves.toBe(false)
    native.sources.mockResolvedValue([selected])
    await expect(f.invoke(DESKTOP_IPC.captureValidate, lease.id)).resolves.toBe(false)
  })

  it.each([
    { audioRequested: true }, { videoRequested: false }, { securityOrigin: 'https://example.com' },
    { frame: null }, { frame: { url: 'dsh-app://app/' } as WebFrameMain },
  ])('rejects unrelated capture requests without consuming the intended grant: %j', async (request) => {
    const f = fixture()
    native.sources.mockResolvedValue([source()])
    await f.invoke(DESKTOP_IPC.capturePrepare, source().id)
    expect(f.grant(request).mock.calls).toEqual([[null]])
    expect(f.grant().mock.calls).toEqual([[{ video: source() }]])
  })

  it('rejects concurrent prepare calls while native discovery is pending', async () => {
    const f = fixture(), discovery = Promise.withResolvers<NativeSource[]>()
    native.sources.mockReturnValue(discovery.promise)
    const first = f.invoke(DESKTOP_IPC.capturePrepare, source().id)
    await expect(f.invoke(DESKTOP_IPC.capturePrepare, source().id)).rejects.toThrow('pending')
    expect(f.owner.request(f.contents, 'dsh-app://app/', true)).toBe(false)
    discovery.resolve([source()])
    const lease = await first as DesktopCaptureLease
    await f.invoke(DESKTOP_IPC.captureRelease, lease.id)
    expect(f.grant().mock.calls).toEqual([[null]])
  })

  it('releases preparation after failure and rejects unlisted or screen sources', async () => {
    const f = fixture()
    native.sources.mockResolvedValue([])
    await expect(f.invoke(DESKTOP_IPC.capturePrepare, 'window:missing:0')).rejects.toThrow('unavailable')
    await expect(f.invoke(DESKTOP_IPC.capturePrepare, 'screen:1:0')).rejects.toThrow('window source')
    native.sources.mockRejectedValueOnce(new Error('native unavailable'))
    await expect(f.invoke(DESKTOP_IPC.capturePrepare, source().id)).rejects.toThrow('native unavailable')
    native.sources.mockResolvedValue([source()])
    await expect(f.invoke(DESKTOP_IPC.capturePrepare, source().id)).resolves.toMatchObject({ source: { id: source().id } })
  })

  it('revokes preparation on navigation and cannot publish late discovery into a new document', async () => {
    const f = fixture(), discovery = Promise.withResolvers<NativeSource[]>()
    native.sources.mockReturnValue(discovery.promise)
    const first = f.invoke(DESKTOP_IPC.capturePrepare, source().id)
    f.emitter.emit('did-start-navigation', {}, 'dsh-app://app/', false, true)
    discovery.resolve([source()])
    await expect(first).rejects.toThrow('unavailable')
    expect(f.grant().mock.calls).toEqual([[null]])
    expect(f.emitter.listenerCount('destroyed')).toBe(0)
  })

  it('permits only document-owned display checks while retaining camera isolation', async () => {
    const f = fixture()
    native.sources.mockResolvedValue([source()])
    expect(f.owner.check(f.contents, 'dsh-app://app/', { isMainFrame: true })).toBe(false)
    await f.invoke(DESKTOP_IPC.capturePrepare, source().id)
    expect(f.owner.check(f.contents, 'dsh-app://app/', { isMainFrame: true })).toBe(true)
    expect(f.owner.check(f.contents, 'dsh-app://app/', { isMainFrame: true, mediaType: 'video' })).toBe(false)
    expect(f.owner.check(f.contents, 'dsh-app://app/', { isMainFrame: true, mediaType: 'audio' })).toBe(false)
    expect(f.owner.check(null, 'dsh-app://app/', { isMainFrame: true })).toBe(false)
    expect(f.owner.check(f.contents, 'https://example.com', { isMainFrame: true })).toBe(false)
    expect(f.owner.check(f.contents, 'dsh-app://app/', { isMainFrame: false })).toBe(false)
    expect(f.owner.request(f.contents, 'dsh-app://app/', false)).toBe(false)
    expect(f.owner.request(f.contents, 'invalid', true)).toBe(false)
  })

  it('stops admission and drains discovery on disposal without registering late leases', async () => {
    const f = fixture(), discovery = Promise.withResolvers<NativeSource[]>()
    native.sources.mockReturnValue(discovery.promise)
    const preparation = f.invoke(DESKTOP_IPC.capturePrepare, source().id)
    const rejected = expect(preparation).rejects.toThrow('closed')
    let settled = false
    const closing = f.owner.dispose().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(native.handlers.size).toBe(0)
    discovery.resolve([source()])
    await Promise.all([closing, rejected])
    expect(f.grant().mock.calls).toEqual([[null]])
    expect(f.setDisplayMediaRequestHandler).toHaveBeenLastCalledWith(null)
    expect(f.emitter.listenerCount('did-start-navigation')).toBe(0)
  })
})
