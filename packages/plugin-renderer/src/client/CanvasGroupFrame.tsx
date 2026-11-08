/** Group frames leave their card contents and canvas gestures reachable. */
import type { PointerEvent, MouseEvent } from 'react'
import { Palette } from 'lucide-react'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CanvasGroupBounds } from './canvas-grouping.ts'
import type { WorkspaceProps } from './props.ts'
import css from './CanvasGroupFrame.module.css'
import colors from './GroupColors.module.css'

/** Render only a group's title as an interactive drag and context-menu target. */
export function CanvasGroupFrame({ frame, selected, busy, select, drag, context, rename, color, currentColor, t }: {
  readonly frame: CanvasGroupBounds
  readonly selected: boolean
  readonly busy: boolean
  readonly select: (extend: boolean) => void
  readonly drag: (event: PointerEvent<HTMLElement>) => void
  readonly context: (event: MouseEvent<HTMLElement>) => void
  readonly rename: () => void
  readonly color: (anchor: HTMLElement) => void
  readonly currentColor: string
  readonly t: WorkspaceProps['t']
}) {
  return <section className={`${css.frame} ${colors.color}`} data-convax-group={frame.id}
    data-color={frame.color ?? 'default'} data-selected={selected || undefined}
    style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}>
    <div className={`${css.header} nodrag nopan nowheel`} data-convax-group-header={frame.id}
      tabIndex={0} role="group" aria-label={frame.title}
      onPointerDown={(event) => {
        if (event.target instanceof Element && event.target.closest('button') !== null) return
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        event.currentTarget.focus({ preventScroll: true })
        select(event.shiftKey || event.metaKey || event.ctrlKey)
        if (!busy) drag(event)
      }}
      onClick={(event) => { event.stopPropagation() }}
      onKeyDown={(event) => {
        if (event.target instanceof Element && event.target.closest('button') !== null) return
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        event.stopPropagation()
        select(event.shiftKey || event.metaKey || event.ctrlKey)
      }}
      onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); if (!busy) rename() }}
      onContextMenu={context}>
      <span className={css.title} data-convax-group-title={frame.id}>{frame.title}</span>
      {selected && <Tooltip label={t('group.color')} side="top" portal>
        <Button size="sm" className={css.colorButton} aria-label={t('group.color')}
          data-convax-group-color-trigger={frame.id} disabled={busy} onClick={(event) => {
            event.stopPropagation(); color(event.currentTarget)
          }} onPointerDown={(event) => { event.stopPropagation() }} onDoubleClick={(event) => { event.stopPropagation() }}>
          <span className={colors.color} data-color={currentColor}>
            <span className={colors.dot} data-mixed={currentColor === 'mixed' || undefined} aria-hidden="true" />
          </span>
          <Palette size={14} aria-hidden />
        </Button>
      </Tooltip>}
    </div>
  </section>
}
