// @vitest-environment jsdom
/** Native View rows share the Conversation roster and resolve the current Session preference. */
import { randomUUID } from 'node:crypto'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConversationViewMenuProps } from '../src/client/contract/slots.ts'
import type { ViewTab } from '../src/client/contract/views.ts'
import { ConversationViewMenu } from '../src/client/skeleton/ConversationViewMenu.tsx'
import { createConversationStore } from '../src/client/stores.ts'

afterEach(cleanup)

const VIEWS: readonly ViewTab[] = [
  { id: 'trajectory', label: 'Trajectory' }, { id: 'chat', label: 'Chat' }, { id: 'timeline', label: 'Timeline' },
]

function bench(preferred: string | null = null) {
  const sessionId = randomUUID() as SessionId
  const store = createConversationStore().create(sessionId)
  onTestFinished(() => { store.clearPersisted() })
  if (preferred !== null) store.actions.setView(preferred)
  const views = createSnapshotStore(VIEWS)
  const selectView = vi.fn<ConversationViewMenuProps['selectView']>((id) => { store.actions.setView(id) })
  const onDismiss = vi.fn<ConversationViewMenuProps['onDismiss']>()
  const unused = (): never => { throw new Error('View menu fixture does not provide unused Session sources or actions') }
  const props: ConversationViewMenuProps = {
    useConversationViews: bindSnapshotSelector(views), useStore: bindSnapshotSelector(store), selectView, onDismiss,
    sessionId, actions: store.actions,
    useSession: unused, useProjection: unused, useAccess: unused, useRemoteAccess: unused, useConversation: unused, useInput: unused,
    useChat: unused, useTrajectory: unused, useSessions: unused, useSessionStatus: unused,
    useSessionRetainInfo: unused, useSessionAccess: unused, usePanelInfo: unused, useResource: unused, useWorkspaces: unused,
    useWorkspaceAccess: unused,
    inputActions: {
      insertQuote: unused, captureInsertion: unused, insertText: unused, setDraft: unused, persistDraft: unused,
      addAttachments: unused, removeAttachment: unused, removeReference: unused, pruneAttachments: unused, submit: unused,
    },
  }
  const view = render(<ConversationViewMenu {...props} />)
  return { ...view, views, store, selectView, onDismiss }
}

describe('Conversation View menu', () => {
  it('renders every roster View as an in-place native row and marks the selected View', () => {
    const b = bench('timeline')
    expect(b.getAllByRole('menuitem').map(row => row.textContent)).toEqual(['Trajectory', 'Chat', 'Timeline'])
    expect(b.getByRole('menuitem', { name: 'Timeline' }).getAttribute('aria-current')).toBe('page')
    expect(b.getByRole('menuitem', { name: 'Chat' }).hasAttribute('aria-current')).toBe(false)
    expect(b.getByRole('menuitem', { name: 'Timeline' }).querySelector('[data-icon="dsw-icon-check-outline-regular"]')).not.toBeNull()
    expect(b.getByRole('menuitem', { name: 'Chat' }).querySelector('[data-icon]')).toBeNull()
    expect(b.queryByRole('menu')).toBeNull()
    expect(b.container.contains(b.getByRole('menuitem', { name: 'Trajectory' }))).toBe(true)
  })

  it.each([null, 'removed-view'])('falls back to Chat when the preferred View is %j', (preferred) => {
    const b = bench(preferred)
    expect(b.getByRole('menuitem', { name: 'Chat' }).getAttribute('aria-current')).toBe('page')
    expect(b.getByRole('menuitem', { name: 'Trajectory' }).hasAttribute('aria-current')).toBe(false)
  })

  it('selects the clicked View before dismissing its containing menu', () => {
    const b = bench()
    fireEvent.click(b.getByRole('menuitem', { name: 'Trajectory' }))
    expect(b.selectView).toHaveBeenCalledExactlyOnceWith('trajectory')
    expect(b.onDismiss).toHaveBeenCalledExactlyOnceWith()
    expect(b.selectView.mock.invocationCallOrder[0]).toBeLessThan(b.onDismiss.mock.invocationCallOrder[0]!)
    expect(b.store.getSnapshot().view).toBe('trajectory')
    expect(b.getByRole('menuitem', { name: 'Trajectory' }).querySelector('[data-icon="dsw-icon-check-outline-regular"]')).not.toBeNull()
    expect(b.getByRole('menuitem', { name: 'Chat' }).querySelector('[data-icon]')).toBeNull()
  })

  it('reacts to roster removal, labels, and an empty roster without choosing another View', () => {
    const b = bench('timeline')
    act(() => { b.views.set([{ id: 'chat', label: 'Chat updated' }, { id: 'notes', label: 'Notes' }]) })
    expect(b.queryByRole('menuitem', { name: 'Timeline' })).toBeNull()
    expect(b.getByRole('menuitem', { name: 'Chat updated' }).getAttribute('aria-current')).toBe('page')
    act(() => { b.store.actions.setView('notes') })
    expect(b.getByRole('menuitem', { name: 'Notes' }).getAttribute('aria-current')).toBe('page')
    act(() => { b.views.set([{ id: 'trajectory', label: 'Trajectory' }]) })
    expect(b.getByRole('menuitem').hasAttribute('aria-current')).toBe(false)
    act(() => { b.views.set([]) })
    expect(b.queryAllByRole('menuitem')).toEqual([])
    expect(b.selectView).not.toHaveBeenCalled()
    expect(b.onDismiss).not.toHaveBeenCalled()
  })
})
