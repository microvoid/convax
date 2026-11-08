// @vitest-environment jsdom
/** The same palette fits pointer and touch windows without saving its previews. */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GroupColorPicker } from '../src/client/GroupColorPicker.tsx'
import { en, type ConvaxKey } from '../src/client/locales.ts'
import type { WorkspaceProps } from '../src/client/props.ts'

const anchors: HTMLElement[] = []
afterEach(() => { cleanup(); for (const anchor of anchors.splice(0)) anchor.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const t = ((key: ConvaxKey, params?: Record<string, string | number>) => en[key]
  .replace(/\{(\w+)\}/gu, (_match, name: string) => String(params?.[name] ?? name))) as WorkspaceProps['t']

function fixture({ sheet = false, pending = false, current = null as 'mixed' | 'blue' | null } = {}) {
  let sheetMode = sheet
  const mediaListeners = new Set<() => void>()
  vi.stubGlobal('matchMedia', (query: string) => ({ get matches() { return sheetMode && query.includes('600px') },
    addEventListener: (_event: string, listener: () => void) => { mediaListeners.add(listener) },
    removeEventListener: (_event: string, listener: () => void) => { mediaListeners.delete(listener) } }))
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(280)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(260)
  const title = document.createElement('div')
  title.dataset.convaxGroupHeader = 'group'
  title.tabIndex = 0
  const trigger = document.createElement('button')
  title.append(trigger); document.body.append(title); anchors.push(title)
  vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(window.innerWidth - 2, window.innerHeight - 2, 2, 2))
  trigger.focus()
  const anchorRef = { current: trigger }
  const preview = vi.fn(), apply = vi.fn(), close = vi.fn()
  function Scenario() {
    const [open, setOpen] = useState(true)
    return <><div role="group" aria-label="Other group" tabIndex={0} onPointerDown={(event) => {
      event.preventDefault(); event.stopPropagation(); event.currentTarget.focus(); setOpen(false)
    }}>Other group</div>{open && <GroupColorPicker anchorRef={anchorRef} current={current} pending={pending}
      preview={preview} apply={apply} close={() => { close(); setOpen(false) }} t={t} />}</>
  }
  return { ...render(<Scenario />), preview, apply, close, title,
    changeSheet: (value: boolean) => { sheetMode = value; for (const listener of mediaListeners) listener() } }
}

describe('Group color palette', () => {
  it('preserves focus on another title when its pointer handler cancels the palette', () => {
    const b = fixture()
    const other = b.getByRole('group', { name: 'Other group' })
    fireEvent.pointerDown(other)
    expect(b.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(other)
    expect(b.apply).not.toHaveBeenCalled()
  })
  it('preserves the focused color while a touch sheet becomes a desktop popover', () => {
    const b = fixture({ sheet: true })
    const blue = b.getByRole('radio', { name: 'Blue' })
    blue.focus()
    act(() => { b.changeSheet(false) })
    expect(b.getByRole('dialog').getAttribute('data-mode')).toBe('popover')
    expect(document.activeElement).toBe(blue)
  })

  it('fits its portal, distinguishes saved selection from previews and restores canvas focus after Escape', () => {
    const b = fixture()
    const panel = b.getByRole('dialog', { name: 'Group color' })
    expect(b.container.contains(panel)).toBe(false)
    expect(Number.parseFloat(panel.style.left)).toBeLessThanOrEqual(window.innerWidth - 292)
    expect(Number.parseFloat(panel.style.top)).toBeLessThanOrEqual(window.innerHeight - 272)
    expect(b.preview).not.toHaveBeenCalled()
    const blue = b.getByRole('radio', { name: 'Blue' })
    fireEvent.pointerEnter(blue, { pointerType: 'mouse' })
    expect(b.preview).toHaveBeenLastCalledWith('blue')
    expect(b.getByRole('radio', { name: 'Default' }).getAttribute('aria-checked')).toBe('true')
    blue.focus()
    fireEvent.keyDown(blue, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(b.getByRole('radio', { name: 'Green' }))
    expect(b.preview).toHaveBeenLastCalledWith('green')
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(b.queryByRole('dialog')).toBeNull()
    expect(b.apply).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(b.title)
  })

  it('shows mixed colors and dismisses an outside pointer without applying a color', () => {
    const b = fixture({ current: 'mixed' })
    expect(b.getByText('Current: Mixed colors')).toBeDefined()
    expect(b.getAllByRole('radio').every(choice => choice.getAttribute('aria-checked') === 'false')).toBe(true)
    fireEvent.pointerDown(document.body)
    expect(b.queryByRole('dialog')).toBeNull()
    expect(b.apply).not.toHaveBeenCalled()
  })

  it('uses a touch sheet with click-to-apply and no focus or pointer preview', () => {
    const b = fixture({ sheet: true })
    expect(b.getByRole('dialog').getAttribute('data-mode')).toBe('sheet')
    const pink = b.getByRole('radio', { name: 'Pink' })
    fireEvent.pointerEnter(pink, { pointerType: 'touch' }); pink.focus()
    expect(b.preview).not.toHaveBeenCalled()
    fireEvent.click(pink)
    expect(b.apply).toHaveBeenCalledExactlyOnceWith('pink')
    expect(b.getByText('Tap a color to apply')).toBeDefined()
  })

  it('disables every color while a change is pending', () => {
    const b = fixture({ pending: true })
    expect(b.getAllByRole('radio').every(choice => choice.hasAttribute('disabled'))).toBe(true)
    fireEvent.click(b.getByRole('radio', { name: 'Blue' }))
    expect(b.apply).not.toHaveBeenCalled()
  })
})
