// @vitest-environment jsdom
/** Browser interaction facts defer ordinary notices and listeners leave with their window owner. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopUpdateBridge } from '@deepseek-ai/dsh-client-ui-settings-general/types'
import { BrowserNoticeEnvironment, NoticeUpdateUnavailableError } from '../src/client/notices/browser.ts'

const cleanups: Array<() => void> = []
beforeEach(() => { vi.spyOn(document, 'hasFocus').mockReturnValue(true) })
afterEach(() => {
  try { for (const close of cleanups.splice(0).reverse()) close() }
  finally { document.body.replaceChildren(); vi.restoreAllMocks() }
})

function fixture(updates?: DesktopUpdateBridge) {
  const clock = { value: 1000 }
  const running = vi.fn(() => false)
  const environment = new BrowserNoticeEnvironment({ document, window, running, capabilities: () => ['canvas.resources'], updates, now: () => clock.value })
  environment.configure(5000)
  return { clock, running, environment }
}

describe('Convax notice browser timing', () => {
  it('defers ordinary notices while typing, holding a drag or executing a task', () => {
    const f = fixture()
    const wake = vi.fn()
    cleanups.push(f.environment.subscribe(wake))
    f.clock.value += 5000
    expect(f.environment.context()).toMatchObject({ available: true, busy: false })
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    expect(f.environment.context().busy).toBe(true)
    input.blur()
    document.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    f.clock.value += 6000
    expect(f.environment.context().busy).toBe(true)
    document.dispatchEvent(new Event('pointerup', { bubbles: true }))
    expect(f.environment.context().busy).toBe(true)
    f.clock.value += 5000
    expect(f.environment.context().busy).toBe(false)
    f.running.mockReturnValue(true)
    expect(f.environment.context().busy).toBe(true)
    expect(wake).toHaveBeenCalledTimes(2)
  })

  it('recognizes a native empty-attribute editable region and its focused descendants', () => {
    const f = fixture()
    f.clock.value += 5000
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', '')
    const input = document.createElement('button')
    editor.append(input)
    document.body.append(editor)
    input.focus()
    expect(f.environment.context().busy).toBe(true)
    editor.remove()
  })

  it('waits for another modal but allows its own notice dialog to remain visible', () => {
    const f = fixture()
    f.clock.value += 5000
    const other = document.createElement('section')
    other.setAttribute('aria-modal', 'true')
    document.body.append(other)
    expect(f.environment.context().available).toBe(false)
    other.remove()
    const notice = document.createElement('section')
    notice.setAttribute('data-convax-notice', 'notice')
    notice.innerHTML = '<div aria-modal="true" data-shortcut-modal="notice"></div>'
    document.body.append(notice)
    expect(f.environment.context().available).toBe(true)
    notice.remove()
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    expect(f.environment.context().available).toBe(false)
  })

  it('resets interrupted pointer activity on blur and removes every listener on release', () => {
    const f = fixture()
    const wake = vi.fn()
    const release = f.environment.subscribe(wake)
    cleanups.push(release)
    document.dispatchEvent(new Event('pointerdown'))
    window.dispatchEvent(new Event('blur'))
    f.clock.value += 5000
    expect(f.environment.context().busy).toBe(false)
    release()
    const calls = wake.mock.calls.length
    document.dispatchEvent(new Event('input'))
    document.dispatchEvent(new Event('keydown'))
    document.dispatchEvent(new Event('pointerdown'))
    document.dispatchEvent(new Event('pointerup'))
    document.dispatchEvent(new Event('pointercancel'))
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    expect(wake).toHaveBeenCalledTimes(calls)
    f.clock.value += 5000
    expect(f.environment.context().busy).toBe(false)
  })

  it('opens native update controls without selecting an installer and isolates external destinations', async () => {
    const status = vi.fn<DesktopUpdateBridge['status']>(async () => ({ phase: 'idle' }))
    const nativeOpen = vi.fn<DesktopUpdateBridge['open']>(async () => {})
    const updates: DesktopUpdateBridge = { status, open: nativeOpen, subscribe: vi.fn<DesktopUpdateBridge['subscribe']>(() => () => {}) }
    const f = fixture(updates)
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    await f.environment.execute({ id: 'update', type: 'open_update', label: 'Update', releaseId: 'release' })
    expect(nativeOpen).toHaveBeenCalledWith()
    expect(status).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    await f.environment.execute({ id: 'page', type: 'open_url', label: 'Details', url: 'https://example.com/details' })
    expect(open).toHaveBeenCalledWith('https://example.com/details', '_blank', 'noopener,noreferrer')
    await f.environment.execute({ id: 'close', type: 'dismiss', label: 'Close' })
    await f.environment.execute({ id: 'later', type: 'snooze', label: 'Later', snoozeSeconds: 3600 })
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('reports a classified unavailable updater instead of pretending an update started', async () => {
    const f = fixture()
    await expect(f.environment.execute({ id: 'update', type: 'open_update', label: 'Update', releaseId: 'release' }))
      .rejects.toBeInstanceOf(NoticeUpdateUnavailableError)
  })
})
