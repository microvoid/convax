/** Typed composer references retain an exact window-node binding independently of edges. */
import { z } from 'zod'
import type { CanvasNodeId, CanvasWindowBindingId } from '@deepseek-ai/dsh-convax-plugin-host/types'

/** Source key shared by connection gestures and submit-time preparation. */
export const WINDOW_REFERENCE_SOURCE = 'convax-window'

/** Exact node occurrence and runtime binding selected by a connection gesture. */
export interface CanvasWindowReference {
  readonly nodeId: CanvasNodeId
  readonly bindingId: CanvasWindowBindingId
}

const schema = z.object({ nodeId: z.string().min(1), bindingId: z.uuid() })

/**
 * Encode a node and binding as a composer source identity.
 * @param reference - Captured node binding.
 * @returns Source-owned, serializable chip identity.
 */
export function encodeWindowReference(reference: CanvasWindowReference): string { return JSON.stringify(reference) }

/**
 * Validate a retained reference before resolving its runtime capture.
 * @param value - Persisted or composer-supplied source identity.
 * @returns Validated node binding.
 * @throws When the JSON or binding fields are invalid.
 */
export function parseWindowReference(value: string): CanvasWindowReference {
  const parsed = schema.parse(JSON.parse(value))
  return { nodeId: parsed.nodeId as CanvasNodeId, bindingId: parsed.bindingId as CanvasWindowBindingId }
}
