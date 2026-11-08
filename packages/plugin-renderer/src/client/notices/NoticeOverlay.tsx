/** Global notice presentation; scheduling, persistence and actions belong to the owning controller. */
import { useEffect } from 'react'
import { Button, Modal, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { NoticePresentation } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type {} from '../props.ts'
import css from './NoticeOverlay.module.css'

/** Current window's presentation and operation feedback. */
export interface NoticeOverlaySnapshot {
  presentation: NoticePresentation | null
  busy: boolean
  error: string | null
}

/** Registrar-owned observation and commands, independent of component remounts. */
export interface NoticeOverlayInjected {
  hooks: { notice: HostObservable<NoticeOverlaySnapshot> }
  shown: (presentationId: NoticePresentation['id']) => void
  close: (presentationId: NoticePresentation['id']) => void
  action: (presentationId: NoticePresentation['id'], actionId: string) => void
  expired: (presentationId: NoticePresentation['id']) => void
}

/** Shell-derived presentation, locale and the owning notice controller's injected face. */
export type NoticeOverlayProps = PropsRuntime<'shell.overlay'> & PropsLocale<'convax'> & InjectFace<NoticeOverlayInjected>

/**
 * Render the current notice without deciding eligibility or recording an unseen candidate.
 * @param props - One window's observable presentation, localized copy and controller commands.
 * @returns A modal, generic banner, transient message, or nothing when no notice is granted.
 */
export function NoticeOverlay(props: NoticeOverlayProps) {
  const snapshot = props.useNotice(value => value)
  const presentation = snapshot.presentation
  const id = presentation?.id
  useEffect(() => {
    if (id === undefined) return
    const reportVisible = (): void => {
      if (document.visibilityState === 'visible') props.shown(id)
    }
    reportVisible()
    document.addEventListener('visibilitychange', reportVisible)
    return () => { document.removeEventListener('visibilitychange', reportVisible) }
  }, [id, props.shown])
  if (presentation === null) return null
  const title = presentation.kind === 'mandatory-update' ? props.t('notices.mandatory.title') : presentation.title
  const body = presentation.kind === 'mandatory-update' ? props.t('notices.mandatory.body') : presentation.body
  const label = (item: NoticePresentation['actions'][number]): string => presentation.kind === 'mandatory-update'
    ? props.t(item.type === 'open_update' ? 'notices.openUpdate' : 'notices.downloadPage') : item.label
  const primary = presentation.actions.find(item => item.type === 'open_update')
    ?? presentation.actions.find(item => item.type !== 'dismiss' && item.type !== 'snooze')
  const initialAction = presentation.actions.find(item => item.type === 'dismiss' || item.type === 'snooze')
  const close = (): void => { if (presentation.dismissible && !snapshot.busy) props.close(presentation.id) }
  const buttons = presentation.actions.map(item => (
    <Button key={item.id} variant={item === primary ? 'primary' : 'outline'}
      disabled={snapshot.busy} onClick={() => { props.action(presentation.id, item.id) }}
      data-modal-autofocus={item === initialAction || undefined}>{label(item)}</Button>
  ))
  switch (presentation.surface) {
    case 'message': {
      const text = [title, body, snapshot.error].filter(Boolean).join(' · ')
      return <>
        <span data-convax-notice={presentation.id} hidden />
        {/* A failed action needs a fresh reading interval; exposure remains keyed by the presentation. */}
        <Toast key={`${presentation.id}:${snapshot.error ?? ''}`} text={text} {...presentation.holdMs === undefined ? {} : { holdMs: presentation.holdMs }}
          actions={presentation.actions.map(item => ({ label: label(item), onClick: () => {
            if (!snapshot.busy) props.action(presentation.id, item.id)
          } }))}
          onDone={() => { props.expired(presentation.id) }} />
      </>
    }
    case 'banner': {
      return <section className={css.banner} data-convax-notice={presentation.id} role="status" aria-label={title}>
        <div className={css.copy}><h2>{title}</h2><p>{body}</p>
          {snapshot.error !== null && <p className={css.error} role="alert">{snapshot.error}</p>}
        </div>
        <div className={css.actions}>{buttons}
          {presentation.dismissible && <Button size="sm" disabled={snapshot.busy} onClick={close}>{props.t('notices.close')}</Button>}
        </div>
      </section>
    }
    case 'modal':
      return (
        <Modal open headless title={title} onClose={close} className={css.dialog ?? ''}>
          <section className={css.content} data-convax-notice={presentation.id} aria-busy={snapshot.busy}>
            <header className={css.header}>
              <h2 data-modal-autofocus={!presentation.dismissible || undefined}
                tabIndex={presentation.dismissible ? undefined : -1} onKeyDown={(event) => {
                  if (presentation.dismissible || event.key !== 'Tab') return
                  event.preventDefault()
                  const controls = event.currentTarget.closest('[role="dialog"]')?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
                  const target = event.shiftKey ? controls?.item(controls.length - 1) : controls?.item(0)
                  target?.focus()
                }}>{title}</h2>
              {presentation.dismissible && <Button size="sm" disabled={snapshot.busy} onClick={close}>{props.t('notices.close')}</Button>}
            </header>
            <p className={css.body}>{body}</p>
            {snapshot.error !== null && <p className={css.error} role="alert">{snapshot.error}</p>}
            <footer className={css.actions}>{buttons}</footer>
          </section>
        </Modal>
      )
    default: return assertNever(presentation.surface)
  }
}
