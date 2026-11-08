/** Transparent group frames leave their card contents and canvas gestures reachable. */
import type { PointerEvent, MouseEvent } from 'react'
import type { CanvasGroupBounds } from './canvas-grouping.ts'
import css from './CanvasGroupFrame.module.css'

/** Render only a group's title as an interactive drag and context-menu target. */
export function CanvasGroupFrame({ frame, selected, busy, select, drag, context, rename }: {
  readonly frame: CanvasGroupBounds
  readonly selected: boolean
  readonly busy: boolean
  readonly select: (extend: boolean) => void
  readonly drag: (event: PointerEvent<HTMLElement>) => void
  readonly context: (event: MouseEvent<HTMLElement>) => void
  readonly rename: () => void
}) {
  return <section className={css.frame} data-convax-group={frame.id} data-selected={selected || undefined}
    style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}>
    <div className={`${css.header} nodrag nopan nowheel`} data-convax-group-header={frame.id}
      tabIndex={0} role="group" aria-label={frame.title}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        event.currentTarget.focus({ preventScroll: true })
        select(event.shiftKey || event.metaKey || event.ctrlKey)
        if (!busy) drag(event)
      }}
      onClick={(event) => { event.stopPropagation() }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        event.stopPropagation()
        select(event.shiftKey || event.metaKey || event.ctrlKey)
      }}
      onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); if (!busy) rename() }}
      onContextMenu={context}>
      <span data-convax-group-title={frame.id}>{frame.title}</span>
    </div>
  </section>
}
