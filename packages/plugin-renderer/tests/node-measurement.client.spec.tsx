// @vitest-environment jsdom
/** Measured canvas nodes stay visible while their controlled data refreshes. */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { useStore as useFlowStore } from '@xyflow/react'
import type { CanvasId, CanvasNodeId, CanvasNodeTypeId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { CanvasGraph, type CanvasGraphProps } from '../src/client/CanvasGraph.tsx'
import { en, type ConvaxKey } from '../src/client/locales.ts'

const NODE_ID = 'measured-node' as CanvasNodeId
const NODE_TYPE = 'example.editor' as CanvasNodeTypeId

/** Observe the real React Flow dimensions beside an editable node surface. */
function NodeContent() {
  const size = useFlowStore(state => state.nodeLookup.get(NODE_ID)?.measured)
  return <article>
    <input aria-label="Node draft" className="nodrag nopan nowheel" />
    <output aria-label="Measured node size">{size?.width ?? 0} × {size?.height ?? 0}</output>
  </article>
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function fixture() {
  const dimensions = { width: 620, height: 360 }
  const observers: ControlledResizeObserver[] = []
  class ControlledResizeObserver implements ResizeObserver {
    readonly targets = new Set<Element>()
    constructor(private readonly callback: ResizeObserverCallback) { observers.push(this) }
    observe(target: Element): void { this.targets.add(target) }
    unobserve(target: Element): void { this.targets.delete(target) }
    disconnect(): void { this.targets.clear() }
    deliver(target: Element): void {
      if (!this.targets.has(target)) throw new Error('The node must be observed before delivering its dimensions')
      const rect = target.getBoundingClientRect()
      const size = { inlineSize: rect.width, blockSize: rect.height }
      this.callback([{ target, contentRect: rect,
        borderBoxSize: [size], contentBoxSize: [size], devicePixelContentBoxSize: [size],
      }], this)
    }
  }
  vi.stubGlobal('ResizeObserver', ControlledResizeObserver)
  vi.stubGlobal('DOMMatrixReadOnly', class { readonly m22 = 1 })
  const sizeOf = (target: HTMLElement) => target.classList.contains('react-flow__node') ? dimensions : { width: 900, height: 700 }
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) { return sizeOf(this).width })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return sizeOf(this).height })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(700)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const size = sizeOf(this)
    return new DOMRect(0, 0, size.width, size.height)
  })
  const props: CanvasGraphProps = {
    document: { id: 'measurement-canvas' as CanvasId, title: 'Board', revision: 1, connections: [], nodes: [{
      id: NODE_ID, typeId: NODE_TYPE, dataVersion: 1, data: {}, position: { x: 40, y: 80 }, revision: 1,
    }] },
    chats: [], nodeTypes: [{ id: NODE_TYPE, dataVersion: 1, ports: [] }], nodeIssues: [],
    renderSlot: () => <NodeContent />,
    history: { canUndo: false, canRedo: false, pending: false }, replayHistory: vi.fn(),
    chatPresentations: {}, applyChatPresentation: vi.fn(), applyResourceView: vi.fn(),
    resourceViews: {}, setResourceExpanded: vi.fn(), setResourcePreviewSize: vi.fn(),
    createChat: vi.fn(), captureConnectionTarget: origin => origin, reportClipboard: vi.fn(), addProject: vi.fn(),
    threadFocus: undefined, consumeThreadFocus: vi.fn(),
    t: ((key: ConvaxKey) => en[key]) as CanvasGraphProps['t'],
    busy: false, viewport: { x: 0, y: 0, zoom: 1 }, setViewport: vi.fn(),
    command: vi.fn(async () => true), openResource: vi.fn(), openSource: vi.fn(), resolveFilePath: vi.fn(), addResources: vi.fn(),
    inputMode: 'mouse', setInputMode: vi.fn(),
  }
  const view = render(<CanvasGraph {...props} />)
  const node = view.container.querySelector<HTMLElement>(`[data-id="${NODE_ID}"]`)
  if (node === null) throw new Error('Expected the real React Flow node wrapper')
  await waitFor(() => { expect(observers.some(observer => observer.targets.has(node))).toBe(true) })
  const observer = observers.find(observer => observer.targets.has(node))
  if (observer === undefined) throw new Error('Expected the node ResizeObserver')
  act(() => { observer.deliver(node) })
  await waitFor(() => { expect(node.style.visibility).toBe('visible') })
  expect(view.getByLabelText('Measured node size').textContent).toBe('620 × 360')
  const hiddenStyles: string[] = []
  const styles = new MutationObserver((records) => {
    for (const record of records) {
      if (/visibility:\s*hidden/u.test(record.oldValue ?? '')) hiddenStyles.push(record.oldValue ?? '')
    }
    if (node.style.visibility === 'hidden') hiddenStyles.push(node.getAttribute('style') ?? '')
  })
  styles.observe(node, { attributes: true, attributeFilter: ['style'], attributeOldValue: true })
  onTestFinished(() => { styles.disconnect() })
  return { view, node, props, observer, dimensions, hiddenStyles }
}

it.each(['selection', 'props refresh', 'Host revision'] as const)('keeps a measured editor visible through %s without waiting for another resize', async (change) => {
  const b = await fixture()
  const editor = b.view.getByRole('textbox', { name: 'Node draft' })
  if (change === 'selection') fireEvent.click(b.node)
  else if (change === 'props refresh') b.view.rerender(<CanvasGraph {...b.props} nodeIssues={[]} />)
  else b.view.rerender(<CanvasGraph {...b.props} document={{
    ...b.props.document, revision: 2,
    nodes: b.props.document.nodes.map(node => ({ ...node, revision: 2, data: { title: 'Updated title' } })),
  }} />)
  await act(async () => {})
  expect(b.view.container.querySelector(`[data-id="${NODE_ID}"]`)).toBe(b.node)
  expect(b.node.style.visibility).toBe('visible')
  expect(b.view.getByRole('textbox', { name: 'Node draft' })).toBe(editor)
  expect(b.view.getByLabelText('Measured node size').textContent).toBe('620 × 360')
  expect(b.hiddenStyles).toEqual([])
})

it('accepts later ResizeObserver dimensions while preserving the measured node and editor', async () => {
  const b = await fixture()
  const editor = b.view.getByRole('textbox', { name: 'Node draft' })
  b.dimensions.width = 700
  b.dimensions.height = 520
  await act(async () => { b.observer.deliver(b.node) })
  await waitFor(() => { expect(b.view.getByLabelText('Measured node size').textContent).toBe('700 × 520') })
  b.view.rerender(<CanvasGraph {...b.props} nodeIssues={[]} />)
  expect(b.view.getByRole('textbox', { name: 'Node draft' })).toBe(editor)
  expect(b.node.style.visibility).toBe('visible')
  expect(b.hiddenStyles).toEqual([])
})

it('measures a deleted and recreated node instead of reusing the removed node dimensions', async () => {
  const b = await fixture()
  b.view.rerender(<CanvasGraph {...b.props} document={{ ...b.props.document, revision: 2, nodes: [] }} />)
  await waitFor(() => { expect(b.view.container.querySelector(`[data-id="${NODE_ID}"]`)).toBeNull() })
  b.dimensions.width = 480
  b.dimensions.height = 240
  b.view.rerender(<CanvasGraph {...b.props} document={{ ...b.props.document, revision: 3 }} />)
  const replacement = b.view.container.querySelector<HTMLElement>(`[data-id="${NODE_ID}"]`)
  if (replacement === null) throw new Error('Expected the recreated React Flow node')
  expect(replacement).not.toBe(b.node)
  expect(replacement.style.visibility).toBe('hidden')
  await waitFor(() => { expect(b.observer.targets.has(replacement)).toBe(true) })
  act(() => { b.observer.deliver(replacement) })
  await waitFor(() => { expect(b.view.getByLabelText('Measured node size').textContent).toBe('480 × 240') })
  expect(replacement.style.visibility).toBe('visible')
})
