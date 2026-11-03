/** Canvas gesture defaults from the visiting device's resolved operating system. */
import type { ShortcutPlatform } from '@deepseek-ai/dsh-client-shortcuts/client'

/** How wheel gestures navigate the canvas. */
export type CanvasInputMode = 'touchpad' | 'mouse'

/**
 * Resolve the initial gesture mode before the user selects a preference.
 * @param platform - Visiting device platform resolved by the shortcut service.
 * @returns Touchpad navigation on macOS; existing mouse navigation elsewhere.
 */
export function defaultCanvasInputMode(platform: ShortcutPlatform): CanvasInputMode {
  return platform === 'macos' ? 'touchpad' : 'mouse'
}
