/** Activity read state follows native request identities and completion edges without opening Sessions. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatus, SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { CanvasChat, CanvasId, CanvasNodeId, CanvasWorkspace } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { CanvasActivity } from '../src/client/activity.ts'

declare module '@deepseek-ai/dsh-client-ui-session/client' {
  interface SessionPendingInteractionMap {
    /** Test-owned pending interaction with an explicit replacement key. */
    canvasActivityTest: SessionPendingInteractionBase & { readonly kind: 'canvas-activity-test' }
  }
}

const first = 'first-session' as SessionId
const second = 'second-session' as SessionId
const third = 'third-session' as SessionId
afterEach(() => { vi.restoreAllMocks() })

function chat(sessionId: SessionId, canvasId = 'board' as CanvasId): CanvasChat {
  return { canvasId, nodeId: `chat-${sessionId}` as CanvasNodeId, title: `Chat ${sessionId}`, cwd: '/project',
    deleting: false, issue: null, threads: [{ sessionId, parentSessionId: null, inheritedEventCount: 0 }] }
}

function workspace(chats: CanvasChat[] = [chat(first), chat(second), chat(third)]): CanvasWorkspace {
  return { revision: 1, nodeTypes: [], nodeIssues: [], chats,
    canvases: [...new Set(chats.map(value => value.canvasId))].map(id => ({
      id, title: `Canvas ${id}`, revision: 1, nodes: [], connections: [], archived: true,
    })) }
}

function summary(id: SessionId, updatedAt: number): SessionSummary {
  return { id, displayTitle: `Session ${id}`, updatedAt, running: false, retainedBy: {}, blank: false }
}

function status(value: Partial<SessionStatus> = {}): SessionStatus {
  return { running: false, completionUnread: false, pendingInteraction: undefined, ...value }
}

function pending(sessionId: SessionId, key: string): SessionStatus {
  return status({ pendingInteraction: { sessionId, key, kind: 'canvas-activity-test' } })
}

function statuses(...items: Array<readonly [SessionId, SessionStatus]>): SessionStatusSnapshot { return new Map(items) }

describe('Convax activity', () => {
  it('orders attention before recent completions and deduplicates Session occurrences across canvases', () => {
    const owner = new CanvasActivity()
    const board = workspace([chat(first), chat(second), chat(third), chat(first, 'other-board' as CanvasId)])
    const source = statuses([first, status({ completionUnread: true })], [second, pending(second, 'approval-1')],
      [third, status({ completionUnread: true })])
    owner.observe(board, source, { [first]: summary(first, 100), [third]: summary(third, 200) })
    expect(owner.getSnapshot().map(row => [row.sessionId, row.kind])).toEqual([
      [second, 'attention'], [third, 'completed'], [first, 'completed'],
    ])
    expect(owner.getSnapshot().find(row => row.sessionId === first)).toMatchObject({
      canvasId: 'board', nodeId: 'chat-first-session', title: 'Session first-session', canvasTitle: 'Canvas board', unread: true,
    })
  })

  it('keeps read attention until resolution and marks a replacement request as new activity', () => {
    const owner = new CanvasActivity()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100)
    const board = workspace([chat(first)])
    owner.observe(board, statuses([first, pending(first, 'request-1')]), {})
    const unread = owner.getSnapshot()
    owner.markRead([first])
    expect(owner.getSnapshot()).toMatchObject([{ kind: 'attention', occurredAt: 100, unread: false }])
    clock.mockReturnValue(200)
    const read = owner.getSnapshot()
    owner.observe(board, statuses([first, pending(first, 'request-1')]), {})
    expect(owner.getSnapshot()).toBe(read)
    expect(unread[0]?.unread).toBe(true)
    owner.observe(board, statuses([first, pending(first, 'request-2')]), {})
    expect(owner.getSnapshot()).toMatchObject([{ kind: 'attention', occurredAt: 200, unread: true }])
    owner.observe(board, statuses([first, status()]), {})
    expect(owner.getSnapshot()).toEqual([])
  })

  it('retains acknowledged completions and starts a new unread row for the next completion edge', () => {
    const owner = new CanvasActivity()
    const board = workspace([chat(first)])
    const stopped = statuses([first, status({ completionUnread: true })])
    owner.observe(board, stopped, { [first]: summary(first, 100) })
    owner.markRead([first])
    const read = owner.getSnapshot()
    owner.observe(board, stopped, { [first]: summary(first, 150) })
    expect(owner.getSnapshot()).toBe(read)
    owner.observe(board, statuses([first, status({ running: true })]), { [first]: summary(first, 200) })
    expect(owner.getSnapshot()).toMatchObject([{ kind: 'completed', occurredAt: 100, unread: false }])
    owner.observe(board, stopped, { [first]: summary(first, 300) })
    expect(owner.getSnapshot()).toMatchObject([{ kind: 'completed', occurredAt: 300, unread: true }])
    owner.observe(board, statuses([first, status()]), { [first]: summary(first, 300) })
    expect(owner.getSnapshot()).toMatchObject([{ kind: 'completed', occurredAt: 300, unread: false }])
  })

  it('marks all current rows read while retaining pending requests and read history', () => {
    const owner = new CanvasActivity()
    owner.observe(workspace(), statuses([first, pending(first, 'request')], [second, status({ completionUnread: true })]), {})
    owner.markRead(owner.getSnapshot().map(row => row.sessionId))
    expect(owner.getSnapshot().map(row => [row.sessionId, row.unread])).toEqual([[first, false], [second, false]])
    owner.markRead(['missing' as SessionId])
    expect(owner.getSnapshot()).toHaveLength(2)
  })

  it('defers a native unread completion until its higher-priority interaction resolves', () => {
    const owner = new CanvasActivity()
    const board = workspace([chat(first)])
    owner.observe(board, statuses([first, { ...pending(first, 'request'), completionUnread: true }]), {})
    expect(owner.getSnapshot()).toMatchObject([{ kind: 'attention', unread: true }])
    owner.observe(board, statuses([first, status({ completionUnread: true })]), { [first]: summary(first, 100) })
    expect(owner.getSnapshot()).toMatchObject([{ kind: 'completed', occurredAt: 100, unread: true }])
  })

  it('updates canvas and Session labels, retains activity while status is unknown, and prunes removed Chats', () => {
    const owner = new CanvasActivity()
    const board = workspace([chat(first)])
    vi.spyOn(Date, 'now').mockReturnValue(50)
    owner.observe(board, statuses([first, status({ completionUnread: true })]), {})
    expect(owner.getSnapshot()).toMatchObject([{ title: 'Chat first-session', occurredAt: 50 }])
    board.canvases[0]!.title = 'Renamed board'
    owner.observe(board, statuses(), { [first]: { ...summary(first, 70), displayTitle: 'Renamed thread' } })
    expect(owner.getSnapshot()).toMatchObject([{ canvasTitle: 'Renamed board', title: 'Renamed thread', unread: true, occurredAt: 50 }])
    owner.observe(workspace([]), statuses(), {})
    expect(owner.getSnapshot()).toEqual([])
    owner.observe(board, statuses([first, status({ completionUnread: true })]), { [first]: summary(first, 100) })
    expect(owner.getSnapshot()).toMatchObject([{ occurredAt: 100, unread: true }])
  })

  it('publishes stable snapshots only when rows change and releases all observers on disposal', () => {
    const owner = new CanvasActivity()
    const board = workspace([chat(first)])
    const source = statuses([first, pending(first, 'request')])
    const listener = vi.fn(), released = vi.fn()
    owner.subscribe(listener)
    const release = owner.subscribe(released)
    release()
    owner.observe(board, source, {})
    expect(listener).toHaveBeenCalledOnce()
    expect(released).not.toHaveBeenCalled()
    const before = owner.getSnapshot()
    owner.observe(board, source, {})
    owner.markRead([])
    expect(owner.getSnapshot()).toBe(before)
    expect(listener).toHaveBeenCalledOnce()
    owner.dispose()
    owner.subscribe(listener)
    owner.observe(board, source, {})
    owner.markRead([first])
    owner.dispose()
    expect(owner.getSnapshot()).toEqual([])
    expect(listener).toHaveBeenCalledOnce()
  })
})
