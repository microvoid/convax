// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { CanvasId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { CanvasTabs } from '../src/client/CanvasTabs.tsx'
import { en, type ConvaxKey } from '../src/client/locales.ts'

type Props = ComponentProps<typeof CanvasTabs>
const id = (value: string): CanvasId => value as CanvasId
const tabs = ['Alpha', 'Beta', 'Gamma'].map(title => ({ id: id(title.toLowerCase()), title }))

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function frames() {
  const pending = new Map<number, FrameRequestCallback>()
  let next = 0
  let timestamp = 0
  const cancel = vi.fn((handle: number) => { pending.delete(handle) })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    const handle = ++next
    pending.set(handle, callback)
    return handle
  })
  vi.stubGlobal('cancelAnimationFrame', cancel)
  onTestFinished(() => { cleanup(); vi.unstubAllGlobals() })
  return {
    pending, cancel,
    advance() {
      const scheduled = [...pending.values()]
      pending.clear()
      timestamp += 16
      act(() => { for (const callback of scheduled) callback(timestamp) })
    },
  }
}

function fixture(width = 300, widths: Readonly<Record<string, number>> = {}, gap = 0, scale = 1) {
  const animation = frames()
  const props: Props = {
    tabs, activeId: id('gamma'), open: vi.fn(), close: vi.fn(), move: vi.fn(), rename: vi.fn(),
    t: ((key: ConvaxKey, values?: Record<string, string | number>) =>
      en[key].replace(/\{(\w+)\}/g, (_match, name: string) => String(values?.[name] ?? ''))) as Props['t'],
  }
  const view = render(<CanvasTabs {...props} />)
  const strip = screen.getByRole('tablist', { name: 'All canvases' })
  const contentWidth = tabs.reduce((total, tab) => total + (widths[tab.id] ?? 100), 0) + gap * (tabs.length - 1)
  Object.defineProperties(strip, {
    clientWidth: { configurable: true, value: width },
    offsetWidth: { configurable: true, value: width },
    scrollWidth: { configurable: true, value: contentWidth },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect(0, 0, width * scale, 30 * scale) },
  })
  strip.style.columnGap = `${gap}px`
  const captured = new Map<Element, number>()
  const capture = vi.fn((element: Element, pointerId: number) => { captured.set(element, pointerId) })
  const release = vi.fn((element: Element, pointerId: number) => {
    if (captured.get(element) === pointerId) captured.delete(element)
  })
  for (const element of strip.querySelectorAll<HTMLElement>('button, [data-canvas-tab]')) {
    Object.defineProperties(element, {
      setPointerCapture: { configurable: true, value: (pointerId: number) => { capture(element, pointerId) } },
      hasPointerCapture: { configurable: true, value: (pointerId: number) => captured.get(element) === pointerId },
      releasePointerCapture: { configurable: true, value: (pointerId: number) => { release(element, pointerId) } },
    })
  }
  const cards = [...strip.querySelectorAll<HTMLElement>('[data-canvas-tab]')]
  const cardWidth = (card: HTMLElement): number => widths[card.dataset.canvasTab ?? ''] ?? 100
  for (const card of cards) {
    Object.defineProperty(card, 'getBoundingClientRect', {
      configurable: true,
      value: () => {
        const order = [...strip.querySelectorAll<HTMLElement>('[data-canvas-tab]')]
        const left = order.slice(0, order.indexOf(card)).reduce((total, preceding) => total + cardWidth(preceding) + gap, 0)
        return new DOMRect((left - strip.scrollLeft) * scale, 0, cardWidth(card) * scale, 30 * scale)
      },
    })
  }
  const alpha = screen.getByRole('tab', { name: 'Alpha' })
  const beta = screen.getByRole('tab', { name: 'Beta' })
  const gamma = screen.getByRole('tab', { name: 'Gamma' })
  const offset = (tab: HTMLElement): number => Number.parseFloat(tab.closest<HTMLElement>('[data-canvas-tab]')!.style.getPropertyValue('--dsh-convax-tab-offset')) || 0
  return { ...view, animation, props, strip, alpha, beta, gamma, captured, capture, release, offset }
}

function pointer(target: HTMLElement, type: string, x: number, y = 15, pointerId = 7): void {
  const event = new MouseEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0,
    buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
  })
  Object.defineProperties(event, {
    pointerId: { value: pointerId }, pointerType: { value: 'mouse' }, isPrimary: { value: true },
  })
  fireEvent(target, event)
}

describe('Convax canvas tab dragging', () => {
  it('moves the grabbed tab and neighboring tabs before committing one order change on release', () => {
    const b = fixture()
    b.alpha.focus()
    pointer(b.alpha, 'pointerdown', 25)
    pointer(b.alpha, 'pointermove', 275)
    expect(b.offset(b.alpha)).toBeGreaterThan(0)
    expect(b.offset(b.beta)).toBeLessThan(0)
    expect(b.offset(b.gamma)).toBeLessThan(0)
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(b.props.move).not.toHaveBeenCalled()
    pointer(b.alpha, 'pointerup', 275)
    fireEvent.click(b.alpha, { detail: 1 })
    expect(b.props.move).toHaveBeenCalledExactlyOnceWith(id('alpha'), id('gamma'), 'after')
    expect(b.props.open).not.toHaveBeenCalled()
    fireEvent.doubleClick(b.alpha)
    expect(b.props.rename).not.toHaveBeenCalled()
    expect(b.captured.size).toBe(0)
    expect(b.animation.pending.size).toBe(0)
    b.rerender(<CanvasTabs {...b.props} tabs={[tabs[1]!, tabs[2]!, tabs[0]!]} />)
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Beta', 'Gamma', 'Alpha'])
    expect(document.activeElement).toBe(b.alpha)
    expect(b.gamma.getAttribute('aria-selected')).toBe('true')
  })

  it.each([0.5, 2])('keeps tab movement under the pointer inside a %s scale canvas', (scale) => {
    const b = fixture(300, {}, 0, scale)
    pointer(b.alpha, 'pointerdown', 25 * scale)
    pointer(b.alpha, 'pointermove', 175 * scale)
    expect(b.offset(b.alpha)).toBe(150)
    expect(b.offset(b.beta)).toBe(-100)
    expect(b.offset(b.gamma)).toBe(0)
    pointer(b.alpha, 'pointermove', 275 * scale)
    expect(b.offset(b.alpha)).toBe(200)
    pointer(b.alpha, 'pointerup', 275 * scale)
    expect(b.props.move).toHaveBeenCalledExactlyOnceWith(id('alpha'), id('gamma'), 'after')
  })

  it('scrolls a zoomed strip in local pixels while the tab stays under the pointer', () => {
    const b = fixture(160, {}, 0, 0.5)
    pointer(b.alpha, 'pointerdown', 12.5)
    pointer(b.alpha, 'pointermove', 77.5)
    b.animation.advance()
    expect(b.strip.scrollLeft).toBeGreaterThan(0)
    for (let frame = 0; frame < 50 && b.animation.pending.size > 0; frame += 1) b.animation.advance()
    expect(b.strip.scrollLeft).toBe(140)
    expect(b.offset(b.alpha)).toBe(200)
    pointer(b.alpha, 'pointerup', 77.5)
    expect(b.props.move).toHaveBeenCalledExactlyOnceWith(id('alpha'), id('gamma'), 'after')
  })

  it('keeps a horizontal drag valid when the pointer moves far above or below the tab row', () => {
    const b = fixture()
    pointer(b.alpha, 'pointerdown', 25)
    pointer(b.alpha, 'pointermove', 275, 180)
    expect(b.offset(b.alpha)).toBeGreaterThan(0)
    pointer(b.alpha, 'pointerup', 275, -80)
    expect(b.props.move).toHaveBeenCalledExactlyOnceWith(id('alpha'), id('gamma'), 'after')
  })

  it('previews unequal-width tabs with their gaps and restores neighbors when the pointer moves back', () => {
    const b = fixture(344, { alpha: 80, beta: 160, gamma: 96 }, 4)
    pointer(b.alpha, 'pointerdown', 20)
    pointer(b.alpha, 'pointermove', 200)
    expect(b.offset(b.alpha)).toBe(180)
    expect(b.offset(b.beta)).toBe(-84)
    expect(b.offset(b.gamma)).toBe(0)
    pointer(b.alpha, 'pointermove', 20)
    expect(b.offset(b.alpha)).toBe(0)
    expect(b.offset(b.beta)).toBe(0)
    expect(b.offset(b.gamma)).toBe(0)
    expect(b.props.move).not.toHaveBeenCalled()
    pointer(b.alpha, 'pointermove', 330)
    expect(b.offset(b.beta)).toBe(-84)
    expect(b.offset(b.gamma)).toBe(-84)
    pointer(b.alpha, 'pointerup', 330)
    expect(b.props.move).toHaveBeenCalledExactlyOnceWith(id('alpha'), id('gamma'), 'after')
  })

  it('keeps vertical jitter and a short horizontal movement as ordinary tab selection', () => {
    const b = fixture()
    pointer(b.alpha, 'pointerdown', 25)
    pointer(b.alpha, 'pointermove', 30, 200)
    expect(b.strip.hasAttribute('data-reordering')).toBe(false)
    expect(b.offset(b.alpha)).toBe(0)
    pointer(b.alpha, 'pointerup', 30, 200)
    fireEvent.click(b.alpha, { detail: 1 })
    expect(b.props.open).toHaveBeenCalledExactlyOnceWith(id('alpha'))
    expect(b.props.move).not.toHaveBeenCalled()
  })

  it.each(['pointercancel', 'lostpointercapture', 'Escape'] as const)('rolls the preview back after %s', (ending) => {
    const b = fixture()
    pointer(b.alpha, 'pointerdown', 25)
    pointer(b.alpha, 'pointermove', 275)
    if (ending === 'Escape') fireEvent.keyDown(b.alpha, { key: 'Escape' })
    else pointer(b.alpha, ending, 275)
    expect(b.strip.hasAttribute('data-reordering')).toBe(false)
    expect(b.offset(b.alpha)).toBe(0)
    pointer(b.alpha, 'pointerup', 275)
    expect(b.props.move).not.toHaveBeenCalled()
    expect(b.animation.pending.size).toBe(0)
    expect(b.captured.size).toBe(0)
    fireEvent.click(b.alpha, { detail: 0 })
    expect(b.props.open).toHaveBeenCalledExactlyOnceWith(id('alpha'))
  })

  it('cancels a press with Escape before the drag threshold without selecting the canvas on release', () => {
    const b = fixture()
    pointer(b.alpha, 'pointerdown', 25)
    pointer(b.alpha, 'pointermove', 27)
    fireEvent.keyDown(b.alpha, { key: 'Escape' })
    pointer(b.alpha, 'pointerup', 27)
    fireEvent.click(b.alpha, { detail: 1 })
    expect(b.props.open).not.toHaveBeenCalled()
    expect(b.props.move).not.toHaveBeenCalled()
    expect(b.captured.size).toBe(0)
    expect(b.animation.pending.size).toBe(0)
    fireEvent.click(b.alpha, { detail: 0 })
    expect(b.props.open).toHaveBeenCalledExactlyOnceWith(id('alpha'))
  })

  it('auto-scrolls a crowded strip while the pointer stays at its edge and commits the revealed destination', () => {
    const b = fixture(160)
    pointer(b.alpha, 'pointerdown', 25)
    pointer(b.alpha, 'pointermove', 155)
    expect(b.animation.pending.size).toBe(1)
    b.animation.advance()
    expect(b.strip.scrollLeft).toBeGreaterThan(0)
    for (let frame = 0; frame < 50 && b.animation.pending.size > 0; frame += 1) b.animation.advance()
    expect(b.strip.scrollLeft).toBe(140)
    expect(b.animation.pending.size).toBe(0)
    expect(b.props.move).not.toHaveBeenCalled()
    pointer(b.alpha, 'pointerup', 155)
    expect(b.props.move).toHaveBeenCalledExactlyOnceWith(id('alpha'), id('gamma'), 'after')
    expect(b.captured.size).toBe(0)
  })

  it('reveals earlier tabs while dragging at the left edge of an already scrolled strip', () => {
    const b = fixture(160)
    b.strip.scrollLeft = 140
    pointer(b.gamma, 'pointerdown', 85)
    pointer(b.gamma, 'pointermove', 5)
    expect(b.animation.pending.size).toBe(1)
    b.animation.advance()
    expect(b.strip.scrollLeft).toBeLessThan(140)
    for (let frame = 0; frame < 50 && b.animation.pending.size > 0; frame += 1) b.animation.advance()
    expect(b.strip.scrollLeft).toBe(0)
    expect(b.animation.pending.size).toBe(0)
    pointer(b.gamma, 'pointerup', 5)
    expect(b.props.move).toHaveBeenCalledExactlyOnceWith(id('gamma'), id('alpha'), 'before')
  })

  it('stops auto-scrolling when the pointer returns to the middle of the strip', () => {
    const b = fixture(160)
    pointer(b.alpha, 'pointerdown', 25)
    pointer(b.alpha, 'pointermove', 155)
    const late = [...b.animation.pending.values()][0]!
    pointer(b.alpha, 'pointermove', 80)
    expect(b.animation.pending.size).toBe(0)
    expect(b.animation.cancel).toHaveBeenCalledOnce()
    act(() => { late(0) })
    expect(b.strip.scrollLeft).toBe(0)
    expect(b.animation.pending.size).toBe(0)
    pointer(b.alpha, 'pointermove', 155)
    b.animation.advance()
    expect(b.strip.scrollLeft).toBeGreaterThan(0)
    pointer(b.alpha, 'pointercancel', 155)
  })

  it.each(['cancel', 'unmount'] as const)('stops edge scrolling after %s and ignores a late animation callback', (ending) => {
    const b = fixture(160)
    pointer(b.alpha, 'pointerdown', 25)
    pointer(b.alpha, 'pointermove', 155)
    const late = [...b.animation.pending.values()][0]!
    expect(b.animation.pending.size).toBe(1)
    if (ending === 'cancel') pointer(b.alpha, 'pointercancel', 155)
    else b.unmount()
    expect(b.animation.pending.size).toBe(0)
    expect(b.animation.cancel).toHaveBeenCalledOnce()
    expect(b.captured.size).toBe(0)
    act(() => { late(32) })
    expect(b.strip.scrollLeft).toBe(0)
    expect(b.animation.pending.size).toBe(0)
    expect(b.props.move).not.toHaveBeenCalled()
  })

  it.each(['blur', 'resize'] as const)('cancels the drag and edge scrolling when the window emits %s', (eventName) => {
    const b = fixture(160)
    pointer(b.alpha, 'pointerdown', 25)
    pointer(b.alpha, 'pointermove', 155)
    const late = [...b.animation.pending.values()][0]!
    fireEvent(window, new Event(eventName))
    expect(b.strip.hasAttribute('data-reordering')).toBe(false)
    expect(b.offset(b.alpha)).toBe(0)
    expect(b.animation.pending.size).toBe(0)
    expect(b.captured.size).toBe(0)
    act(() => { late(32) })
    expect(b.strip.scrollLeft).toBe(0)
    expect(b.animation.pending.size).toBe(0)
    pointer(b.alpha, 'pointerup', 155)
    fireEvent.click(b.alpha, { detail: 1 })
    expect(b.props.move).not.toHaveBeenCalled()
    expect(b.props.open).not.toHaveBeenCalled()
  })

  it('clears the settling presentation only when the grabbed tab finishes its own animation', () => {
    const b = fixture()
    pointer(b.alpha, 'pointerdown', 25)
    pointer(b.alpha, 'pointermove', 275)
    pointer(b.alpha, 'pointerup', 275)
    const card = b.alpha.closest<HTMLElement>('[data-canvas-tab]')!
    expect(card.hasAttribute('data-settling')).toBe(true)
    // React 18 uses prefixed animation events when jsdom does not expose AnimationEvent.
    const eventName = !('AnimationEvent' in window) && 'WebkitAnimation' in document.createElement('div').style
      ? 'webkitAnimationEnd' : 'animationend'
    fireEvent(b.alpha, new Event(eventName, { bubbles: true }))
    expect(card.hasAttribute('data-settling')).toBe(true)
    fireEvent(card, new Event(eventName, { bubbles: true }))
    expect(card.hasAttribute('data-settling')).toBe(false)
    expect(card.style.getPropertyValue('--dsh-convax-tab-settle')).toBe('')
    expect(b.props.move).toHaveBeenCalledOnce()
  })

  it('keeps close and rename actions separate from dragging', () => {
    const b = fixture()
    const close = screen.getByRole('button', { name: 'Close Alpha' })
    pointer(close, 'pointerdown', 90)
    pointer(close, 'pointermove', 275)
    pointer(close, 'pointerup', 275)
    fireEvent.click(close)
    expect(b.props.close).toHaveBeenCalledExactlyOnceWith(id('alpha'))
    expect(b.capture).not.toHaveBeenCalled()
    expect(b.props.move).not.toHaveBeenCalled()
    expect(b.props.open).not.toHaveBeenCalled()
    fireEvent.doubleClick(b.beta)
    expect(b.props.rename).toHaveBeenCalledExactlyOnceWith(id('beta'), 'Beta')
  })

  it('retains keyboard sorting and restores focus after the controlled order changes', () => {
    const b = fixture()
    b.beta.focus()
    fireEvent.keyDown(b.beta, { key: 'ArrowLeft', altKey: true })
    expect(b.props.move).toHaveBeenCalledExactlyOnceWith(id('beta'), id('alpha'), 'before')
    expect(b.props.open).not.toHaveBeenCalled()
    b.rerender(<CanvasTabs {...b.props} tabs={[tabs[1]!, tabs[0]!, tabs[2]!]} />)
    expect(document.activeElement).toBe(b.beta)
    expect(b.gamma.getAttribute('aria-selected')).toBe('true')
  })

  it('cancels a local preview when the available tabs change', () => {
    const b = fixture(160)
    pointer(b.alpha, 'pointerdown', 25)
    pointer(b.alpha, 'pointermove', 155)
    expect(b.strip.hasAttribute('data-reordering')).toBe(true)
    b.rerender(<CanvasTabs {...b.props} tabs={[tabs[0]!, tabs[2]!]} />)
    expect(b.strip.hasAttribute('data-reordering')).toBe(false)
    expect(b.offset(b.alpha)).toBe(0)
    expect(b.animation.pending.size).toBe(0)
    expect(b.captured.size).toBe(0)
    expect(b.props.move).not.toHaveBeenCalled()
  })
})
