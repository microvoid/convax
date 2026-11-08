// @vitest-environment jsdom
/** Deferred clipboard reads cannot apply to another canvas revision or an unmounted graph. */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasCommand, CanvasDocument, CanvasGroupId, CanvasId, CanvasNodeId, CanvasNodeTypeId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { copyCanvasSelection, type CanvasClipboardNotice, type CanvasClipboardView, type ClipboardNodeSize } from '../src/client/canvas-clipboard.ts'
import type { ClipboardObstacle } from '../src/client/clipboard-placement.ts'
import { useCanvasClipboard } from '../src/client/use-canvas-clipboard.ts'

const ID = 'source' as CanvasNodeId
const document: CanvasDocument = { id: 'canvas' as CanvasId, title: 'Board', revision: 1, connections: [], nodes: [{
  id: ID, typeId: 'convax.file' as CanvasNodeTypeId, dataVersion: 1, data: { path: '/project/notes.txt' }, revision: 1, position: { x: 0, y: 0 },
}] }
const dimensions = { [ID]: { width: 100, height: 80 } }
const views: Record<string, CanvasClipboardView> = { [ID]: { kind: 'resource', presentation: { expanded: false } } }
const text = JSON.stringify(copyCanvasSelection(document, [ID], dimensions, views))
const readText = vi.fn<() => Promise<string>>()
const writeText = vi.fn<(text: string) => Promise<void>>()
beforeEach(() => {
  readText.mockReset().mockResolvedValue(text)
  writeText.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { readText, writeText } })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function deferredRead() {
  let resolve: (value: string) => void = () => { throw new Error('Read not started') }
  const promise = new Promise<string>((accept) => { resolve = accept })
  readText.mockReturnValueOnce(promise)
  return { promise, resolve }
}

function fixture(initial: CanvasDocument = document, initialDimensions: Readonly<Record<string, ClipboardNodeSize>> = dimensions,
  initialViews: Readonly<Record<string, CanvasClipboardView>> = views) {
  const command = vi.fn<(command: CanvasCommand) => Promise<boolean>>(async () => true)
  const report = vi.fn<(notice: CanvasClipboardNotice) => void>()
  const select = vi.fn<(ids: CanvasNodeId[]) => void>()
  const reveal = vi.fn<(ids: CanvasNodeId[]) => void>()
  const applyViews = vi.fn()
  function Scenario({ current = initial, obstacles = initial.nodes.map(node => ({ ...node.position, ...initialDimensions[node.id]! })) }: {
    readonly current?: CanvasDocument
    readonly obstacles?: readonly ClipboardObstacle[]
  }) {
    const clipboard = useCanvasClipboard({
      document: current, dimensions: initialDimensions, views: initialViews, obstacles, command, report, select, reveal,
      applyViews, pasteCenter: () => ({ x: 400, y: 300 }) })
    return <>
      <button onClick={() => { void clipboard.copy(initial.nodes.map(node => node.id)) }}>Copy</button>
      <button onClick={() => { void clipboard.paste() }}>Paste</button>
      <button onClick={() => { void clipboard.paste({ x: 150, y: 0 }) }}>Paste at point</button>
      <button onClick={() => { void clipboard.duplicate(initial.nodes.map(node => node.id)) }}>Duplicate</button>
      <button onClick={() => { clipboard.cancel() }}>Cancel</button>
      <output aria-label="Clipboard pending">{String(clipboard.pending)}</output>
    </>
  }
  const view = render(<Scenario />)
  return { view, Scenario, command, report, select, reveal, applyViews }
}

describe('Canvas clipboard operation lifecycle', () => {
  it('writes tagged text through the shared clipboard helper and reports its accepted result', async () => {
    const b = fixture()
    fireEvent.click(b.view.getByRole('button', { name: 'Copy' }))
    await waitFor(() => { expect(b.view.getByLabelText('Clipboard pending').textContent).toBe('false') })
    expect(JSON.parse(writeText.mock.calls[0]![0])).toMatchObject({ kind: 'convax.canvas.nodes', version: 2 })
    expect(b.report).toHaveBeenCalledExactlyOnceWith('clipboard.copied')
    expect(b.command).not.toHaveBeenCalled()
  })

  it.each(['paste', 'duplicate'] as const)('selects and reveals only the new nodes after a committed %s', async (kind) => {
    const b = fixture()
    fireEvent.click(b.view.getByRole('button', { name: kind === 'paste' ? 'Paste' : 'Duplicate' }))
    await waitFor(() => { expect(b.view.getByLabelText('Clipboard pending').textContent).toBe('false') })
    const command = b.command.mock.calls[0]![0]
    expect(command.kind).toBe('add-subgraph')
    if (command.kind !== 'add-subgraph') throw new Error('Expected graph copy command')
    expect(command.nodes[0]?.id).not.toBe(ID)
    expect(b.select).toHaveBeenCalledExactlyOnceWith(command.nodes.map(node => node.id))
    expect(b.reveal).toHaveBeenCalledExactlyOnceWith(command.nodes.map(node => node.id))
    expect(b.applyViews).toHaveBeenCalledExactlyOnceWith([{ nodeId: command.nodes[0]!.id, view: views[ID] }])
    expect(b.applyViews.mock.invocationCallOrder[0]).toBeLessThan(b.select.mock.invocationCallOrder[0]!)
    expect(writeText).not.toHaveBeenCalled()
  })

  it.each(['paste', 'duplicate'] as const)('commits complete group membership and fresh identities during %s', async (kind) => {
    const groupId = 'reference-group' as CanvasGroupId
    const source: CanvasDocument = { ...document, groups: [{ id: groupId, title: 'References' }],
      nodes: [{ ...document.nodes[0]!, groupId }],
    }
    if (kind === 'paste') readText.mockResolvedValueOnce(JSON.stringify(copyCanvasSelection(source, [ID], dimensions, views)))
    const b = fixture(source)
    fireEvent.click(b.view.getByRole('button', { name: kind === 'paste' ? 'Paste' : 'Duplicate' }))
    await waitFor(() => { expect(b.view.getByLabelText('Clipboard pending').textContent).toBe('false') })
    const command = b.command.mock.calls[0]![0]
    if (command.kind !== 'add-subgraph') throw new Error('Expected graph copy command')
    expect(command.groups).toHaveLength(1)
    expect(command.groups![0]!.id).not.toBe(groupId)
    expect(command.nodes[0]!.groupId).toBe(command.groups![0]!.id)
    expect(b.select).toHaveBeenCalledExactlyOnceWith(command.nodes.map(node => node.id))
  })

  it.each(['revision', 'canvas', 'unmount'] as const)('does not write graph data when %s changes during a deferred native read', async (change) => {
    const pending = deferredRead()
    const b = fixture()
    fireEvent.click(b.view.getByRole('button', { name: 'Paste' }))
    expect(readText).toHaveBeenCalledOnce()
    expect(b.view.getByLabelText('Clipboard pending').textContent).toBe('true')
    if (change === 'unmount') b.view.unmount()
    else b.view.rerender(<b.Scenario current={{ ...document, ...(change === 'revision' ? { revision: 2 } : { id: 'other' as CanvasId }) }} />)
    await act(async () => { pending.resolve(text); await pending.promise })
    expect(b.command).not.toHaveBeenCalled()
    expect(b.select).not.toHaveBeenCalled()
    expect(b.reveal).not.toHaveBeenCalled()
    if (change === 'revision') expect(b.report).toHaveBeenCalledExactlyOnceWith('clipboard.changed')
    else expect(b.report).not.toHaveBeenCalled()
  })

  it('uses the current measured obstacles after clipboard permission resolves without a graph revision change', async () => {
    const pending = deferredRead()
    const b = fixture()
    fireEvent.click(b.view.getByRole('button', { name: 'Paste at point' }))
    b.view.rerender(<b.Scenario obstacles={[{ x: 0, y: 0, width: 400, height: 80 }]} />)
    await act(async () => { pending.resolve(text); await pending.promise })
    const command = b.command.mock.calls[0]![0]
    if (command.kind !== 'add-subgraph') throw new Error('Expected graph copy command')
    const point = command.nodes[0]!.position
    expect(point.x < 400 && point.x + 100 > 0 && point.y < 80 && point.y + 80 > 0).toBe(false)
  })

  it('cancels a pending native read and ignores its late result without clearing a newer operation', async () => {
    const first = deferredRead()
    const second = deferredRead()
    const b = fixture()
    fireEvent.click(b.view.getByRole('button', { name: 'Paste' }))
    fireEvent.click(b.view.getByRole('button', { name: 'Cancel' }))
    expect(b.view.getByLabelText('Clipboard pending').textContent).toBe('false')
    fireEvent.click(b.view.getByRole('button', { name: 'Paste' }))
    await act(async () => { first.resolve(text); await first.promise })
    expect(b.command).not.toHaveBeenCalled()
    expect(b.view.getByLabelText('Clipboard pending').textContent).toBe('true')
    await act(async () => { second.resolve(text); await second.promise })
    expect(b.command).toHaveBeenCalledOnce()
    expect(b.view.getByLabelText('Clipboard pending').textContent).toBe('false')
  })

  it('copies collapsed narrow Chat presentation before selecting its fresh group and preserves source preferences', async () => {
    const chatId = 'chat' as CanvasNodeId
    const resourceId = 'resource' as CanvasNodeId
    const source: CanvasDocument = { ...document, nodes: [
      { ...document.nodes[0]!, id: chatId, typeId: 'convax.chat' as CanvasNodeTypeId, data: { title: 'Chat', cwd: '/project' } },
      { ...document.nodes[0]!, id: resourceId, position: { x: 450, y: 0 } },
    ] }
    const sizes = { [chatId]: { width: 400, height: 40 }, [resourceId]: { width: 320, height: 80 } }
    const sourceViews: Record<string, CanvasClipboardView> = {
      [chatId]: { kind: 'chat', presentation: { collapsed: true, size: { width: 400, height: 160 }, toolWidths: { normal: 540 } } },
      [resourceId]: { kind: 'resource', presentation: { expanded: true, width: 320, height: 160 } },
    }
    const before = structuredClone(sourceViews)
    const b = fixture(source, sizes, sourceViews)
    fireEvent.click(b.view.getByRole('button', { name: 'Duplicate' }))
    await waitFor(() => { expect(b.view.getByLabelText('Clipboard pending').textContent).toBe('false') })
    const command = b.command.mock.calls[0]![0]
    if (command.kind !== 'add-subgraph') throw new Error('Expected graph copy command')
    expect(command.nodes[1]!.position.x - command.nodes[0]!.position.x).toBe(450)
    expect(b.applyViews).toHaveBeenCalledExactlyOnceWith([
      { nodeId: command.nodes[0]!.id, view: before[chatId] }, { nodeId: command.nodes[1]!.id, view: before[resourceId] },
    ])
    expect(sourceViews).toEqual(before)
    expect(command.nodes[0]!.position.x + 400).toBeLessThan(command.nodes[1]!.position.x)
  })

  it('reports denied access and ordinary text without changing the graph', async () => {
    const b = fixture()
    readText.mockRejectedValueOnce(new Error('Permission denied'))
    fireEvent.click(b.view.getByRole('button', { name: 'Paste' }))
    await waitFor(() => { expect(b.report).toHaveBeenLastCalledWith('clipboard.readFailed') })
    await waitFor(() => { expect(b.view.getByLabelText('Clipboard pending').textContent).toBe('false') })
    readText.mockResolvedValueOnce('ordinary clipboard text')
    fireEvent.click(b.view.getByRole('button', { name: 'Paste' }))
    await waitFor(() => { expect(b.report).toHaveBeenLastCalledWith('clipboard.invalid') })
    expect(b.command).not.toHaveBeenCalled()
    expect(b.select).not.toHaveBeenCalled()
    expect(b.reveal).not.toHaveBeenCalled()
  })

  it('allows only one clipboard operation while a native permission request is pending', async () => {
    const pending = deferredRead()
    const b = fixture()
    fireEvent.click(b.view.getByRole('button', { name: 'Paste' }))
    fireEvent.click(b.view.getByRole('button', { name: 'Paste' }))
    fireEvent.click(b.view.getByRole('button', { name: 'Duplicate' }))
    expect(readText).toHaveBeenCalledOnce()
    await act(async () => { pending.resolve(text); await pending.promise })
    expect(b.command).toHaveBeenCalledOnce()
  })
})
