/** Chat-local thread navigation using the same pointer-following order preview as canvas tabs. */
import { ChevronDown, Plus } from 'lucide-react'
import { useRef } from 'react'
import { Button, Menu, MenuItemButton, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ChatProps } from './props.ts'
import { useTabReorder } from './use-tab-reorder.ts'
import css from './ChatCard.module.css'
import reorderCss from './TabReorder.module.css'

interface ThreadTab {
  readonly id: SessionId
  readonly title: string
  readonly status?: string
}

/** Navigation data and actions for one Chat's retained Sessions. */
export type ThreadTabsProps = Pick<ChatProps, 't' | 'SessionProvider' | 'renderSlot' | 'renderFactorySlot'> & {
  readonly tabs: readonly ThreadTab[]
  readonly activeId: SessionId | undefined
  readonly reference: SessionReference | undefined
  readonly menuOpen: boolean
  readonly settingsOpen: boolean
  readonly disabled: boolean
  readonly select: (id: SessionId) => void
  readonly move: (id: SessionId, target: SessionId, side: 'before' | 'after') => void
  readonly setMenuOpen: (open: boolean) => void
  readonly setSettingsOpen: (open: boolean) => void
  readonly fork: (id: SessionId) => void
  readonly create: () => void
}

/**
 * Keep thread sorting previews independent from the retained conversation flow.
 * @param props - Visible thread identities, native menu rendering, and Chat navigation actions.
 * @returns Sortable tabs followed immediately by the new-thread button.
 */
export function ThreadTabs(props: ThreadTabsProps) {
  const { tabs, activeId, reference, t, SessionProvider, renderSlot, renderFactorySlot } = props
  const reorder = useTabReorder(tabs, props.move)
  const settingsAnchor = useRef<HTMLButtonElement>(null)
  return <div className={css.threadNavigation}>
    <div ref={reorder.strip} className={`${css.threadTabs} ${reorderCss.strip} nodrag nopan nowheel`} role="tablist" aria-label={t('chat.threads')}
      data-reordering={reorder.dragging || undefined}>
      {tabs.map(thread => <div key={thread.id} className={`${css.threadTab} ${reorderCss.tab}`} data-thread-tab={thread.id}
        data-active={thread.id === activeId || undefined} {...reorder.item(thread.id)}>
        <Tooltip label={thread.title} disabled={reorder.dragging} portal>
          <button {...reorder.button(thread.id)} className={`${css.threadButton} nodrag nopan`} type="button" role="tab"
            aria-selected={thread.id === activeId} onClick={() => { props.select(thread.id) }}>
            <span className={css.threadTitle}>{thread.title}</span>
            {thread.status !== undefined && <span className={css.threadStatus}>{thread.status}</span>}
          </button>
        </Tooltip>
        {thread.id === activeId && <Menu open={props.menuOpen} portal align="start" className="nodrag nopan"
          onClose={() => { props.setMenuOpen(false) }}
          anchor={<Button ref={settingsAnchor} size="sm" aria-label={t('chat.threadActions')} onClick={() => {
            props.setSettingsOpen(false)
            props.setMenuOpen(!props.menuOpen)
          }}>
            <ChevronDown size={12} aria-hidden />
          </Button>}>
          {reference !== undefined && <SessionProvider session={reference}>
            {renderSlot('convax.chat.views', { onDismiss: () => { props.setMenuOpen(false) } })}
          </SessionProvider>}
          <MenuItemButton separatorBefore disabled={reference === undefined} onSelect={() => {
            props.setMenuOpen(false)
            props.setSettingsOpen(true)
          }}>{t('chat.settings')}</MenuItemButton>
          <MenuItemButton separatorBefore disabled={props.disabled} onSelect={() => { props.setMenuOpen(false); props.fork(thread.id) }}>{t('chat.fork')}</MenuItemButton>
          {renderFactorySlot('workspace.session.archive', {
            sessionId: thread.id, disabled: props.disabled, onDismiss: () => { props.setMenuOpen(false) },
          })}
        </Menu>}
        {thread.id === activeId && props.settingsOpen && reference !== undefined && <SessionProvider session={reference}>
          {renderFactorySlot('convax.chat.settings', {
            anchorRef: settingsAnchor, title: thread.title,
            onClose: () => { props.setSettingsOpen(false); settingsAnchor.current?.focus({ preventScroll: true }) },
          })}
        </SessionProvider>}
      </div>)}
    </div>
    <Tooltip label={t('chat.newThread')} portal>
      <Button size="sm" className="nodrag nopan nowheel" aria-label={t('chat.newThread')} disabled={props.disabled} onClick={props.create}>
        <Plus size={16} aria-hidden />
      </Button>
    </Tooltip>
  </div>
}
