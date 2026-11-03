// @vitest-environment jsdom
/** Right-click targets remain independent of selection and shared menus stay keyboard reachable. */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import type { CanvasNodeId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { CanvasContextMenu } from '../src/client/CanvasContextMenu.tsx'
import { canvasContextTargets, ownsNativeCanvasContextMenu } from '../src/client/canvas-context-menu.ts'
import { en, type ConvaxKey } from '../src/client/locales.ts'
import type { WorkspaceProps } from '../src/client/props.ts'

const FIRST = 'first' as CanvasNodeId
const SECOND = 'second' as CanvasNodeId
const THIRD = 'third' as CanvasNodeId
const t = ((key: ConvaxKey) => en[key]) as WorkspaceProps['t']

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function fixture(targetCount = 0, busy = false) {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(220)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(240)
  const actions = {
    addProject: vi.fn(), addFiles: vi.fn(), newChat: vi.fn(), focus: vi.fn(), remove: vi.fn(), selectAll: vi.fn(), fit: vi.fn(),
    copy: vi.fn(), paste: vi.fn(), duplicate: vi.fn(), replayHistory: vi.fn(),
  }
  function Scenario() {
    const [open, setOpen] = useState(true)
    return <><button>Outside</button>{open && <CanvasContextMenu point={{ x: window.innerWidth - 1, y: window.innerHeight - 1 }}
      targetCount={targetCount} busy={busy} history={{ canUndo: true, canRedo: false, pending: false }}
      t={t} close={() => { setOpen(false) }} {...actions} />}</>
  }
  const view = render(<Scenario />)
  return { view, actions }
}

describe('Canvas context targeting', () => {
  it('uses the selected set for selected hits, an individual unselected hit, and blank space inside the selection bounds', () => {
    const selected = [FIRST, SECOND]
    const bounds = [
      { id: FIRST, x: 0, y: 0, width: 100, height: 80 }, { id: SECOND, x: 300, y: 200, width: 100, height: 80 },
    ]
    expect(canvasContextTargets(FIRST, selected, bounds, { x: 20, y: 30 })).toBe(selected)
    expect(canvasContextTargets(THIRD, selected, bounds, { x: 800, y: 800 })).toEqual([THIRD])
    expect(canvasContextTargets(undefined, selected, bounds, { x: 200, y: 160 })).toBe(selected)
    expect(canvasContextTargets(undefined, selected, bounds, { x: 600, y: 160 })).toEqual([])
    expect(selected).toEqual([FIRST, SECOND])
  })

  it('leaves editors and Chat content native while allowing the Chat drag header', () => {
    const article = document.createElement('article')
    article.dataset.convaxChat = 'chat'
    const header = document.createElement('header')
    header.dataset.convaxChatDrag = ''
    const content = document.createElement('div')
    const editor = document.createElement('div')
    editor.contentEditable = 'true'
    editor.setAttribute('contenteditable', 'true')
    content.append(editor)
    article.append(header, content)
    expect(ownsNativeCanvasContextMenu(header)).toBe(false)
    expect(ownsNativeCanvasContextMenu(content)).toBe(true)
    expect(ownsNativeCanvasContextMenu(editor)).toBe(true)
    const terminal = document.createElement('div')
    terminal.className = 'xterm'
    expect(ownsNativeCanvasContextMenu(terminal)).toBe(true)
  })
})

describe('Canvas context menu', () => {
  it('places creation actions in a portal and clamps their menu inside the viewport', () => {
    const b = fixture()
    const menu = b.view.getByRole('menu')
    expect(b.view.container.contains(menu)).toBe(false)
    expect(Number.parseFloat(menu.style.left)).toBeLessThanOrEqual(window.innerWidth - 220 - 12)
    expect(Number.parseFloat(menu.style.top)).toBeLessThanOrEqual(window.innerHeight - 240 - 12)
    expect(document.activeElement).toBe(b.view.getByRole('menuitem', { name: 'Add project' }))
    expect(b.view.queryByRole('menuitem', { name: 'Remove selected references' })).toBeNull()
    fireEvent.click(b.view.getByRole('menuitem', { name: 'Add files' }))
    expect(b.actions.addFiles).toHaveBeenCalledOnce()
    expect(b.view.queryByRole('menu')).toBeNull()
  })

  it('exposes target actions and closes after activating Remove', () => {
    const b = fixture(2)
    expect(b.view.container.querySelector('[data-convax-context-menu]')?.getAttribute('data-target-count')).toBe('2')
    expect(b.view.getByRole('menuitem', { name: 'Focus selection' })).toBeDefined()
    expect(b.view.queryByRole('menuitem', { name: 'New chat' })).toBeNull()
    fireEvent.click(b.view.getByRole('menuitem', { name: 'Remove selected references' }))
    expect(b.actions.remove).toHaveBeenCalledOnce()
    expect(b.view.queryByRole('menu')).toBeNull()
  })

  it.each(['Escape', 'outside'] as const)('closes with %s while invoking no graph action', (method) => {
    const b = fixture()
    if (method === 'Escape') fireEvent.keyDown(b.view.getByRole('menuitem', { name: 'Add project' }), { key: 'Escape' })
    else fireEvent.pointerDown(b.view.getByRole('button', { name: 'Outside' }))
    expect(b.view.queryByRole('menu')).toBeNull()
    for (const action of Object.values(b.actions)) expect(action).not.toHaveBeenCalled()
  })

  it('blocks mutation actions while busy and keeps viewport actions available', () => {
    const b = fixture(2, true)
    expect(b.view.getByRole('menuitem', { name: 'Remove selected references' }).hasAttribute('disabled')).toBe(true)
    expect(b.view.getByRole('menuitem', { name: 'Focus selection' }).hasAttribute('disabled')).toBe(false)
    fireEvent.click(b.view.getByRole('menuitem', { name: 'Fit canvas' }))
    expect(b.actions.fit).toHaveBeenCalledOnce()
  })
})


it.each([0, 2])('exposes available Undo in the %s-target context menu and blocks unavailable Redo', (targets) => {
  const b = fixture(targets)
  expect(b.view.getByRole('menuitem', { name: 'Redo' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(b.view.getByRole('menuitem', { name: 'Undo' }))
  expect(b.actions.replayHistory).toHaveBeenCalledExactlyOnceWith('undo')
  expect(b.view.queryByRole('menu')).toBeNull()
})
