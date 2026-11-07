// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultNodeCreations } from '@deepseek-ai/dsh-convax-plugin-inernal-nodes-renderer/client'
import { CanvasAddToolbar } from '../src/client/CanvasAddToolbar.tsx'
import type { CanvasCreationDefinition } from '../src/client/contributions.ts'
import { en, type ConvaxKey } from '../src/client/locales.ts'
import type { WorkspaceProps } from '../src/client/props.ts'

const t = ((key: ConvaxKey) => en[key]) as WorkspaceProps['t']
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function fixture(creations = defaultNodeCreations(t, true), busy = false) {
  const create = vi.fn()
  const view = render(<><button type="button">Outside</button><CanvasAddToolbar creations={creations} busy={busy} create={create} t={t} /></>)
  return { ...view, create, creations }
}

describe('Canvas add toolbar', () => {
  it('groups project and file intake behind one icon and invokes the selected feature', () => {
    const b = fixture()
    const add = screen.getByRole('button', { name: 'Add folder or files' })
    expect(add.textContent).toBe('')
    expect(screen.queryByRole('button', { name: 'Add folder' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add files' })).toBeNull()
    fireEvent.click(add)
    expect(b.container.contains(screen.getByRole('menu'))).toBe(false)
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Add folder', 'Add files'])
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Add folder' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add files' }))
    expect(b.create).toHaveBeenCalledExactlyOnceWith(b.creations.find(entry => entry.id === 'files'))
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(add)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add folder' }))
    expect(b.create).toHaveBeenLastCalledWith(b.creations.find(entry => entry.id === 'project'))
  })

  it('keeps application-window and AI chat actions as separate labeled icons', () => {
    const b = fixture()
    for (const [name, id] of [['Application window', 'window'], ['New chat', 'chat']] as const) {
      const button = screen.getByRole('button', { name })
      expect(button.textContent).toBe('')
      fireEvent.click(button)
      expect(b.create).toHaveBeenLastCalledWith(b.creations.find(entry => entry.id === id))
    }
  })

  it.each(['Escape', 'outside'])('dismisses resource intake with %s without creating a node', (method) => {
    const b = fixture()
    const add = screen.getByRole('button', { name: 'Add folder or files' })
    fireEvent.click(add)
    if (method === 'Escape') fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Add folder' }), { key: 'Escape' })
    else fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(b.create).not.toHaveBeenCalled()
    if (method === 'Escape') expect(document.activeElement).toBe(add)
  })

  it('blocks mutation actions while busy and preserves contributions without native window support', () => {
    const b = fixture(defaultNodeCreations(t), true)
    expect(screen.queryByRole('button', { name: 'Application window' })).toBeNull()
    for (const name of ['Add folder or files', 'New chat']) {
      const button = screen.getByRole('button', { name })
      expect(button.hasAttribute('disabled')).toBe(true)
      fireEvent.click(button)
    }
    expect(b.create).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('retains third-party creations, including entries without their own icon', () => {
    const entry: CanvasCreationDefinition = { id: 'acme.board', label: () => 'New board', create: vi.fn() }
    const b = fixture([entry])
    expect(screen.queryByRole('button', { name: 'Add folder or files' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'New board' }))
    expect(b.create).toHaveBeenCalledExactlyOnceWith(entry)
  })

  it('drops an open resource menu when its contributions unload', () => {
    const b = fixture()
    fireEvent.click(screen.getByRole('button', { name: 'Add folder or files' }))
    b.rerender(<CanvasAddToolbar creations={[]} busy={false} create={b.create} t={t} />)
    expect(screen.queryByRole('menu')).toBeNull()
    b.rerender(<CanvasAddToolbar creations={b.creations} busy={false} create={b.create} t={t} />)
    expect(screen.getByRole('button', { name: 'Add folder or files' }).getAttribute('aria-expanded')).toBe('false')
  })
})
