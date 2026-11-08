/** Color sessions keep previews local and guard captured targets across asynchronous work. */
import { describe, expect, it, vi } from 'vitest'
import type { CanvasDocument, CanvasGroupId, CanvasId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { CanvasGroupColorController, type CanvasGroupColorView } from '../src/client/group-color-controller.ts'

const FIRST = 'first' as CanvasGroupId
const SECOND = 'second' as CanvasGroupId
function fixture() {
  let document: CanvasDocument = { id: 'canvas' as CanvasId, title: 'Board', revision: 1, nodes: [], connections: [],
    groups: [{ id: FIRST, title: 'First', color: 'purple' }, { id: SECOND, title: 'Second' }] }
  let view: CanvasGroupColorView | null = null
  const setColor = vi.fn(async () => true)
  const controller = new CanvasGroupColorController({ document: () => document, available: () => true,
    setColor, changed: (next) => { view = next } })
  return { controller, setColor, view: () => view, document: () => document,
    update: (next: CanvasDocument) => { document = next } }
}

describe('Window group color sessions', () => {
  it('distinguishes default preview from no preview and saves nothing on cancellation', () => {
    const b = fixture()
    b.controller.open([FIRST, SECOND])
    b.controller.preview(null)
    expect(b.view()?.preview).toBeNull()
    b.controller.preview(undefined)
    expect(b.view()?.preview).toBeUndefined()
    b.controller.close()
    expect(b.view()).toBeNull()
    expect(b.setColor).not.toHaveBeenCalled()
    expect(b.document().groups?.[0]?.color).toBe('purple')
  })

  it.each(['revision', 'canvas', 'selection', 'inactive'] as const)('cancels a preview on %s changes', async (change) => {
    const b = fixture()
    b.controller.open([FIRST])
    b.controller.preview('blue')
    b.update({ ...b.document(), ...(change === 'revision' ? { revision: 2 } : {}),
      ...(change === 'canvas' ? { id: 'other' as CanvasId } : {}) })
    b.controller.reconcile(change !== 'inactive', change === 'selection' ? [SECOND] : [FIRST])
    expect(b.view()).toBeNull()
    expect(await b.controller.apply('pink')).toBe(false)
    expect(b.setColor).not.toHaveBeenCalled()
  })

  it('blocks pending submissions and does not dismiss a newer palette when an old promise settles', async () => {
    const b = fixture()
    const pending = Promise.withResolvers<boolean>()
    b.setColor.mockReturnValueOnce(pending.promise)
    b.controller.open([FIRST])
    const apply = b.controller.apply('blue')
    expect(b.view()?.pending).toBe(true)
    expect(await b.controller.apply('pink')).toBe(false)
    expect(b.controller.open([SECOND])).toBe(false)
    b.controller.close()
    expect(b.controller.open([SECOND])).toBe(true)
    pending.resolve(false)
    expect(await apply).toBe(false)
    expect(b.view()).toEqual({ groupIds: [SECOND], preview: undefined, pending: false })
    expect(b.setColor).toHaveBeenCalledExactlyOnceWith([FIRST], 'blue')
  })

  it('clears the applying preview after rejection and ignores a successful self-broadcast after closing', async () => {
    const b = fixture()
    b.setColor.mockResolvedValueOnce(false)
    b.controller.open([FIRST])
    expect(await b.controller.apply('blue')).toBe(false)
    expect(b.view()).toBeNull()
    const pending = Promise.withResolvers<boolean>()
    b.setColor.mockReturnValueOnce(pending.promise)
    b.controller.open([FIRST])
    const apply = b.controller.apply('green')
    b.update({ ...b.document(), revision: 2, groups: [{ id: FIRST, title: 'First', color: 'green' }] })
    b.controller.reconcile(true, [FIRST])
    expect(b.view()).toBeNull()
    pending.resolve(true)
    expect(await apply).toBe(true)
    expect(b.view()).toBeNull()
  })
})
