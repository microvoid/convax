// @vitest-environment jsdom
/** Source selection is explicit and recoverable; enumeration never supplies previews or auto-selects. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopWindowSourceId } from '@deepseek-ai/dsh-util-desktop-capture'
import { WindowPicker } from '../src/client/WindowPicker.tsx'
import { en, type ConvaxKey } from '../src/client/locales.ts'
import type { WorkspaceProps } from '../src/client/props.ts'

const t = ((key: ConvaxKey) => en[key]) as WorkspaceProps['t']
afterEach(cleanup)

it('filters native window names and captures only the explicitly chosen source', async () => {
  const list = vi.fn(async () => [
    { id: 'window:1:0' as DesktopWindowSourceId, name: 'First document', appIcon: 'data:image/png;base64,fixture' },
    { id: 'window:2:0' as DesktopWindowSourceId, name: 'Second document' },
  ])
  const select = vi.fn(async () => true)
  const close = vi.fn()
  render(<WindowPicker rebind={false} list={list} select={select} close={close} t={t} />)
  const first = await screen.findByRole('button', { name: 'First document' })
  expect(first.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,fixture')
  expect(first.querySelector('svg')).toBeNull()
  const second = screen.getByRole('button', { name: 'Second document' })
  expect(second.querySelector('img')).toBeNull()
  expect(second.querySelector('svg')).not.toBeNull()
  expect(select).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole('textbox', { name: 'Search windows' }), { target: { value: 'Second' } })
  expect(screen.queryByRole('button', { name: 'First document' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Second document' }))
  await waitFor(() => { expect(select).toHaveBeenCalledExactlyOnceWith('window:2:0') })
  await waitFor(() => { expect(close).toHaveBeenCalledOnce() })
})

it('preserves the source list and allows explicit retry after capture refusal', async () => {
  const list = vi.fn(async () => [{ id: 'window:1:0' as DesktopWindowSourceId, name: 'Test window' }])
  const select = vi.fn(async () => false)
  const close = vi.fn()
  render(<WindowPicker rebind list={list} select={select} close={close} t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Test window' }))
  await screen.findByRole('alert')
  expect(close).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Test window' })).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await waitFor(() => { expect(list).toHaveBeenCalledTimes(2) })
})
