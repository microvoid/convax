/** Session-owned native controls anchored outside the canvas transform. */
import { useEffect, useRef, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { Button, MenuSurface, Tooltip, useAnchoredPosition, useDismissOnOutsidePointer, useModalLayer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatSettingsProps } from '@deepseek-ai/dsh-convax-plugin-renderer/client'
import css from './ChatSettings.module.css'

const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/**
 * Present native Conversation actions and tools for the retained Session.
 * @param props - Session-scoped slots, localized copy, trigger and dismissal owner.
 * @returns A body-portaled dialog positioned from the active thread dropdown.
 */
export function ChatSettings({ anchorRef, title, onClose, renderFactorySlot, t }: ChatSettingsProps) {
  const panel = useRef<HTMLDivElement>(null)
  const position = useAnchoredPosition({ open: true, anchorRef, panelRef: panel, align: 'start', gap: 4, margin: 12 })
  useDismissOnOutsidePointer(anchorRef, true, onClose, panel)
  useModalLayer(panel, true, onClose)
  useEffect(() => {
    const dismissOnScroll = (event: Event) => {
      const target = event.target
      if (target instanceof Node && (panel.current?.contains(target) || anchorRef.current?.contains(target))) return
      // Native child menus and dialogs may portal their scroll container.
      if (target instanceof Element && target.closest('[role="menu"], [role="dialog"]') !== null) return
      onClose()
    }
    window.addEventListener('wheel', dismissOnScroll, { passive: true })
    window.addEventListener('scroll', dismissOnScroll, true)
    return () => {
      window.removeEventListener('wheel', dismissOnScroll)
      window.removeEventListener('scroll', dismissOnScroll, true)
    }
  }, [anchorRef, onClose])
  return createPortal(<MenuSurface ref={panel} className={css.panel} style={position ?? MEASURE_STYLE}
    role="dialog" aria-modal="true" aria-label={t('chat.settings')} tabIndex={-1}
    onPointerDown={(event) => { event.stopPropagation() }} onClick={(event) => { event.stopPropagation() }}
    onWheel={(event) => { event.stopPropagation() }}>
    <header className={css.header}>
      <div className={css.heading}>
        <h2 className={css.title}>{t('chat.settings')}</h2>
        <p className={css.sessionTitle}>{title}</p>
      </div>
      <Tooltip label={t('chat.closeSettings')} portal>
        <Button size="sm" aria-label={t('chat.closeSettings')} onClick={onClose}><X size={16} aria-hidden /></Button>
      </Tooltip>
    </header>
    <section className={css.section} aria-label={t('chat.settingsConversation')}>
      <h3 className={css.sectionTitle}>{t('chat.settingsConversation')}</h3>
      <div className={css.controls}>{renderFactorySlot('conversation.header.content', { hideChrome: false, presentation: 'actions' })}</div>
    </section>
    <section className={css.section} aria-label={t('chat.settingsTools')}>
      <h3 className={css.sectionTitle}>{t('chat.settingsTools')}</h3>
      <div className={css.controls}>{renderFactorySlot('conversation.header.content', { hideChrome: false, presentation: 'utilities' })}</div>
    </section>
  </MenuSurface>, document.body)
}
