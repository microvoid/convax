/** Chat dimensions and pointer resizing in unscaled canvas CSS pixels. */

/** Saved left-column width and transcript scrollport height, excluding the tool pane. */
export interface ChatSize {
  /** Left-column width before canvas scaling. */
  width: number
  /** Transcript scrollport height, excluding the header and composer. */
  height: number
}

/** Minimum left-column width that retains the Chat's controls. */
export const CHAT_MIN_WIDTH = 400
/** Minimum transcript scrollport height. */
export const CHAT_MIN_HEIGHT = 160

/**
 * Resize from a pointer gesture's starting dimensions without mutating them.
 * @param start - left-column width and scrollport height at pointer down, in canvas CSS pixels.
 * @param dx - horizontal pointer displacement in viewport CSS pixels.
 * @param dy - vertical pointer displacement in viewport CSS pixels.
 * @param scale - positive canvas zoom at the start of the gesture.
 * @param minHeight - optional larger scrollport height floor.
 * @returns dimensions clamped to the Chat's layout minima, without a maximum.
 */
export function resizeChat(start: ChatSize, dx: number, dy: number, scale: number, minHeight = CHAT_MIN_HEIGHT): ChatSize {
  return {
    width: Math.max(CHAT_MIN_WIDTH, start.width + dx / scale),
    height: Math.max(CHAT_MIN_HEIGHT, minHeight, start.height + dy / scale),
  }
}
