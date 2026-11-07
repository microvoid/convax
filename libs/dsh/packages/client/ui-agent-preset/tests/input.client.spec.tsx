// @vitest-environment jsdom
/** Composer mode selection keeps the current Session and the new-Session action separate. */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { AgentPresetInput, type AgentPresetInputProps } from '../src/client/AgentPresetInput.tsx'
import type { AgentPresetSeatState } from '../src/client/seat-store.ts'
import type { AgentPresetDefaultState } from '../src/client/default-store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

function bench(options: {
  started?: boolean
  metadataBlank?: boolean
  locked?: boolean
  enabled?: boolean
  state?: Partial<AgentPresetSeatState>
  defaults?: Partial<AgentPresetDefaultState>
  create?: () => Promise<void>
} = {}) {
  const sid = SessionId('input-session')
  const state = createSnapshotStore<AgentPresetSeatState>({
    current: 'standard',
    options: [{ id: 'standard' }, { id: 'ptc' }, { id: 'minimal' }, { id: 'mine', name: 'Custom mode' }],
    busy: false, loading: false, introduce: false, error: null,
    ...options.state,
  })
  const sessions = createSnapshotStore<SessionListState>({
    ids: [sid], byId: { [sid]: {
      id: sid, displayTitle: 'Conversation', updatedAt: 1, blank: options.started !== true, running: false,
      retainedBy: {}, projectionValues: {
        agentPreset: 'standard',
        ...options.metadataBlank === undefined ? {} : { sessionListMetadata: { blank: options.metadataBlank, lastPromptAt: null } },
      },
    } }, phase: 'ready', projectionsBySession: {},
  })
  const developerTools = createSnapshotStore(options.enabled ?? true)
  const defaults = createSnapshotStore<AgentPresetDefaultState>({ saving: false, error: null, ...options.defaults })
  const select = vi.fn(() => Promise.resolve(undefined))
  const load = vi.fn(() => Promise.resolve())
  const onNewSession = vi.fn(options.create ?? (() => Promise.resolve()))
  const props = {
    sessionId: sid,
    useSessions: bindSnapshotSelector(sessions),
    useAgentPresetSeat: bindSnapshotSelector(state),
    usePresetDefault: bindSnapshotSelector(defaults),
    useDeveloperTools: bindSnapshotSelector(developerTools),
    select, load, onNewSession,
    startSession: (id, create) => create(id),
    locked: options.locked ?? false, t: makeTranslate(en),
  } as AgentPresetInputProps
  const view = render(<AgentPresetInput {...props} />)
  return { state, defaults, sessions, developerTools, select, load, onNewSession, view }
}

function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Agent mode: Standard mode' }))
}

describe('composer agent mode', () => {
  it('selects the blank Session without creating another Session', async () => {
    const b = bench()
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: /^PTC mode/ }))
    await waitFor(() => { expect(b.select).toHaveBeenCalledWith('ptc') })
    expect(b.onNewSession).not.toHaveBeenCalled()
    expect(b.load).toHaveBeenCalledOnce()
  })

  it('selects a Session with no committed turn even when its display summary is not blank', async () => {
    const b = bench({ started: true, metadataBlank: true })
    open()
    expect(screen.queryByText(en.composerFixed)).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /^PTC mode/ }))
    await waitFor(() => { expect(b.select).toHaveBeenCalledWith('ptc') })
    expect(b.onNewSession).not.toHaveBeenCalled()
  })

  it('keeps a Session with a committed turn fixed even when its display summary is blank', async () => {
    const b = bench({ started: false, metadataBlank: false })
    open()
    expect(screen.getByText(en.composerFixed)).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: /^New conversation in PTC mode/ }))
    await waitFor(() => { expect(b.onNewSession).toHaveBeenCalledWith('ptc') })
    expect(b.select).not.toHaveBeenCalled()
  })

  it('creates another Session with the selected mode after the current Session starts', async () => {
    const b = bench({ started: true })
    open()
    expect(screen.getByText(en.composerFixed)).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: /^New conversation in PTC mode/ }))
    await waitFor(() => { expect(b.onNewSession).toHaveBeenCalledWith('ptc') })
    expect(b.select).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Agent mode: Standard mode' })).toBeTruthy()
  })

  it('uses the recorded mode for a started Session even when a pending stage differs', () => {
    bench({ started: true, state: { current: 'ptc' } })
    expect(screen.getByRole('button', { name: 'Agent mode: Standard mode' })).toBeTruthy()
  })

  it('keeps the mode fixed and presents a local creation failure with retry available', async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValue(undefined)
    const b = bench({ started: true, create })
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: /^New conversation in PTC mode/ }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('Could not create conversation: Connection lost') })
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: /^New conversation in PTC mode/ }))
    await waitFor(() => { expect(b.onNewSession).toHaveBeenCalledTimes(2) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(b.select).not.toHaveBeenCalled()
  })

  it('disables the control during creation and restores it after settlement', async () => {
    const gate = Promise.withResolvers<undefined>()
    bench({ started: true, create: () => gate.promise })
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: /^New conversation in PTC mode/ }))
    const button = screen.getByRole('button', { name: 'Agent mode: Standard mode' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.textContent).toContain('Creating…')
    await act(async () => { gate.resolve(undefined); await gate.promise })
    expect(button.disabled).toBe(false)
  })

  it.each([{ loading: true }, { busy: true }])('disables interaction while the controller is %j', (state) => {
    bench({ state })
    expect(screen.getByRole('button', { name: 'Agent mode: Standard mode' }).getAttribute('disabled')).toBe('')
  })

  it('respects the composer lock', () => {
    bench({ locked: true })
    expect(screen.getByRole('button', { name: 'Agent mode: Standard mode' }).getAttribute('disabled')).toBe('')
  })

  it('filters Coding Tools modes while preserving custom modes and the current mode label', async () => {
    const b = bench({ enabled: false, state: { current: 'ptc' } })
    fireEvent.click(screen.getByRole('button', { name: 'Agent mode: PTC mode' }))
    expect(screen.queryByRole('menuitem', { name: /^PTC mode/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /^Minimal mode/ })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /^Custom mode/ }))
    await waitFor(() => { expect(b.select).toHaveBeenCalledWith('mine') })
  })

  it('shows a failed roster read locally and allows refreshing an empty roster', () => {
    const b = bench({ state: { options: [], current: '', error: 'Unavailable' } })
    expect(screen.getByRole('alert').textContent).toBe('Could not load modes: Unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Agent mode: Agent mode' }))
    expect(screen.getByText(en.composerEmpty)).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Refresh modes' }))
    expect(b.load).toHaveBeenCalledTimes(2)
  })

  it('shows a refused blank-Session selection beside its composer', () => {
    bench({ state: { error: { preset: { id: 'ptc' }, reason: 'Already started' } } })
    expect(screen.getByRole('alert').textContent).toBe('Could not switch to PTC mode: Already started')
  })

  it('keeps a failed default save visible beside the selected mode', () => {
    bench({ state: { current: 'ptc' }, defaults: { error: 'Disk full' } })
    expect(screen.getByRole('button', { name: 'Agent mode: PTC mode' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('Mode selected, but could not save it for new conversations: Disk full')
  })

  it('disables mode choices while another composer saves the shared default', () => {
    bench({ defaults: { saving: true } })
    expect(screen.getByRole('button', { name: 'Agent mode: Standard mode' }).getAttribute('disabled')).toBe('')
  })

  it('dismisses its portaled menu with Escape', () => {
    bench()
    open()
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
