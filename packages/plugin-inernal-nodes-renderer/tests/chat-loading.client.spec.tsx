// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { conversationSnapshot, makeTranslate, sessionSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ResourceSnapshot } from '@deepseek-ai/dsh-client-resources/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ChatSession, ChatThread } from '../src/client/ChatCard.tsx'
import type { ChatSessionProps, ChatThreadProps } from '@deepseek-ai/dsh-convax-plugin-renderer/client'
import { en } from '@deepseek-ai/dsh-convax-plugin-renderer/client'
import css from '../src/client/ChatCard.module.css'

afterEach(cleanup)

const SID = 'loading-thread' as SessionId

function sessionFixture(snapshot: SessionSnapshot) {
  const renderFactorySlot = vi.fn<ChatSessionProps['renderFactorySlot']>(() => null)
  const summaries: SessionListState = {
    ids: [SID], phase: 'ready', projectionsBySession: {},
    byId: { [SID]: { id: SID, displayTitle: 'New thread', blank: false, running: false, updatedAt: 0, retainedBy: {} } },
  }
  const inputs = {
    sessionId: SID,
    useSession: selector => selector(snapshot),
    useConversation: selector => selector(conversationSnapshot()),
    useSessions: selector => selector(summaries),
    renderFactorySlot,
    onSelectWorkspace: async () => {}, onFork: () => {}, onNewSessionWithPreset: async () => {},
  } satisfies Pick<ChatSessionProps, 'sessionId' | 'useSession' | 'useConversation' | 'useSessions' | 'renderFactorySlot'
    | 'onSelectWorkspace' | 'onFork' | 'onNewSessionWithPreset'>
  return { props: inputs as ChatSessionProps, renderFactorySlot }
}

describe('Convax Chat initialization', () => {
  it.each([
    ['configuration without a first user turn', { awaitingFirstTurn: true }, 'hero'],
    ['existing conversation history', { awaitingFirstTurn: false }, 'active'],
    ['running first turn', { awaitingFirstTurn: true, running: true }, 'active'],
  ] as const)('chooses the native layout for %s', (_label, overrides, phase) => {
    const fixture = sessionFixture({ ...sessionSnapshot(SID), blank: false, ...overrides })
    const view = render(<ChatSession {...fixture.props} />)
    expect(view.container.querySelector('[data-convax-chat-phase]')?.getAttribute('data-convax-chat-phase')).toBe(phase)
    expect(fixture.renderFactorySlot).toHaveBeenLastCalledWith('conversation.content', expect.objectContaining({
      variant: 'embedded', composerPlacement: 'below', phase, hero: phase === 'hero',
    }))
  })

  it('keeps pending and failed content visible before a Session provider can expose its children', () => {
    const resource = vi.fn<() => ResourceSnapshot<never>>().mockReturnValue({
      status: 'loading', value: undefined, failure: undefined,
    })
    const renderSlot = vi.fn(() => null)
    // The renderer's strict Session provider renders no children without a
    // retained reference; root-owned loading UI must remain outside it.
    const SessionProvider: ChatThreadProps['SessionProvider'] = ({ session, children }) =>
      session === undefined ? null : children
    const inputs = {
      sessionId: SID, active: true, collapsed: false, useResource: () => resource(), SessionProvider,
      renderSlot: () => renderSlot(), layoutChanged: () => {}, t: makeTranslate(en),
    } satisfies Pick<ChatThreadProps, 'sessionId' | 'active' | 'collapsed' | 'useResource' | 'SessionProvider'
      | 'renderSlot' | 'layoutChanged' | 't'>
    const props = inputs as ChatThreadProps
    const view = render(<ChatThread {...props} />)
    expect(view.container.querySelector(`.${css.spinner}`)).not.toBeNull()
    expect(renderSlot).not.toHaveBeenCalled()
    resource.mockReturnValue({ status: 'failed', value: undefined, failure: undefined })
    view.rerender(<ChatThread {...props} />)
    expect(screen.getByRole('alert').textContent).toBe(en['chat.loadFailed'])
    expect(view.container.querySelector(`.${css.spinner}`)).toBeNull()
    expect(renderSlot).not.toHaveBeenCalled()
  })
})
