import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CanvasId, CanvasNodeId, CanvasOperationId, CanvasThreadRequest } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createCanvasViewStore, createChatViewStore } from '../src/client/store.ts'
import { resourceAddress, resourcePath } from '../src/client/resources.ts'
import { orderedChatThreads } from '../src/client/thread-order.ts'

const id = (value: string): CanvasId => value as CanvasId

function storageFixture() {
  const backing = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => { backing.set(key, value) },
    removeItem: (key: string) => { backing.delete(key) },
  })
  return backing
}

describe('Convax window preferences', () => {
  it('closes the active tab, selects its neighbor, and reopens without duplication', () => {
    const store = createCanvasViewStore().create()
    store.actions.open(id('a'))
    store.actions.open(id('b'))
    store.actions.open(id('c'))
    store.actions.open(id('b'))
    store.actions.close(id('b'))
    expect(store.getSnapshot()).toMatchObject({ tabs: ['a', 'c'], activeCanvasId: 'c', closedTabs: ['b'] })
    store.actions.open(id('b'))
    store.actions.open(id('b'))
    expect(store.getSnapshot()).toMatchObject({ tabs: ['a', 'c', 'b'], activeCanvasId: 'b', closedTabs: [] })
  })

  it('keeps camera positions per canvas and removes only deleted canvas preferences', () => {
    const store = createCanvasViewStore().create()
    const first = { x: 100, y: -40, zoom: 0.75 }
    const second = { x: -20, y: 30, zoom: 1.5 }
    store.actions.open(id('a'))
    store.actions.setViewport(id('a'), first)
    store.actions.open(id('b'))
    store.actions.setViewport(id('b'), second)
    store.actions.close(id('a'))
    expect(store.getSnapshot().viewports).toEqual({ a: first, b: second })
    store.actions.reconcile([id('b')])
    expect(store.getSnapshot()).toMatchObject({ tabs: ['b'], closedTabs: [], viewports: { b: second } })
  })

  it('does not share tab state between independently registered windows', () => {
    const handle = createCanvasViewStore()
    const first = handle.create()
    const second = handle.create()
    first.actions.open(id('first'))
    expect(second.getSnapshot().tabs).toEqual([])
  })

  it.each([
    ['d', 'b', 'before', ['a', 'd', 'b', 'c']],
    ['a', 'c', 'after', ['b', 'c', 'a', 'd']],
    ['d', 'a', 'after', ['a', 'd', 'b', 'c']],
    ['a', 'd', 'before', ['b', 'c', 'a', 'd']],
  ] as const)('moves %s %s %s while retaining selection and other preferences', (source, target, side, expected) => {
    const store = createCanvasViewStore().create()
    for (const canvas of ['a', 'b', 'c', 'd', 'closed']) store.actions.open(id(canvas))
    store.actions.close(id('closed'))
    store.actions.open(id('c'))
    store.actions.setViewport(id('a'), { x: 7, y: -20, zoom: 0.8 })
    const previous = store.getSnapshot()
    store.actions.moveTab(id(source), id(target), side)
    expect(store.getSnapshot()).toEqual({ ...previous, tabs: expected })
  })

  it.each([
    ['a', 'b', 'before'],
    ['b', 'a', 'after'],
    ['a', 'a', 'before'],
    ['a', 'a', 'after'],
    ['missing', 'a', 'before'],
    ['a', 'missing', 'after'],
  ] as const)('leaves the order unchanged for %s %s %s', (source, target, side) => {
    const store = createCanvasViewStore().create()
    for (const canvas of ['a', 'b', 'c']) store.actions.open(id(canvas))
    const previous = store.getSnapshot()
    store.actions.moveTab(id(source), id(target), side)
    expect(store.getSnapshot()).toBe(previous)
  })

  it('selects the next visible neighbor after closing a reordered active tab', () => {
    const store = createCanvasViewStore().create()
    for (const canvas of ['a', 'b', 'c', 'd']) store.actions.open(id(canvas))
    store.actions.open(id('b'))
    store.actions.moveTab(id('d'), id('b'), 'after')
    store.actions.close(id('b'))
    expect(store.getSnapshot()).toMatchObject({ tabs: ['a', 'd', 'c'], activeCanvasId: 'd', closedTabs: ['b'] })
  })
})

describe('Convax Chat thread order', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('remembers each Chat order without changing its selected or visited threads', () => {
    storageFixture()
    const node = 'chat' as CanvasNodeId
    const other = 'other' as CanvasNodeId
    const sessions = ['a', 'b', 'c'].map(value => value as SessionId)
    const [a, b, c] = sessions as [SessionId, SessionId, SessionId]
    const store = createChatViewStore().create()
    store.actions.selectThread(node, b)
    store.actions.setCollapsed(node, true)
    const previous = store.getSnapshot()
    store.actions.moveThread(node, sessions, c, a, 'before')
    expect(store.getSnapshot()).toEqual({ ...previous, threadOrders: { chat: [c, a, b] } })
    store.actions.moveThread(other, sessions, a, c, 'after')
    const restored = createChatViewStore().create()
    expect(restored.getSnapshot().threadOrders).toEqual({ chat: [c, a, b], other: [b, c, a] })
    expect(restored.getSnapshot().selectedThreads[node]).toBe(b)
    expect(restored.getSnapshot().visitedThreads?.[node]).toEqual([b])
    expect(restored.getSnapshot().collapsedChats?.[node]).toBe(true)
  })

  it('appends new threads, ignores stale saved IDs, and retains the archived position for restoration', () => {
    const a = 'a' as SessionId
    const b = 'b' as SessionId
    const c = 'c' as SessionId
    const added = 'added' as SessionId
    const missing = 'missing' as SessionId
    const threads = [a, b, c, added].map(sessionId => ({ sessionId }))
    const saved = [c, missing, b, b, a]
    const ordered = orderedChatThreads(threads, saved)
    expect(ordered.map(thread => thread.sessionId)).toEqual([c, b, a, added])
    expect(ordered.filter(thread => thread.sessionId !== b).map(thread => thread.sessionId)).toEqual([c, a, added])
    expect(orderedChatThreads(threads, saved).map(thread => thread.sessionId)).toEqual([c, b, a, added])
    expect(orderedChatThreads(threads, undefined)).toEqual(threads)
    expect(orderedChatThreads([], saved)).toEqual([])
  })

  it('ignores missing identities and moves that already match the displayed position', () => {
    const node = 'chat' as CanvasNodeId
    const a = 'a' as SessionId
    const b = 'b' as SessionId
    const missing = 'missing' as SessionId
    const store = createChatViewStore().create()
    const previous = store.getSnapshot()
    for (const [source, target, side] of [
      [a, b, 'before'], [b, a, 'after'], [a, a, 'after'], [missing, a, 'before'], [a, missing, 'after'],
    ] as const) store.actions.moveThread(node, [a, b], source, target, side)
    expect(store.getSnapshot()).toBe(previous)
  })
})

describe('Convax Chat size preferences', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('restores independent node dimensions when the Chat store remounts', () => {
    storageFixture()
    const first = 'first' as CanvasNodeId
    const second = 'second' as CanvasNodeId
    const store = createChatViewStore().create()
    store.actions.setSize(first, { width: 640, height: 500 })
    store.actions.setSize(second, { width: 880, height: 900 })
    store.actions.setSize(first, { width: 700, height: 520 })

    const restored = createChatViewStore().create()
    expect(restored.getSnapshot().sizes).toEqual({
      first: { width: 700, height: 520 },
      second: { width: 880, height: 900 },
    })
    restored.actions.setSize(second, { width: 820, height: 760 })
    expect(createChatViewStore().create().getSnapshot().sizes).toEqual({
      first: { width: 700, height: 520 },
      second: { width: 820, height: 760 },
    })
  })

  it('adds a size to older preferences without replacing thread selection or collapse state', () => {
    const backing = storageFixture()
    const previous = {
      selectedThreads: { chat: 'selected-thread' }, threadAttempts: {}, collapsedChats: { chat: true },
    }
    backing.set('convax.chat.view.v1', JSON.stringify(previous))
    const store = createChatViewStore().create()
    expect(store.getSnapshot().sizes).toBeUndefined()
    store.actions.setSize('chat' as CanvasNodeId, { width: 700, height: 520 })
    const expected = { ...previous, sizes: { chat: { width: 700, height: 520 } } }
    expect(store.getSnapshot()).toEqual(expected)
    expect(createChatViewStore().create().getSnapshot()).toEqual(expected)
  })

  it('restores tool widths for each Chat and display mode independently', () => {
    storageFixture()
    const first = 'first' as CanvasNodeId
    const second = 'second' as CanvasNodeId
    const store = createChatViewStore().create()
    store.actions.setToolWidth(first, 520, false)
    store.actions.setToolWidth(first, 1040, true)
    store.actions.setToolWidth(second, 600, false)
    store.actions.setToolWidth(second, 1100, true)
    store.actions.setToolWidth(first, 560, false)

    const restored = createChatViewStore().create()
    expect(restored.getSnapshot().toolWidths).toEqual({
      first: { normal: 560, fullscreen: 1040 },
      second: { normal: 600, fullscreen: 1100 },
    })
    restored.actions.setToolWidth(second, 1160, true)
    expect(createChatViewStore().create().getSnapshot().toolWidths).toEqual({
      first: { normal: 560, fullscreen: 1040 },
      second: { normal: 600, fullscreen: 1160 },
    })
  })

  it('adds a tool width to older preferences without assigning the other display mode', () => {
    const backing = storageFixture()
    const previous = {
      selectedThreads: { chat: 'selected-thread' }, threadAttempts: {},
      collapsedChats: { chat: true }, sizes: { chat: { width: 700, height: 520 } },
    }
    backing.set('convax.chat.view.v1', JSON.stringify(previous))
    const store = createChatViewStore().create()
    expect(store.getSnapshot()).toEqual(previous)
    expect(store.getSnapshot().toolWidths).toBeUndefined()
    store.actions.setToolWidth('chat' as CanvasNodeId, 1080, true)
    const expected = { ...previous, toolWidths: { chat: { fullscreen: 1080 } } }
    expect(store.getSnapshot()).toEqual(expected)
    expect(createChatViewStore().create().getSnapshot()).toEqual(expected)
  })

  it('shares tool widths across a Chat\'s threads while keeping Chat dimensions independent', () => {
    storageFixture()
    const chat = 'chat' as CanvasNodeId
    const firstThread = 'first-thread' as SessionId
    const secondThread = 'second-thread' as SessionId
    const store = createChatViewStore().create()
    store.actions.selectThread(chat, firstThread)
    store.actions.setSize(chat, { width: 700, height: 520 })
    store.actions.setToolWidth(chat, 540, false)
    store.actions.setToolWidth(chat, 1080, true)
    store.actions.selectThread(chat, secondThread)
    expect(store.getSnapshot().toolWidths).toEqual({ chat: { normal: 540, fullscreen: 1080 } })
    expect(store.getSnapshot().sizes).toEqual({ chat: { width: 700, height: 520 } })
    store.actions.setToolWidth(chat, 580, false)
    store.actions.setSize(chat, { width: 820, height: 760 })
    store.actions.selectThread(chat, firstThread)

    const restored = createChatViewStore().create()
    expect(restored.getSnapshot()).toMatchObject({
      selectedThreads: { chat: firstThread },
      visitedThreads: { chat: [firstThread, secondThread] },
      toolWidths: { chat: { normal: 580, fullscreen: 1080 } },
      sizes: { chat: { width: 820, height: 760 } },
    })
  })
})

describe('Convax resource preview preferences', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('retains each resource expansion and preview dimensions across canvas switches and remounts', () => {
    storageFixture()
    const first = 'first-file' as CanvasNodeId
    const second = 'second-file' as CanvasNodeId
    const store = createCanvasViewStore().create()
    store.actions.open(id('a'))
    store.actions.setResourceExpanded(first, true)
    store.actions.setResourcePreviewSize(first, { width: 640, height: 360 })
    store.actions.open(id('b'))
    store.actions.setResourcePreviewSize(second, { width: 420, height: 280 })
    store.actions.setResourceExpanded(second, true)
    store.actions.setResourceExpanded(first, false)
    store.actions.open(id('a'))

    const expected = {
      'first-file': { expanded: false, width: 640, height: 360 },
      'second-file': { expanded: true, width: 420, height: 280 },
    }
    expect(store.getSnapshot().resourceViews).toEqual(expected)
    const restored = createCanvasViewStore().create()
    expect(restored.getSnapshot()).toMatchObject({ activeCanvasId: 'a', resourceViews: expected })
    restored.actions.setResourceExpanded(first, true)
    expect(createCanvasViewStore().create().getSnapshot().resourceViews?.[first]).toEqual({ expanded: true, width: 640, height: 360 })
  })

  it('adds resource preferences to older window data without changing tabs, cameras or input mode', () => {
    const backing = storageFixture()
    const previous = {
      tabs: ['a'], activeCanvasId: 'a', closedTabs: ['b'], directory: '/project',
      viewports: { a: { x: 12, y: -30, zoom: 0.8 } }, inputMode: 'touchpad',
    }
    backing.set('convax.canvas.view.v1', JSON.stringify(previous))
    const store = createCanvasViewStore().create()
    expect(store.getSnapshot()).toEqual(previous)
    store.actions.setResourcePreviewSize('file' as CanvasNodeId, { width: 480, height: 320 })
    const expected = { ...previous, resourceViews: { file: { expanded: false, width: 480, height: 320 } } }
    expect(store.getSnapshot()).toEqual(expected)
    expect(createCanvasViewStore().create().getSnapshot()).toEqual(expected)
  })

  it('restores height-only previews and adds width on the next resize without replacing other preferences', () => {
    const backing = storageFixture()
    const previous = {
      tabs: ['a'], activeCanvasId: 'a', closedTabs: [], directory: '/project',
      viewports: { a: { x: 12, y: -30, zoom: 0.8 } }, inputMode: 'touchpad',
      resourceViews: { file: { expanded: true, height: 360 }, other: { expanded: false, height: 280 } },
    }
    backing.set('convax.canvas.view.v1', JSON.stringify(previous))
    const store = createCanvasViewStore().create()
    expect(store.getSnapshot()).toEqual(previous)
    expect(store.getSnapshot().resourceViews?.file?.width).toBeUndefined()
    store.actions.setResourcePreviewSize('file' as CanvasNodeId, { width: 520, height: 380 })
    const expected = { ...previous, resourceViews: {
      file: { expanded: true, width: 520, height: 380 }, other: previous.resourceViews.other,
    } }
    expect(store.getSnapshot()).toEqual(expected)
    expect(createCanvasViewStore().create().getSnapshot()).toEqual(expected)
  })

  it('removes deleted node preferences while preserving nodes on retained canvases', () => {
    storageFixture()
    const live = 'live' as CanvasNodeId
    const deleted = 'deleted' as CanvasNodeId
    const store = createCanvasViewStore().create()
    store.actions.open(id('a'))
    store.actions.open(id('b'))
    store.actions.setResourceExpanded(live, true)
    store.actions.setResourcePreviewSize(live, { width: 600, height: 420 })
    store.actions.setResourceExpanded(deleted, true)
    store.actions.reconcile([id('b')])
    expect(store.getSnapshot().resourceViews?.[deleted]).toEqual({ expanded: true })
    store.actions.reconcile([id('b')], [live])
    expect(store.getSnapshot()).toMatchObject({ tabs: ['b'], resourceViews: { live: { expanded: true, width: 600, height: 420 } } })
    expect(store.getSnapshot().resourceViews?.[deleted]).toBeUndefined()
    expect(createCanvasViewStore().create().getSnapshot().resourceViews).toEqual({ live: { expanded: true, width: 600, height: 420 } })
  })
})

describe('Convax resource keys', () => {
  it.each(['/projects/a folder/中文.md', 'C:\\projects\\a b\\file.txt'])('preserves file paths through URL encoding: %s', (path) => {
    expect(resourcePath(resourceAddress('convax-preview', path))).toBe(path)
  })
})

describe('Convax copied presentation preferences', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('copies only Chat dimensions, collapse and tool widths while retaining navigation owners', () => {
    storageFixture()
    const store = createChatViewStore().create()
    const source = 'source' as CanvasNodeId
    const target = 'target' as CanvasNodeId
    const thread = 'source-thread' as SessionId
    store.actions.selectThread(source, thread)
    store.actions.setSize(source, { width: 420, height: 320 })
    store.actions.setCollapsed(source, true)
    store.actions.setToolWidth(source, 540, false)
    const navigation = store.getSnapshot()
    store.actions.copyPresentation(target, {
      collapsed: true, size: { width: 420, height: 320 }, toolWidths: { normal: 540 },
    })
    expect(store.getSnapshot()).toEqual({
      ...navigation,
      collapsedChats: { source: true, target: true },
      sizes: { source: { width: 420, height: 320 }, target: { width: 420, height: 320 } },
      toolWidths: { source: { normal: 540 }, target: { normal: 540 } },
    })
    expect(store.getSnapshot().selectedThreads[target]).toBeUndefined()
    expect(store.getSnapshot().visitedThreads?.[target]).toBeUndefined()
    expect(createChatViewStore().create().getSnapshot()).toEqual(store.getSnapshot())
  })

  it('preserves absent Chat dimensions and clears only previous presentation values when replaced', () => {
    const store = createChatViewStore().create()
    const chat = 'chat' as CanvasNodeId
    store.actions.copyPresentation(chat, { collapsed: false })
    expect(store.getSnapshot()).toEqual({ selectedThreads: {}, threadAttempts: {}, collapsedChats: { chat: false } })
    store.actions.setSize(chat, { width: 620, height: 480 })
    store.actions.setToolWidth(chat, 520, false)
    store.actions.copyPresentation(chat, { collapsed: true })
    expect(store.getSnapshot()).toEqual({
      selectedThreads: {}, threadAttempts: {}, collapsedChats: { chat: true }, sizes: {}, toolWidths: {},
    })
  })

  it('copies resource expansion with optional saved dimensions without changing other window preferences', () => {
    const store = createCanvasViewStore().create()
    store.actions.open(id('canvas'))
    const previous = store.getSnapshot()
    store.actions.copyResourceView('first' as CanvasNodeId, { expanded: true, height: 300 })
    store.actions.copyResourceView('second' as CanvasNodeId, { expanded: false })
    expect(store.getSnapshot()).toEqual({ ...previous, resourceViews: {
      first: { expanded: true, height: 300 }, second: { expanded: false },
    } })
  })
})


describe('Convax window graph history', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  const op = (value: string) => value as CanvasOperationId

  it('persists independent canvas stacks, ignores duplicate receipts and preserves another window', () => {
    storageFixture()
    const handle = createCanvasViewStore()
    const store = handle.create()
    const other = handle.create()
    store.actions.recordHistory(id('a'), op('first'), {})
    store.actions.recordHistory(id('a'), op('first'), {})
    store.actions.recordHistory(id('b'), op('second'), {})
    store.actions.replayHistory(id('a'), op('first'), 'undo', {})
    store.actions.replayHistory(id('a'), op('first'), 'undo', {})
    expect(store.getSnapshot().histories).toEqual({
      a: { undo: [], redo: ['first'], resourceViews: {} },
      b: { undo: ['second'], redo: [], resourceViews: {} },
    })
    expect(other.getSnapshot().histories).toBeUndefined()
    expect(createCanvasViewStore().create().getSnapshot().histories).toEqual(store.getSnapshot().histories)
  })

  it('retains removed views for redo, drops the abandoned redo branch, and prunes deleted canvases', () => {
    const store = createCanvasViewStore().create()
    store.actions.recordHistory(id('a'), op('create'), {})
    const view = { expanded: true, width: 520, height: 340 }
    store.actions.replayHistory(id('a'), op('create'), 'undo', { file: view })
    expect(store.getSnapshot().histories?.a?.resourceViews.create).toEqual({ file: view })
    store.actions.replayHistory(id('a'), op('create'), 'redo', {})
    expect(store.getSnapshot().histories?.a?.undo).toEqual(['create'])
    store.actions.replayHistory(id('a'), op('create'), 'undo', {})
    store.actions.recordHistory(id('a'), op('replacement'), {})
    expect(store.getSnapshot().histories?.a).toEqual({ undo: ['replacement'], redo: [], resourceViews: {} })
    store.actions.recordHistory(id('b'), op('other'), {})
    store.actions.reconcile([id('b')])
    expect(Object.keys(store.getSnapshot().histories ?? {})).toEqual(['b'])
  })
})


it('clears only the matching terminal thread attempt without changing the selected Session', () => {
  const store = createChatViewStore().create()
  const nodeId = 'chat' as CanvasNodeId
  const first = 'first' as SessionId
  const stale = 'stale' as CanvasOperationId
  const active = 'active' as CanvasOperationId
  const request: CanvasThreadRequest = { canvasId: id('canvas'), nodeId, operationId: active, expectedRevision: 1, kind: 'create' }
  store.actions.selectThread(nodeId, first)
  store.actions.stageThread(nodeId, request)
  store.actions.clearThreadAttempt(nodeId, stale)
  expect(store.getSnapshot().threadAttempts[nodeId]).toEqual(request)
  store.actions.clearThreadAttempt(nodeId, active)
  expect(store.getSnapshot().threadAttempts[nodeId]).toBeUndefined()
  expect(store.getSnapshot().selectedThreads[nodeId]).toBe(first)
})
