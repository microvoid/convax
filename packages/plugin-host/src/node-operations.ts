/** Optional node feature operations registered independently of graph persistence. */
import type { CanvasCommandRequest, CanvasCommandResult, CanvasThreadRequest, CanvasThreadResult,
  CanvasOpenSessionRequest, CanvasOpenSessionResult } from './types.ts'

/** Native Session adaptation supplied by a session-owning node plugin. */
export interface CanvasSessionOperations {
  /** @param request - Revisioned graph mutation. @param signal - Caller cancellation. @returns Coordinated mutation result. */
  execute(request: CanvasCommandRequest, signal?: AbortSignal): Promise<CanvasCommandResult>
  /** @param request - Retained native Session creation identity. @returns Created or recovered binding. */
  createThread(request: CanvasThreadRequest): Promise<CanvasThreadResult>
  /** @param request - Existing Session and requested node placement. @returns Its unique graph binding. */
  openSession(request: CanvasOpenSessionRequest): Promise<CanvasOpenSessionResult>
  /** @returns Once durable unfinished operations have been retried. */
  recover(): Promise<void>
  /** @returns After adapter-owned coordination drains; native Agents are not stopped. */
  close(): Promise<void>
}

/** Delivery catch-up supplied by a node plugin and independent of open views. */
export interface CanvasDeliveryOperations {
  /** @returns Once recorded native deliveries have been retried. */
  retry(): Promise<void>
  /** @returns After observations drain without stopping native work. */
  close(): Promise<void>
}
