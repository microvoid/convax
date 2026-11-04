// @vitest-environment jsdom
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactFlowProps } from '@xyflow/react'
import type { CanvasId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { CanvasGraph, type CanvasGraphProps } from '../src/client/CanvasGraph.tsx'
import { en, type ConvaxKey } from '../src/client/locales.ts'

vi.mock('@xyflow/react', async (importOriginal) => {
  const original = await importOriginal<typeof import('@xyflow/react')>()
  const { useEffect } = await import('react')
  function DropSurface({ onInit, onDrop, onDragOver, onDragEnter }: ReactFlowProps) {
    const flow = original.useReactFlow()
    useEffect(() => { onInit?.(flow) }, [flow, onInit])
    return <div data-testid="pane" onDrop={onDrop} onDragOver={onDragOver} onDragEnter={onDragEnter}>
      <article data-convax-input-owner="chat"><input aria-label="Chat input" /></article>
    </div>
  }
  return {
    ...original,
    ReactFlow: (props: ReactFlowProps) => <original.ReactFlowProvider><DropSurface {...props} /></original.ReactFlowProvider>,
  }
})

afterEach(cleanup)

function fixture() {
  const addResources = vi.fn<CanvasGraphProps['addResources']>()
  const resolveFilePath = vi.fn((file: File) => `/project/${file.name}`)
  const props: CanvasGraphProps = {
    document: { id: 'canvas' as CanvasId, title: 'Board', revision: 0, nodes: [], connections: [] },
    chats: [], nodeTypes: [], nodeIssues: [], renderSlot: () => null,
    history: { canUndo: false, canRedo: false, pending: false }, replayHistory: vi.fn(),
    chatPresentations: {}, applyChatPresentation: vi.fn(), applyResourceView: vi.fn(),
    resourceViews: {}, setResourceExpanded: vi.fn(), setResourcePreviewSize: vi.fn(),
    createChat: vi.fn(), captureConnectionTarget: origin => origin, reportClipboard: vi.fn(), addProject: vi.fn(),
    threadFocus: undefined, consumeThreadFocus: vi.fn(),
    t: ((key: ConvaxKey) => en[key]) as CanvasGraphProps['t'],
    busy: false, viewport: undefined, setViewport: vi.fn(), inputMode: 'mouse', setInputMode: vi.fn(), command: vi.fn(async () => true),
    openResource: vi.fn(), openSource: vi.fn(), resolveFilePath, addResources,
  }
  render(<CanvasGraph {...props} />)
  return { addResources, resolveFilePath }
}

function transfer(files: File[] = [], path = '') {
  return {
    types: [...(files.length > 0 ? ['Files'] : []), ...(path !== '' ? ['application/x-convax-resource'] : [])],
    files, getData: (type: string) => type === 'application/x-convax-resource' ? path : '', dropEffect: 'none',
  }
}

function dispatch(target: Element, type: 'drop' | 'dragover', dataTransfer: ReturnType<typeof transfer>) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 71, clientY: 32 })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  fireEvent(target, event)
  return event
}

describe('Canvas file drops', () => {
  it('resolves every native file or folder synchronously and consumes the pane drop before document attachments', () => {
    const b = fixture()
    const files = [new File([], 'folder'), new File(['text'], 'file.txt')]
    const documentDrop = vi.fn()
    document.addEventListener('drop', documentDrop)
    onTestFinished(() => { document.removeEventListener('drop', documentDrop) })
    const dataTransfer = transfer(files)
    dispatch(screen.getByTestId('pane'), 'dragover', dataTransfer)
    expect(dataTransfer.dropEffect).toBe('copy')
    const event = dispatch(screen.getByTestId('pane'), 'drop', dataTransfer)
    expect(b.resolveFilePath.mock.calls.map(([file]) => file)).toEqual(files)
    expect(b.addResources).toHaveBeenCalledWith([
      { name: 'folder', path: '/project/folder' }, { name: 'file.txt', path: '/project/file.txt' },
    ], { x: 71, y: 32 })
    expect(event.defaultPrevented).toBe(true)
    expect(documentDrop).not.toHaveBeenCalled()
  })

  it('keeps the internal reference MIME authoritative when browser Files accompany it', () => {
    const b = fixture()
    dispatch(screen.getByTestId('pane'), 'drop', transfer([new File([], 'unrelated')], '/project/original.txt'))
    expect(b.addResources).toHaveBeenCalledWith([{ name: '/project/original.txt', path: '/project/original.txt' }], { x: 71, y: 32 })
    expect(b.resolveFilePath).not.toHaveBeenCalled()
  })

  it('preserves native-path lookup failures for visible workspace feedback', () => {
    const b = fixture()
    b.resolveFilePath.mockReturnValueOnce('').mockImplementationOnce(() => { throw new Error('Native path unavailable') })
    dispatch(screen.getByTestId('pane'), 'drop', transfer([new File([], 'virtual'), new File([], 'unreadable')]))
    expect(b.addResources).toHaveBeenCalledWith([
      { name: 'virtual', path: null }, { name: 'unreadable', path: null },
    ], { x: 71, y: 32 })
  })

  it('leaves a Chat input drop to the native composer without creating canvas references', () => {
    const b = fixture()
    const documentDrop = vi.fn()
    const documentDragOver = vi.fn()
    document.addEventListener('drop', documentDrop)
    document.addEventListener('dragover', documentDragOver)
    onTestFinished(() => {
      document.removeEventListener('drop', documentDrop)
      document.removeEventListener('dragover', documentDragOver)
    })
    const dataTransfer = transfer([new File([], 'chat-reference')])
    dispatch(screen.getByRole('textbox', { name: 'Chat input' }), 'dragover', dataTransfer)
    dispatch(screen.getByRole('textbox', { name: 'Chat input' }), 'drop', dataTransfer)
    expect(documentDrop).toHaveBeenCalledOnce()
    expect(documentDragOver).toHaveBeenCalledOnce()
    expect(b.resolveFilePath).not.toHaveBeenCalled()
    expect(b.addResources).not.toHaveBeenCalled()
  })
})
