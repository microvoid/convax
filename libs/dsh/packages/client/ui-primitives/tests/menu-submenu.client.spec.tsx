// @vitest-environment jsdom
/** Cascading catalogues remain reachable outside clipped parents and near viewport edges. */
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Menu } from '../src/Menu.tsx'
import { POINTER_GRACE_MS } from '../src/pointer-grace.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

const items = [{ id: 'provider', label: 'Provider', submenu: [
  { id: 'image', label: 'Image model' }, { id: 'video', label: 'Video model' },
] }]

describe('cascading Menu', () => {
  it.each([
    { x: 340, width: 480, expected: 152 },
    { x: 12, width: 240, expected: 48 },
  ])('fits the child card at x=$x in a $width viewport', ({ x, width, expected }) => {
    vi.stubGlobal('innerWidth', width)
    vi.stubGlobal('innerHeight', 400)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(x, 330, 100, 34))
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(180)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(240)
    render(<Menu open portal anchor={<button>Models</button>} items={items} selectedId="image" onClose={vi.fn()} />)
    const parent = screen.getByRole('menuitem', { name: 'Provider' })
    fireEvent.click(parent)
    const child = screen.getByRole('menuitem', { name: 'Image model' })
    const menu = child.closest('[role="menu"]') as HTMLElement
    expect(menu.parentElement).toBe(document.body)
    expect(menu.style.left).toBe(`${expected}px`)
    expect(menu.style.top).toBe('148px')
    expect(child.getAttribute('aria-current')).toBe('true')
    expect(parent.closest('[role="menu"]')?.contains(child)).toBe(false)
  })

  it('supports entering, leaving and selecting child rows by keyboard without closing on an inside pointer', () => {
    const selected = vi.fn(), closed = vi.fn()
    function Example() {
      const [open, setOpen] = useState(false)
      return <Menu open={open} portal anchor={<button onClick={() => { setOpen(true) }}>Models</button>} items={items}
        onClose={() => { closed(); setOpen(false) }} onSelect={(id) => { selected(id); setOpen(false) }} />
    }
    const ownerKeys = vi.fn()
    render(<div onKeyDown={ownerKeys}><Example /></div>)
    const trigger = screen.getByRole('button', { name: 'Models' })
    trigger.focus(); fireEvent.click(trigger)
    const parent = screen.getByRole('menuitem', { name: 'Provider' })
    act(() => { parent.focus() })
    fireEvent.keyDown(parent, { key: 'ArrowRight' })
    const child = screen.getByRole('menuitem', { name: 'Image model' })
    expect(document.activeElement).toBe(child)
    fireEvent.pointerDown(child)
    expect(closed).not.toHaveBeenCalled()
    fireEvent.keyDown(child, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(parent)
    expect(screen.queryByRole('menuitem', { name: 'Image model' })).toBeNull()
    fireEvent.keyDown(parent, { key: 'ArrowRight' })
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Image model' }), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Video model' }))
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab' })
    expect(selected).toHaveBeenCalledWith('video')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(ownerKeys).not.toHaveBeenCalled()
  })

  it('keeps the child open while crossing the pointer gap and dismisses outside the menu', () => {
    vi.useFakeTimers()
    const close = vi.fn()
    render(<Menu open portal anchor={<button>Models</button>} items={items} onClose={close} />)
    const parent = screen.getByRole('menuitem', { name: 'Provider' })
    fireEvent.mouseEnter(parent.parentElement as HTMLElement)
    fireEvent.mouseLeave(parent.parentElement as HTMLElement)
    act(() => { vi.advanceTimersByTime(POINTER_GRACE_MS / 2) })
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Image model' }).closest('[role="menu"]') as HTMLElement)
    act(() => { vi.advanceTimersByTime(POINTER_GRACE_MS) })
    expect(screen.getByRole('menuitem', { name: 'Image model' })).toBeDefined()
    fireEvent.pointerDown(document.body)
    expect(close).toHaveBeenCalledOnce()
  })

  it('cancels pending pointer dismissal when keyboard focus enters the child', () => {
    vi.useFakeTimers()
    render(<Menu open portal anchor={<button>Models</button>} items={items} onClose={vi.fn()} />)
    const parent = screen.getByRole('menuitem', { name: 'Provider' })
    act(() => { parent.focus() })
    fireEvent.mouseLeave(parent.parentElement as HTMLElement)
    fireEvent.keyDown(parent, { key: 'ArrowRight' })
    const child = screen.getByRole('menuitem', { name: 'Image model' })
    act(() => { vi.advanceTimersByTime(POINTER_GRACE_MS) })
    expect(document.activeElement).toBe(child)
    expect(screen.getByRole('menuitem', { name: 'Image model' })).toBe(child)
  })
})
