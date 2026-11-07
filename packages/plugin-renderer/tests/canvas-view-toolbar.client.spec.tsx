// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CanvasViewToolbar } from '../src/client/CanvasViewToolbar.tsx'
import { en, type ConvaxKey } from '../src/client/locales.ts'

type Props = ComponentProps<typeof CanvasViewToolbar>
const t = ((key: ConvaxKey) => en[key]) as Props['t']
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function fixture(overrides: Partial<Props> = {}) {
  const props: Props = {
    inputMode: 'touchpad', setInputMode: vi.fn(), zoom: 0.38, locale: 'en',
    zoomOut: vi.fn(), resetZoom: vi.fn(), zoomIn: vi.fn(), fit: vi.fn(), undo: vi.fn(), redo: vi.fn(),
    undoDisabled: false, redoDisabled: false, t, ...overrides,
  }
  const view = render(<><button type="button">Outside</button><CanvasViewToolbar {...props} /></>)
  return { ...view, props }
}

describe('Canvas view toolbar', () => {
  it('exposes seven icon controls and keeps the current zoom accessible without visible text', () => {
    const b = fixture()
    const bar = b.container.querySelector('[data-convax-view-toolbar]')!
    expect(bar.textContent).toBe('')
    expect(bar.querySelectorAll('button')).toHaveLength(7)
    const reset = screen.getByRole('button', { name: 'Reset zoom to 100%' })
    expect(reset.getAttribute('aria-description')).toBe('38%')
    expect(screen.getByRole('button', { name: 'Canvas input mode' }).getAttribute('aria-description')).toBe('Touchpad mode')
    b.rerender(<CanvasViewToolbar {...b.props} zoom={1.25} locale="de" inputMode="mouse" />)
    expect(screen.getByRole('button', { name: 'Reset zoom to 100%' }).getAttribute('aria-description'))
      .toBe(new Intl.NumberFormat('de', { style: 'percent', maximumFractionDigits: 0 }).format(1.25))
    expect(screen.getByRole('button', { name: 'Canvas input mode' }).getAttribute('aria-description')).toBe('Mouse mode')
  })

  it('selects an input mode through the portaled menu without navigating the viewport', () => {
    const b = fixture()
    const trigger = screen.getByRole('button', { name: 'Canvas input mode' })
    fireEvent.click(trigger)
    expect(b.container.contains(screen.getByRole('menu'))).toBe(false)
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Touchpad mode', 'Mouse mode'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mouse mode' }))
    expect(b.props.setInputMode).toHaveBeenCalledExactlyOnceWith('mouse')
    expect(screen.queryByRole('menu')).toBeNull()
    for (const action of [b.props.zoomOut, b.props.resetZoom, b.props.zoomIn, b.props.fit, b.props.undo, b.props.redo]) {
      expect(action).not.toHaveBeenCalled()
    }
  })

  it.each(['Escape', 'outside'])('closes the mode menu with %s without changing the saved preference', (method) => {
    const b = fixture()
    const trigger = screen.getByRole('button', { name: 'Canvas input mode' })
    fireEvent.click(trigger)
    if (method === 'Escape') fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Touchpad mode' }), { key: 'Escape' })
    else fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(b.props.setInputMode).not.toHaveBeenCalled()
    if (method === 'Escape') expect(document.activeElement).toBe(trigger)
  })

  it('delegates viewport and history actions independently', () => {
    const b = fixture()
    for (const [label, action] of [
      ['Zoom out', b.props.zoomOut], ['Reset zoom to 100%', b.props.resetZoom], ['Zoom in', b.props.zoomIn],
      ['Fit canvas', b.props.fit], ['Undo', b.props.undo], ['Redo', b.props.redo],
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name: label }))
      expect(action).toHaveBeenCalledOnce()
    }
  })

  it('blocks unavailable history while retaining viewport controls', () => {
    const b = fixture({ undoDisabled: true, redoDisabled: true })
    for (const label of ['Undo', 'Redo']) {
      const button = screen.getByRole('button', { name: label })
      expect(button.hasAttribute('disabled')).toBe(true)
      fireEvent.click(button)
    }
    expect(b.props.undo).not.toHaveBeenCalled()
    expect(b.props.redo).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Fit canvas' }))
    expect(b.props.fit).toHaveBeenCalledOnce()
  })
})
