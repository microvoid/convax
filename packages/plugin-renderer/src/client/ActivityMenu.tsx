/** Window-level activity stays in a compact, anchored navigation surface. */
import { useRef, useState, type CSSProperties, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Bell, CircleCheck, CircleHelp, X } from 'lucide-react'
import {
  Button, MenuSurface, Tooltip, relativeTime, useAnchoredPosition, useDismissOnOutsidePointer, useModalLayer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { CanvasActivityItem } from './activity.ts'
import type { WorkspaceProps } from './props.ts'
import css from './ActivityMenu.module.css'

interface ActivityProps {
  readonly locale?: string
  readonly items: readonly CanvasActivityItem[]
  readonly busy: boolean
  readonly t: WorkspaceProps['t']
  readonly onSelect: (item: CanvasActivityItem) => Promise<boolean>
  readonly onReadAll: () => void
}

const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/**
 * Show an unread badge without consuming notifications when the list opens.
 * @param props - Current activities and owner-controlled acknowledgement and navigation.
 * @returns The persistent activity entry and its dismissible overlay.
 */
export function ActivityMenu(props: ActivityProps) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const unread = props.items.filter(item => item.unread).length
  return <>
    <Tooltip label={props.t('activity.title')} side="bottom" portal>
      <Button ref={anchor} size="sm" className={css.trigger} aria-haspopup="dialog" aria-expanded={open}
        aria-label={props.t(unread === 0 ? 'activity.title' : 'activity.unreadLabel', { count: new Intl.NumberFormat(props.locale ?? 'en').format(unread) })}
        onClick={() => { setOpen(value => !value) }}>
        <Bell size={14} aria-hidden /><span>{props.t('activity.title')}</span>
        {unread > 0 && <span className={css.badge} aria-hidden>{unread > 99 ? '99+' : new Intl.NumberFormat(props.locale ?? 'en').format(unread)}</span>}
      </Button>
    </Tooltip>
    {open && <ActivityPanel {...props} anchorRef={anchor} unread={unread} close={() => { setOpen(false) }} />}
  </>
}

function ActivityPanel({ items, busy, t, locale = 'en', onSelect, onReadAll, anchorRef, unread, close }: ActivityProps & {
  readonly anchorRef: RefObject<HTMLButtonElement | null>
  readonly unread: number
  readonly close: () => void
}) {
  const panel = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const [opening, setOpening] = useState(false)
  const position = useAnchoredPosition({ open: true, anchorRef, panelRef: panel, align: 'end', gap: 6, margin: 12 })
  useDismissOnOutsidePointer(anchorRef, true, close, panel)
  useModalLayer(panel, position !== null, close)
  const choose = async (item: CanvasActivityItem): Promise<void> => {
    if (opening || busy) return
    setOpening(true)
    try { if (await onSelect(item)) close() }
    finally { setOpening(false) }
  }
  const now = Date.now()
  return createPortal(<MenuSurface ref={panel} className={css.panel} style={position ?? MEASURE_STYLE}
    role="dialog" aria-modal="true" aria-label={t('activity.title')} tabIndex={-1}
    onPointerDown={(event) => { event.stopPropagation() }} onClick={(event) => { event.stopPropagation() }}>
    <header className={css.header}>
      <h2>{t('activity.title')}</h2>
      <Button size="sm" disabled={unread === 0} onClick={() => {
        const next = panel.current?.querySelector<HTMLButtonElement>('[data-convax-activity-session]:not(:disabled)') ?? closeButton.current
        next?.focus()
        onReadAll()
      }}>{t('activity.markAll')}</Button>
      <Tooltip label={t('activity.close')} portal>
        <Button ref={closeButton} size="sm" aria-label={t('activity.close')} onClick={close}
          data-modal-autofocus={items.length === 0 || undefined}><X size={16} aria-hidden /></Button>
      </Tooltip>
    </header>
    <div className={css.list}>
      {items.length === 0 ? <div className={css.empty}><Bell size={24} aria-hidden /><p>{t('activity.empty')}</p></div>
        : <ul className={css.rows}>{items.map((item, index) => {
          const state = t(item.kind === 'attention' ? 'activity.attention' : 'activity.completed')
          const time = relativeTime(item.occurredAt, now)
          return <li key={item.sessionId}>
            <button type="button" className={css.row} disabled={busy || opening}
              data-convax-activity-session={item.sessionId} data-unread={item.unread || undefined}
              data-modal-autofocus={index === 0 || undefined}
              aria-label={t('activity.itemLabel', { title: item.title, state })}
              aria-description={item.unread ? t('activity.unread') : undefined}
              onClick={() => { void choose(item) }}>
              <span className={css.dot} aria-hidden />
              <span className={css.content}>
                <span className={css.summary}>
                  <span className={css.title} title={item.title}>{item.title}</span>
                  <span className={css.state}>{item.kind === 'attention'
                    ? <CircleHelp size={12} aria-hidden /> : <CircleCheck size={12} aria-hidden />}{state}</span>
                </span>
                <span className={css.metadata}>
                  <span className={css.canvas} title={item.canvasTitle}>{item.canvasTitle}</span>
                  <time data-convax-activity-time dateTime={new Date(item.occurredAt).toISOString()}
                    title={new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(item.occurredAt)}>
                    {t(`activity.time.${time.unit}`, { count: new Intl.NumberFormat(locale).format(time.n) })}
                  </time>
                </span>
              </span>
            </button>
          </li>
        })}</ul>}
    </div>
  </MenuSurface>, document.body)
}
