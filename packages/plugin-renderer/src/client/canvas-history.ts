/** Window history records only user-issued graph operations and the preferences removed with their nodes. */
import type { CanvasCommand, CanvasDocument } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { ResourceView } from './store.ts'

/**
 * Exclude canvas lifecycle, metadata and history transitions from the local undo stack.
 * @param command - One successfully committed command issued by this window.
 * @returns Whether its durable operation identity belongs on this canvas's undo stack.
 */
export function recordsCanvasHistory(command: CanvasCommand): boolean {
  switch (command.kind) {
    case 'create': case 'delete': case 'rename': case 'history':
    case 'set-archived': case 'duplicate': case 'purge': return false
    case 'add-node': case 'add-subgraph': case 'move-nodes': case 'arrange-nodes': case 'remove-nodes':
    case 'update-node': case 'add-connection': case 'remove-connections': return true
    case 'batch': return command.ops.some(operation => operation.op.startsWith('node.') || operation.op.startsWith('edge.'))
    default: return assertNever(command)
  }
}

/**
 * Retain only preferences that would otherwise be removed by graph reconciliation.
 * @param before - Canvas before the successful operation.
 * @param after - Committed canvas after the operation.
 * @param views - Window-owned preferences captured before submitting the operation, before watched removals can prune them.
 * @returns Detached preferences for removed node identities.
 */
export function removedResourceViews(before: CanvasDocument | undefined, after: CanvasDocument | undefined,
  views: Readonly<Record<string, ResourceView>>): Record<string, ResourceView> {
  const retained = new Set(after?.nodes.map(node => node.id) ?? [])
  return Object.fromEntries((before?.nodes ?? []).flatMap((node) => {
    const view = views[node.id]
    return retained.has(node.id) || view === undefined ? [] : [[node.id, { ...view }]]
  }))
}

/**
 * Restore saved viewing state only for nodes reintroduced by a history transition.
 * @param before - Canvas before undo or redo.
 * @param after - Committed canvas after undo or redo.
 * @param saved - Preferences retained with the original operation.
 * @param current - Existing views, including nodes observed before an idempotent retry receipt arrives.
 * @returns Preferences for restored nodes, preserving every unrelated live view.
 */
export function restoredResourceViews(before: CanvasDocument | undefined, after: CanvasDocument | undefined,
  saved: Readonly<Record<string, ResourceView>>, current: Readonly<Record<string, ResourceView>>): Record<string, ResourceView> {
  const previous = new Set(before?.nodes.map(node => node.id) ?? [])
  return Object.fromEntries((after?.nodes ?? []).flatMap((node) => {
    const view = saved[node.id]
    return view === undefined || previous.has(node.id) && current[node.id] !== undefined ? [] : [[node.id, { ...view }]]
  }))
}
