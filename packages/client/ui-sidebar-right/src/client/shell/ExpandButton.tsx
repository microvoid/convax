/** Session-bound header entry for native panels and persistent embedded-panel toggles. */
import type { ShortcutCatalogEntry } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { InjectFace, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReactNode } from 'react'
import { Button, IconPanelLeftOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { createSidebarRightStore } from '../stores.ts'
import css from './ExpandButton.module.css'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspacePresentation } from '@deepseek-ai/dsh-client-ui-layout/client'

/** The button's props: the header corner seat, the shared store, and copy. */
export type ExpandButtonProps =
  & PropsRuntime<'conversation.session.header.corner'>
  & PropsStore<ReturnType<typeof createSidebarRightStore>>
  & PropsLocale<'sidebarRight'>
  & InjectFace<{
    hooks: {
      shortcuts: HostObservable<readonly ShortcutCatalogEntry[]>
      workspacePresentation: HostObservable<WorkspacePresentation>
      embeddedSessions: HostObservable<readonly SessionId[]>
    }
    expand: () => void
  }>

/** The embedded panel's persistent toggle, or the native frame's collapsed-panel entry. */
export function ExpandButton({
  sessionId, useStore, actions, t, useShortcuts, useWorkspacePresentation, useEmbeddedSessions, expand,
}: ExpandButtonProps): ReactNode {
  // A session with no surface yet is collapsed: the panel seat materializes the
  // surface on its own mount, and until then there is nothing expanded.
  const shortcut = useShortcuts(entries => entries.find(entry => entry.id === 'sidebar.right.toggle'))
  const expanded = useStore(state => state.bySession[sessionId]?.layout.expanded ?? false)
  const workspace = useWorkspacePresentation(value => value)
  const embedded = useEmbeddedSessions(ids => ids.includes(sessionId))
  const shown = workspace.active && !embedded ? workspace.rightbarOpen && workspace.sessionId === sessionId : expanded
  if (shown && !embedded) return null
  return (
    <Tooltip label={t(shown ? 'chrome.collapse' : 'chrome.expand')} shortcutKeys={shortcut?.keys} side="bottom" delayMs={500}>
      <Button
        size="sm"
        className={css.button}
        aria-label={t(shown ? 'chrome.collapseAria' : 'chrome.expandAria')}
        aria-expanded={shown}
        aria-keyshortcuts={shortcut?.aria}
        data-sidebar-right-expand
        data-expanded={shown || undefined}
        onClick={() => { if (embedded && shown) actions.setExpanded(sessionId, false); else expand() }}
      >
        <IconPanelLeftOutlineRegular className={css.icon} />
      </Button>
    </Tooltip>
  )
}
