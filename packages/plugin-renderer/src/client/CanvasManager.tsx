/** Canvas navigation and management stay separate from native Session archival. */
import { useId, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Archive, ArchiveRestore, Check, Copy, Ellipsis, Pencil, Plus, Search, Trash2, X } from 'lucide-react'
import { Button, Menu, MenuSurface, Tooltip, useAnchoredPosition, useDismissOnOutsidePointer, useModalLayer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CanvasChat, CanvasDocument, CanvasId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { WorkspaceProps } from './props.ts'
import css from './CanvasManager.module.css'

/** Read-only canvas summaries and owner-controlled navigation and mutations. */
export interface CanvasManagerProps {
  readonly anchorRef: RefObject<HTMLButtonElement | null>
  readonly canvases: readonly CanvasDocument[]
  readonly chats: readonly CanvasChat[]
  readonly activeId: CanvasId | undefined
  readonly open: boolean
  readonly busy: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onSelect: (id: CanvasId) => void
  readonly onRename: (id: CanvasId) => void
  readonly onArchive: (id: CanvasId, archived: boolean) => void
  readonly onDuplicate: (id: CanvasId) => void
  readonly onDelete: (id: CanvasId) => void
  readonly onCreate: () => void
  readonly t: WorkspaceProps['t']
}

const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/**
 * Anchor canvas management to the owner's persistent workspace-menu button.
 * @param props - Anchor, canvas summaries, current selection, localized copy, and owning actions.
 * @returns The body-portaled dialog while open.
 */
export function CanvasManager(props: CanvasManagerProps) {
  return props.open ? <CanvasManagerPanel {...props} /> : null
}

function CanvasManagerPanel(props: CanvasManagerProps) {
  const { canvases, chats, activeId, busy, t, anchorRef, onOpenChange } = props
  const panel = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [archived, setArchived] = useState(false)
  const [menuId, setMenuId] = useState<CanvasId | null>(null)
  const [focusSearch] = useState(() => typeof matchMedia !== 'function' || !matchMedia('(pointer: coarse)').matches)
  const tabs = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const close = (): void => { onOpenChange(false) }
  const position = useAnchoredPosition({ open: true, anchorRef, panelRef: panel, align: 'end', gap: 6, margin: 12 })
  useDismissOnOutsidePointer(anchorRef, true, onOpenChange, panel)
  useModalLayer(panel, position !== null, close)
  const archivedCount = canvases.filter(canvas => canvas.archived === true).length
  const search = query.trim().toLowerCase()
  const visible = canvases.filter(canvas => (canvas.archived === true) === archived && canvas.title.toLowerCase().includes(search))
  const chatCounts = new Map<CanvasId, number>()
  for (const chat of chats) chatCounts.set(chat.canvasId, (chatCounts.get(chat.canvasId) ?? 0) + 1)
  return createPortal(<MenuSurface ref={panel} className={css.panel} style={position ?? MEASURE_STYLE}
    role="dialog" aria-modal="true" aria-label={t('canvas.all')} tabIndex={-1}
    onPointerDownCapture={(event) => {
      if (event.target instanceof Element && panel.current?.contains(event.target)
        && event.target.closest('[data-canvas-manager-menu]')?.getAttribute('data-canvas-manager-menu') !== menuId) setMenuId(null)
    }}
    onPointerDown={(event) => { event.stopPropagation() }} onClick={(event) => { event.stopPropagation() }}>
    <header className={css.header}>
      <h2 className={css.heading}>{t('canvas.all')}</h2>
      <Tooltip label={t('canvas.manager.close')} portal>
        <Button size="sm" aria-label={t('canvas.manager.close')} onClick={close}><X size={16} aria-hidden /></Button>
      </Tooltip>
    </header>
    <label className={css.search}>
      <Search size={16} aria-hidden />
      <input type="search" value={query} aria-label={t('canvas.manager.search')} placeholder={t('canvas.manager.search')}
        data-modal-autofocus={focusSearch || undefined}
        onChange={(event) => { setQuery(event.currentTarget.value) }} />
    </label>
    <div ref={tabs} className={css.tabs} role="tablist" aria-label={t('canvas.all')}
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return
        const next = event.key === 'Home' ? false : event.key === 'End' ? true
          : event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? !archived : undefined
        if (next === undefined) return
        event.preventDefault()
        setMenuId(null)
        setArchived(next)
        tabs.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next ? 1 : 0]?.focus()
      }}>
      {[false, true].map(value => <button key={String(value)} type="button" role="tab" aria-selected={archived === value}
        aria-controls={panelId} tabIndex={archived === value ? 0 : -1} className={css.tab}
        onClick={() => { setMenuId(null); setArchived(value) }}>
        {t(value ? 'canvas.manager.archived' : 'canvas.manager.active')}{' '}
        <span className={css.count}>{value ? archivedCount : canvases.length - archivedCount}</span>
      </button>)}
    </div>
    <div id={panelId} role="tabpanel" aria-label={t(archived ? 'canvas.manager.archived' : 'canvas.manager.active')} className={css.list}>
      {visible.length === 0 ? <p className={css.empty} role="status">
        {t(search !== '' ? 'canvas.manager.noMatches' : archived ? 'canvas.manager.emptyArchived' : 'canvas.manager.empty')}
      </p> : <ul className={css.rows}>{visible.map(canvas => <CanvasManagerRow key={canvas.id} canvas={canvas}
        current={canvas.id === activeId} chatCount={chatCounts.get(canvas.id) ?? 0} busy={busy} t={t}
        menuOpen={menuId === canvas.id} setMenuOpen={(open) => { setMenuId(open ? canvas.id : null) }}
        select={() => { close(); props.onSelect(canvas.id) }}
        rename={() => { close(); props.onRename(canvas.id) }}
        archive={() => { props.onArchive(canvas.id, canvas.archived !== true) }}
        duplicate={() => { props.onDuplicate(canvas.id) }} remove={() => { close(); props.onDelete(canvas.id) }} />)}</ul>}
    </div>
    <footer className={css.footer}>
      <Button size="sm" disabled={busy} onClick={() => { close(); props.onCreate() }}><Plus size={16} aria-hidden />{t('canvas.new')}</Button>
    </footer>
  </MenuSurface>, document.body)
}

function CanvasManagerRow({ canvas, current, chatCount, busy, t, menuOpen, setMenuOpen, select, rename, archive, duplicate, remove }: {
  readonly canvas: CanvasDocument
  readonly current: boolean
  readonly chatCount: number
  readonly busy: boolean
  readonly t: WorkspaceProps['t']
  readonly menuOpen: boolean
  readonly setMenuOpen: (open: boolean) => void
  readonly select: () => void
  readonly rename: () => void
  readonly archive: () => void
  readonly duplicate: () => void
  readonly remove: () => void
}) {
  const details = useId()
  const metadata = <>
    <span className={css.name}>{canvas.title}</span>
    <span id={details} className={css.details}>{t('canvas.manager.details', { nodes: canvas.nodes.length, chats: chatCount })}</span>
  </>
  return <li className={css.row} data-canvas-manager-row={canvas.id} data-current={current || undefined}>
    {canvas.archived === true ? <div className={css.metadata}>{metadata}</div>
      : <button type="button" className={css.select} aria-label={canvas.title} aria-describedby={details}
        aria-current={current ? 'page' : undefined} onClick={select}>{metadata}</button>}
    <div className={css.actions}>
      {current && <span className={css.current}><Check size={12} aria-hidden />{t('canvas.manager.current')}</span>}
      {canvas.archived === true && <Button size="sm" disabled={busy} onClick={archive}>{t('canvas.manager.unarchive')}</Button>}
      <Menu open={menuOpen} portal align="end" onClose={() => { setMenuOpen(false) }}
        className={css.more} anchor={<Tooltip label={t('canvas.manager.actions', { name: canvas.title })} portal>
          <Button size="sm" data-canvas-manager-menu={canvas.id} aria-label={t('canvas.manager.actions', { name: canvas.title })}
            aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => { setMenuOpen(!menuOpen) }}><Ellipsis size={16} aria-hidden /></Button>
        </Tooltip>}
        items={[
          { id: 'rename', label: t('canvas.rename'), icon: <Pencil size={16} aria-hidden />, disabled: busy },
          { id: 'archive', label: t(canvas.archived === true ? 'canvas.manager.unarchive' : 'canvas.manager.archive'),
            icon: canvas.archived === true ? <ArchiveRestore size={16} aria-hidden /> : <Archive size={16} aria-hidden />, disabled: busy },
          { id: 'duplicate', label: t('canvas.manager.duplicate'), icon: <Copy size={16} aria-hidden />, disabled: busy },
          { type: 'separator', id: 'danger' },
          { id: 'delete', label: t('canvas.manager.delete'), icon: <Trash2 size={16} aria-hidden />, danger: true, disabled: busy },
        ]} onSelect={(id) => {
          setMenuOpen(false)
          if (id === 'rename') rename()
          else if (id === 'archive') archive()
          else if (id === 'duplicate') duplicate()
          else if (id === 'delete') remove()
        }} />
    </div>
  </li>
}
