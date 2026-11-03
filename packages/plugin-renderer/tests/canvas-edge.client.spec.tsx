// @vitest-environment jsdom
/** Connection actions exercise React Flow's real hover, selection, and edge-label seats. */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { Handle, Position } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasConnectionId, CanvasId, CanvasNodeId, CanvasNodeTypeId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { CanvasGraph, type CanvasGraphProps } from '../src/client/CanvasGraph.tsx'
import { en, type ConvaxKey } from '../src/client/locales.ts'

const SOURCE = 'source' as CanvasNodeId
const FIRST = 'first' as CanvasNodeId
const SECOND = 'second' as CanvasNodeId
const TYPE = 'fixture.reference' as CanvasNodeTypeId
const FIRST_EDGE = 'first-edge' as CanvasConnectionId
const SECOND_EDGE = 'second-edge' as CanvasConnectionId

const observers: ControlledResizeObserver[] = []
class ControlledResizeObserver implements ResizeObserver {
  readonly targets = new Set<Element>()
  constructor(private readonly callback: ResizeObserverCallback) { observers.push(this) }
  observe(target: Element): void { this.targets.add(target) }
  unobserve(target: Element): void { this.targets.delete(target) }
  disconnect(): void { this.targets.clear() }
  deliver(target: Element): void {
    const contentRect = target.getBoundingClientRect()
    const size = { inlineSize: contentRect.width, blockSize: contentRect.height }
    this.callback([{ target, contentRect, borderBoxSize: [size], contentBoxSize: [size], devicePixelContentBoxSize: [size] }], this)
  }
}

beforeEach(() => {
  observers.length = 0
  vi.stubGlobal('ResizeObserver', ControlledResizeObserver)
  vi.stubGlobal('DOMMatrixReadOnly', class { readonly m22 = 1 })
  const sizeOf = (element: HTMLElement) => element.classList.contains('react-flow__node')
    ? { width: 160, height: 80 } : { width: 900, height: 700 }
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) { return sizeOf(this).width })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return sizeOf(this).height })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(700)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const size = sizeOf(this)
    return new DOMRect(0, 0, size.width, size.height)
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function fixture() {
  const command = vi.fn<CanvasGraphProps['command']>(async () => true)
  const props: CanvasGraphProps = {
    document: {
      id: 'connections-canvas' as CanvasId, title: 'Board', revision: 1,
      nodes: [SOURCE, FIRST, SECOND].map((id, index) => ({
        id, typeId: TYPE, dataVersion: 1, data: {}, position: { x: index === 0 ? 40 : 400, y: index * 150 + 40 }, revision: 1,
      })),
      connections: [FIRST_EDGE, SECOND_EDGE].map((id, index) => ({
        id, source: SOURCE, target: index === 0 ? FIRST : SECOND, sourcePort: 'output', targetPort: 'input', purpose: 'input',
      })),
    },
    chats: [], nodeTypes: [{ id: TYPE, dataVersion: 1, ports: [
      { id: 'input', direction: 'input', valueKind: 'reference' }, { id: 'output', direction: 'output', valueKind: 'reference' },
    ] }], nodeIssues: [],
    renderSlot: () => <article>
      <Handle id="input" type="target" position={Position.Left} />Reference
      <Handle id="output" type="source" position={Position.Right} />
    </article>,
    history: { canUndo: false, canRedo: false, pending: false }, replayHistory: vi.fn(),
    chatPresentations: {}, applyChatPresentation: vi.fn(), applyResourceView: vi.fn(),
    resourceViews: {}, setResourceExpanded: vi.fn(), setResourcePreviewSize: vi.fn(),
    createChat: vi.fn(), captureConnectionTarget: origin => origin, reportClipboard: vi.fn(), addProject: vi.fn(),
    threadFocus: undefined, consumeThreadFocus: vi.fn(),
    t: ((key: ConvaxKey) => en[key]) as CanvasGraphProps['t'],
    busy: false, viewport: { x: 0, y: 0, zoom: 1 }, setViewport: vi.fn(),
    command, openResource: vi.fn(), openSource: vi.fn(), resolveFilePath: vi.fn(), addResources: vi.fn(),
    inputMode: 'mouse', setInputMode: vi.fn(),
  }
  const view = render(<CanvasGraph key={props.document.id} {...props} />)
  const nodes = await waitFor(() => {
    const mounted = [...view.container.querySelectorAll<HTMLElement>('.react-flow__node')]
    expect(mounted).toHaveLength(props.document.nodes.length)
    expect(mounted.every(node => observers.some(observer => observer.targets.has(node)))).toBe(true)
    return mounted
  })
  await waitFor(() => { expect(view.container.querySelector('[data-canvas-gestures-ready]')).not.toBeNull() })
  act(() => { for (const node of nodes) observers.find(observer => observer.targets.has(node))!.deliver(node) })
  const edge = (id = FIRST_EDGE) => {
    const element = view.container.querySelector<SVGGElement>(`[data-convax-edge="${id}"]`)
    if (element === null) throw new Error(`Missing rendered connection: ${id}`)
    return element
  }
  await waitFor(() => { expect(edge()).toBeDefined() })
  const wrapper = (id = FIRST_EDGE) => edge(id).closest<SVGGElement>('.react-flow__edge')!
  const cut = (id = FIRST_EDGE) => {
    const button = view.container.querySelector<HTMLButtonElement>(`[data-convax-edge-cut="${id}"]`)
    if (button === null) throw new Error(`Missing midpoint action: ${id}`)
    return button
  }
  const graph = view.container.querySelector<HTMLElement>('[data-convax-graph]')!
  const press = (target: Parameters<typeof fireEvent>[0], options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Delete', ...options })
    fireEvent(target, event)
    return event
  }
  return { props, command, view, graph, edge, wrapper, cut, press }
}

describe('Canvas connection actions', () => {
  it('reveals the midpoint action on hover and deletes only the hovered connection', async () => {
    const b = await fixture()
    expect(b.edge().hasAttribute('data-active')).toBe(false)
    fireEvent.pointerEnter(b.edge())
    expect(b.edge().hasAttribute('data-hovered')).toBe(true)
    expect(b.cut().getAttribute('aria-label')).toBe('Cut connection')
    expect(b.cut().disabled).toBe(false)
    expect({
      hovered: b.edge().hasAttribute('data-hovered'), selected: b.edge().hasAttribute('data-selected'),
      active: b.edge().hasAttribute('data-active'), midpointAction: b.cut().getAttribute('aria-label'),
    }).toMatchSnapshot('hovered connection tools')
    const event = b.press(document.body)
    expect(event.defaultPrevented).toBe(true)
    expect(b.command).toHaveBeenCalledExactlyOnceWith({ kind: 'remove-connections', connectionIds: [FIRST_EDGE] })
    expect(b.edge()).toBeDefined()
  })

  it('clears hover on leave and deletes the selected connection with Backspace', async () => {
    const b = await fixture()
    fireEvent.pointerEnter(b.edge())
    fireEvent.pointerLeave(b.edge())
    expect(b.press(document.body).defaultPrevented).toBe(false)
    expect(b.command).not.toHaveBeenCalled()
    fireEvent.click(b.wrapper())
    expect(b.edge().hasAttribute('data-selected')).toBe(true)
    b.wrapper().focus()
    expect(b.press(b.wrapper(), { key: 'Backspace' }).defaultPrevented).toBe(true)
    expect(b.command).toHaveBeenCalledExactlyOnceWith({ kind: 'remove-connections', connectionIds: [FIRST_EDGE] })
  })

  it('gives the hovered connection precedence over another selected connection', async () => {
    const b = await fixture()
    fireEvent.click(b.wrapper())
    fireEvent.pointerEnter(b.edge(SECOND_EDGE))
    b.press(document.body)
    expect(b.command).toHaveBeenCalledExactlyOnceWith({ kind: 'remove-connections', connectionIds: [SECOND_EDGE] })
  })

  it('cuts through the focusable midpoint button without changing node selection', async () => {
    const b = await fixture()
    fireEvent.click(b.wrapper())
    const button = b.cut()
    button.focus()
    expect(document.activeElement).toBe(button)
    fireEvent.click(button, { detail: 0 })
    expect(b.command).toHaveBeenCalledExactlyOnceWith({ kind: 'remove-connections', connectionIds: [FIRST_EDGE] })
    expect(b.view.container.querySelector('.react-flow__node.selected')).toBeNull()
  })

  it('keeps the cut action available while the pointer crosses from the curve to its midpoint', async () => {
    const b = await fixture()
    fireEvent.pointerEnter(b.edge())
    fireEvent(b.edge(), new MouseEvent('pointerout', { bubbles: true, relatedTarget: b.cut() }))
    expect(b.edge().hasAttribute('data-hovered')).toBe(true)
    fireEvent.pointerEnter(b.cut().parentElement!.parentElement!)
    fireEvent.pointerLeave(b.cut().parentElement!.parentElement!)
    expect(b.edge().hasAttribute('data-hovered')).toBe(false)
  })

  it('does not turn a touch pointer entering the curve into a hover target', async () => {
    const b = await fixture()
    const event = new MouseEvent('pointerover', { bubbles: true })
    Object.defineProperty(event, 'pointerType', { value: 'touch' })
    fireEvent(b.edge(), event)
    expect(b.edge().hasAttribute('data-hovered')).toBe(false)
    expect(b.press(document.body).defaultPrevented).toBe(false)
    expect(b.command).not.toHaveBeenCalled()
  })

  it('sends a single cut while the Host mutation is pending and permits a retry after failure', async () => {
    const b = await fixture()
    let finish: (saved: boolean) => void = () => { throw new Error('Mutation has not started') }
    const pending = new Promise<boolean>((resolve) => { finish = resolve })
    b.command.mockReturnValueOnce(pending)
    fireEvent.pointerEnter(b.edge())
    fireEvent.click(b.cut())
    fireEvent.click(b.cut())
    expect(b.press(document.body).defaultPrevented).toBe(false)
    expect(b.command).toHaveBeenCalledOnce()
    await act(async () => { finish(false); await pending })
    fireEvent.click(b.cut())
    expect(b.command).toHaveBeenCalledTimes(2)
  })

  it('preserves visible connections after a rejected mutation and removes them only after the Host update', async () => {
    const b = await fixture()
    b.command.mockResolvedValueOnce(false)
    fireEvent.pointerEnter(b.edge())
    fireEvent.click(b.cut())
    await act(async () => {})
    expect(b.edge()).toBeDefined()
    fireEvent.click(b.cut())
    expect(b.command).toHaveBeenCalledTimes(2)
    b.view.rerender(<CanvasGraph key={b.props.document.id} {...b.props} document={{
      ...b.props.document, revision: 2, connections: b.props.document.connections.filter(connection => connection.id !== FIRST_EDGE),
    }} />)
    await waitFor(() => { expect(b.view.container.querySelector(`[data-convax-edge="${FIRST_EDGE}"]`)).toBeNull() })
    expect(b.edge(SECOND_EDGE)).toBeDefined()
  })

  it('keeps busy connections visible and blocks keyboard, button, and double-click mutations', async () => {
    const b = await fixture()
    fireEvent.pointerEnter(b.edge())
    b.view.rerender(<CanvasGraph key={b.props.document.id} {...b.props} busy />)
    expect(b.cut().disabled).toBe(true)
    expect(b.press(document.body).defaultPrevented).toBe(false)
    fireEvent.click(b.cut())
    fireEvent.doubleClick(b.wrapper())
    expect(b.command).not.toHaveBeenCalled()
    expect(b.edge()).toBeDefined()
  })

  it('leaves editing controls, dialogs, modifiers, and repeated keys to their owners', async () => {
    const b = await fixture()
    fireEvent.pointerEnter(b.edge())
    const controls: HTMLElement[] = [document.createElement('input'), document.createElement('textarea'),
      document.createElement('select'), document.createElement('button')]
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    editable.tabIndex = 0
    controls.push(editable)
    for (const role of ['slider', 'dialog']) {
      const control = document.createElement('div')
      control.setAttribute('role', role)
      control.tabIndex = 0
      controls.push(control)
    }
    b.graph.append(...controls)
    for (const control of controls) {
      control.focus()
      expect(b.press(control).defaultPrevented, control.outerHTML).toBe(false)
      expect(b.press(document.body).defaultPrevented, control.outerHTML).toBe(false)
    }
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    for (const options of [{ repeat: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }]) {
      expect(b.press(document.body, options).defaultPrevented).toBe(false)
    }
    expect(b.command).not.toHaveBeenCalled()
  })

  it('leaves Delete outside the canvas alone even while a connection remains hovered', async () => {
    const b = await fixture()
    fireEvent.pointerEnter(b.edge())
    const outside = document.createElement('button')
    b.view.container.append(outside)
    outside.focus()
    expect(b.press(outside).defaultPrevented).toBe(false)
    expect(b.press(document.body).defaultPrevented).toBe(false)
    expect(b.command).not.toHaveBeenCalled()
  })

  it('clears transient connection targeting when a different canvas mounts', async () => {
    const b = await fixture()
    fireEvent.click(b.wrapper())
    fireEvent.pointerEnter(b.edge())
    const documentId = 'another-canvas' as CanvasId
    b.view.rerender(<CanvasGraph key={documentId} {...b.props} document={{ ...b.props.document, id: documentId }} />)
    expect(b.press(document.body).defaultPrevented).toBe(false)
    expect(b.command).not.toHaveBeenCalled()
  })
})
