// @vitest-environment jsdom
/** Connection-end callbacks retain the temporary line and captured creation target until cancellation or selection. */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Position, type InternalNode, type OnConnectEnd, type ReactFlowProps } from '@xyflow/react'
import type { CanvasId, CanvasNodeId, CanvasNodeTypeId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CanvasConnectionOrigin } from '../src/client/props.ts'
import { CanvasGraph, type CanvasGraphProps } from '../src/client/CanvasGraph.tsx'
import { connectionDropPoint, isBlankConnectionTarget } from '../src/client/connection-creation.ts'
import { en, type ConvaxKey } from '../src/client/locales.ts'

const callbacks = vi.hoisted(() => ({ current: undefined as ReactFlowProps | undefined }))
vi.mock('@xyflow/react', async (importOriginal) => {
  const original = await importOriginal<typeof import('@xyflow/react')>()
  return { ...original, ReactFlow: (props: ReactFlowProps) => {
    callbacks.current = props
    return <original.ReactFlow {...props} />
  } }
})

const SOURCE = 'source' as CanvasNodeId
const TYPE = 'fixture.reference' as CanvasNodeTypeId
beforeEach(() => {
  callbacks.current = undefined
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(900)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(700)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(700)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 900, 700))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function fixture() {
  const captureConnectionTarget = vi.fn<CanvasGraphProps['captureConnectionTarget']>(origin => ({
    ...origin, targetSession: { sessionId: 'original-thread' as SessionId },
  }))
  const props: CanvasGraphProps = {
    document: { id: 'connection-create' as CanvasId, title: 'Board', revision: 1, connections: [], nodes: [{
      id: SOURCE, typeId: TYPE, position: { x: 40, y: 80 }, revision: 1, dataVersion: 1, data: {},
    }] },
    chats: [], nodeTypes: [{ id: TYPE, dataVersion: 1, ports: [] }], nodeIssues: [], renderSlot: () => <article>Reference</article>,
    history: { canUndo: false, canRedo: false, pending: false }, replayHistory: vi.fn(),
    chatPresentations: {}, applyChatPresentation: vi.fn(), applyResourceView: vi.fn(),
    resourceViews: {}, setResourceExpanded: vi.fn(), setResourcePreviewSize: vi.fn(),
    createChat: vi.fn(), captureConnectionTarget, reportClipboard: vi.fn(), addProject: vi.fn(),
    threadFocus: undefined, consumeThreadFocus: vi.fn(),
    t: ((key: ConvaxKey) => en[key]) as CanvasGraphProps['t'],
    busy: false, viewport: { x: 0, y: 0, zoom: 1 }, setViewport: vi.fn(),
    command: vi.fn(async () => true), openResource: vi.fn(), openSource: vi.fn(), resolveFilePath: file => `/host/${file.name}`, addResources: vi.fn(),
    inputMode: 'mouse', setInputMode: vi.fn(),
  }
  const view = render(<CanvasGraph {...props} />)
  await waitFor(() => { expect(callbacks.current?.onConnectStart).toBeTypeOf('function') })
  const pane = view.container.querySelector<HTMLElement>('.react-flow__pane')!
  const start = (direction: 'input' | 'output' = 'output'): CanvasConnectionOrigin => {
    act(() => { callbacks.current?.onConnectStart?.(new MouseEvent('mousedown'), {
      nodeId: SOURCE, handleId: direction, handleType: direction === 'output' ? 'source' : 'target',
    }) })
    const result = captureConnectionTarget.mock.results.at(-1)
    if (result?.type !== 'return') throw new Error('Connection target was not captured')
    return result.value
  }
  const drop = (direction: 'input' | 'output' = 'output', target: Element = pane, valid = false) => {
    const userNode = callbacks.current!.nodes![0]!
    const fromNode: InternalNode = { ...userNode, measured: { width: 160, height: 80 },
      internals: { positionAbsolute: userNode.position, z: 0, userNode } }
    const state: Parameters<OnConnectEnd>[1] = {
      isValid: valid, from: { x: 200, y: 120 }, fromNode, fromPosition: direction === 'output' ? Position.Right : Position.Left,
      fromHandle: { id: direction, nodeId: SOURCE, x: 160, y: 40, width: 6, height: 6, position: Position.Right,
        type: direction === 'output' ? 'source' : 'target' },
      to: { x: 450, y: 300 }, toHandle: null, toNode: null, toPosition: null, pointer: { x: 450, y: 300 },
    }
    const event = new MouseEvent('mouseup', { bubbles: true, clientX: 450, clientY: 300 })
    act(() => { target.dispatchEvent(event); callbacks.current?.onConnectEnd?.(event, state) })
  }
  return { view, props, pane, start, drop, captureConnectionTarget }
}

describe('Connection creation in blank canvas space', () => {
  it('retains an output line and forwards the captured origin when creating Chat', async () => {
    const b = await fixture()
    const origin = b.start()
    b.drop()
    const preview = b.view.container.querySelector('[data-convax-connection-preview]')!
    expect(preview.getAttribute('data-origin-direction')).toBe('output')
    expect(preview.getAttribute('d')).toContain('M')
    expect(b.props.command).not.toHaveBeenCalled()
    fireEvent.click(b.view.getByRole('menuitem', { name: 'New chat' }))
    expect(b.props.createChat).toHaveBeenCalledExactlyOnceWith(undefined, undefined, { x: 450, y: 300 }, origin)
    expect(b.captureConnectionTarget).toHaveBeenCalledOnce()
    expect(b.view.container.querySelector('[data-convax-connection-preview]')).toBeNull()
  })

  it('retains input direction and its original thread through asynchronous file selection', async () => {
    const b = await fixture()
    const origin = b.start('input')
    b.drop('input')
    fireEvent.click(b.view.getByRole('menuitem', { name: 'Add files' }))
    expect(b.view.container.querySelector('[data-convax-connection-preview]')).toBeNull()
    const picker = b.view.container.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(picker, { target: { files: [new File(['notes'], 'notes.txt')] } })
    expect(b.props.addResources).toHaveBeenCalledExactlyOnceWith([{ name: 'notes.txt', path: '/host/notes.txt' }], { x: 450, y: 300 }, origin)
    expect(origin.direction).toBe('input')
    expect(origin.targetSession?.sessionId).toBe('original-thread')
  })

  it.each(['Escape', 'outside', 'blur'] as const)('cancels a dropped line with %s without mutation', async (method) => {
    const b = await fixture()
    b.start()
    b.drop()
    if (method === 'Escape') fireEvent.keyDown(document.body, { key: 'Escape' })
    else if (method === 'blur') fireEvent(window, new Event('blur'))
    else fireEvent.pointerDown(b.pane)
    expect(b.view.container.querySelector('[data-convax-connection-preview]')).toBeNull()
    expect(b.view.queryByRole('menu')).toBeNull()
    expect(b.props.command).not.toHaveBeenCalled()
    expect(b.props.createChat).not.toHaveBeenCalled()
  })

  it('does not offer creation after Escape cancels an active drag or over a node body', async () => {
    const b = await fixture()
    b.start()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    b.drop()
    expect(b.view.queryByRole('menu')).toBeNull()
    b.start()
    b.drop('output', b.view.container.querySelector('.react-flow__node')!)
    expect(b.view.queryByRole('menu')).toBeNull()
    expect(b.props.command).not.toHaveBeenCalled()
  })

  it('keeps valid connections on the existing command path and never opens creation', async () => {
    const b = await fixture()
    b.start()
    act(() => { callbacks.current?.onConnect?.({ source: SOURCE, sourceHandle: 'output', target: 'target', targetHandle: 'input' }) })
    b.drop('output', b.pane, true)
    expect(b.view.queryByRole('menu')).toBeNull()
    expect(b.props.command).toHaveBeenCalledOnce()
    const command = vi.mocked(b.props.command).mock.calls[0]?.[0]
    if (command?.kind !== 'add-connection') throw new Error('Expected a connection command')
    expect(command.connection.id).toBeTypeOf('string')
    expect(command.connection).toEqual({
      id: command.connection.id, source: SOURCE, sourcePort: 'output', target: 'target', targetPort: 'input', purpose: 'input',
    })
  })

  it('clears a cancelled file origin before another normal file intake', async () => {
    const b = await fixture()
    b.start('input')
    b.drop('input')
    fireEvent.click(b.view.getByRole('menuitem', { name: 'Add files' }))
    const picker = b.view.container.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent(picker, new Event('cancel'))
    fireEvent.change(picker, { target: { files: [new File(['normal'], 'normal.txt')] } })
    expect(b.props.addResources).toHaveBeenCalledExactlyOnceWith([{ name: 'normal.txt', path: '/host/normal.txt' }], { x: 450, y: 300 })
  })

  it('reads final mouse coordinates and excludes card controls from blank-space admission', async () => {
    const b = await fixture()
    expect(connectionDropPoint(new MouseEvent('mouseup', { clientX: 72, clientY: 91 }))).toEqual({ x: 72, y: 91 })
    expect(isBlankConnectionTarget(b.view.container.querySelector('[data-convax-graph]')!, b.pane)).toBe(true)
    expect(isBlankConnectionTarget(b.view.container.querySelector('[data-convax-graph]')!, b.view.getByRole('button', { name: 'Add files' }))).toBe(false)
  })
})
