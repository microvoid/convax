/** Coordinates for docking surfaces inside translated or scaled containers. */

/** Visual origin and CSS-pixel scale of one surface. */
export interface SurfaceCoordinates {
  readonly left: number
  readonly top: number
  readonly scaleX: number
  readonly scaleY: number
}

/**
 * Read axis-aligned CSS scaling; unmeasured dimensions use the unscaled reading.
 * @param root - Docking surface whose local coordinates contain floating panels.
 * @returns Viewport origin and scale from local CSS pixels to viewport pixels.
 */
export function surfaceCoordinates(root: HTMLElement): SurfaceCoordinates {
  const rect = root.getBoundingClientRect()
  return {
    left: rect.left, top: rect.top,
    scaleX: root.offsetWidth > 0 && rect.width > 0 ? rect.width / root.offsetWidth : 1,
    scaleY: root.offsetHeight > 0 && rect.height > 0 ? rect.height / root.offsetHeight : 1,
  }
}
