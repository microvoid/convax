// @vitest-environment jsdom
/** Notification surfaces use the real slot bindings and shared modal and message primitives. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { NoticePresentation } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { NoticeOverlay } from '../src/client/notices/NoticeOverlay.tsx'
import type { NoticeOverlayInjected, NoticeOverlaySnapshot } from '../src/client/notices/NoticeOverlay.tsx'
import { NS, dictionaries } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

function notice(change: Partial<NoticePresentation> = {}): NoticePresentation {
  return {
    id: 'notice-presentation' as NoticePresentation['id'], noticeId: 'feature-intro', revision: '2',
    kind: 'feature', surface: 'modal', title: 'Connect resources', body: 'Use a resource in your conversation.',
    actions: [{ id: 'dismiss', type: 'dismiss', label: 'Got it' },
      { id: 'try', type: 'open_url', label: 'Try it', url: 'https://example.com/feature' }],
    dismissible: true, ...change,
  }
}

async function fixture(presentation: NoticePresentation | null) {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const locale = new LocaleRuntime(runtime.ctx)
  locale.setLocale('en')
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  runtime.ctx.effect(() => locale.register(NS, dictionaries))
  const source = createSnapshotStore<NoticeOverlaySnapshot>({ presentation, busy: false, error: null })
  const shown = vi.fn<NoticeOverlayInjected['shown']>()
  const close = vi.fn<NoticeOverlayInjected['close']>(() => {
    source.set({ ...source.getSnapshot(), presentation: null })
  })
  const action = vi.fn<NoticeOverlayInjected['action']>()
  const expired = vi.fn<NoticeOverlayInjected['expired']>()
  await runtime.declare({ 'shell.overlay': { kind: 'list', scope: 'root' } })
  await runtime.mount({ inject: ['slots'], apply(ctx) {
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay', id: 'test-notices', locale: NS,
      inject: (): NoticeOverlayInjected => ({ hooks: { notice: source }, shown, close, action, expired }),
    }, NoticeOverlay))
  } })
  return { runtime, locale, source, shown, close, action, expired,
    show: () => runtime.renderSlot('shell.overlay', {}),
    update: async (change: Partial<NoticeOverlaySnapshot>) => {
      await act(async () => { source.set({ ...source.getSnapshot(), ...change }) })
    },
  }
}

describe('Convax notice surfaces', () => {
  it('keeps an empty queue invisible and reports exposure only after a visible presentation mounts', async () => {
    const b = await fixture(null)
    b.show()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(b.shown).not.toHaveBeenCalled()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await b.update({ presentation: notice() })
    expect(b.shown).not.toHaveBeenCalled()
    visibility.mockReturnValue('visible')
    fireEvent(document, new Event('visibilitychange'))
    expect(b.shown).toHaveBeenCalledExactlyOnceWith('notice-presentation')
  })

  it('closes an ordinary modal with Escape or its mask and restores the invoking focus', async () => {
    render(<button type="button">Continue editing</button>)
    const invoking = screen.getByRole('button', { name: 'Continue editing' })
    invoking.focus()
    const b = await fixture(notice())
    b.show()
    const dialog = screen.getByRole('dialog', { name: 'Connect resources' })
    expect(dialog.querySelector('[data-convax-notice]')).not.toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Got it' }))
    fireEvent.keyDown(document.activeElement ?? dialog, { key: 'Escape' })
    expect(b.close).toHaveBeenCalledExactlyOnceWith('notice-presentation')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(invoking)
    await b.update({ presentation: notice({ id: 'second-presentation' as NoticePresentation['id'] }) })
    const reopened = screen.getByRole('dialog', { name: 'Connect resources' })
    const mask = reopened.parentElement?.querySelector('[aria-hidden="true"]')
    expect(mask).not.toBeNull()
    fireEvent.click(mask!)
    expect(b.close).toHaveBeenLastCalledWith('second-presentation')
    expect(document.activeElement).toBe(invoking)
  })

  it('keeps a mandatory update open on Escape and mask clicks and delegates explicit update actions', async () => {
    const presentation = notice({ kind: 'mandatory-update', title: '', body: '', dismissible: false,
      actions: [{ id: 'update', type: 'open_update', label: '', releaseId: 'release-2' }] })
    const b = await fixture(presentation)
    b.show()
    const dialog = screen.getByRole('dialog', { name: 'Update required' })
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Update required' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open updater' }))
    expect(dialog.textContent).toContain('Installation still requires your confirmation.')
    fireEvent.keyDown(document.activeElement ?? dialog, { key: 'Escape' })
    fireEvent.click(dialog.parentElement!.querySelector('[aria-hidden="true"]')!)
    expect(b.close).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Update required' })).toBe(dialog)
    fireEvent.click(screen.getByRole('button', { name: 'Open updater' }))
    expect(b.action).toHaveBeenCalledExactlyOnceWith(presentation.id, 'update')
    await b.update({ busy: true })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Open updater' }).disabled).toBe(true)
    await b.update({ busy: false, error: 'The update could not be opened. Try again.' })
    expect(screen.getByRole('alert').textContent).toContain('Try again')
    expect(screen.getByRole('dialog', { name: 'Update required' })).toBe(dialog)
  })

  it('focuses a local dismissal instead of an external action on automatic presentation', async () => {
    const b = await fixture(notice({ actions: [
      { id: 'try', type: 'open_url', label: 'Learn more', url: 'https://example.test/feature' },
      { id: 'dismiss', type: 'dismiss', label: 'Got it' },
    ] }))
    b.show()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Got it' }))
    expect(b.action).not.toHaveBeenCalled()
  })

  it('shows maintenance as a transient message without a persistent banner', async () => {
    vi.useFakeTimers()
    const presentation = notice({ kind: 'maintenance', surface: 'message', title: 'Cloud service maintenance',
      body: 'Local canvases remain available.', actions: [], holdMs: 1000 })
    const b = await fixture(presentation)
    b.show()
    expect(screen.getByRole('alert').textContent).toContain('Cloud service maintenance · Local canvases remain available.')
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => { vi.advanceTimersByTime(2000) })
    expect(b.expired).toHaveBeenCalledExactlyOnceWith(presentation.id)
  })

  it('gives a failed message action a fresh reading interval without counting another exposure', async () => {
    vi.useFakeTimers()
    const presentation = notice({ surface: 'message', holdMs: 1000 })
    const b = await fixture(presentation)
    b.show()
    fireEvent.click(screen.getByRole('button', { name: 'Try it' }))
    expect(b.action).toHaveBeenCalledExactlyOnceWith(presentation.id, 'try')
    await act(async () => { vi.advanceTimersByTime(1500) })
    await b.update({ error: 'The page could not be opened. Try again.' })
    expect(screen.getByRole('alert').textContent).toContain('The page could not be opened')
    await act(async () => { vi.advanceTimersByTime(1500) })
    expect(b.expired).not.toHaveBeenCalled()
    expect(b.shown).toHaveBeenCalledExactlyOnceWith(presentation.id)
    await act(async () => { vi.advanceTimersByTime(500) })
    expect(b.expired).toHaveBeenCalledExactlyOnceWith(presentation.id)
  })

  it('retains the generic banner and displays shared language changes without replacing supplied content', async () => {
    const presentation = notice({ surface: 'banner' })
    const b = await fixture(presentation)
    b.show()
    expect(screen.getByRole('status', { name: 'Connect resources' }).textContent).toContain(presentation.body)
    fireEvent.click(screen.getByRole('button', { name: 'Try it' }))
    expect(b.action).toHaveBeenCalledExactlyOnceWith(presentation.id, 'try')
    await act(async () => { b.locale.setLocale('zh') })
    expect(screen.getByRole('button', { name: '关闭' })).toBeDefined()
    expect(screen.getByRole('status').textContent).toContain(presentation.body)
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(b.close).toHaveBeenCalledExactlyOnceWith(presentation.id)
  })
})
