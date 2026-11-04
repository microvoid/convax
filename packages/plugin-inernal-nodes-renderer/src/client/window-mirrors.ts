/** Renderer-owned native window streams survive view changes but never graph removal or rebind. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { DesktopCaptureLease, DesktopCaptureLeaseId, DesktopWindowCapture, DesktopWindowSource, DesktopWindowSourceId } from '@deepseek-ai/dsh-util-desktop-capture'
import type { CanvasNode, CanvasNodeId, CanvasWindowBindingId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { PreparedReference } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { WindowMirrorState, WindowReconnectResult } from './window-contract.ts'
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

interface Capture {
  readonly lease: DesktopCaptureLease
  readonly stream: MediaStream
  readonly ended: () => void
}

interface Binding {
  readonly nodeId: CanvasNodeId
  readonly id: CanvasWindowBindingId
  source?: DesktopWindowSource
  capture?: Capture
  revoking?: DesktopCaptureLeaseId
  observed: boolean
}

interface Revocation { pending?: Promise<void> }

/** Stream ownership is keyed by node occurrence as well as binding, preventing copied nodes from borrowing a live source. */
export class CanvasWindowMirrors {
  private readonly state = createSnapshotStore<Readonly<Record<string, WindowMirrorState>>>({})
  private readonly bindings = new Map<CanvasWindowBindingId, Binding>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly validations = new Map<Capture, Promise<void>>()
  private readonly reconnections = new Map<Binding, Promise<WindowReconnectResult>>()
  private readonly revocations = new Map<DesktopCaptureLeaseId, Revocation>()
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
    if (this.lifetime.signal.aborted) return Promise.reject(new Error('Window captures have been disposed'))
    const previous = this.release(bindingId)
    const binding: Binding = { nodeId, id: bindingId, observed: false }
    this.bindings.set(bindingId, binding)
    const work = this.admission.then(async () => {
      try {
        await previous
        this.assertCurrent(binding)
        const capture = await this.acquire(binding, sourceId)
        this.assertCurrent(binding)
        if (binding.capture !== capture) throw new Error('Selected window disconnected')
        this.publish(binding, capture.lease.source.name, 'live')
        return capture.lease.source.name
      } catch (error) {
        if (this.bindings.get(bindingId) === binding) await this.release(bindingId)
        throw error
      }
    })
    this.admission = work.then(() => {}, () => {})
    return this.track(work)
  }

  /**
   * Retry the exact runtime source without changing graph or draft reference identities.
   * @param nodeId - Original graph occurrence; copies cannot borrow its source.
   * @param bindingId - Its unchanged graph binding identity.
   * @returns Selection is required without a remembered candidate; failed or retired attempts settle unavailable.
   */
  reconnect(nodeId: CanvasNodeId, bindingId: CanvasWindowBindingId): Promise<WindowReconnectResult> {
    if (this.lifetime.signal.aborted) return Promise.resolve('unavailable')
    const binding = this.bindings.get(bindingId)
    const source = binding?.source
    if (binding?.nodeId !== nodeId || source === undefined) return Promise.resolve('selection-required')
    const existing = this.reconnections.get(binding)
    if (existing !== undefined) return existing
    if (binding.capture?.stream.getVideoTracks()[0]?.readyState === 'live') return Promise.resolve('connected')
    const released = this.releaseCapture(binding)
    const work = this.admission.then(async (): Promise<WindowReconnectResult> => {
      try {
        await released
        this.assertCurrent(binding)
        const sources = await this.provider().list()
        this.assertCurrent(binding)
        if (!sources.some(value => value.id === source.id && value.name === source.name)) throw new Error('Original window is unavailable')
        const capture = await this.acquire(binding, source.id, source)
        this.assertCurrent(binding)
        if (binding.capture !== capture) throw new Error('Original window disconnected')
        this.publish(binding, source.name, 'live')
        return 'connected'
      } catch (_error) {
        // Capture cancellation and provider failures share the retryable UI outcome.
        if (this.isCurrent(binding)) this.publish(binding, source.name, 'failed')
        return 'unavailable'
      }
    })
    this.reconnections.set(binding, work)
    const settled = (): void => { this.reconnections.delete(binding) }
    void work.then(settled, settled)
    this.admission = work.then(() => {}, () => {})
    this.publish(binding, source.name, 'connecting')
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
    const binding = this.bindings.get(bindingId)
    const capture = binding?.capture
    if (binding?.nodeId !== nodeId || capture === undefined || this.lifetime.signal.aborted) return Promise.resolve()
    const existing = this.validations.get(capture)
    if (existing !== undefined) return existing
    const work = (async () => {
      try {
        if (!await this.provider().validate(capture.lease.id)) this.markDisconnected(binding, capture)
      } catch (error) {
        this.markDisconnected(binding, capture)
        this.reportFailure(error)
      }
    })()
    this.validations.set(capture, work)
    void work.then(() => { this.validations.delete(capture) }, () => { this.validations.delete(capture) })
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
    const capture = binding?.capture
    const host = document.getElementById(viewportId)
    if (binding?.nodeId !== nodeId || capture === undefined || host === null) return () => {}
    const video = document.createElement('video')
    video.muted = true
    video.autoplay = true
    video.playsInline = true
    video.srcObject = capture.stream
    video.setAttribute('aria-hidden', 'true')
    host.append(video)
    let mounted = true
    void video.play().catch((_error: unknown) => { if (mounted) this.markDisconnected(binding, capture) })
    return () => { mounted = false; video.pause(); video.srcObject = null; video.remove() }
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
      const binding = this.bindings.get(reference.bindingId)
      const capture = binding?.capture
      combined.throwIfAborted()
      if (binding?.nodeId !== reference.nodeId || capture === undefined) throw new Error('Window reference is disconnected; reselect its window')
      const current = (): void => {
        combined.throwIfAborted()
        if (this.bindings.get(reference.bindingId) !== binding || binding.capture !== capture
          || capture.stream.getVideoTracks()[0]?.readyState !== 'live') {
          throw new Error('Window reference is disconnected; reselect its window')
        }
      }
      current()
      if (!await this.provider().validate(capture.lease.id)) { this.markDisconnected(binding, capture); throw new Error('Window is closed, minimized, or unavailable') }
      current()
      const track = capture.stream.getVideoTracks()[0]
      if (track === undefined) throw new Error('Window image capture has no video track')
      const image = await this.platform.image(track)
      current()
      if (!await this.provider().validate(capture.lease.id)) { this.markDisconnected(binding, capture); throw new Error('Window became unavailable during capture') }
      current()
      const capturedAt = new Date().toISOString()
      return { text: `Application window: ${capture.lease.source.name}\nCaptured at: ${capturedAt}\nImage: ${image.width} × ${image.height}`,
        attachments: [{ type: 'image', mediaType: 'image/png', data: image.data, name: `${capture.lease.source.name}.png` }] } satisfies PreparedReference
    })()
    return this.track(work)
  }

  /**
   * Stop the binding's tracks, revoke its native lease, and forget its runtime source.
   * @param bindingId - Failed or replaced graph binding.
   * @returns Cleanup completion for its native capture.
   */
  release(bindingId: CanvasWindowBindingId): Promise<void> {
    const binding = this.bindings.get(bindingId)
    if (binding === undefined) return Promise.resolve()
    this.bindings.delete(bindingId)
    delete binding.source
    const next = Object.fromEntries(Object.entries(this.state.getSnapshot()).filter(([id]) => id !== bindingId))
    this.state.set(next)
    return this.releaseCapture(binding)
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
      const capture = binding.capture
      if (capture === undefined) continue
      for (const track of capture.stream.getTracks()) {
        track.removeEventListener('ended', capture.ended)
        if (track.readyState !== 'ended') track.stop()
      }
    }
    this.closing = (async () => {
      while (this.pending.size > 0) await Promise.allSettled([...this.pending])
      await Promise.allSettled([...this.bindings.keys()].map(id => this.release(id)))
      const revoked = await Promise.allSettled([...this.revocations.keys()].map(id => this.releaseLease(id)))
      while (this.pending.size > 0) await Promise.allSettled([...this.pending])
      this.state.set({})
      const failures: unknown[] = []
      for (const result of revoked) if (result.status === 'rejected') failures.push(result.reason)
      if (failures.length > 0) throw new AggregateError(failures, 'Window capture leases could not be revoked')
    })()
    return this.closing
  }

  private provider(): DesktopWindowCapture {
    if (this.bridge === undefined) throw new Error('Application window mirroring requires Desktop')
    return this.bridge
  }
  private isCurrent(binding: Binding): boolean {
    return !this.lifetime.signal.aborted && this.bindings.get(binding.id) === binding
  }
  private assertCurrent(binding: Binding): void {
    this.lifetime.signal.throwIfAborted()
    if (this.bindings.get(binding.id) !== binding) throw new Error('Window binding was retired')
  }
  private async acquire(binding: Binding, sourceId: DesktopWindowSourceId, expected?: DesktopWindowSource): Promise<Capture> {
    this.assertCurrent(binding)
    const bridge = this.provider()
    const lease = await bridge.prepare(sourceId)
    let stream: MediaStream | undefined
    try {
      this.assertCurrent(binding)
      if (lease.source.id !== sourceId || (expected !== undefined && lease.source.name !== expected.name)) throw new Error('Selected window changed')
      stream = await this.platform.acquire()
      this.assertCurrent(binding)
      if (!await bridge.validate(lease.id) || stream.getVideoTracks().length !== 1
        || stream.getVideoTracks()[0]?.readyState !== 'live') throw new Error('Selected window is unavailable')
      this.assertCurrent(binding)
      const capture: Capture = { lease, stream, ended: () => { this.markDisconnected(binding, capture) } }
      for (const track of stream.getTracks()) track.addEventListener('ended', capture.ended)
      binding.source = lease.source
      binding.capture = capture
      return capture
    } catch (error) {
      for (const track of stream?.getTracks() ?? []) if (track.readyState !== 'ended') track.stop()
      binding.revoking = lease.id
      try { await this.releaseCapture(binding) } catch (cleanupError) { this.reportFailure(cleanupError) }
      throw error
    }
  }
  private releaseCapture(binding: Binding): Promise<void> {
    const capture = binding.capture
    if (capture !== undefined) {
      delete binding.capture
      binding.revoking = capture.lease.id
      for (const track of capture.stream.getTracks()) {
        track.removeEventListener('ended', capture.ended)
        if (track.readyState !== 'ended') track.stop()
      }
    }
    const leaseId = binding.revoking
    if (leaseId === undefined) return Promise.resolve()
    const work = this.releaseLease(leaseId)
    void work.then(() => { if (binding.revoking === leaseId) delete binding.revoking }, (_error: unknown) => {
      // The lease remains owned until another explicit reconnect or disposal retries revocation.
    })
    return work
  }
  private releaseLease(leaseId: DesktopCaptureLeaseId): Promise<void> {
    let revocation = this.revocations.get(leaseId)
    if (revocation?.pending !== undefined) return revocation.pending
    if (revocation === undefined) {
      revocation = {}
      this.revocations.set(leaseId, revocation)
    }
    const owner = revocation
    const work = (async () => { await this.provider().release(leaseId) })()
    owner.pending = work
    void work.then(() => { this.revocations.delete(leaseId) }, () => { delete owner.pending })
    return this.track(work)
  }
  private publish(binding: Binding, name: string, status: WindowMirrorState['status']): void {
    this.state.set({ ...this.state.getSnapshot(), [binding.id]: { nodeId: binding.nodeId, name, status } })
  }
  private markDisconnected(binding: Binding, capture: Capture): void {
    if (!this.isCurrent(binding) || binding.capture !== capture) return
    void this.releaseCapture(binding).catch(this.reportFailure)
    this.publish(binding, capture.lease.source.name, 'disconnected')
  }
  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work)
    void work.then(() => { this.pending.delete(work) }, () => { this.pending.delete(work) })
    return work
  }
}
