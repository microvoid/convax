// @vitest-environment jsdom
/** Submit-owned reference images share native draft capture, command policy, and failure restoration. */
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { ReferenceInsert } from '../src/client/contract/draft-editor.ts'
import type { CommandClaim, InputTriggerController, PreparedReference } from '../src/client/contract/input.ts'
import { SessionInputShell, type SessionInputDeps } from '../src/client/input/facade.ts'
import { prepareDraftPrompt } from '../src/client/input/prompt.ts'

const image = { type: 'image' as const, mediaType: 'image/png' as const, data: 'Zmlyc3Q=', name: 'window.png' }
const windowReference: ReferenceInsert = { source: 'window', ref: 'window:one', label: 'Window one', clipboardText: '@window:one' }

function shellWith(prepareReference: NonNullable<InputTriggerController['prepareReference']>, sink?: SessionInputDeps['defaultSink']): SessionInputShell {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const provider: InputTriggerController = {
    launcher: createSnapshotStore<string | null>(null),
    lexicon: createSnapshotStore<ReadonlyMap<'/' | '@', readonly string[]>>(new Map()),
    track: () => {}, arbitrate: () => 'pass', onSpace: () => false,
    serializeReference: () => Promise.reject(new Error('rich references must prepare their images')),
    prepareReference,
    adjudicate: () => Promise.resolve(undefined), resolveClaim: () => Promise.resolve(undefined),
    openReference: () => false, toggleSource: () => {},
  }
  const shell = new SessionInputShell({
    actx: ctx, inputTriggers: () => provider,
    defaultSink: sink ?? (() => Promise.resolve({ kind: 'success' })),
    commandAttachments: { serialize: () => Promise.resolve([]), release: () => {}, unsupportedNotice: token => `${token.trim()} refuses images` },
  })
  onTestFinished(() => { shell.dispose() })
  return shell
}

function command(shell: SessionInputShell, attachments: boolean, submit: CommandClaim['submit']): void {
  shell.setDraft('/capture ')
  expect(shell.beginCommand({ name: 'capture', token: '/capture ', attachments, submit }, {
    start: 0, end: '/capture '.length, draftRev: shell.snapshot.draftRev,
  })).toBe(true)
  shell.addReferences([windowReference])
}

describe('reference input preparation', () => {
  it('preserves inline and card order when image preparations settle in reverse', async () => {
    const first = Promise.withResolvers<PreparedReference>()
    const second = Promise.withResolvers<PreparedReference>()
    const prepare = vi.fn((_source: string, ref: string) => ref === 'inline' ? first.promise : second.promise)
    const pending = prepareDraftPrompt({
      text: '@inline',
      references: [{ source: 'window', ref: 'inline', label: 'Inline', clipboardText: '@inline', offset: 0, length: 7 }],
      attachedReferences: [{ ...windowReference, ref: 'card' }],
    }, prepare)
    const secondImage = { ...image, data: 'c2Vjb25k' }
    second.resolve({ text: 'second source', attachments: [secondImage] })
    first.resolve({ text: 'first source', attachments: [image] })
    await expect(pending).resolves.toEqual({ text: 'first source\n\nsecond source', attachments: [image, secondImage] })
    expect(prepare.mock.calls).toEqual([['window', 'inline'], ['window', 'card']])
  })

  it('sends image-only references without allocating draft attachment ids or reading newer edits', async () => {
    const gate = Promise.withResolvers<PreparedReference>()
    onTestFinished(() => { gate.resolve({ text: '', attachments: [] }) })
    const sink = vi.fn<SessionInputDeps['defaultSink']>(() => Promise.resolve({ kind: 'success' }))
    const shell = shellWith(() => gate.promise, sink)
    shell.addReferences([windowReference])
    shell.submit('steer')
    shell.setDraft('new draft while capturing')
    gate.resolve({ text: '', attachments: [image] })
    await vi.waitFor(() => { expect(sink).toHaveBeenCalledExactlyOnceWith('', [], 'steer', expect.any(AbortSignal), [image]) })
    expect(shell.snapshot.draft).toBe('new draft while capturing')
    expect(shell.snapshot.attachmentIds).toEqual([])
    expect(shell.snapshot.attachedReferences).toEqual([])
  })

  it('restores a failed reference beside newer text and takes a new image on deliberate retry', async () => {
    const gate = Promise.withResolvers<PreparedReference>()
    onTestFinished(() => { gate.resolve({ text: '', attachments: [] }) })
    const prepare = vi.fn<NonNullable<InputTriggerController['prepareReference']>>()
      .mockImplementationOnce(() => gate.promise)
      .mockResolvedValueOnce({ text: 'fresh source', attachments: [image] })
    const sink = vi.fn<SessionInputDeps['defaultSink']>(() => Promise.resolve({ kind: 'success' }))
    const shell = shellWith(prepare, sink)
    shell.setDraft('old question')
    shell.addReferences([windowReference])
    shell.submit()
    shell.setDraft('new question')
    gate.reject(new Error('window closed'))
    await vi.waitFor(() => { expect(shell.snapshot.attachedReferences).toMatchObject([windowReference]) })
    expect(shell.snapshot.draft).toBe('new question')
    expect(shell.notices.getSnapshot()?.text).toBe('window closed')
    expect(sink).not.toHaveBeenCalled()
    shell.submit()
    await vi.waitFor(() => { expect(sink).toHaveBeenCalledExactlyOnceWith('new question\n\nfresh source', [], 'queue', expect.any(AbortSignal), [image]) })
    expect(prepare).toHaveBeenCalledTimes(2)
  })

  it('admits no partial prompt when one of several references fails', async () => {
    const sink = vi.fn<SessionInputDeps['defaultSink']>(() => Promise.resolve({ kind: 'success' }))
    const shell = shellWith((_source, ref) => ref === 'window:one'
      ? Promise.resolve({ text: 'one', attachments: [image] })
      : Promise.reject(new Error('second window unavailable')), sink)
    shell.setDraft('compare')
    shell.addReferences([windowReference, { ...windowReference, ref: 'window:two' }])
    shell.submit()
    await vi.waitFor(() => { expect(shell.snapshot.attachedReferences).toHaveLength(2) })
    expect(shell.snapshot.draft).toBe('compare')
    expect(sink).not.toHaveBeenCalled()
  })

  it('passes prepared images to a command that accepts attachments', async () => {
    const submit = vi.fn<CommandClaim['submit']>(() => Promise.resolve({ kind: 'success' }))
    const shell = shellWith(() => Promise.resolve({ text: 'source', attachments: [image] }))
    command(shell, true, submit)
    shell.submit()
    await vi.waitFor(() => { expect(submit).toHaveBeenCalledExactlyOnceWith('source', expect.any(Context), [image]) })
    expect(shell.snapshot.attachedReferences).toEqual([])
  })

  it('keeps the draft instead of dropping images for a command without attachment support', async () => {
    const submit = vi.fn<CommandClaim['submit']>(() => Promise.resolve({ kind: 'success' }))
    const shell = shellWith(() => Promise.resolve({ text: 'source', attachments: [image] }))
    command(shell, false, submit)
    shell.submit()
    await vi.waitFor(() => { expect(shell.notices.getSnapshot()?.text).toBe('/capture refuses images') })
    expect(submit).not.toHaveBeenCalled()
    expect(shell.snapshot.attachedReferences).toMatchObject([windowReference])
    expect(shell.snapshot.phase).toBe('claimed')
  })

  it('aborts pending preparation and rejects late delivery after disposal', async () => {
    const gate = Promise.withResolvers<PreparedReference>()
    const entered = Promise.withResolvers<AbortSignal>()
    const sink = vi.fn<SessionInputDeps['defaultSink']>(() => Promise.resolve({ kind: 'success' }))
    const shell = shellWith((_source, _ref, signal) => { entered.resolve(signal); return gate.promise }, sink)
    shell.addReferences([windowReference])
    shell.submit()
    const signal = await entered.promise
    shell.dispose()
    expect(signal.aborted).toBe(true)
    gate.resolve({ text: 'late capture', attachments: [image] })
    // Drain the completed preparation's continuations; the shell has no public settlement promise.
    await setImmediate()
    expect(sink).not.toHaveBeenCalled()
  })
})
