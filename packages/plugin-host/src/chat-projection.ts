/** Pure Chat views derived from one read of the graph's coordination records. */
import type { CanvasTableValue } from './schema.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CanvasChat, CanvasChatIssueCode, CanvasDocument, CanvasId, CanvasNode, CanvasNodeId } from './types.ts'

/** Detached durable records used during one repository read. */
export interface CanvasChatRecords {
  readonly bindings: readonly CanvasTableValue<'bindings'>[]
  readonly threadOperations: readonly CanvasTableValue<'thread_operations'>[]
  readonly deletions: readonly CanvasTableValue<'deletions'>[]
}

interface ChatDetails {
  bindings: CanvasTableValue<'bindings'>[]
  deleting: boolean
  threadError: string | null
  deletionError: string | null
  deliveryError: string | null
}

type ChatIndex = Map<CanvasId, Map<CanvasNodeId, ChatDetails>>

function details(index: ChatIndex, canvasId: CanvasId, nodeId: CanvasNodeId): ChatDetails {
  let nodes = index.get(canvasId)
  if (nodes === undefined) { nodes = new Map(); index.set(canvasId, nodes) }
  let value = nodes.get(nodeId)
  if (value === undefined) {
    value = { bindings: [], deleting: false, threadError: null, deletionError: null, deliveryError: null }
    nodes.set(nodeId, value)
  }
  return value
}

function indexThreadStates(index: ChatIndex, operations: CanvasChatRecords['threadOperations']): Set<SessionId> {
  const suppressed = new Set<SessionId>()
  for (const operation of operations) {
    if (operation.phase === 'suppressed' && operation.sessionId !== null) suppressed.add(operation.sessionId)
    if (operation.phase === 'pending') {
      details(index, operation.canvasId, operation.nodeId).threadError ??= operation.error
    }
  }
  return suppressed
}

function indexDeletionStates(index: ChatIndex, deletions: CanvasChatRecords['deletions']): void {
  for (const deletion of deletions) {
    if (deletion.phase !== 'deleting') continue
    for (const nodeId of deletion.nodeIds) {
      const chat = details(index, deletion.canvasId, nodeId)
      chat.deleting = true
      chat.deletionError ??= deletion.error
    }
  }
}

function indexBindings(index: ChatIndex, bindings: CanvasChatRecords['bindings'], suppressed: ReadonlySet<SessionId>): void {
  for (const binding of bindings) {
    if (suppressed.has(binding.sessionId)) continue
    const chat = details(index, binding.canvasId, binding.nodeId)
    chat.bindings.push(binding)
    chat.deliveryError ??= binding.deliveryError
  }
}

function threadOrder(left: CanvasTableValue<'bindings'>, right: CanvasTableValue<'bindings'>): number {
  return left.ordinal - right.ordinal || left.sessionId.localeCompare(right.sessionId)
}

function projectChat(index: ChatIndex, canvas: CanvasDocument, node: CanvasNode): CanvasChat | undefined {
  if (node.typeId !== 'convax.chat') return undefined
  const chat = details(index, canvas.id, node.id)
  const threads = chat.bindings.toSorted(threadOrder)
    .map(({ sessionId, parentSessionId, inheritedEventCount }) => ({ sessionId, parentSessionId, inheritedEventCount }))
  const issueCode: CanvasChatIssueCode | undefined = chat.threadError !== null ? 'thread-create'
    : chat.deletionError !== null ? 'deletion' : chat.deliveryError !== null ? 'delivery' : undefined
  return {
    canvasId: canvas.id, nodeId: node.id,
    title: typeof node.data.title === 'string' ? node.data.title : canvas.title,
    ...(node.data.defaultTitle === true ? { defaultTitle: true as const } : {}),
    cwd: typeof node.data.cwd === 'string' ? node.data.cwd : '',
    threads, deleting: chat.deleting,
    issue: chat.threadError ?? chat.deletionError ?? chat.deliveryError,
    ...(issueCode === undefined ? {} : { issueCode }),
  }
}

/**
 * Index durable records for one read without retaining mutable graph state.
 * @param records - Records in their durable key order, which determines the first reported failure.
 * @returns A pure node reader; non-Chat nodes return undefined and Chat results have independent thread values.
 */
export function createChatProjection(records: CanvasChatRecords): (canvas: CanvasDocument, node: CanvasNode) => CanvasChat | undefined {
  const index: ChatIndex = new Map()
  const suppressed = indexThreadStates(index, records.threadOperations)
  indexDeletionStates(index, records.deletions)
  indexBindings(index, records.bindings, suppressed)
  return (canvas, node) => projectChat(index, canvas, node)
}
