/** Retry identities compare the JSON fields retained in durable operation receipts. */
import { isDeepStrictEqual } from 'node:util'
import type { CanvasCommandRequest, CanvasThreadRequest } from './types.ts'

type CanvasRequest = CanvasCommandRequest | CanvasThreadRequest

/**
 * Compare in-flight or previously validated durable requests using their serialized fields.
 * @param previous - Captured request or validated JSON text from its durable receipt.
 * @param request - Proposed identical retry; undefined optional fields have no serialized value.
 * @returns Whether all JSON fields match independently of object property order.
 */
export function sameCanvasRequest(previous: CanvasRequest | string, request: CanvasRequest): boolean {
  const stored: unknown = JSON.parse(typeof previous === 'string' ? previous : JSON.stringify(previous))
  const proposed: unknown = JSON.parse(JSON.stringify(request))
  return isDeepStrictEqual(stored, proposed)
}
