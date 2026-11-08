/** Canvas, node and selection actions use the shared viewport-fitting menu. */
import { Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CanvasGroup, CanvasGroupId, CanvasPoint } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { WorkspaceProps } from './props.ts'

/**
 * Render context actions at an untransformed screen coordinate.
 * @param props - Pointer anchor, target count, localized labels and owner actions.
 * @returns A portaled menu with native Escape, outside-click and keyboard handling.
 */
export function CanvasContextMenu({
  point, targetCount, busy, history, replayHistory, t, close, creations,
  focus, remove, selectAll, fit, copy, paste, duplicate,
  groupCount = 0, groups = [], canRemoveFromGroup = false, canGroup = true, group, ungroup, renameGroup, assignGroup,
}: {
  readonly point: CanvasPoint
  readonly targetCount: number
  readonly busy: boolean
  readonly history: { readonly canUndo: boolean; readonly canRedo: boolean; readonly pending: boolean }
  readonly replayHistory: (direction: 'undo' | 'redo') => void
  readonly t: WorkspaceProps['t']
  readonly close: () => void
  readonly creations: readonly { id: string; label: string; create: () => void }[]
  readonly focus: () => void
  readonly remove: () => void
  readonly selectAll: () => void
  readonly fit: () => void
  readonly copy: () => void
  readonly paste: () => void
  readonly duplicate: () => void
  readonly groupCount?: number
  readonly groups?: readonly CanvasGroup[]
  readonly canRemoveFromGroup?: boolean
  readonly canGroup?: boolean
  readonly group?: (() => void) | undefined
  readonly ungroup?: (() => void) | undefined
  readonly renameGroup?: (() => void) | undefined
  readonly assignGroup?: ((groupId: CanvasGroupId | null) => void) | undefined
}) {
  return <Menu open portal autoFocus anchor={<span data-convax-context-menu="" data-target-count={targetCount} aria-hidden="true" />}
    getAnchorRect={() => new DOMRect(point.x, point.y, 0, 0)} onClose={close}
    items={[...(targetCount === 0 ? [
      ...creations.map(entry => ({ id: `create:${entry.id}`, label: entry.label, disabled: busy })),
      { type: 'separator', id: 'clipboard' },
      { id: 'paste', label: t('clipboard.paste'), disabled: busy },
      { type: 'separator', id: 'view' },
      { id: 'all', label: t('canvas.selectAll') },
      { id: 'fit', label: t('canvas.zoom.fit') },
    ] satisfies MenuEntry[] : [
      { id: 'focus', label: t('selection.focus') },
      { id: 'copy', label: t('clipboard.copy'), disabled: busy },
      { id: 'duplicate', label: t('clipboard.duplicate'), disabled: busy },
      { id: 'paste', label: t('clipboard.paste'), disabled: busy },
      ...(targetCount >= 2 && canGroup && group !== undefined ? [{ id: 'group', label: t('group.create'), disabled: busy }] : []),
      ...(groupCount > 0 && ungroup !== undefined ? [{ id: 'ungroup', label: t('group.ungroup'), disabled: busy }] : []),
      ...(renameGroup !== undefined ? [{ id: 'rename-group', label: t('group.rename'), disabled: busy }] : []),
      ...(assignGroup !== undefined && groups.length > 0 ? [{ id: 'assign-group', label: t('group.addTo'), disabled: busy,
        submenu: groups.map(item => ({ id: `group:${item.id}`, label: item.title, disabled: busy })) }] : []),
      ...(canRemoveFromGroup && assignGroup !== undefined ? [{ id: 'leave-group', label: t('group.removeFrom'), disabled: busy }] : []),
      { id: 'remove', label: t(groupCount > 0 ? 'group.delete' : 'selection.remove'), disabled: busy, danger: true },
      { type: 'separator', id: 'view' },
      { id: 'all', label: t('canvas.selectAll') },
      { id: 'fit', label: t('canvas.zoom.fit') },
    ] satisfies MenuEntry[]),
    { type: 'separator', id: 'history' },
    { id: 'undo', label: t('history.undo'), disabled: busy || history.pending || !history.canUndo },
    { id: 'redo', label: t('history.redo'), disabled: busy || history.pending || !history.canRedo },
    ]} onSelect={(id) => {
      close()
      if (id.startsWith('create:')) creations.find(entry => `create:${entry.id}` === id)?.create()
      else if (id === 'focus') focus()
      else if (id === 'remove') remove()
      else if (id === 'all') selectAll()
      else if (id === 'fit') fit()
      else if (id === 'copy') copy()
      else if (id === 'paste') paste()
      else if (id === 'duplicate') duplicate()
      else if (id === 'group') group?.()
      else if (id === 'ungroup') ungroup?.()
      else if (id === 'rename-group') renameGroup?.()
      else if (id === 'leave-group') assignGroup?.(null)
      else if (id.startsWith('group:')) assignGroup?.(id.slice(6) as CanvasGroupId)
      else if (id === 'undo' || id === 'redo') replayHistory(id)
    }} />
}
