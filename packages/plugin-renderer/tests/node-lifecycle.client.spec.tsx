// @vitest-environment jsdom
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, within } from '@testing-library/react'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as applyResources, inject as resourceInject } from '@deepseek-ai/dsh-client-resources/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CanvasDocument, CanvasNodeIssue, CanvasNodeTypeId, CanvasNodeTypeInfo, CanvasNodeId, CanvasId, CanvasConnectionId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { ReactFlowProps } from '@xyflow/react'
import type { ReactNode } from 'react'
import { CanvasGraph } from '../src/client/CanvasGraph.tsx'
import { ConvaxRenderer, NodePorts } from '../src/client/node-renderers.tsx'
import { ResourceNode } from '@deepseek-ai/dsh-convax-plugin-inernal-nodes-renderer/client'
import type { CanvasNodeRendererProps } from '../src/client/props.ts'
import { NS, en, zh } from '../src/client/locales.ts'

vi.mock('@xyflow/react', () => ({
  ReactFlowProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useStore: () => () => {},
  ViewportPortal: ({ children }: { children: ReactNode }) => <>{children}</>,
  Background: () => null, NodeToolbar: ({ children, role, 'aria-label': label }: { children: ReactNode; role?: 'toolbar'; 'aria-label'?: string }) => <div role={role} aria-label={label}>{children}</div>, Position: { Left: 'left', Right: 'right', Top: 'top' },
  useUpdateNodeInternals: () => () => {},
  Handle: ({ id, type, isConnectable }: { id: string; type: string; isConnectable: boolean }) =>
    <span data-port-id={id} data-port-direction={type} data-connectable={isConnectable} />,
  ReactFlow: ({ nodes = [], edges = [], nodeTypes, onNodeDragStop }: ReactFlowProps) => <>
    {nodes.map((node) => {
      const Component = nodeTypes?.[node.type ?? 'default']
      return <div key={node.id} data-testid={`node-${node.id}`} data-position={JSON.stringify(node.position)}>
        {Component !== undefined && <Component id={node.id} data={node.data} type={node.type ?? 'default'}
          dragging={false} isConnectable draggable selectable deletable selected={node.selected ?? false}
          zIndex={0} positionAbsoluteX={node.position.x} positionAbsoluteY={node.position.y} />}
        <button type="button" onClick={() => { onNodeDragStop?.(new MouseEvent('mouseup'), node, [{ ...node, position: { x: 350, y: 220 } }]) }}>Move {node.id}</button>
      </div>
    })}
    {edges.map(edge => <output key={edge.id} data-testid={`edge-${edge.id}`}>{JSON.stringify(edge)}</output>)}
  </>,
}))

afterEach(() => { cleanup(); localStorage.clear() })

const customType = 'example.note' as CanvasNodeTypeId
const noteId = 'saved-note' as CanvasNodeId
const fileId = 'working-file' as CanvasNodeId
const canvasId = 'saved-canvas' as CanvasId
const customDefinition: CanvasNodeTypeInfo = {
  id: customType, dataVersion: 1, ports: [{ id: 'notes', direction: 'output', valueKind: 'resource' }],
}
const document: CanvasDocument = {
  id: canvasId, title: 'Saved board', revision: 7,
  nodes: [{
    id: noteId, typeId: customType, dataVersion: 1,
    data: { title: 'Saved extension content', nested: { values: ['kept', 4, null] } },
    position: { x: -45, y: 90 }, revision: 3,
  }, {
    id: fileId, typeId: 'convax.file' as CanvasNodeTypeId, dataVersion: 1,
    data: { path: '/project/working.txt' }, position: { x: 450, y: 120 }, revision: 2,
  }],
  connections: [{
    id: 'retained-edge' as CanvasConnectionId, source: noteId, sourcePort: 'legacy-notes',
    target: fileId, targetPort: 'input', purpose: 'input',
  }],
}

interface Scenario {
  document: CanvasDocument
  nodeTypes: CanvasNodeTypeInfo[]
  nodeIssues: CanvasNodeIssue[]
}

async function fixture(nodeTypes: CanvasNodeTypeInfo[] = []) {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const locale = new LocaleRuntime(runtime.ctx)
  locale.setLocale('en')
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.mount({ inject: [...resourceInject], apply: applyResources })
  const source = createSnapshotStore<Scenario>({
    document: structuredClone(document), nodeTypes: [{
      id: 'convax.file' as CanvasNodeTypeId, dataVersion: 1,
      ports: [{ id: 'input', direction: 'input', valueKind: 'resource' }],
    }, ...nodeTypes], nodeIssues: [],
  })
  const command = vi.fn(async () => true)
  const openResource = vi.fn()
  const setResourcePreviewSize = vi.fn()
  await runtime.mount({
    inject: ['slots'],
    apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'test: node dictionaries')
      const registry = new ConvaxRenderer(ctx)
      registry.registerNodeRenderer('convax.file' as CanvasNodeTypeId, { dataVersion: 1, component: ResourceNode })
      ctx.slots.inject('shell.workspace', () => ctx.slots.register({
        name: 'shell.workspace', locale: NS,
        children: { 'convax.node': { kind: 'keyed', scope: 'root' } },
        inject: () => ({ hooks: { scenario: source } }),
      }, (props: PropsRuntime<'shell.workspace'> & PropsLocale<'convax'> & PropsRenderSlots<'convax.node'> & InjectFace<{ hooks: { scenario: typeof source } }>) => {
        const snapshot = props.useScenario(value => value)
        return <CanvasGraph {...snapshot} chats={[]} renderSlot={props.renderSlot} t={props.t}
          createChat={() => {}} captureConnectionTarget={origin => origin} reportClipboard={() => {}}
          threadFocus={undefined} consumeThreadFocus={() => {}}
          busy={false} viewport={undefined} setViewport={() => {}} inputMode="mouse" setInputMode={() => {}} command={command}
          history={{ canUndo: false, canRedo: false, pending: false }} replayHistory={() => {}}
          chatPresentations={{}} applyChatPresentation={() => {}} applyResourceView={() => {}}
          resourceViews={{}} setResourceExpanded={() => {}} setResourcePreviewSize={setResourcePreviewSize}
          openResource={openResource} openSource={() => {}} resolveFilePath={() => ''} addResources={() => {}} addProject={() => {}} />
      }))
    },
  })
  const mountDisplay = async (dataVersion = 1) => {
    const render = vi.fn((props: CanvasNodeRendererProps) => <article>
      <NodePorts nodeId={props.node.id} ports={props.ports} connectable={!props.busy} />
      <span>{typeof props.node.data.title === 'string' ? props.node.data.title : ''}</span>
    </article>)
    const handle = await runtime.mount({
      inject: ['convaxRenderer'],
      apply(ctx) { ctx.convaxRenderer.registerNodeRenderer(customType, { dataVersion, component: render }) },
    })
    return { handle, render }
  }
  await runtime.declare({ 'shell.workspace': { kind: 'single', scope: 'root' } })
  return { runtime, source, command, openResource, setResourcePreviewSize, mountDisplay }
}

describe('Convax node display lifecycle', () => {
  it('retains missing-provider payloads, positions and named connections while allowing movement and deletion', async () => {
    const b = await fixture()
    const display = await b.mountDisplay()
    const view = b.runtime.renderSlot('shell.workspace', {})
    const note = view.view.getByTestId(`node-${noteId}`)
    expect(within(note).getByRole('status').textContent).toContain('Node plugin unavailable')
    expect(display.render).not.toHaveBeenCalled()
    expect(note.getAttribute('data-position')).toBe(JSON.stringify(document.nodes[0]!.position))
    expect(note.querySelector('[data-port-id="legacy-notes"]')?.getAttribute('data-connectable')).toBe('false')
    expect(view.view.getByTestId('edge-retained-edge').textContent).toContain('legacy-notes')
    fireEvent.keyDown(within(note).getByRole('button', { name: 'Resize preview' }), { key: 'ArrowRight' })
    expect(b.setResourcePreviewSize).toHaveBeenCalledExactlyOnceWith(noteId, { width: 330, height: 160 })
    fireEvent.click(view.view.getByRole('button', { name: `Move ${noteId}` }))
    expect(b.command).toHaveBeenCalledWith({ kind: 'move-nodes', nodes: [{ id: noteId, position: { x: 350, y: 220 } }] })
    fireEvent.click(within(note).getByRole('button', { name: 'Remove reference' }))
    expect(b.command).toHaveBeenCalledWith({ kind: 'remove-nodes', nodeIds: [noteId] })
    fireEvent.click(view.view.getByRole('button', { name: 'Expand preview' }))
    expect(b.openResource).toHaveBeenCalledWith(expect.objectContaining({ path: '/project/working.txt' }))
    expect(b.source.getSnapshot().document).toEqual(document)

    act(() => { b.source.update((state) => { state.nodeTypes.push(customDefinition) }) })
    expect(within(note).getByText('Saved extension content')).toBeDefined()
    expect(b.source.getSnapshot().document.nodes[0]?.data).toEqual(document.nodes[0]?.data)
    expect(note.getAttribute('data-position')).toBe(JSON.stringify(document.nodes[0]!.position))
    act(() => { b.source.update((state) => { state.nodeTypes = state.nodeTypes.filter(type => type.id !== customType) }) })
    expect(within(note).getByRole('status').textContent).toContain('Node plugin unavailable')
    act(() => { b.source.update((state) => { state.nodeTypes.push(customDefinition) }) })
    expect(within(note).getByText('Saved extension content')).toBeDefined()
    expect(b.source.getSnapshot().document).toEqual(document)
  })

  it('keeps a working Host definition independent from client display unload and reload', async () => {
    const b = await fixture([customDefinition])
    const view = b.runtime.renderSlot('shell.workspace', {})
    const note = view.view.getByTestId(`node-${noteId}`)
    expect(within(note).getByRole('status').textContent).toContain('Node display unavailable')
    const display = await b.mountDisplay()
    expect(within(note).getByText('Saved extension content')).toBeDefined()
    await display.handle.dispose()
    expect(within(note).getByRole('status').textContent).toContain('Node display unavailable')
    expect(b.source.getSnapshot().nodeTypes).toContainEqual(customDefinition)
    await b.mountDisplay()
    expect(within(note).getByText('Saved extension content')).toBeDefined()
    expect(b.command).not.toHaveBeenCalled()
    expect(b.source.getSnapshot().document).toEqual(document)
  })

  it('does not give incompatible or migrating payloads to business renderers', async () => {
    const b = await fixture([{ ...customDefinition, dataVersion: 2 }])
    const display = await b.mountDisplay()
    const view = b.runtime.renderSlot('shell.workspace', {})
    const note = view.view.getByTestId(`node-${noteId}`)
    expect(within(note).getByRole('status').textContent).toContain('Node data is incompatible')
    expect(display.render).not.toHaveBeenCalled()
    act(() => { b.source.update((state) => {
      state.nodeIssues = [{ canvasId, nodeId: noteId, kind: 'migrating', message: 'Version upgrade pending' }]
    }) })
    expect(within(note).getByRole('status').textContent).toContain('Updating node')
    expect(display.render).not.toHaveBeenCalled()
    act(() => { b.source.update((state) => {
      state.nodeTypes[1] = customDefinition
      state.nodeIssues = [{ canvasId, nodeId: noteId, kind: 'incompatible', message: 'Payload upgrade failed' }]
    }) })
    expect(within(note).getByText('Payload upgrade failed')).toBeDefined()
    expect(display.render).not.toHaveBeenCalled()
    act(() => { b.source.update((state) => { state.nodeIssues = [] }) })
    expect(within(note).getByText('Saved extension content')).toBeDefined()
    expect(b.source.getSnapshot().document).toEqual(document)
  })

  it('requires the Client display to support the exact Host-compatible payload version', async () => {
    const b = await fixture([{ ...customDefinition, dataVersion: 2 }])
    act(() => { b.source.update((state) => { state.document.nodes[0]!.dataVersion = 2 }) })
    const display = await b.mountDisplay(1)
    const view = b.runtime.renderSlot('shell.workspace', {})
    expect(within(view.view.getByTestId(`node-${noteId}`)).getByRole('status').textContent).toContain('Node display is incompatible')
    expect(display.render).not.toHaveBeenCalled()
    await display.handle.dispose()
    await b.mountDisplay(2)
    expect(view.view.getByText('Saved extension content')).toBeDefined()
  })

  it('rejects duplicate displays and releases explicitly disposed registrations once', async () => {
    const b = await fixture([customDefinition])
    const display = await b.mountDisplay()
    const view = b.runtime.renderSlot('shell.workspace', {})
    expect(() => b.runtime.ctx.convaxRenderer.registerNodeRenderer(customType, {
      dataVersion: 1, component: display.render,
    })).toThrow('already registered')
    await display.handle.dispose()
    const remove = b.runtime.ctx.convaxRenderer.registerNodeRenderer(customType, {
      dataVersion: 1, component: display.render,
    })
    act(() => { remove(); remove() })
    expect(within(view.view.getByTestId(`node-${noteId}`)).getByRole('status').textContent).toContain('Node display unavailable')
    expect(b.source.getSnapshot().document).toEqual(document)
  })
})
