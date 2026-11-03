/** Typed, process-local Desktop window capture reservations; streams remain in the renderer. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Electron-issued identity of a currently selectable window, never a durable reconnect identity. */
export type DesktopWindowSourceId = Branded<'DesktopWindowSourceId'>

/** Main-process reservation owned by one application document. */
export type DesktopCaptureLeaseId = Branded<'DesktopCaptureLeaseId'>

/** Selectable window metadata; listing does not capture its content. */
export interface DesktopWindowSource {
  readonly id: DesktopWindowSourceId
  readonly name: string
  /** Owner application's PNG data URL, omitted when its native icon is unavailable. */
  readonly appIcon?: string
}

/** A one-shot stream grant followed by validation until the caller releases it. */
export interface DesktopCaptureLease {
  readonly id: DesktopCaptureLeaseId
  readonly source: DesktopWindowSource
}

/** Primary-document window capture operations; no Electron objects or window content cross this bridge. */
export interface DesktopWindowCapture {
  /** @returns Current window identities, titles and available app icons, without thumbnails; rejects on enumeration failure. */
  list(this: void): Promise<readonly DesktopWindowSource[]>
  /**
   * Reserve one exact window for the caller's next video-only getDisplayMedia request.
   * Only one unused reservation may exist per document. Caller operations must serialize
   * prepare/getDisplayMedia and release after failure or track disposal.
   * @param sourceId - Identity returned by current enumeration.
   * @returns The document-owned reservation; rejects if unavailable or another grant is pending.
   */
  prepare(this: void, sourceId: DesktopWindowSourceId): Promise<DesktopCaptureLease>
  /**
   * Check an admitted stream's exact source against fresh native enumeration.
   * A missing source invalidates the lease permanently; it never retargets or reconnects.
   * @param leaseId - The caller's admitted reservation.
   * @returns Whether that source remains available; false includes release or document replacement.
   */
  validate(this: void, leaseId: DesktopCaptureLeaseId): Promise<boolean>
  /**
   * Revoke the unused grant or admitted reservation. Stop renderer-owned tracks separately.
   * @param leaseId - Caller-owned reservation; already released ids are harmless.
   * @returns Completion after revocation.
   */
  release(this: void, leaseId: DesktopCaptureLeaseId): Promise<void>
}
