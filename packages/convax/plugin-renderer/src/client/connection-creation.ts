/** Empty-space connection drops retain their browser pointer and original port direction. */
import type { CanvasPoint } from '@deepseek-ai/dsh-convax-plugin-host/types'

/**
 * Read the final mouse or touch position without using the stale drag-start target.
 * @param event - Browser connection-end event.
 * @returns Screen coordinates, or null when a cancelled touch has no final position.
 */
export function connectionDropPoint(event: MouseEvent | TouchEvent): CanvasPoint | null {
  if ('changedTouches' in event) {
    const touch = event.changedTouches[0]
    return touch === undefined ? null : { x: touch.clientX, y: touch.clientY }
  }
  return { x: event.clientX, y: event.clientY }
}

/**
 * Admit creation only over the canvas background, leaving cards and controls alone.
 * @param root - The graph receiving the connection drop.
 * @param target - Element under the final pointer position.
 * @returns Whether a new connected node may be offered at this location.
 */
export function isBlankConnectionTarget(root: HTMLElement, target: Element | null): boolean {
  return target !== null && root.contains(target)
    && target.closest('.react-flow__node, .react-flow__edge, .react-flow__panel, button, input, textarea, select, [contenteditable], [role="menu"], [data-convax-chat]') === null
    && target.closest('.react-flow') !== null
}
