/** Context-menu targeting retains the user's selection until an action changes the graph. */
import type { CanvasNodeId, CanvasPoint } from '@deepseek-ai/dsh-convax-plugin-host/types'

/** Measured selectable rectangle in canvas coordinates. */
export interface CanvasContextBounds extends CanvasPoint {
  readonly id: CanvasNodeId
  readonly width: number
  readonly height: number
}

/**
 * Preserve native context menus in editors, conversation content and terminals.
 * @param target - The original right-click target.
 * @returns Whether the nested content owns its context menu.
 */
export function ownsNativeCanvasContextMenu(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  const selection = target.ownerDocument.getSelection()
  if (selection?.isCollapsed === false && selection.containsNode(target, true)) return true
  if (target.closest('input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="slider"], [role="menu"], [role="dialog"], .xterm') !== null) return true
  return target.closest('[data-convax-input-owner]') !== null && target.closest('[data-convax-node-drag]') === null
}

/**
 * Resolve one node or the existing selection without selecting anything.
 * @param hitId - Node under the pointer, or undefined on the canvas background.
 * @param selection - Current selected node identities.
 * @param bounds - Measured nodes for the blank-space selection hit test.
 * @param point - Context-menu pointer in canvas coordinates.
 * @returns Node identities affected by actions; an empty array opens the canvas menu.
 */
export function canvasContextTargets(
  hitId: CanvasNodeId | undefined,
  selection: readonly CanvasNodeId[],
  bounds: readonly CanvasContextBounds[],
  point: CanvasPoint,
): readonly CanvasNodeId[] {
  if (hitId !== undefined) return selection.includes(hitId) ? selection : [hitId]
  const selected = bounds.filter(node => selection.includes(node.id))
  if (selected.length === 0) return []
  const left = Math.min(...selected.map(node => node.x))
  const top = Math.min(...selected.map(node => node.y))
  const right = Math.max(...selected.map(node => node.x + node.width))
  const bottom = Math.max(...selected.map(node => node.y + node.height))
  return point.x >= left && point.x <= right && point.y >= top && point.y <= bottom ? selection : []
}
