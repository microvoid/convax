/** Initial placement of new reference cards; existing geometry remains unchanged. */
import type { CanvasNode, CanvasPoint } from '@deepseek-ai/dsh-convax-plugin-host/types'

/** Border-box width shared by resource cards and their initial placement. */
export const RESOURCE_CARD_WIDTH = 320
/** Horizontal separation shared by list additions and multi-item drops. */
export const RESOURCE_CARD_GAP = 32
/** Initial width of a Conversation card, also used when placing neighboring nodes. */
export const CHAT_CARD_WIDTH = 620

/**
 * Place a list-added card in a free horizontal lane beside existing cards.
 * Horizontal separation remains valid for cards with arbitrarily wrapped paths.
 * @param nodes - current committed cards; their positions are read-only.
 * @returns initial position of the new card.
 */
export function nextResourcePosition(nodes: readonly (Pick<CanvasNode, 'position'> & Partial<Pick<CanvasNode, 'typeId'>>)[],
  definitions: Readonly<Record<string, { defaultSize?: { readonly width: number } }>> = {}): CanvasPoint {
  return {
    x: nodes.reduce((right, node) => {
      const width = node.typeId === undefined ? RESOURCE_CARD_WIDTH : definitions[node.typeId]?.defaultSize?.width ?? RESOURCE_CARD_WIDTH
      return Math.max(right, node.position.x + width + RESOURCE_CARD_GAP)
    }, 80),
    y: 80,
  }
}
