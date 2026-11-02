// @vitest-environment jsdom
/** Reference cards persist independently of editor text and settle with their own submission. */
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { DraftSnapshot, ReferenceInsert } from '../src/client/contract/draft-editor.ts'
import type { CommandClaim, InputTriggerController, PickOutcome, SubmitOutcome } from '../src/client/contract/input.ts'
import { parseStoredDraft, resolveDraftInput } from '../src/client/draft.ts'
import { SessionInputShell, type SessionInputDeps } from '../src/client/input/facade.ts'

const file: ReferenceInsert = {
  source: 'reference', ref: '@src/main.ts', label: 'main.ts', appearance: 'file', clipboardText: '@src/main.ts',
}
const session: ReferenceInsert = {
  source: 'reference', ref: '@[Research](dsh-session:c291cmNl)', label: 'Research', appearance: 'session',
  clipboardText: '@[Research](dsh-session:c291cmNl)',
}

function triggerProvider(overrides: Partial<InputTriggerController> = {}): InputTriggerController {
  return {
    launcher: createSnapshotStore<string | null>(null),
    lexicon: createSnapshotStore<ReadonlyMap<'/' | '@', readonly string[]>>(new Map()),
    track: () => {},
    arbitrate: () => 'pass',
    onSpace: () => false,
    serializeReference: (source, ref) => Promise.resolve(`${source}:${ref}`),
    adjudicate: () => Promise.resolve(undefined),
    resolveClaim: () => Promise.resolve(undefined),
    openReference: () => false,
    toggleSource: () => {},
    ...overrides,
  }
}

function makeShell(overrides: Partial<SessionInputDeps> = {}): SessionInputShell {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const provider = triggerProvider()
  const shell = new SessionInputShell({
    actx: ctx,
    inputTriggers: () => provider,
    defaultSink: () => Promise.resolve({ kind: 'success' }),
    commandAttachments: { serialize: () => Promise.resolve([]), release: () => {}, unsupportedNotice: token => token },
    ...overrides,
  })
  onTestFinished(() => { shell.dispose() })
  return shell
}

function claimCommand(shell: SessionInputShell, submit: CommandClaim['submit']): void {
  shell.setDraft('/goal ')
  expect(shell.beginCommand({ name: 'goal', token: '/goal ', submit }, {
    start: 0, end: '/goal '.length, draftRev: shell.snapshot.draftRev,
  })).toBe(true)
}

describe('reference card drafts', () => {
  it('appends independent cards without editing inline content and persists them without runtime ids', () => {
    const shell = makeShell()
    shell.setDraft({ text: file.clipboardText, references: [{ ...file, offset: 0, length: file.clipboardText.length }] })
    const editorState = shell.editor.getEditorState()
    const occurrences = shell.snapshot.occurrences
    const revision = shell.snapshot.draftRev
    const write = vi.fn<(draft: DraftSnapshot) => void>()
    shell.bindDraftPersistence(write)
    const mutable = { ...session }
    expect(shell.addReferences([mutable, mutable])).toBe(true)
    mutable.label = 'changed by caller'
    expect(shell.editor.getEditorState()).toBe(editorState)
    expect(shell.snapshot.draft).toBe(file.clipboardText)
    expect(shell.snapshot.occurrences).toEqual(occurrences)
    expect(shell.snapshot.draftRev).toBeGreaterThan(revision)
    expect(shell.snapshot.attachmentIds).toEqual([])
    expect(shell.snapshot.attachedReferences).toMatchObject([session, session])
    for (const reference of shell.snapshot.attachedReferences) expect(typeof reference.id).toBe('string')
    expect(new Set(shell.snapshot.attachedReferences.map(reference => reference.id)).size).toBe(2)
    expect(shell.draftSnapshot).toEqual({
      text: file.clipboardText, references: [{ ...file, offset: 0, length: file.clipboardText.length }],
      attachedReferences: [session, session],
    })
    expect(write).toHaveBeenLastCalledWith(shell.draftSnapshot)
    expect(JSON.stringify(shell.draftSnapshot)).not.toContain('"id"')
  })

  it('restores cards with fresh runtime ids and clears them when plain text replaces the draft', () => {
    const draft: DraftSnapshot = { text: 'read this', references: [], attachedReferences: [file, session] }
    const shell = makeShell()
    shell.setDraft(draft)
    const first = shell.snapshot.attachedReferences.map(reference => reference.id)
    expect(shell.draftSnapshot).toEqual(draft)
    shell.setDraft(draft)
    expect(shell.snapshot.attachedReferences.map(reference => reference.id)).not.toEqual(first)
    expect(shell.snapshot.attachedReferences).toMatchObject([file, session])
    shell.setDraft('replacement')
    expect(shell.snapshot.attachedReferences).toEqual([])
    expect(shell.draftSnapshot).toEqual({ text: 'replacement', references: [] })
  })

  it('copies card metadata and reads legacy stored drafts without requiring cards', () => {
    expect(parseStoredDraft('legacy text')).toEqual({ text: 'legacy text', references: [] })
    expect(parseStoredDraft({ text: '', references: [] })).toEqual({ text: '', references: [] })
    const reference = { ...file }
    const draft = { text: '', references: [], attachedReferences: [reference] }
    const copied = resolveDraftInput(draft)
    reference.label = 'caller edit'
    draft.attachedReferences.length = 0
    expect(copied).toEqual({ text: '', references: [], attachedReferences: [file] })
    expect(parseStoredDraft({
      text: '', references: [], attachedReferences: [{ ...session, id: 'old-browser-id', offset: 12 }],
    })).toEqual({ text: '', references: [], attachedReferences: [session] })
  })

  it.each<{ name: string; attachedReferences: unknown }>([
    { name: 'a non-array card list', attachedReferences: {} },
    { name: 'a null card', attachedReferences: [null] },
    { name: 'a missing source', attachedReferences: [{ ref: 'file', label: 'File', clipboardText: '@file' }] },
    { name: 'a non-string reference', attachedReferences: [{ ...file, ref: 3 }] },
    { name: 'a missing label', attachedReferences: [{ source: 'reference', ref: 'file', clipboardText: '@file' }] },
    { name: 'a non-string clipboard projection', attachedReferences: [{ ...file, clipboardText: false }] },
    { name: 'an unsupported appearance', attachedReferences: [{ ...file, appearance: 'image' }] },
  ])('rejects stored drafts with $name', ({ attachedReferences }) => {
    expect(parseStoredDraft({ text: '', references: [], attachedReferences })).toBeUndefined()
  })

  it('keeps reference-only drafts during initialization and appends text before their cards', () => {
    const shell = makeShell()
    shell.addReferences([file])
    const id = shell.snapshot.attachedReferences[0]!.id
    expect(shell.requestDraftInitialization({ prompt: 'ignored' })).toBe('preserved')
    expect(shell.requestDraftInitialization({ prompt: 'read this', whenDraftExists: 'append' })).toBe('applied')
    expect(shell.draftSnapshot).toEqual({ text: 'read this', references: [], attachedReferences: [file] })
    expect(shell.snapshot.attachedReferences[0]?.id).toBe(id)
    expect(shell.requestDraftInitialization({ prompt: 'fresh', whenDraftExists: 'replace' })).toBe('applied')
    expect(shell.draftSnapshot).toEqual({ text: 'fresh', references: [] })
    shell.addReferences([session])
    expect(shell.requestDraftInitialization({ clearPreviousDraft: true })).toBe('applied')
    expect(shell.snapshot.attachedReferences).toEqual([])
  })

  it('invalidates captured insertions when cards are added or individually removed', () => {
    const shell = makeShell()
    shell.setDraft('retain this text')
    const beforeAdd = shell.actions.captureInsertion()
    shell.addReferences([file, file])
    expect(shell.actions.insertText('late result', beforeAdd)).toBe(false)
    const beforeRemove = shell.actions.captureInsertion()
    const [first, second] = shell.snapshot.attachedReferences
    if (first === undefined || second === undefined) throw new Error('Expected two reference cards')
    shell.actions.removeReference(first.id)
    expect(shell.snapshot.attachedReferences).toEqual([second])
    expect(shell.removeReference(first.id)).toBe(false)
    expect(shell.actions.insertText('late result', beforeRemove)).toBe(false)
    expect(shell.snapshot.draft).toBe('retain this text')
  })
})

describe('reference card submission', () => {
  it('serializes a reference-only message in card order and retains it through a failed send', async () => {
    const sink = vi.fn<SessionInputDeps['defaultSink']>()
      .mockResolvedValueOnce({ kind: 'error', text: 'Host refused input' })
      .mockResolvedValueOnce({ kind: 'success' })
    const serializeReference = vi.fn<InputTriggerController['serializeReference']>((source, ref) => Promise.resolve(`${source}:${ref}`))
    const provider = triggerProvider({ serializeReference })
    const shell = makeShell({ defaultSink: sink, inputTriggers: () => provider })
    shell.addReferences([session, file])
    const cards = shell.snapshot.attachedReferences
    shell.submit('steer')
    expect(shell.snapshot.phase).toBe('plain')
    expect(shell.snapshot.attachedReferences).toEqual([])
    await vi.waitFor(() => { expect(sink).toHaveBeenCalledOnce(); expect(shell.snapshot.attachedReferences).toEqual(cards) })
    expect(sink).toHaveBeenNthCalledWith(1, `reference:${session.ref}\n\nreference:${file.ref}`, [], 'steer', expect.any(AbortSignal))
    expect(shell.snapshot.attachedReferences).toEqual(cards)
    expect(shell.snapshot.draft).toBe('')
    expect(shell.notices.getSnapshot()?.text).toBe('Host refused input')
    shell.submit()
    await vi.waitFor(() => { expect(shell.snapshot.attachedReferences).toEqual([]) })
    expect(serializeReference.mock.calls.map(([source, ref]) => [source, ref])).toEqual([
      [session.source, session.ref], [file.source, file.ref], [session.source, session.ref], [file.source, file.ref],
    ])
    expect(shell.snapshot.attachmentIds).toEqual([])
  })

  it('appends serialized cards after inline reference text as separate paragraphs', async () => {
    const sink = vi.fn<SessionInputDeps['defaultSink']>(() => Promise.resolve({ kind: 'success' }))
    const shell = makeShell({ defaultSink: sink })
    const text = `read ${file.clipboardText}`
    shell.setDraft({ text, references: [{ ...file, offset: 5, length: file.clipboardText.length }], attachedReferences: [session] })
    shell.submit()
    await vi.waitFor(() => { expect(sink).toHaveBeenCalledOnce() })
    expect(sink.mock.calls[0]?.[0]).toBe(`read reference:${file.ref}\n\nreference:${session.ref}`)
    await vi.waitFor(() => { expect(shell.snapshot.phase).toBe('plain') })
  })

  it('serializes cards into command arguments and retains them when the command fails', async () => {
    const submit = vi.fn<CommandClaim['submit']>()
      .mockResolvedValueOnce({ kind: 'error', text: 'command unavailable' })
      .mockResolvedValueOnce({ kind: 'success' })
    const shell = makeShell()
    claimCommand(shell, submit)
    shell.actions.insertText('review', shell.actions.captureInsertion())
    shell.addReferences([file, session])
    const cards = shell.snapshot.attachedReferences
    shell.submit()
    await vi.waitFor(() => { expect(shell.snapshot.phase).toBe('claimed') })
    expect(submit).toHaveBeenNthCalledWith(1, `review\n\nreference:${file.ref}\n\nreference:${session.ref}`, expect.any(Context), [])
    expect(shell.snapshot.attachedReferences).toEqual(cards)
    expect(shell.snapshot.draft).toBe('/goal review')
    shell.submit()
    await vi.waitFor(() => { expect(shell.snapshot.attachedReferences).toEqual([]) })
    expect(shell.snapshot.draft).toBe('')
  })

  it('retains cards and blocks the sink when a reference owner cannot serialize them', async () => {
    const sink = vi.fn<SessionInputDeps['defaultSink']>(() => Promise.resolve({ kind: 'success' }))
    const provider = triggerProvider({ serializeReference: () => Promise.reject(new Error('reference unavailable')) })
    const shell = makeShell({ defaultSink: sink, inputTriggers: () => provider })
    shell.addReferences([file])
    shell.submit()
    await vi.waitFor(() => { expect(shell.snapshot.attachedReferences).toMatchObject([file]) })
    expect(sink).not.toHaveBeenCalled()
    expect(shell.notices.getSnapshot()?.text).toBe('reference unavailable')
  })

  it('refuses card changes during adjudication and resumes editing after it settles', async () => {
    const pending = Promise.withResolvers<PickOutcome>()
    onTestFinished(() => { pending.resolve('handled') })
    const entered = Promise.withResolvers<undefined>()
    const provider = triggerProvider({ adjudicate: () => { entered.resolve(undefined); return pending.promise } })
    const shell = makeShell({ inputTriggers: () => provider })
    shell.setDraft('/pending')
    shell.addReferences([file])
    const cards = shell.snapshot.attachedReferences
    shell.submit()
    await entered.promise
    expect(shell.snapshot.phase).toBe('adjudicating')
    expect(shell.addReferences([session])).toBe(false)
    expect(shell.removeReference(cards[0]!.id)).toBe(false)
    expect(shell.snapshot.attachedReferences).toEqual(cards)
    pending.resolve(undefined)
    await vi.waitFor(() => { expect(shell.snapshot.phase).toBe('plain') })
    expect(shell.addReferences([session])).toBe(true)
  })

  it('allows a new draft during a detached send and retains its cards after late success', async () => {
    const pending = Promise.withResolvers<SubmitOutcome>()
    onTestFinished(() => { pending.resolve({ kind: 'error' }) })
    const entered = Promise.withResolvers<AbortSignal>()
    const sink = vi.fn<SessionInputDeps['defaultSink']>((_text, _attachments, _mode, signal) => {
      entered.resolve(signal)
      return pending.promise
    })
    const shell = makeShell({ defaultSink: sink })
    shell.addReferences([file])
    const original = shell.snapshot.attachedReferences[0]!
    shell.submit()
    const signal = await entered.promise
    expect(signal.aborted).toBe(false)
    expect(shell.snapshot.attachedReferences).toEqual([])
    expect(shell.addReferences([session])).toBe(true)
    expect(shell.removeReference(original.id)).toBe(false)
    shell.setDraft({ text: '', references: [], attachedReferences: [file, session] })
    const replacement = shell.snapshot.attachedReferences
    expect(replacement[0]?.id).not.toBe(original.id)
    pending.resolve({ kind: 'success' })
    await vi.waitFor(() => { expect(shell.snapshot.phase).toBe('plain') })
    expect(shell.snapshot.attachedReferences).toEqual(replacement)
    expect(shell.draftSnapshot).toEqual({ text: '', references: [], attachedReferences: [file, session] })
  })

  it('restores failed reference snapshots in submission order after reversed settlement', async () => {
    const first = Promise.withResolvers<SubmitOutcome>()
    const second = Promise.withResolvers<SubmitOutcome>()
    const sink = vi.fn<SessionInputDeps['defaultSink']>()
      .mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const shell = makeShell({ defaultSink: sink })
    shell.setDraft('first')
    shell.addReferences([file])
    const firstCard = shell.snapshot.attachedReferences[0]!
    shell.submit()
    expect(shell.snapshot).toMatchObject({ draft: '', phase: 'plain', attachedReferences: [] })
    shell.setDraft('second')
    shell.addReferences([session])
    const secondCard = shell.snapshot.attachedReferences[0]!
    shell.submit()
    await vi.waitFor(() => { expect(sink).toHaveBeenCalledTimes(2) })
    second.resolve({ kind: 'error', text: 'second failed' })
    await vi.waitFor(() => { expect(shell.snapshot.draft).toBe('second') })
    expect(shell.snapshot.attachedReferences).toEqual([secondCard])
    first.resolve({ kind: 'error', text: 'first failed' })
    await vi.waitFor(() => { expect(shell.snapshot.draft).toBe('first\n\nsecond') })
    expect(shell.snapshot.attachedReferences).toEqual([firstCard, secondCard])
    expect(sink.mock.calls.map(call => call[0])).toEqual([
      `first\n\nreference:${file.ref}`, `second\n\nreference:${session.ref}`,
    ])
  })

  it('restores failed cards beside newer input without overwriting that text', async () => {
    const pending = Promise.withResolvers<SubmitOutcome>()
    const sink = vi.fn<SessionInputDeps['defaultSink']>(() => pending.promise)
    const shell = makeShell({ defaultSink: sink })
    shell.setDraft('submitted text')
    shell.addReferences([file])
    const submitted = shell.snapshot.attachedReferences[0]!
    shell.submit()
    await vi.waitFor(() => { expect(sink).toHaveBeenCalledOnce() })
    shell.setDraft('new draft')
    shell.addReferences([session])
    const current = shell.snapshot.attachedReferences[0]!
    pending.resolve({ kind: 'error', text: 'failed send' })
    await vi.waitFor(() => { expect(shell.notices.getSnapshot()?.text).toBe('failed send') })
    expect(shell.snapshot.draft).toBe('new draft')
    expect(shell.snapshot.attachedReferences).toEqual([submitted, current])
  })

  it('sends the captured references after arbitration while preserving a programmatic replacement', async () => {
    const adjudication = Promise.withResolvers<PickOutcome>()
    const entered = Promise.withResolvers<undefined>()
    const provider = triggerProvider({ adjudicate: () => {
      entered.resolve(undefined)
      return adjudication.promise
    } })
    const sink = vi.fn<SessionInputDeps['defaultSink']>(() => Promise.resolve({ kind: 'success' }))
    const shell = makeShell({ defaultSink: sink, inputTriggers: () => provider })
    shell.setDraft({ text: '/unknown', references: [], attachedReferences: [file] })
    shell.submit()
    await entered.promise
    shell.setDraft({ text: 'replacement', references: [], attachedReferences: [session] })
    const replacement = shell.snapshot.attachedReferences
    adjudication.resolve(undefined)
    await vi.waitFor(() => { expect(sink).toHaveBeenCalledOnce() })
    expect(sink.mock.calls[0]?.[0]).toBe(`/unknown\n\nreference:${file.ref}`)
    expect(shell.snapshot.draft).toBe('replacement')
    expect(shell.snapshot.attachedReferences).toEqual(replacement)
  })

  it('refuses card changes after disposal and aborts pending reference serialization', async () => {
    const pending = Promise.withResolvers<string>()
    onTestFinished(() => { pending.resolve('late reference') })
    const entered = Promise.withResolvers<AbortSignal>()
    const provider = triggerProvider({ serializeReference: (_source, _ref, signal) => {
      entered.resolve(signal)
      return pending.promise
    } })
    const sink = vi.fn<SessionInputDeps['defaultSink']>(() => Promise.resolve({ kind: 'success' }))
    const shell = makeShell({ defaultSink: sink, inputTriggers: () => provider })
    shell.addReferences([file])
    const cards = shell.snapshot.attachedReferences
    shell.submit()
    const signal = await entered.promise
    shell.dispose()
    expect(signal.aborted).toBe(true)
    expect(shell.addReferences([session])).toBe(false)
    expect(shell.removeReference(cards[0]!.id)).toBe(false)
    pending.resolve('late reference')
    await pending.promise
    // The shell exposes no settlement promise; drain its queued serialization continuations.
    await setImmediate()
    expect(shell.snapshot.attachedReferences).toEqual([])
    expect(sink).not.toHaveBeenCalled()
  })
})
