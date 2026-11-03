/** Native View-selection rows whose containing menu owns focus, dismissal, and placement. */
import { IconCheckOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConversationViewMenuProps } from '../contract/slots.ts'
import { resolveActiveView } from '../view-selection.ts'

/**
 * List every currently registered Conversation View for one Session.
 * @param props - Session store, resolved View roster, selection callback, and containing-menu dismissal.
 * @returns Native menu rows without a separate trigger, popup, or focus owner.
 */
export function ConversationViewMenu({ useConversationViews, useStore, selectView, onDismiss }: ConversationViewMenuProps) {
  const views = useConversationViews(value => value)
  const selected = useStore(state => state.view)
  const active = resolveActiveView(views, selected)
  return <>{views.map(view => <MenuItemButton key={view.id} current={view.id === active?.id}
    icon={view.id === active?.id ? <IconCheckOutlineRegular size={16} /> : null} onSelect={() => {
      selectView(view.id)
      onDismiss()
    }}>{view.label}</MenuItemButton>)}</>
}
