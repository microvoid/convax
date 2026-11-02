// @vitest-environment jsdom
/** Empty composers provide a paragraph before the first native composition. */
import { fireEvent } from '@testing-library/react'
import { expect, it, onTestFinished, vi } from 'vitest'
import { $getRoot, $getSelection, $isParagraphNode, UNDO_COMMAND } from 'lexical'
import { DraftEditorRuntime } from '../src/client/input/editor/runtime.ts'

function fixture() {
  const geometry = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect')
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect() })
  onTestFinished(() => {
    if (geometry === undefined) Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect')
    else Object.defineProperty(Range.prototype, 'getBoundingClientRect', geometry)
  })
  const root = document.createElement('div')
  root.contentEditable = 'true'
  root.tabIndex = 0
  const outside = document.createElement('button')
  document.body.append(root, outside)
  outside.focus()
  const onUpdate = vi.fn()
  const runtime: DraftEditorRuntime = new DraftEditorRuntime({
    onUpdate: () => { runtime.refreshProjection(); onUpdate() },
    quoteLabels: () => ({ remove: 'Remove quote' }),
    openReference: () => false,
    lexicon: () => new Map(), resolveLexicon: () => undefined,
  })
  const initializedUpdates = onUpdate.mock.calls.length
  const dispose = runtime.register()
  runtime.setDraft('')
  runtime.editor.setRootElement(root)
  onTestFinished(() => {
    dispose()
    root.remove()
    outside.remove()
  })
  return { root, outside, runtime, initializedUpdates }
}

it('binds an empty paragraph without moving focus, publishing a draft edit, or adding an undo step', () => {
  const f = fixture()
  expect(f.initializedUpdates).toBe(0)
  expect(document.activeElement).toBe(f.outside)
  expect(f.root.querySelector('p')).not.toBeNull()
  f.runtime.editor.getEditorState().read(() => {
    const root = $getRoot()
    expect(root.getChildrenSize()).toBe(1)
    expect($isParagraphNode(root.getFirstChild())).toBe(true)
    expect($getSelection()).toBeNull()
  })
  expect(f.runtime.projection.clipboardText).toBe('')
  f.runtime.editor.dispatchCommand(UNDO_COMMAND, undefined)
  f.runtime.editor.read(() => {})
  expect(f.root.querySelector('p')).not.toBeNull()
  expect(document.activeElement).toBe(f.outside)
})

it('retains the first composed character without an earlier plain-text edit', async () => {
  const f = fixture()
  f.runtime.editor.focus()
  fireEvent.compositionStart(f.root)
  f.runtime.editor.read(() => {})
  const span = f.root.querySelector('[data-lexical-text]')
  expect(span).not.toBeNull()
  const text = span?.firstChild
  if (text === undefined || text === null) throw new Error('Composition must have a text anchor')
  // The platform IME writes into its composing DOM text before the input event.
  text.textContent = '你'
  const selection = document.getSelection()!
  const range = document.createRange()
  range.setStart(text, 1)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
  fireEvent.input(f.root, { inputType: 'insertCompositionText', data: '你', isComposing: true })
  fireEvent.compositionEnd(f.root, { data: '你' })
  await vi.waitFor(() => { expect(f.runtime.projection.clipboardText).toBe('你') })
  expect(f.root.textContent).toBe('你')
  f.runtime.editor.getEditorState().read(() => { expect($getRoot().getAllTextNodes()).toHaveLength(1) })
})
