/** Shared actions above the single selected canvas card, independent of canvas zoom. */
import { AppWindow, FolderOpen, Maximize2, MessageCirclePlus, Settings, Trash2 } from 'lucide-react'
import { Fragment, type MouseEvent } from 'react'
import { NodeToolbar, Position } from '@xyflow/react'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CanvasNodeId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { WorkspaceProps } from './props.ts'
import css from './CardToolbar.module.css'

/** One directly reachable card action, with a Lucide icon and localized name. */
export interface CardToolbarAction {
  id: 'zoom' | 'source' | 'window' | 'chat' | 'conversation' | 'remove'
  label: string
  disabled?: boolean
  expanded?: boolean
  onClick: (event: MouseEvent<HTMLButtonElement>) => void
}

const ICONS = {
  zoom: Maximize2,
  source: FolderOpen,
  window: AppWindow,
  chat: MessageCirclePlus,
  conversation: Settings,
  remove: Trash2,
}

/**
 * Keep node actions outside card content while preserving their owning callbacks.
 * @param props - Node identity and localized action data with owning callbacks.
 * @returns A screen-sized toolbar shown for the single selected node.
 */
export function CardToolbar({ nodeId, name, actions, t }: {
  nodeId: CanvasNodeId
  name: string
  actions: readonly CardToolbarAction[]
  t: WorkspaceProps['t']
}) {
  return <NodeToolbar nodeId={nodeId} position={Position.Top} className={`${css.toolbar} nodrag nopan nowheel`}
    role="toolbar" aria-label={t('node.actions', { name })}>
    {actions.map((action, index) => {
      const Icon = ICONS[action.id]
      return <Fragment key={action.id}>
        {action.id === 'remove' && index > 0 && <span className={css.separator} role="separator" />}
        <Tooltip label={action.label} side="top" portal>
          <Button size="sm" aria-label={action.label} disabled={action.disabled} onClick={action.onClick}
            aria-haspopup={action.id === 'conversation' ? 'dialog' : undefined} aria-expanded={action.expanded}>
            <Icon size={16} aria-hidden />
          </Button>
        </Tooltip>
      </Fragment>
    })}
  </NodeToolbar>
}
