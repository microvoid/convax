// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SlotFactoryMap } from '@deepseek-ai/dsh-client-ui-slots'
import { ThreadTabs } from '../src/client/ThreadTabs.tsx'
import { en, type ConvaxKey } from '@deepseek-ai/dsh-convax-plugin-renderer/client'

type Props = ComponentProps<typeof ThreadTabs>
type ArchiveOwner = SlotFactoryMap['workspace.session.archive']['props']
const id = (value: string): SessionId => value as SessionId
const tabs = ['Alpha', 'Beta', 'Gamma'].map(title => ({ id: id(title.toLowerCase()), title }))

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function fixture(scale = 1, widths: readonly number[] = [100, 100, 100]) {
  const pending = new Map<number, FrameRequestCallback>()
  let next = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    const handle = ++next
    pending.set(handle, callback)
    return handle
  })
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => { pending.delete(handle) })
  const factory = vi.fn<(name: string, owner: object) => null>(() => null)
  const props: Props = {
    tabs, activeId: id('gamma'), reference: undefined, menuOpen: false, settingsOpen: false, disabled: false,
    select: vi.fn(), move: vi.fn(), setMenuOpen: vi.fn(), setSettingsOpen: vi.fn(), fork: vi.fn(), create: vi.fn(),
    SessionProvider: ({ children }) => <>{children}</>,
    renderSlot: () => null,
    renderFactorySlot: (name, owner) => factory(name, owner),
    t: ((key: ConvaxKey, values?: Record<string, string | number>) =>
      en[key].replace(/\{(\w+)\}/g, (_match, name: string) => String(values?.[name] ?? ''))) as Props['t'],
  }
  const view = render(<ThreadTabs {...props} />)
  const strip = screen.getByRole('tablist', { name: 'Chat threads' })
  const width = widths.reduce((total, value) => total + value, 0)
  Object.defineProperties(strip, {
    clientWidth: { configurable: true, value: Math.round(width) },
    offsetWidth: { configurable: true, value: Math.round(width) },
    scrollWidth: { configurable: true, value: Math.round(width) },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect(40, 20, width * scale, 30 * scale) },
  })
  const captured = new Map<Element, number>()
  for (const element of strip.querySelectorAll<HTMLElement>('button')) {
    Object.defineProperties(element, {
      setPointerCapture: { configurable: true, value: (pointerId: number) => { captured.set(element, pointerId) } },
      hasPointerCapture: { configurable: true, value: (pointerId: number) => captured.get(element) === pointerId },
      releasePointerCapture: { configurable: true, value: (pointerId: number) => {
        if (captured.get(element) === pointerId) captured.delete(element)
      } },
    })
  }
  for (const card of strip.querySelectorAll<HTMLElement>('[data-thread-tab]')) {
    Object.defineProperty(card, 'getBoundingClientRect', {
      configurable: true,
      value: () => {
        const order = [...strip.querySelectorAll('[data-thread-tab]')]
        const index = order.indexOf(card)
        const left = widths.slice(0, index).reduce((total, value) => total + value, 0)
        return new DOMRect(40 + (left - strip.scrollLeft) * scale, 20, (widths[index] ?? 0) * scale, 30 * scale)
      },
    })
  }
  const alpha = within(strip).getByRole('tab', { name: 'Alpha' })
  const beta = within(strip).getByRole('tab', { name: 'Beta' })
  const gamma = within(strip).getByRole('tab', { name: 'Gamma' })
  const offset = (tab: HTMLElement): number => Number.parseFloat(tab.closest<HTMLElement>('[data-thread-tab]')!.style.getPropertyValue('--dsh-convax-tab-offset')) || 0
  return { ...view, props, factory, strip, alpha, beta, gamma, offset, captured, pending, x: (value: number) => 40 + value * scale }
}

function pointer(target: HTMLElement, type: string, x: number, pointerId = 7): void {
  const event = new MouseEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: 30, button: 0,
    buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
  })
  Object.defineProperties(event, {
    pointerId: { value: pointerId }, pointerType: { value: 'mouse' }, isPrimary: { value: true },
  })
  fireEvent(target, event)
}

describe('Convax Chat thread tabs', () => {
  it('places the new-thread action immediately after the tabs in the same left navigation group', () => {
    const b = fixture()
    const plus = screen.getByRole('button', { name: 'New thread' })
    const navigation = b.strip.parentElement!
    expect(navigation.firstElementChild).toBe(b.strip)
    expect(navigation.lastElementChild?.contains(plus)).toBe(true)
    expect(b.strip.contains(plus)).toBe(false)
    expect(within(b.strip).getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Alpha', 'Beta', 'Gamma'])
    fireEvent.click(plus)
    expect(b.props.create).toHaveBeenCalledOnce()
    expect(b.props.move).not.toHaveBeenCalled()
    expect(b.props.select).not.toHaveBeenCalled()
  })

  it('provides the selected actual Session identity and dismissal callback to the native archive action', () => {
    const b = fixture()
    b.rerender(<ThreadTabs {...b.props} menuOpen />)
    const factory = b.factory
    expect(factory.mock.calls.at(-1)?.[0]).toBe('workspace.session.archive')
    const request = factory.mock.calls.at(-1)?.[1] as ArchiveOwner | undefined
    expect(request).toMatchObject({ sessionId: id('gamma'), disabled: false })
    if (request === undefined) throw new Error('Archive factory owner is missing')
    request.onDismiss()
    expect(b.props.setMenuOpen).toHaveBeenLastCalledWith(false)
    b.rerender(<ThreadTabs {...b.props} activeId={id('beta')} menuOpen disabled />)
    expect(factory.mock.calls.at(-1)?.[0]).toBe('workspace.session.archive')
    expect(factory.mock.calls.at(-1)?.[1]).toMatchObject({ sessionId: id('beta'), disabled: true })
    expect(screen.getByRole('menuitem', { name: 'Fork thread' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'New thread' }).hasAttribute('disabled')).toBe(true)
  })

  it.each([0.5, 2])('previews and commits sorting at %s canvas zoom without selecting another thread', (scale) => {
    const b = fixture(scale)
    b.alpha.focus()
    pointer(b.alpha, 'pointerdown', b.x(25))
    pointer(b.alpha, 'pointermove', b.x(175))
    expect(b.offset(b.alpha)).toBe(150)
    expect(b.offset(b.beta)).toBe(-100)
    expect(b.offset(b.gamma)).toBe(0)
    expect(b.props.move).not.toHaveBeenCalled()
    expect(within(b.strip).getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Alpha', 'Beta', 'Gamma'])
    pointer(b.alpha, 'pointerup', b.x(175))
    fireEvent.click(b.alpha, { detail: 1 })
    expect(b.props.move).toHaveBeenCalledExactlyOnceWith(id('alpha'), id('beta'), 'after')
    expect(b.props.select).not.toHaveBeenCalled()
    expect(b.gamma.getAttribute('aria-selected')).toBe('true')
    expect(b.captured.size).toBe(0)
    expect(b.pending.size).toBe(0)
    b.rerender(<ThreadTabs {...b.props} tabs={[tabs[1]!, tabs[0]!, tabs[2]!]} />)
    expect(within(b.strip).getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Beta', 'Alpha', 'Gamma'])
    expect(document.activeElement).toBe(b.alpha)
  })

  it.each([0.5, 1, 2])('moves a wide thread past a shorter neighbor with fractional layout at %s zoom', (scale) => {
    const b = fixture(scale, [72.01125, 78.0121875, 50.0078125])
    pointer(b.beta, 'pointerdown', b.x(92.01125))
    pointer(b.beta, 'pointermove', b.x(1000))
    expect(b.offset(b.gamma)).toBeLessThan(0)
    pointer(b.beta, 'pointerup', b.x(1000))
    expect(b.props.move).toHaveBeenCalledExactlyOnceWith(id('beta'), id('gamma'), 'after')
    expect(b.props.select).not.toHaveBeenCalled()
    expect(b.captured.size).toBe(0)
  })

  it('makes room once the leading edge crosses half the neighboring tab and restores it when moving back', () => {
    const b = fixture(1, [72, 180, 50])
    pointer(b.beta, 'pointerdown', b.x(92))
    pointer(b.beta, 'pointermove', b.x(122))
    expect(b.offset(b.gamma)).toBe(-180)
    expect(b.props.move).not.toHaveBeenCalled()
    pointer(b.beta, 'pointermove', b.x(92))
    expect(b.offset(b.gamma)).toBe(0)
    pointer(b.beta, 'pointermove', b.x(50))
    expect(b.offset(b.alpha)).toBe(180)
    pointer(b.beta, 'pointermove', b.x(92))
    expect(b.offset(b.alpha)).toBe(0)
    pointer(b.beta, 'pointerup', b.x(92))
    expect(b.props.move).not.toHaveBeenCalled()
  })

  it('keeps the dropdown trigger, fork action, and new-thread action separate from sorting', () => {
    const b = fixture()
    const trigger = screen.getByRole('button', { name: 'Current thread actions' })
    pointer(trigger, 'pointerdown', b.x(275))
    pointer(trigger, 'pointerup', b.x(275))
    fireEvent.click(trigger)
    expect(b.props.setMenuOpen).toHaveBeenLastCalledWith(true)
    b.rerender(<ThreadTabs {...b.props} menuOpen />)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fork thread' }))
    expect(b.props.fork).toHaveBeenCalledExactlyOnceWith(id('gamma'))
    expect(b.props.setMenuOpen).toHaveBeenLastCalledWith(false)
    fireEvent.click(screen.getByRole('button', { name: 'New thread' }))
    expect(b.props.create).toHaveBeenCalledOnce()
    expect(b.props.move).not.toHaveBeenCalled()
    expect(b.props.select).not.toHaveBeenCalled()
    expect(b.captured.size).toBe(0)
  })

  it('cancels a preview with Escape and keeps the following pointer click from selecting it', () => {
    const b = fixture()
    pointer(b.alpha, 'pointerdown', b.x(25))
    pointer(b.alpha, 'pointermove', b.x(275))
    expect(b.offset(b.beta)).toBe(-100)
    fireEvent.keyDown(b.alpha, { key: 'Escape' })
    pointer(b.alpha, 'pointerup', b.x(275))
    fireEvent.click(b.alpha, { detail: 1 })
    expect(b.props.move).not.toHaveBeenCalled()
    expect(b.props.select).not.toHaveBeenCalled()
    expect(b.strip.hasAttribute('data-reordering')).toBe(false)
    expect(b.captured.size).toBe(0)
    expect(b.pending.size).toBe(0)
  })

  it('sorts with Alt plus arrow keys while preserving selected thread and keyboard focus', () => {
    const b = fixture()
    b.beta.focus()
    fireEvent.keyDown(b.beta, { key: 'ArrowLeft', altKey: true })
    expect(b.props.move).toHaveBeenCalledExactlyOnceWith(id('beta'), id('alpha'), 'before')
    expect(b.props.select).not.toHaveBeenCalled()
    b.rerender(<ThreadTabs {...b.props} tabs={[tabs[1]!, tabs[0]!, tabs[2]!]} />)
    expect(document.activeElement).toBe(b.beta)
    expect(b.gamma.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(b.beta, { key: 'ArrowLeft', altKey: true })
    expect(b.props.move).toHaveBeenCalledOnce()
    fireEvent.keyDown(b.beta, { key: 'ArrowRight', altKey: true })
    expect(b.props.move).toHaveBeenLastCalledWith(id('beta'), id('alpha'), 'after')
  })
})
