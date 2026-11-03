/** Pointer-following canvas tabs with local reorder previews and retained keyboard focus. */
import { X } from 'lucide-react'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CanvasId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { WorkspaceProps } from './props.ts'
import { useTabReorder } from './use-tab-reorder.ts'
import css from './Workspace.module.css'
import reorderCss from './TabReorder.module.css'

interface CanvasTab {
  readonly id: CanvasId
  readonly title: string
}

/** Inputs for one window's canvas tab strip; preview movement never writes the saved order. */
export interface CanvasTabsProps {
  readonly tabs: readonly CanvasTab[]
  readonly activeId: CanvasId | undefined
  readonly open: (id: CanvasId) => void
  readonly close: (id: CanvasId) => void
  readonly move: (id: CanvasId, target: CanvasId, side: 'before' | 'after') => void
  readonly rename: (id: CanvasId, title: string) => void
  readonly t: WorkspaceProps['t']
}

/**
 * Move a tab with the pointer while neighboring tabs preview the saved insertion position.
 * @param props - Canvas identities, selection, localized labels, and window preference actions.
 * @returns A horizontally scrollable strip with pointer and keyboard sorting.
 */
export function CanvasTabs({ tabs, activeId, open, close, move, rename, t }: CanvasTabsProps) {
  const reorder = useTabReorder(tabs, move)
  return <div ref={reorder.strip} className={`${css.tabs} ${reorderCss.strip}`} role="tablist" aria-label={t('canvas.all')} data-reordering={reorder.dragging || undefined}>
    {tabs.map(canvas => <div key={canvas.id} className={`${css.tab} ${reorderCss.tab}`} data-canvas-tab={canvas.id}
      data-active={canvas.id === activeId || undefined} {...reorder.item(canvas.id)}>
      <Tooltip label={canvas.title} disabled={reorder.dragging} side="bottom" portal>
        <button type="button" role="tab" aria-selected={canvas.id === activeId} className={css.tabTitle}
          {...reorder.button(canvas.id)} onClick={() => { open(canvas.id) }}
          onDoubleClick={() => { rename(canvas.id, canvas.title) }}>{canvas.title}</button>
      </Tooltip>
      <Tooltip label={t('canvas.close', { name: canvas.title })} side="bottom" portal>
        <Button size="sm" className={`${css.chromeButton} ${css.tabClose}`}
          aria-label={t('canvas.close', { name: canvas.title })} onClick={() => { close(canvas.id) }}>
          <X size={12} aria-hidden />
        </Button>
      </Tooltip>
    </div>)}
  </div>
}
