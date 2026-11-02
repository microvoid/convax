// @vitest-environment jsdom
/** Canvas management exercises real shared overlays and owner-controlled mutations. */
import { createRef, useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CanvasChat, CanvasDocument, CanvasId, CanvasNodeId, CanvasNodeTypeId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { CanvasManager, type CanvasManagerProps } from '../src/client/CanvasManager.tsx'
import { en, type ConvaxKey } from '../src/client/locales.ts'

const id = (value: string): CanvasId => value as CanvasId
const canvases: CanvasDocument[] = ['Alpha', 'Beta', 'Gamma'].map((title, index) => ({
  id: id(title.toLowerCase()), title, revision: 1, connections: [], archived: index === 2,
  nodes: index === 0 ? [0, 1].map(index => ({
    id: `node-${index}` as CanvasNodeId, typeId: 'fixture.reference' as CanvasNodeTypeId, dataVersion: 1,
    revision: 1, position: { x: 0, y: 0 }, data: {},
  })) : [],
}))
const chats: CanvasChat[] = [{
  canvasId: id('alpha'), nodeId: 'alpha-chat' as CanvasNodeId, title: 'Project chat', cwd: '/project',
  deleting: false, issue: null, threads: [],
}]

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function fixture() {
  const anchorRef = createRef<HTMLButtonElement>()
  let props: CanvasManagerProps = {
    anchorRef, canvases, chats, activeId: id('alpha'), open: false, busy: false,
    onOpenChange: vi.fn(), onSelect: vi.fn(), onRename: vi.fn(), onArchive: vi.fn(),
    onDuplicate: vi.fn(), onDelete: vi.fn(), onCreate: vi.fn(),
    t: ((key: ConvaxKey, values?: Record<string, string | number>) =>
      en[key].replace(/\{(\w+)\}/g, (_match, name: string) => String(values?.[name] ?? ''))) as CanvasManagerProps['t'],
  }
  function Harness() {
    const [open, setOpen] = useState(false)
    return <>
      <button ref={anchorRef} type="button" aria-expanded={open}
        onClick={() => { setOpen(current => !current) }}>Workspace actions</button>
      <CanvasManager {...props} open={open} onOpenChange={(next) => { props.onOpenChange(next); setOpen(next) }} />
      <button type="button">Outside</button></>
  }
  const view = render(<Harness />)
  const anchor = screen.getByRole('button', { name: 'Workspace actions' })
  return {
    ...view, anchor, get props() { return props },
    open() { anchor.focus(); fireEvent.click(anchor); return screen.getByRole('dialog', { name: 'All canvases' }) },
    update(next: Partial<CanvasManagerProps>) { props = { ...props, ...next }; view.rerender(<Harness />) },
  }
}

describe('Convax canvas manager', () => {
  it('shows active canvases, their counts and the current marker in a body-portaled dialog', () => {
    const b = fixture()
    expect(b.anchor.getAttribute('aria-expanded')).toBe('false')
    const dialog = b.open()
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search canvases' }))
    expect(dialog.parentElement).toBe(document.body)
    expect(b.anchor.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('tab', { name: 'Canvases 2' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: 'Archived 1' }).getAttribute('aria-selected')).toBe('false')
    expect(screen.getByRole('button', { name: 'Alpha' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByText('Current')).toBeDefined()
    expect(screen.getByText('2 nodes · 1 chats')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Beta' })).toBeDefined()
    expect(screen.queryByText('Gamma')).toBeNull()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(b.anchor)
  })

  it('keeps initial focus away from the search field on coarse pointers and restores the trigger on close', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    const b = fixture()
    b.open()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close canvas manager' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(b.anchor)
  })

  it('searches the selected archive filter and resets transient search and filter after closing', () => {
    const b = fixture()
    b.open()
    const search = screen.getByRole('searchbox', { name: 'Search canvases' })
    fireEvent.change(search, { target: { value: ' bEtA ' } })
    expect(screen.getByRole('button', { name: 'Beta' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Alpha' })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'Archived 1' }))
    expect(screen.getByRole('status').textContent).toBe('No matching canvases')
    fireEvent.change(search, { target: { value: 'gamma' } })
    expect(screen.getByText('Gamma')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Unarchive' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Close canvas manager' }))
    b.open()
    expect(screen.getByRole<HTMLInputElement>('searchbox', { name: 'Search canvases' }).value).toBe('')
    expect(screen.getByRole('tab', { name: 'Canvases 2' }).getAttribute('aria-selected')).toBe('true')
  })

  it('closes on selection, creation, and outside pointers without mutating another canvas', () => {
    const b = fixture()
    b.open()
    fireEvent.click(screen.getByRole('button', { name: 'Beta' }))
    expect(b.props.onSelect).toHaveBeenCalledExactlyOnceWith(id('beta'))
    expect(screen.queryByRole('dialog')).toBeNull()
    b.open()
    fireEvent.click(screen.getByRole('button', { name: 'New canvas' }))
    expect(b.props.onCreate).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
    b.open()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(b.props.onArchive).not.toHaveBeenCalled()
    expect(b.props.onDelete).not.toHaveBeenCalled()
  })

  it('keeps its dialog while native row menus invoke archive and duplicate, and delegates permanent deletion', () => {
    const b = fixture()
    const dialog = b.open()
    const more = screen.getByRole('button', { name: 'Actions for Alpha' })
    fireEvent.click(more)
    const archive = screen.getByRole('menuitem', { name: 'Archive' })
    fireEvent.pointerDown(archive)
    expect(screen.getByRole('dialog')).toBe(dialog)
    fireEvent.click(archive)
    expect(b.props.onArchive).toHaveBeenCalledExactlyOnceWith(id('alpha'), true)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('dialog')).toBe(dialog)
    fireEvent.click(more)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate canvas' }))
    expect(b.props.onDuplicate).toHaveBeenCalledExactlyOnceWith(id('alpha'))
    expect(screen.getByRole('dialog')).toBe(dialog)
    fireEvent.click(more)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Permanently delete…' }))
    expect(b.props.onDelete).toHaveBeenCalledExactlyOnceWith(id('alpha'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(b.props.onSelect).not.toHaveBeenCalled()
  })

  it('unarchives an archived canvas explicitly without selecting or opening it', () => {
    const b = fixture()
    b.open()
    fireEvent.click(screen.getByRole('tab', { name: 'Archived 1' }))
    expect(screen.queryByRole('button', { name: 'Gamma' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Unarchive' }))
    expect(b.props.onArchive).toHaveBeenCalledExactlyOnceWith(id('gamma'), false)
    expect(b.props.onSelect).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeDefined()
  })

  it.each(['Beta', 'Gamma'])('delegates renaming %s without opening or unarchiving it', (title) => {
    const b = fixture()
    b.open()
    if (title === 'Gamma') fireEvent.click(screen.getByRole('tab', { name: 'Archived 1' }))
    fireEvent.click(screen.getByRole('button', { name: `Actions for ${title}` }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename canvas' }))
    expect(b.props.onRename).toHaveBeenCalledExactlyOnceWith(id(title.toLowerCase()))
    expect(b.props.onSelect).not.toHaveBeenCalled()
    expect(b.props.onArchive).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('disables mutations while busy but preserves navigation and layered Escape focus return', () => {
    const b = fixture()
    b.update({ busy: true })
    const dialog = b.open()
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: 'New canvas' }).disabled).toBe(true)
    const more = screen.getByRole('button', { name: 'Actions for Alpha' })
    more.focus()
    fireEvent.click(more)
    expect(screen.getAllByRole<HTMLButtonElement>('menuitem').every(item => item.disabled)).toBe(true)
    fireEvent.keyDown(more, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(document.activeElement).toBe(more)
    fireEvent.keyDown(more, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(b.anchor)
    b.open()
    fireEvent.click(screen.getByRole('button', { name: 'Beta' }))
    expect(b.props.onSelect).toHaveBeenCalledExactlyOnceWith(id('beta'))
    expect(b.props.onArchive).not.toHaveBeenCalled()
  })

  it('supports keyboard filter navigation and distinct empty states', () => {
    const b = fixture()
    b.update({ canvases: [], chats: [] })
    b.open()
    const active = screen.getByRole('tab', { name: 'Canvases 0' })
    active.focus()
    expect(screen.getByRole('status').textContent).toBe('No canvases yet')
    fireEvent.keyDown(active, { key: 'ArrowRight' })
    const archived = screen.getByRole('tab', { name: 'Archived 0' })
    expect(document.activeElement).toBe(archived)
    expect(archived.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('status').textContent).toBe('No archived canvases')
    fireEvent.keyDown(archived, { key: 'Home' })
    expect(document.activeElement).toBe(active)
  })
})
