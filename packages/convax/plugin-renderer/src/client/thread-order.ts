/** Resolve saved thread navigation order against the Chat's current visible Sessions. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * Keep saved tabs first and append Sessions added since the last reorder.
 * @param threads - Current visible thread bindings, in Host order.
 * @param order - This window's saved navigation order, which may contain archived Sessions.
 * @returns Current bindings in navigation order, without stale or duplicate saved entries.
 */
export function orderedChatThreads<T extends { readonly sessionId: SessionId }>(
  threads: readonly T[], order: readonly SessionId[] | undefined,
): T[] {
  const remaining = new Map(threads.map(thread => [thread.sessionId, thread]))
  const result: T[] = []
  for (const id of order ?? []) {
    const thread = remaining.get(id)
    if (thread === undefined) continue
    result.push(thread)
    remaining.delete(id)
  }
  return [...result, ...remaining.values()]
}
