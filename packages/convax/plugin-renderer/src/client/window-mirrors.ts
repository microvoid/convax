/** Renderer-owned native window streams survive view changes but never graph removal or rebind. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { DesktopCaptureLease, DesktopWindowCapture, DesktopWindowSource, DesktopWindowSourceId } from '@deepseek-ai/dsh-util-desktop-capture'
import type { CanvasNode, CanvasNodeId, CanvasWindowBindingId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { PreparedReference } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { WindowMirrorState } from './window-contract.ts'
import type { CanvasWindowReference } from './window-reference.ts'

/** Browser platform work, separated from source selection and graph ownership. */
export interface WindowMirrorPlatform {
  acquire(this: void): Promise<MediaStream>
  image(this: void, track: MediaStreamTrack): Promise<{ readonly data: string; readonly width: number; readonly height: number }>
}

interface ImageCaptureInstance { grabFrame(): Promise<ImageBitmap> }
interface ImageCaptureConstructor { new(track: MediaStreamTrack): ImageCaptureInstance }

/**
 * Resolve the Desktop capture capability without activating a source.
 * @returns The origin-scoped bridge, absent in ordinary browsers.
 */
export function desktopWindowCapture(): DesktopWindowCapture | undefined {
  return (globalThis as { dshDesktop?: { readonly windowCapture?: DesktopWindowCapture } }).dshDesktop?.windowCapture
}

/** Browser implementation captures a fresh track frame without requiring a visible video callback. */
export const browserWindowMirrorPlatform: WindowMirrorPlatform = {
  acquire: () => navigator.mediaDevices.getDisplayMedia({ audio: false, video: true }),
  async image(track) {
    const ImageCapture = (globalThis as { ImageCapture?: ImageCaptureConstructor }).ImageCapture
    if (ImageCapture === undefined) throw new Error('Window image capture is unavailable')
    const frame = await new ImageCapture(track).grabFrame()
    try {
      const canvas = document.createElement('canvas')
      canvas.width = frame.width
      canvas.height = frame.height
      const context = canvas.getContext('2d')
      if (context === null) throw new Error('Window image encoding is unavailable')
      context.drawImage(frame, 0, 0)
      const data = canvas.toDataURL('image/png').split(',')[1]
      if (data === undefined || frame.width === 0 || frame.height === 0) throw new Error('Window capture returned no pixels')
      return { data, width: frame.width, height: frame.height }
    } finally { frame.close() }
  },
}

interface Binding {
  readonly nodeId: CanvasNodeId
  readonly id: CanvasWindowBindingId
  readonly name: string
  readonly lease: DesktopCaptureLease
  readonly stream: MediaStream
  readonly ended: () => void
  observed: boolean
}

/** Stream ownership is keyed by node occurrence as well as binding, preventing copied nodes from borrowing a live source. */
export class CanvasWindowMirrors {
  private readonly state = createSnapshotStore<Readonly<Record<string, WindowMirrorState>>>({})
  private readonly bindings = new Map<CanvasWindowBindingId, Binding>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly validations = new Map<CanvasWindowBindingId, Promise<void>>()
  private readonly lifetime = new AbortController()
  private admission: Promise<void> = Promise.resolve()
  private closing: Promise<void> | undefined

  /**
   * Own one renderer's native captures and their cleanup failures.
   * @param bridge - Current Desktop capture provider.
   * @param platform - Browser stream/frame implementation.
   * @param reportFailure - Reporter for asynchronous validation or cleanup failures.
   */
  constructor(private readonly bridge: DesktopWindowCapture | undefined,
    private readonly platform: WindowMirrorPlatform = browserWindowMirrorPlatform,
    private readonly reportFailure: (error: unknown) => void = (error) => { console.error('Convax window capture cleanup failed', error) }) {}

  /**
   * Report native capture availability without requesting permission.
   * @returns Whether this renderer has a native window provider.
   */
  get available(): boolean { return this.bridge !== undefined }
  /**
   * Expose detached mirror state for framework-generated selector hooks.
   * @returns The latest node-bound capture states.
   */
  readonly getSnapshot = (): Readonly<Record<string, WindowMirrorState>> => this.state.getSnapshot()
  /**
   * Observe mirror availability changes.
   * @param listener - Capture observer.
   * @returns Observer release.
   */
  readonly subscribe = (listener: () => void): (() => void) => this.state.subscribe(listener)

  /**
   * Enumerate selectable windows without requesting image capture.
   * @returns Current native window identities and titles.
   */
  async list(): Promise<readonly DesktopWindowSource[]> { this.lifetime.signal.throwIfAborted(); return await this.provider().list() }

  /**
   * Bind a user-selected window through serialized same-frame display-media admission.
   * @param nodeId - Exact destination occurrence, minted before graph admission.
   * @param bindingId - New graph binding identity; never a native window id.
   * @param sourceId - User-selected runtime source.
   * @returns Capture name for the node payload; failure releases any acquired stream/lease.
   */
  bind(nodeId: CanvasNodeId, bindingId: CanvasWindowBindingId, sourceId: DesktopWindowSourceId): Promise<string> {
    const work = this.admission.then(async () => {
      this.lifetime.signal.throwIfAborted()
      const bridge = this.provider()
      const lease = await bridge.prepare(sourceId)
      let stream: MediaStream | undefined
      try {
        this.lifetime.signal.throwIfAborted()
        stream = await this.platform.acquire()
        this.lifetime.signal.throwIfAborted()
        if (!await bridge.validate(lease.id) || stream.getVideoTracks().length !== 1) throw new Error('Selected window is unavailable')
        this.lifetime.signal.throwIfAborted()
        const ended = (): void => { this.markDisconnected(bindingId) }
        const binding: Binding = { nodeId, id: bindingId, name: lease.source.name, lease, stream, ended, observed: false }
        for (const track of stream.getTracks()) track.addEventListener('ended', ended)
        this.bindings.set(bindingId, binding)
        this.publish(binding, 'live')
        return lease.source.name
      } catch (error) {
        for (const track of stream?.getTracks() ?? []) track.stop()
        await bridge.release(lease.id)
        throw error
      }
    })
    this.admission = work.then(() => {}, () => {})
    return this.track(work)
  }

  /**
   * Retire captures whose graph occurrence was removed or rebound.
   * @param nodes - Authoritative nodes from all canvases; copies have distinct occurrence ids.
   */
  reconcile(nodes: readonly CanvasNode[]): void {
    for (const binding of this.bindings.values()) {
      const node = nodes.find(value => value.id === binding.nodeId && value.typeId === 'convax.window' && value.data.bindingId === binding.id)
      if (node !== undefined) binding.observed = true
      else if (binding.observed) void this.release(binding.id).catch(this.reportFailure)
    }
    const retained = Object.fromEntries(Object.entries(this.state.getSnapshot()).filter(([id, state]) =>
      this.bindings.has(id as CanvasWindowBindingId) || nodes.some(node => node.id === state.nodeId && node.data.bindingId === id)))
    if (Object.keys(retained).length !== Object.keys(this.state.getSnapshot()).length) this.state.set(retained)
  }

  /**
   * Recheck a viewed source on focus, visibility, or pointer return without polling.
   * @param nodeId - Exact viewed occurrence.
   * @param bindingId - Its runtime binding.
   * @returns Completion after unavailable sources release their capture.
   */
  validate(nodeId: CanvasNodeId, bindingId: CanvasWindowBindingId): Promise<void> {
    const existing = this.validations.get(bindingId)
    if (existing !== undefined) return existing
    const work = (async () => {
      if (this.lifetime.signal.aborted) return
      const binding = this.bindings.get(bindingId)
      if (binding?.nodeId !== nodeId) return
      try {
        if (!await this.provider().validate(binding.lease.id) && this.bindings.get(bindingId) === binding) this.markDisconnected(bindingId)
      } catch (error) {
        this.markDisconnected(bindingId)
        this.reportFailure(error)
      }
    })()
    this.validations.set(bindingId, work)
    void work.then(() => { this.validations.delete(bindingId) }, () => { this.validations.delete(bindingId) })
    return this.track(work)
  }

  /**
   * Attach a read-only view without transferring capture ownership to the component.
   * @param nodeId - Exact graph occurrence.
   * @param bindingId - Runtime source binding.
   * @param viewportId - Connected element created by the mirror component.
   * @returns View-only cleanup; the stream remains available to draft references.
   */
  mount(nodeId: CanvasNodeId, bindingId: CanvasWindowBindingId, viewportId: string): () => void {
    const binding = this.bindings.get(bindingId)
    const host = document.getElementById(viewportId)
    if (binding?.nodeId !== nodeId || host === null) return () => {}
    const video = document.createElement('video')
    video.muted = true
    video.autoplay = true
    video.playsInline = true
    video.srcObject = binding.stream
    video.setAttribute('aria-hidden', 'true')
    host.append(video)
    void video.play().catch((_error: unknown) => { this.markDisconnected(bindingId) })
    return () => { video.pause(); video.srcObject = null; video.remove() }
  }

  /**
   * Materialize one submit-owned immutable image, validating the source before and after capture.
   * @param reference - Exact node/binding captured with the draft.
   * @param signal - Native submit/source-registration lifetime.
   * @returns Image plus source metadata for the existing DSH prompt admission.
   */
  prepare(reference: CanvasWindowReference, signal: AbortSignal): Promise<PreparedReference> {
    const work = (async () => {
      const combined = AbortSignal.any([signal, this.lifetime.signal])
      const current = (): Binding => {
        combined.throwIfAborted()
        const binding = this.bindings.get(reference.bindingId)
        if (binding?.nodeId !== reference.nodeId || binding.stream.getVideoTracks()[0]?.readyState !== 'live') throw new Error('Window reference is disconnected; reselect its window')
        return binding
      }
      const binding = current()
      if (!await this.provider().validate(binding.lease.id)) { this.markDisconnected(binding.id); throw new Error('Window is closed, minimized, or unavailable') }
      current()
      const track = binding.stream.getVideoTracks()[0]
      if (track === undefined) throw new Error('Window image capture has no video track')
      const image = await this.platform.image(track)
      current()
      if (!await this.provider().validate(binding.lease.id)) { this.markDisconnected(binding.id); throw new Error('Window became unavailable during capture') }
      if (current() !== binding) throw new Error('Window reference changed during capture')
      const capturedAt = new Date().toISOString()
      return { text: `Application window: ${binding.name}\nCaptured at: ${capturedAt}\nImage: ${image.width} × ${image.height}`,
        attachments: [{ type: 'image', mediaType: 'image/png', data: image.data, name: `${binding.name}.png` }] } satisfies PreparedReference
    })()
    return this.track(work)
  }

  /**
   * Stop the binding's tracks and revoke its native lease.
   * @param bindingId - Failed or replaced graph binding.
   * @returns Cleanup completion for its native capture.
   */
  release(bindingId: CanvasWindowBindingId): Promise<void> {
    const binding = this.bindings.get(bindingId)
    if (binding === undefined) return Promise.resolve()
    this.bindings.delete(bindingId)
    for (const track of binding.stream.getTracks()) { track.removeEventListener('ended', binding.ended); if (track.readyState !== 'ended') track.stop() }
    const next = Object.fromEntries(Object.entries(this.state.getSnapshot()).filter(([id]) => id !== bindingId))
    this.state.set(next)
    return this.track(this.provider().release(binding.lease.id))
  }

  /**
   * Cancel preparation and drain frame consumers before releasing their native leases.
   * @returns Completion after all acquired streams and owned work settle.
   */
  dispose(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.lifetime.abort()
    // Stopping tracks releases a native grabFrame wait; leases remain until its consumer settles.
    for (const binding of this.bindings.values()) {
      for (const track of binding.stream.getTracks()) { track.removeEventListener('ended', binding.ended); track.stop() }
    }
    this.closing = (async () => {
      while (this.pending.size > 0) await Promise.allSettled([...this.pending])
      await Promise.all([...this.bindings.keys()].map(id => this.release(id)))
      while (this.pending.size > 0) await Promise.allSettled([...this.pending])
      this.state.set({})
    })()
    return this.closing
  }

  private provider(): DesktopWindowCapture {
    if (this.bridge === undefined) throw new Error('Application window mirroring requires Desktop')
    return this.bridge
  }
  private publish(binding: Binding, status: WindowMirrorState['status']): void {
    this.state.set({ ...this.state.getSnapshot(), [binding.id]: { nodeId: binding.nodeId, name: binding.name, status } })
  }
  private markDisconnected(id: CanvasWindowBindingId): void {
    const binding = this.bindings.get(id)
    if (binding === undefined) return
    void this.release(id).catch(this.reportFailure)
    this.publish(binding, 'disconnected')
  }
  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work)
    void work.then(() => { this.pending.delete(work) }, () => { this.pending.delete(work) })
    return work
  }
}
