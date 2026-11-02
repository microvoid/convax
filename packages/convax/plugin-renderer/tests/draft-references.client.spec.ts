// @vitest-environment jsdom
/** Canvas gestures use the resident native draft without owning graph connections. */
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { makeTranslate, TestSessions } from '@deepseek-ai/dsh-client-test-runtime'
import { InputHub } from '@deepseek-ai/dsh-client-ui-conversation/src/client/input/hub.ts'
import { zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import type { SubmitOutcome } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { CanvasNodeId, CanvasResource, CanvasWindowBindingId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { CanvasDraftReferences } from '../src/client/draft-references.ts'
import { parseWindowReference } from '../src/client/window-reference.ts'

const chatId = 'chat-reference-gesture' as CanvasNodeId
const folder: CanvasResource = { path: '/projects/folder with spaces', name: 'folder with spaces', kind: 'folder', size: null }

it('inserts an exact window binding into the captured thread without taking an image', async () => {
  const b = await fixture()
  const id = b.ids[0]
  const input = b.hub.shell(id)
  input.setDraft('Check this window')
  const reference = { nodeId: 'source-window' as CanvasNodeId, bindingId: randomUUID() as CanvasWindowBindingId }
  expect(await b.references.insertWindow(id, reference, 'Test document')).toBe(true)
  const chip = input.snapshot.attachedReferences[0]!
  expect(chip).toMatchObject({ source: 'convax-window', label: 'Test document' })
  expect(parseWindowReference(chip.ref)).toEqual(reference)
  expect(input.snapshot.draft).toBe('Check this window')
  expect(b.hub.shell(b.ids[1]).snapshot.attachedReferences).toEqual([])
  input.removeReference(chip.id)
  expect(input.snapshot.attachedReferences).toEqual([])
  expect(input.snapshot.draft).toBe('Check this window')
})

async function fixture() {
  const ctx = new Context()
  const sessions = new TestSessions(async (operation) => { await operation() }, ctx)
  ctx.provide('sessions', sessions)
  const ids = [SessionId(`canvas-draft-${randomUUID()}`), SessionId(`canvas-draft-${randomUUID()}`)] as const
  await Promise.all(ids.map(id => sessions.add({ id })))
  const retained = ids.map(id => sessions.retain(id))
  await Promise.all(retained.map(reference => reference.ready))
  const hub = new InputHub(ctx, makeTranslate(zh, {}))
  const lifetime = new AbortController()
  const references = new CanvasDraftReferences(sessions, { input: hub }, lifetime.signal)
  onTestFinished(async () => {
    lifetime.abort()
    for (const reference of retained) reference.release()
    await sessions.disposeScopes()
    await ctx.fiber.dispose()
    for (const id of ids) localStorage.removeItem(`dsh.conversation.${id}`)
  })
  return { ctx, sessions, ids, hub, lifetime, references }
}

it.each([
  { resource: folder, ref: '@"/projects/folder with spaces/"', label: 'folder with spaces/', appearance: 'folder' },
  { resource: { path: '/projects/readme.md', name: 'readme.md', kind: 'file', size: 10 } satisfies CanvasResource,
    ref: '@/projects/readme.md', label: 'readme.md', appearance: 'file' },
])('adds a $appearance card to the captured thread without changing its editor', async ({ resource, ref, label, appearance }) => {
  const b = await fixture()
  const [id, otherId] = b.ids
  const input = b.hub.shell(id)
  const other = b.hub.shell(otherId)
  const previous = '@src/existing.ts'
  input.setDraft({
    text: `Inspect ${previous} first`,
    references: [{ source: 'reference', ref: previous, clipboardText: previous, label: 'existing.ts',
      appearance: 'file', offset: 'Inspect '.length, length: previous.length }],
  })
  other.setDraft('Separate thread draft')
  const original = input.draftSnapshot
  const editor = input.editor.getEditorState().toJSON()
  const releasePrevious = b.references.bind(chatId, id)
  const captured = b.references.capture(chatId)!
  const releaseCurrent = b.references.bind(chatId, otherId)
  releasePrevious()
  expect(b.references.capture(chatId)).toBe(otherId)

  expect(await b.references.insert(captured, resource)).toBe(true)
  expect(input.snapshot.draft).toBe(original.text)
  expect(input.editor.getEditorState().toJSON()).toEqual(editor)
  expect(input.draftSnapshot.references).toEqual(original.references)
  expect(input.snapshot.attachedReferences).toEqual([expect.objectContaining({
    source: 'reference', ref, clipboardText: ref, label, appearance,
  })])
  expect(other.snapshot.draft).toBe('Separate thread draft')
  expect(other.snapshot.attachedReferences).toEqual([])
  expect(b.sessions.retainInfo(id).getSnapshot().retainedBy.convaxChat).toBeUndefined()
  input.removeReference(input.snapshot.attachedReferences[0]!.id)
  expect(input.snapshot.attachedReferences).toEqual([])
  expect(input.draftSnapshot).toEqual(original)
  expect(input.editor.getEditorState().toJSON()).toEqual(editor)
  expect(b.references.capture(chatId)).toBe(otherId)
  releaseCurrent()
  expect(b.references.capture(chatId)).toBeUndefined()
})

it('refuses a connection reference while native admission is locked and releases its borrowed Session', async () => {
  const b = await fixture()
  const id = b.ids[0]
  const input = b.hub.shell(id)
  const pending = Promise.withResolvers<SubmitOutcome>()
  onTestFinished(() => { pending.resolve({ kind: 'error' }) })
  input.setDraft('/pending task')
  expect(input.beginCommand({ name: 'pending', token: '/pending ', submit: () => pending.promise },
    { start: 0, end: '/pending '.length, draftRev: input.snapshot.draftRev })).toBe(true)
  input.submit()
  expect(input.snapshot.phase).toBe('submitting')
  const before = input.draftSnapshot
  expect(await b.references.insert(id, folder)).toBe(false)
  expect(input.draftSnapshot).toEqual(before)
  expect(b.sessions.retainInfo(id).getSnapshot().retainedBy.convaxChat).toBeUndefined()
  pending.resolve({ kind: 'error' })
  await vi.waitFor(() => { expect(input.snapshot.phase).toBe('claimed') })
})

it('releases a pending target when the renderer lifetime ends before its Session opens', async () => {
  const ctx = new Context()
  const sessions = new TestSessions(async (operation) => { await operation() }, ctx)
  const lifetime = new AbortController()
  const pending = Promise.withResolvers<undefined>()
  const id = SessionId(`canvas-draft-opening-${randomUUID()}`)
  onTestFinished(async () => {
    pending.resolve(undefined)
    lifetime.abort()
    await sessions.disposeScopes()
    await ctx.fiber.dispose()
  })
  await sessions.add({ id, initialOpen: () => pending.promise })
  const hub = new InputHub(ctx, makeTranslate(zh, {}))
  const references = new CanvasDraftReferences(sessions, { input: hub }, lifetime.signal)
  const insertion = references.insert(id, folder)
  expect(sessions.retainInfo(id).getSnapshot().retainedBy.convaxChat).toBe(1)
  lifetime.abort()
  await expect(insertion).rejects.toMatchObject({ name: 'AbortError' })
  expect(sessions.retainInfo(id).getSnapshot().referenceCount).toBe(0)
})
