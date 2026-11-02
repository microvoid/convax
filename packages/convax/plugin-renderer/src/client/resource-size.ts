/** File card and preview dimensions in unscaled canvas CSS pixels. */
import { RESOURCE_CARD_WIDTH } from './placement.ts'

/** Saved resource card width and expanded preview body height. */
export interface ResourceSize {
  /** Card border-box width before canvas scaling. */
  width: number
  /** Preview body height, excluding the resource header. */
  height: number
}

/** Initial height shared by expanded file previews. */
export const RESOURCE_PREVIEW_HEIGHT = 240
/** Compact audio body height, including its waveform and transport controls. */
export const AUDIO_PREVIEW_HEIGHT = 104
/** Minimum height that retains the preview's controls. */
export const RESOURCE_MIN_PREVIEW_HEIGHT = 160

/**
 * Resize a resource preview at the canvas zoom without limiting expansion.
 * @param start - Card width and preview body height at the start of the gesture.
 * @param dx - Horizontal pointer displacement in viewport CSS pixels.
 * @param dy - Vertical pointer displacement in viewport CSS pixels.
 * @param scale - Positive canvas zoom at the start of the gesture.
 * @param minimumHeight - Preview layout's minimum height; audio uses its compact body height.
 * @returns Dimensions clamped to the resource's existing layout minima.
 */
export function resizeResource(
  start: ResourceSize, dx: number, dy: number, scale: number, minimumHeight = RESOURCE_MIN_PREVIEW_HEIGHT,
): ResourceSize {
  return {
    width: Math.max(RESOURCE_CARD_WIDTH, start.width + dx / scale),
    height: Math.max(minimumHeight, start.height + dy / scale),
  }
}
