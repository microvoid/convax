/** Retry confirmed resource-addition conflicts that did not change the graph. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import type { CanvasCommandRequest, CanvasCommandResult, CanvasDocument, CanvasOperationId } from '@deepseek-ai/dsh-convax-plugin-host/types'

/**
 * Submit a resource addition and retry once if only the canvas revision advanced.
 * A Chat thread binding can advance that revision without changing nodes or connections.
 * @param execute - Host mutation transport, which can reject if its result is unknown.
 * @param canvas - Document used to place the resource and capture its optional connection.
 * @param request - Addition with the revision from that document.
 * @returns The final result and its operation ID for local history.
 */
export async function executeResourceAddition(
  execute: (request: CanvasCommandRequest) => Promise<CanvasCommandResult>,
  canvas: CanvasDocument, request: CanvasCommandRequest,
): Promise<{ operationId: CanvasOperationId; result: CanvasCommandResult }> {
  const result = await execute(request)
  if (result.ok || result.code !== 'conflict') return { operationId: request.operationId, result }
  const current = result.workspace.canvases.find(value => value.id === canvas.id)
  if (current === undefined || current.revision <= canvas.revision || !deepEqualJson(canvas, { ...current, revision: canvas.revision })) {
    return { operationId: request.operationId, result }
  }
  const operationId = randomUUID() as CanvasOperationId
  return { operationId, result: await execute({ ...request, expectedRevision: current.revision, operationId }) }
}
