/** Primary-document, one-shot window grants independent of agent Computer Use. */
import { randomUUID } from 'node:crypto'
import { desktopCapturer, ipcMain, type BrowserWindow, type DesktopCapturerSource, type IpcMainInvokeEvent, type PermissionCheckHandlerHandlerDetails, type Session, type WebContents, type WebFrameMain } from 'electron'
import type { DesktopCaptureLease, DesktopCaptureLeaseId, DesktopWindowSource, DesktopWindowSourceId } from '@deepseek-ai/dsh-util-desktop-capture'
import { DESKTOP_IPC } from './ipc.ts'

interface Lease {
  readonly id: DesktopCaptureLeaseId
  source: DesktopCapturerSource | undefined
  readonly contents: WebContents
  readonly frame: WebFrameMain
  phase: 'preparing' | 'prepared' | 'active'
}

/** Screen-sharing permission checks supplied to the existing microphone permission owner. */
export interface DesktopCapturePermissions {
  /**
   * @param contents - Requesting document.
   * @param origin - Request origin.
   * @param details - Chromium media details.
   * @returns Whether this document has an exact pending or active capture grant.
   */
  check(contents: WebContents | null, origin: string, details: PermissionCheckHandlerHandlerDetails): boolean
  /**
   * @param contents - Requesting document.
   * @param url - Request URL.
   * @param isMainFrame - Chromium frame classification.
   * @returns Whether a pending one-shot grant can authorize display capture.
   */
  request(contents: WebContents, url: string, isMainFrame: boolean): boolean
}

/** Installed Desktop capture IPC and its dependent enumeration lifetime. */
export interface DesktopWindowCaptureOwner extends DesktopCapturePermissions {
  /**
   * Stop admission, revoke leases, remove listeners, and await pending native enumerations.
   * @returns Completion after owned work settles.
   */
  dispose(): Promise<void>
}

function applicationOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'dsh-app:' && url.hostname === 'app'
  } catch (_error) { return false /* Invalid origins cannot request native capture. */ }
}

function sourceView(source: Pick<DesktopCapturerSource, 'id' | 'name'> & { readonly appIcon: Electron.NativeImage | null }): DesktopWindowSource {
  const icon = source.appIcon
  return { id: source.id as DesktopWindowSourceId, name: source.name,
    ...(icon === null || icon.isEmpty() ? {} : { appIcon: icon.resize({ width: 32, height: 32 }).toDataURL() }) }
}

/**
 * Install exact-window capture on the application session. The caller retains microphone
 * permission ownership and delegates display checks through the returned owner.
 * @param browserSession - Session of the owned application document.
 * @param primary - Current primary application window.
 * @param assertSender - Existing main-frame and application-origin IPC guard.
 * @returns Capture permissions and asynchronous teardown.
 */
export function installDesktopWindowCapture(
  browserSession: Pick<Session, 'setDisplayMediaRequestHandler'>,
  primary: () => BrowserWindow | undefined,
  assertSender: (event: IpcMainInvokeEvent) => BrowserWindow,
): DesktopWindowCaptureOwner {
  const leases = new Map<DesktopCaptureLeaseId, Lease>()
  const pending = new Map<WebContents, Lease>()
  const listeners = new Map<WebContents, () => void>()
  const work = new Set<Promise<DesktopCapturerSource[]>>()
  let closed = false

  const owned = (contents: WebContents | null): contents is WebContents =>
    !closed && contents !== null && !contents.isDestroyed() && primary()?.webContents === contents
  const revoke = (lease: Lease): void => {
    leases.delete(lease.id)
    if (pending.get(lease.contents) === lease) pending.delete(lease.contents)
  }
  const retire = (contents: WebContents): void => {
    for (const lease of leases.values()) if (lease.contents === contents) revoke(lease)
    pending.delete(contents)
    listeners.get(contents)?.()
    listeners.delete(contents)
  }
  const watch = (contents: WebContents): void => {
    if (listeners.has(contents)) return
    const navigation = (_event: Electron.Event, _url: string, inPlace: boolean, main: boolean): void => {
      if (main && !inPlace) retire(contents)
    }
    const gone = (): void => { retire(contents) }
    contents.on('did-start-navigation', navigation)
    contents.on('render-process-gone', gone)
    contents.on('destroyed', gone)
    listeners.set(contents, () => {
      contents.off('did-start-navigation', navigation)
      contents.off('render-process-gone', gone)
      contents.off('destroyed', gone)
    })
  }
  const assertOpen = (): void => {
    if (closed) throw new Error('Desktop window capture is closed')
  }
  const sources = async (fetchWindowIcons: boolean): Promise<DesktopCapturerSource[]> => {
    assertOpen()
    const task = desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons })
    work.add(task)
    try {
      const result = await task
      assertOpen()
      return result.filter(source => source.id.startsWith('window:'))
    } finally { work.delete(task) }
  }
  const caller = (event: IpcMainInvokeEvent): WebContents => {
    const window = assertSender(event)
    if (!owned(window.webContents)) throw new Error('Desktop window capture is unavailable')
    return window.webContents
  }
  ipcMain.handle(DESKTOP_IPC.captureList, async (event): Promise<readonly DesktopWindowSource[]> => {
    const contents = caller(event)
    const result = await sources(true)
    if (!owned(contents) || event.senderFrame !== contents.mainFrame) throw new Error('Desktop capture document changed')
    return result.map(sourceView)
  })
  ipcMain.handle(DESKTOP_IPC.capturePrepare, async (event, id: unknown): Promise<DesktopCaptureLease> => {
    const contents = caller(event)
    if (typeof id !== 'string' || !id.startsWith('window:')) throw new Error('A listed window source is required')
    if (pending.has(contents)) throw new Error('Another window capture grant is pending')
    const frame = event.senderFrame
    if (frame === null) throw new Error('Desktop capture document is unavailable')
    const lease: Lease = { id: randomUUID() as DesktopCaptureLeaseId, source: undefined, contents, frame, phase: 'preparing' }
    pending.set(contents, lease)
    watch(contents)
    try {
      const source = (await sources(false)).find(candidate => candidate.id === id)
      if (source === undefined || !owned(contents) || contents.mainFrame !== frame || pending.get(contents) !== lease) throw new Error('The selected window is unavailable')
      lease.source = source
      lease.phase = 'prepared'
      leases.set(lease.id, lease)
      return { id: lease.id, source: sourceView(source) }
    } catch (error) { revoke(lease); throw error }
  })
  ipcMain.handle(DESKTOP_IPC.captureValidate, async (event, id: unknown): Promise<boolean> => {
    const contents = caller(event)
    if (typeof id !== 'string') return false
    const lease = leases.get(id as DesktopCaptureLeaseId)
    if (lease === undefined || lease.source === undefined || lease.contents !== contents || lease.frame !== contents.mainFrame || lease.phase !== 'active') return false
    const sourceId = lease.source.id
    const available = (await sources(false)).some(source => source.id === sourceId)
    if (!available || !owned(contents) || leases.get(lease.id) !== lease || lease.frame !== contents.mainFrame) {
      revoke(lease)
      return false
    }
    return true
  })
  ipcMain.handle(DESKTOP_IPC.captureRelease, (event, id: unknown): void => {
    const contents = caller(event)
    if (typeof id !== 'string') return
    const lease = leases.get(id as DesktopCaptureLeaseId)
    if (lease?.contents === contents) revoke(lease)
  })
  browserSession.setDisplayMediaRequestHandler((request, callback) => {
    const contents = primary()?.webContents
    const lease = contents === undefined ? undefined : pending.get(contents)
    if (lease === undefined || lease.source === undefined || lease.phase !== 'prepared' || !owned(lease.contents) || !leases.has(lease.id) || request.frame !== lease.frame
      || request.frame !== lease.contents.mainFrame || !applicationOrigin(request.securityOrigin)
      || !request.videoRequested || request.audioRequested) { callback(null); return }
    pending.delete(lease.contents)
    lease.phase = 'active'
    callback({ video: lease.source })
  }, { useSystemPicker: false })
  return {
    check(contents, origin, details) {
      return owned(contents) && details.isMainFrame && applicationOrigin(origin)
        && (details.mediaType === undefined || details.mediaType === 'unknown')
        && [...leases.values()].some(lease => lease.contents === contents && lease.frame === contents.mainFrame)
    },
    request(contents, url, main) {
      const lease = pending.get(contents)
      return owned(contents) && main && applicationOrigin(url) && lease?.phase === 'prepared' && lease.frame === contents.mainFrame
    },
    async dispose() {
      closed = true
      for (const contents of [...listeners.keys()]) retire(contents)
      pending.clear()
      leases.clear()
      const channels = [DESKTOP_IPC.captureList, DESKTOP_IPC.capturePrepare, DESKTOP_IPC.captureValidate, DESKTOP_IPC.captureRelease]
      for (const channel of channels) {
        ipcMain.removeHandler(channel)
      }
      browserSession.setDisplayMediaRequestHandler(null)
      await Promise.allSettled([...work])
    },
  }
}
