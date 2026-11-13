/** Pointer-following canvas tabs with local reorder previews and retained keyboard focus. */
import { ChevronDown, Plus, X } from 'lucide-react'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CanvasId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { WorkspaceProps } from './props.ts'
import { useTabReorder } from './use-tab-reorder.ts'
import css from './Workspace.module.css'
import reorderCss from './TabReorder.module.css'
import tabCss from './CanvasTabs.module.css'

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
  readonly onShowAll?: (() => void) | undefined
  readonly allButtonRef?: RefObject<HTMLButtonElement> | undefined
  readonly allOpen?: boolean | undefined
  readonly create?: (() => void) | undefined
  readonly busy?: boolean | undefined
  readonly t: WorkspaceProps['t']
}

/**
 * Move a tab with the pointer while neighboring tabs preview the saved insertion position.
 * @param props - Canvas identities, selection, localized labels, and window preference actions.
 * @returns A bounded strip with pointer and keyboard sorting and access to overflowed canvases.
 */
export function CanvasTabs({
  tabs, activeId, open, close, move, rename, onShowAll, allButtonRef, allOpen = false, create, busy, t,
}: CanvasTabsProps) {
  const reorder = useTabReorder(tabs, move)
  const container = useRef<HTMLDivElement>(null)
  const internalButton = useRef<HTMLButtonElement>(null)
  const allButton = allButtonRef ?? internalButton
  const focusedTab = useRef<string | null>(null)
  const previousAllOpen = useRef(allOpen)
  const [width, setWidth] = useState(0)
  const bounded = onShowAll !== undefined
  useEffect(() => {
    const element = container.current
    if (!bounded || element === null) return
    let disposed = false
    const measure = (): void => {
      if (disposed) return
      setWidth(element.clientWidth)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => { disposed = true; observer.disconnect() }
  }, [bounded])
  const available = width - (create === undefined ? 0 : 32)
  const fitting = Math.floor((available + 2 - (allOpen ? 32 : 0)) / 114)
  const capacity = fitting >= tabs.length ? fitting : Math.max(1, Math.floor((available - 30) / 114))
  const shown = new Set(tabs.slice(0, capacity).map(tab => tab.id))
  if (activeId !== undefined && tabs.some(tab => tab.id === activeId) && !shown.has(activeId)) {
    const last = tabs[capacity - 1]
    if (last !== undefined) shown.delete(last.id)
    shown.add(activeId)
  }
  const visibleTabs = bounded ? tabs.filter(tab => shown.has(tab.id)) : tabs
  const overflow = bounded && (allOpen || visibleTabs.length < tabs.length)
  const visibleIds = JSON.stringify(visibleTabs.map(tab => tab.id))
  useEffect(() => {
    const closed = previousAllOpen.current && !allOpen
    previousAllOpen.current = allOpen
    if (closed && !overflow && document.activeElement === document.body) {
      reorder.strip.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true })
      return
    }
    const focused = focusedTab.current
    if (focused !== null && !visibleTabs.some(tab => tab.id === focused) && document.activeElement === document.body) {
      focusedTab.current = null
      allButton.current?.focus({ preventScroll: true })
    }
  }, [visibleIds, allOpen, overflow])
  return <div ref={container} className={tabCss.container}
    onFocusCapture={(event) => { focusedTab.current = event.target.closest<HTMLElement>('[data-canvas-tab]')?.dataset.canvasTab ?? null }}
    onBlurCapture={() => { focusedTab.current = null }}>
    <div ref={reorder.strip} className={`${css.tabs} ${reorderCss.strip} ${bounded ? tabCss.bounded : ''}`}
      style={bounded ? { maxWidth: Math.max(0, visibleTabs.length * 162 - 2) } : undefined}
      role="tablist" aria-label={t('canvas.all')} data-reordering={reorder.dragging || undefined}>
      {visibleTabs.map(canvas => <div key={canvas.id} className={`${css.tab} ${reorderCss.tab}`} data-canvas-tab={canvas.id}
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
    {overflow && <Tooltip label={t('canvas.all')} side="bottom" portal>
      <Button ref={allButton} size="sm" className={tabCss.allButton} aria-label={t('canvas.all')}
        aria-haspopup="dialog" aria-expanded={allOpen} onClick={onShowAll}><ChevronDown size={14} aria-hidden /></Button>
    </Tooltip>}
    {create !== undefined && <Tooltip label={t('canvas.new')} side="bottom" portal>
      <Button size="sm" className={css.chromeButton} disabled={busy} aria-label={t('canvas.new')} onClick={create}>
        <Plus size={14} aria-hidden />
      </Button>
    </Tooltip>}
  </div>
}
