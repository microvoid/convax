// @vitest-environment jsdom
/** Shared activity overlays keep acknowledgement explicit and preserve keyboard focus after bulk reads. */
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CanvasId, CanvasNodeId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ActivityMenu } from '../src/client/ActivityMenu.tsx'
import type { CanvasActivityItem } from '../src/client/activity.ts'
import { en, type ConvaxKey } from '../src/client/locales.ts'
import type { WorkspaceProps } from '../src/client/props.ts'

const items: readonly CanvasActivityItem[] = [
  { sessionId: 'attention-thread' as SessionId, canvasId: 'alpha' as CanvasId, nodeId: 'alpha-chat' as CanvasNodeId,
    title: 'Review changes', canvasTitle: 'Alpha', kind: 'attention', occurredAt: 100, unread: true },
  { sessionId: 'completed-thread' as SessionId, canvasId: 'beta' as CanvasId, nodeId: 'beta-chat' as CanvasNodeId,
    title: 'Project summary', canvasTitle: 'Beta', kind: 'completed', occurredAt: 200, unread: true },
]
const t = ((key: ConvaxKey, values?: Record<string, string | number>) =>
  en[key].replace(/\{(\w+)\}/g, (_match, name: string) => String(values?.[name] ?? ''))) as WorkspaceProps['t']

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function fixture() {
  const select = vi.fn<(item: CanvasActivityItem) => Promise<boolean>>(async () => true)
  const readAll = vi.fn<(focused: Element | null, buttonDisabled: boolean) => void>()
  function Harness() {
    const [current, setCurrent] = useState(items)
    return <>
      <ActivityMenu items={current} busy={false} t={t}
        onReadAll={() => {
          readAll(document.activeElement, screen.getByRole<HTMLButtonElement>('button', { name: 'Mark all as read' }).disabled)
          setCurrent(value => value.map(item => ({ ...item, unread: false })))
        }}
        onSelect={async (item) => {
          const opened = await select(item)
          if (opened) setCurrent(value => value.map(row => row.sessionId === item.sessionId ? { ...row, unread: false } : row))
          return opened
        }} />
      <button type="button">Outside</button>
    </>
  }
  render(<Harness />)
  const trigger = screen.getByRole('button', { name: 'Activity, 2 unread' })
  return { trigger, select, readAll,
    open() { trigger.focus(); fireEvent.click(trigger); return screen.getByRole('dialog', { name: 'Activity' }) },
  }
}

describe('Convax activity menu', () => {
  it('opens a body-portaled list without acknowledging or selecting its unread activities', () => {
    const b = fixture()
    const dialog = b.open()
    expect(dialog.parentElement).toBe(document.body)
    expect(b.trigger.getAttribute('aria-expanded')).toBe('true')
    expect(within(dialog).getByRole('button', { name: 'Review changes, Needs attention' }).getAttribute('data-unread')).toBe('true')
    expect(within(dialog).getByRole('button', { name: 'Project summary, Finished' }).getAttribute('data-unread')).toBe('true')
    expect(b.readAll).not.toHaveBeenCalled()
    expect(b.select).not.toHaveBeenCalled()
    fireEvent.keyDown(document.activeElement ?? dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(b.trigger)
    expect(b.trigger.getAttribute('aria-label')).toBe('Activity, 2 unread')
    b.open()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(b.readAll).not.toHaveBeenCalled()
  })

  it('moves focus to the first activity before bulk-read disables its button and keeps attention visible', () => {
    const b = fixture()
    const dialog = b.open()
    const attention = within(dialog).getByRole('button', { name: 'Review changes, Needs attention' })
    const markAll = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Mark all as read' })
    markAll.focus()
    fireEvent.click(markAll)
    expect(b.readAll).toHaveBeenCalledExactlyOnceWith(attention, false)
    expect(markAll.disabled).toBe(true)
    expect(document.activeElement).toBe(attention)
    expect(attention.getAttribute('data-unread')).toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Project summary, Finished' }).getAttribute('data-unread')).toBeNull()
    expect(b.trigger.getAttribute('aria-label')).toBe('Activity')
    expect(b.trigger.textContent).toBe('')
    expect(b.select).not.toHaveBeenCalled()
    fireEvent.keyDown(attention, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(b.trigger)
  })

  it('retains the menu and unread state after failed asynchronous navigation, then closes after a successful retry', async () => {
    const b = fixture()
    const reply = Promise.withResolvers<boolean>()
    b.select.mockImplementationOnce(async () => await reply.promise)
    const dialog = b.open()
    const attention = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Review changes, Needs attention' })
    fireEvent.click(attention)
    expect(attention.disabled).toBe(true)
    expect(b.select).toHaveBeenCalledExactlyOnceWith(items[0])
    await act(async () => { reply.resolve(false) })
    expect(screen.getByRole('dialog', { name: 'Activity' })).toBe(dialog)
    expect(attention.disabled).toBe(false)
    expect(attention.getAttribute('data-unread')).toBe('true')
    expect(b.trigger.getAttribute('aria-label')).toBe('Activity, 2 unread')
    expect(b.readAll).not.toHaveBeenCalled()
    fireEvent.click(attention)
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(b.select).toHaveBeenCalledTimes(2)
    expect(b.trigger.getAttribute('aria-label')).toBe('Activity, 1 unread')
    expect(document.activeElement).toBe(b.trigger)
  })
})
