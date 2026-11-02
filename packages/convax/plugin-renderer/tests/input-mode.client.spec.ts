// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CanvasId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { defaultCanvasInputMode } from '../src/client/input-mode.ts'
import { createCanvasViewStore } from '../src/client/store.ts'

const preferenceKey = 'convax.canvas.view.v1'
let previous: string | null

beforeEach(() => {
  previous = localStorage.getItem(preferenceKey)
  localStorage.removeItem(preferenceKey)
})
afterEach(() => {
  if (previous === null) localStorage.removeItem(preferenceKey)
  else localStorage.setItem(preferenceKey, previous)
})

describe('Canvas input preferences', () => {
  it.each([
    { platform: 'macos', mode: 'touchpad' },
    { platform: 'windows', mode: 'mouse' },
    { platform: 'linux', mode: 'mouse' },
  ] as const)('defaults to $mode on $platform', ({ platform, mode }) => {
    expect(defaultCanvasInputMode(platform)).toBe(mode)
  })

  it('restores existing canvas preferences without pinning an input mode', () => {
    const viewport = { x: 100, y: -40, zoom: 0.75 }
    localStorage.setItem(preferenceKey, JSON.stringify({
      tabs: ['a'], activeCanvasId: 'a', closedTabs: [], directory: '/project', viewports: { a: viewport },
    }))
    const store = createCanvasViewStore().create()
    expect(store.getSnapshot().inputMode).toBeUndefined()
    expect(store.getSnapshot().inputMode ?? defaultCanvasInputMode('macos')).toBe('touchpad')
    expect(store.getSnapshot().viewports).toEqual({ a: viewport })
    expect(store.getSnapshot().directory).toBe('/project')
  })

  it.each(['touchpad', 'mouse'] as const)('keeps the explicit %s choice across canvas switches and remounts', (mode) => {
    const a = 'a' as CanvasId
    const b = 'b' as CanvasId
    const store = createCanvasViewStore().create()
    store.actions.open(a)
    store.actions.setInputMode(mode)
    store.actions.open(b)
    store.actions.close(b)
    store.actions.reconcile([a])
    const restored = createCanvasViewStore().create()
    expect(restored.getSnapshot().inputMode).toBe(mode)
    expect(restored.getSnapshot().tabs).toEqual([a])
    expect(restored.getSnapshot().activeCanvasId).toBe(a)
  })
})
