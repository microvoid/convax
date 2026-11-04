/** Connected-node creation retains the dropped line while the shared menu owns input. */
import { getBezierPath, Position, useStore as useFlowStore, ViewportPortal } from '@xyflow/react'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CanvasPoint } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { CanvasConnectionOrigin } from './props.ts'
import css from './Workspace.module.css'

const OPPOSITE_POSITION: Record<Position, Position> = {
  [Position.Left]: Position.Right, [Position.Right]: Position.Left,
  [Position.Top]: Position.Bottom, [Position.Bottom]: Position.Top,
}

/**
 * Keep the origin attached to its live measured handle while the viewport moves.
 * @param props - Original port, fallback drag-start coordinate and final world position.
 * @returns A decorative world-coordinate connection path.
 */
export function ConnectionCreationPreview({ origin, from, to, position }: {
  readonly origin: CanvasConnectionOrigin
  readonly from: CanvasPoint
  readonly to: CanvasPoint
  readonly position: Position
}) {
  const node = useFlowStore(state => state.nodeLookup.get(origin.nodeId))
  const handle = node?.internals.handleBounds?.[origin.direction === 'output' ? 'source' : 'target']?.find(item => item.id === origin.portId)
  const start = node !== undefined && handle !== undefined ? {
    x: node.internals.positionAbsolute.x + handle.x + handle.width / 2,
    y: node.internals.positionAbsolute.y + handle.y + handle.height / 2,
  } : from
  const startPosition = handle?.position ?? position
  const targetPosition = OPPOSITE_POSITION[startPosition]
  const [path] = getBezierPath({ sourceX: start.x, sourceY: start.y, sourcePosition: startPosition,
    targetX: to.x, targetY: to.y, targetPosition })
  return <ViewportPortal><svg className={css.snapGuides} aria-hidden="true">
    <path d={path} className={css.connectionPreview} data-convax-connection-preview=""
      data-origin-node={origin.nodeId} data-origin-port={origin.portId} data-origin-direction={origin.direction} />
  </svg></ViewportPortal>
}

/**
 * Offer native project, file or Chat creation without changing the graph until selection succeeds.
 * @param props - Screen anchor, operation state, translated copy and creation callbacks.
 * @returns The shared portaled menu with no persistent graph side effects.
 */
export function ConnectionCreationMenu({ point, busy, close, creations }: {
  readonly point: CanvasPoint
  readonly busy: boolean
  readonly close: () => void
  readonly creations: readonly { id: string; label: string; create: () => void }[]
}) {
  return <Menu open portal autoFocus anchor={<span data-convax-connection-menu="" aria-hidden="true" />}
    getAnchorRect={() => new DOMRect(point.x, point.y, 0, 0)} onClose={close} items={creations.map(entry => ({ id: `create:${entry.id}`, label: entry.label, disabled: busy }))} onSelect={(id) => {
      close()
      creations.find(entry => `create:${entry.id}` === id)?.create()
    }} />
}
