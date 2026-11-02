/** Canvas connections keep their cut action and directional highlight on the same curve. */
import { Scissors } from 'lucide-react'
import { useId } from 'react'
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CanvasConnectionId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { WorkspaceProps } from './props.ts'
import css from './CanvasEdge.module.css'

/** Transient drawing state and the revision-bound cut callback for one saved connection. */
export type GraphEdge = Edge<{
  hovered: boolean
  endpointSelected: boolean
  busy: boolean
  zoom: number
  t: WorkspaceProps['t']
  cut: (ids: readonly CanvasConnectionId[]) => void
  hover: (id: string | null) => void
  select: (id: string) => void
}, 'convaxConnection'>

/**
 * Draw a selectable connection with a screen-sized midpoint cut button.
 * @param props - React Flow curve coordinates and the owning graph's actions.
 * @returns The curve, decorative flow highlight and midpoint action.
 */
export function CanvasEdge({
  id, data, selected, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
}: EdgeProps<GraphEdge>) {
  const gradient = useId()
  const [path, x, y] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  if (data === undefined) return null
  const active = selected || data.hovered || data.endpointSelected
  const actionVisible = selected || data.hovered
  return <>
    <g className={css.edge} data-convax-edge={id} data-active={active || undefined}
      data-selected={selected || undefined} data-hovered={data.hovered || undefined}
      onPointerEnter={(event) => { if (event.pointerType !== 'touch') data.hover(id) }}
      onPointerLeave={(event) => {
        if (event.pointerType === 'touch') return
        const next = event.relatedTarget
        if (!(next instanceof Element) || next.closest('[data-convax-edge-cut]')?.getAttribute('data-convax-edge-cut') !== id) data.hover(null)
      }}>
      <defs><linearGradient id={gradient} x1={sourceX} y1={sourceY} x2={targetX} y2={targetY} gradientUnits="userSpaceOnUse">
        <stop offset="0%" className={css.blue} stopOpacity="0" />
        <stop offset="25%" className={css.blue} />
        <stop offset="50%" className={css.green} />
        <stop offset="75%" className={css.gold} />
        <stop offset="100%" className={css.blue} />
      </linearGradient></defs>
      <BaseEdge id={id} path={path} className={css.line} interactionWidth={24} />
      {active && <path className={css.flow} d={path} pathLength={1} stroke={`url(#${gradient})`} aria-hidden="true" />}
    </g>
    <EdgeLabelRenderer>
      <div className={`${css.cut} nodrag nopan nowheel`} data-visible={actionVisible || undefined}
        style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${1 / data.zoom})` }}
        onPointerEnter={(event) => { if (event.pointerType !== 'touch') data.hover(id) }} onPointerLeave={(event) => {
          if (event.pointerType === 'touch') return
          const next = event.relatedTarget
          if (!(next instanceof Element) || next.closest('[data-convax-edge]')?.getAttribute('data-convax-edge') !== id) data.hover(null)
        }}>
        <Tooltip label={data.t('connection.cut')} portal>
          <Button size="sm" className={css.cutButton} aria-label={data.t('connection.cut')} data-convax-edge-cut={id}
            disabled={data.busy} onFocus={() => { data.select(id) }} onClick={(event) => {
              event.stopPropagation()
              data.cut([id as CanvasConnectionId])
            }}><Scissors size={16} aria-hidden /></Button>
        </Tooltip>
      </div>
    </EdgeLabelRenderer>
  </>
}
