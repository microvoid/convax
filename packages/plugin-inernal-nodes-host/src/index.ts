/** Default Convax node providers and native DSH Session adaptation. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-convax-plugin-host'
import { registerDefaultNodes } from './definitions.ts'
import { registerCanvasAdmission } from './admission.ts'
import { CanvasChatCoordinator } from './chats.ts'
import { CanvasDeliveryCoordinator } from './deliveries.ts'
import { CanvasTerminalController } from './terminals.ts'
export { CanvasTerminalController } from './terminals.ts'

export { registerDefaultNodes } from './definitions.ts'
export { CanvasChatCoordinator } from './chats.ts'
export { CanvasDeliveryCoordinator, canvasDeliveryProjection } from './deliveries.ts'
export { createFileDeliveryOutput } from './file-delivery.ts'
export { registerCanvasAdmission } from './admission.ts'
export { archiveCanvasThread } from './archive.ts'
export { CanvasSessionMaterializer } from './session-materializer.ts'
export type { CanvasThreadSessions, CanvasSessionReceipt } from './session-materializer.ts'

/** Cordis plugin identity; the paired renderer has an independent lifetime. */
export const name = 'convax-plugin-inernal-nodes-host'
/** Node providers consume the public canvas and native DSH services. */
export const inject = ['convax', 'fs', 'agents', 'sessions', 'sessionPersistence', 'sessionProjections']

/**
 * Install default providers and recover feature work without creating Agents.
 * @param ctx - Composed Host context; disposal preserves graph records and native tasks.
 * @returns After delivery projection is ready; Session adaptation waits for its own dependencies.
 */
export async function apply(ctx: Context): Promise<void> {
  ctx.inject(['terminalController', 'subprocess', 'typert'], (scope) => { new CanvasTerminalController(scope) })
  registerDefaultNodes((definition) => { ctx.effect(() => ctx.convax.registerNodeType(definition)) })
  ctx.effect(() => registerCanvasAdmission(ctx, ctx.convax.repository), 'convax nodes: Session admission')
  const deliveries = new CanvasDeliveryCoordinator(ctx, ctx.convax.repository)
  ctx.effect(() => ctx.convax.registerDeliveryOperations(deliveries), 'convax nodes: delivery coordination')
  await deliveries.start()
  ctx.inject(['workspaceRegistry', 'sessionQuery'], async (scope) => {
    const coordinator = new CanvasChatCoordinator(scope, scope.convax.repository)
    scope.effect(() => scope.convax.registerSessionOperations(coordinator), 'convax nodes: Session coordination')
    await coordinator.recover()
  })
}
