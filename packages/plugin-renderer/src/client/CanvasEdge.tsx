/** Canvas connections keep their cut action and directional highlight on the same curve. */
import { Scissors } from 'lucide-react'
import { useContext, useId, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { NativeCanvasRenderContext } from './canvas-render-primitives.tsx'
import type { NativeCanvasCurve } from './native-canvas-scene.ts'
import type { CanvasZoom } from './canvas-surface-types.ts'
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
  zoom: CanvasZoom
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
  const [path, x, y] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  return <CanvasEdgeStroke {...{ id, data, selected, sourceX, sourceY, targetX, targetY, path, x, y }} />
}

export function NativeCanvasEdge({ curve }: { readonly curve: NativeCanvasCurve }) {
  const { edge, source, target, path, x, y } = curve
  return <CanvasEdgeStroke id={edge.id} data={edge.data} selected={edge.selected}
    sourceX={source.x} sourceY={source.y} targetX={target.x} targetY={target.y} {...{ path, x, y }} native />
}

function CanvasEdgeLabel({ children }: { readonly children: ReactNode }) {
  const canvas = useContext(NativeCanvasRenderContext)
  if (canvas === null) return <EdgeLabelRenderer>{children}</EdgeLabelRenderer>
  return canvas.worldOverlay === null ? null : createPortal(children, canvas.worldOverlay)
}

function CanvasEdgeStroke({ id, data, selected, sourceX, sourceY, targetX, targetY, path, x, y, native = false }: {
  readonly id: string
  readonly data: GraphEdge['data']
  readonly selected: boolean | undefined
  readonly sourceX: number
  readonly sourceY: number
  readonly targetX: number
  readonly targetY: number
  readonly path: string
  readonly x: number
  readonly y: number
  readonly native?: boolean
}) {
  const gradient = useId()
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
      {(!native || active) && <defs><linearGradient id={gradient} x1={sourceX} y1={sourceY} x2={targetX} y2={targetY} gradientUnits="userSpaceOnUse">
        <stop offset="0%" className={css.blue} stopOpacity="0" />
        <stop offset="25%" className={css.blue} />
        <stop offset="50%" className={css.green} />
        <stop offset="75%" className={css.gold} />
        <stop offset="100%" className={css.blue} />
      </linearGradient></defs>}
      {native && !active
        ? <path d={path} className="react-flow__edge-interaction" fill="none" stroke="transparent" strokeWidth={24} pointerEvents="stroke" />
        : <BaseEdge id={id} path={path} className={css.line} interactionWidth={24} />}
      {active && <path className={css.flow} d={path} pathLength={1} stroke={`url(#${gradient})`} aria-hidden="true" />}
    </g>
    {(!native || actionVisible) && <CanvasEdgeCut id={id} data={data} x={x} y={y} visible={actionVisible} />}
  </>
}

const subscribeHiddenCut = () => () => {}

function CanvasEdgeCut({ id, data, x, y, visible }: {
  readonly id: string
  readonly data: NonNullable<GraphEdge['data']>
  readonly x: number
  readonly y: number
  readonly visible: boolean
}) {
  const zoom = useSyncExternalStore(visible ? data.zoom.subscribe : subscribeHiddenCut, data.zoom.getSnapshot, data.zoom.getSnapshot)
  return <CanvasEdgeLabel>
    <div className={`${css.cut} nodrag nopan nowheel`} data-visible={visible || undefined}
      style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${1 / zoom})` }}
      onPointerEnter={(event) => { if (event.pointerType !== 'touch') data.hover(id) }} onPointerLeave={(event) => {
        if (event.pointerType === 'touch') return
        const next = event.relatedTarget
        if (!(next instanceof Element) || next.closest('[data-convax-edge]')?.getAttribute('data-convax-edge') !== id) data.hover(null)
      }}>
      <Tooltip label={data.t('connection.cut')} side="top" portal>
        <Button size="sm" className={css.cutButton} aria-label={data.t('connection.cut')} data-convax-edge-cut={id}
          disabled={data.busy} onFocus={() => { data.select(id) }} onClick={(event) => {
            event.stopPropagation()
            data.cut([id as CanvasConnectionId])
          }}><Scissors size={16} aria-hidden /></Button>
      </Tooltip>
    </div>
  </CanvasEdgeLabel>
}
