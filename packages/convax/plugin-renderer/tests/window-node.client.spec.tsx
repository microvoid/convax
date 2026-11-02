// @vitest-environment jsdom
/** Window cards display retained captures without forwarding input to native applications. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import type { CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasWindowBindingId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { WindowMirror, WindowNode } from '../src/client/WindowNode.tsx'
import type { WindowMirrorProps } from '../src/client/window-contract.ts'
import { en, zh, NS, type ConvaxKey } from '../src/client/locales.ts'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as applyResources, inject as resourceInject } from '@deepseek-ai/dsh-client-resources/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { ConvaxRenderer } from '../src/client/node-renderers.tsx'
import type { CanvasNodeOwner } from '../src/client/props.ts'
import type { WindowMirrorState, WindowReconnectResult } from '../src/client/window-contract.ts'

vi.mock('@xyflow/react', () => ({
  NodeToolbar: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Position: { Left: 'left', Right: 'right', Top: 'top' }, useUpdateNodeInternals: () => () => {},
  Handle: () => <span />,
}))

afterEach(cleanup)

function fixture(available: boolean, live: boolean) {
  const nodeId = 'window-node' as CanvasNodeId
  const bindingId = 'a63cbf5a-bcaa-420b-b744-32496a769c72' as CanvasWindowBindingId
  const release = vi.fn()
  const props: WindowMirrorProps = {
    node: { id: nodeId, typeId: 'convax.window' as CanvasNodeTypeId, dataVersion: 1,
      data: { bindingId, name: 'Test document' }, revision: 0, position: { x: 0, y: 0 } },
    ports: [], selected: false, busy: false, resourceExpanded: true,
    useWindowMirrors: selector => selector(live ? {
      [bindingId]: { nodeId, name: 'Test document', status: 'live' },
    } : {}),
    canvasId: 'window-canvas' as CanvasId, canvasRevision: 1,
    definition: { id: 'convax.window' as CanvasNodeTypeId, dataVersion: 1, ports: [] },
    chat: undefined, focusSessionId: undefined, inputs: [], consumeFocus: vi.fn(),
    openResource: vi.fn(), openSource: vi.fn(),
    renderFactorySlot: () => null,
    useFactorySlot: () => { throw new Error('Window card does not render a local Factory slot') },
    useResource: () => { throw new Error('Window card does not read file resources') },
    useWorkspaces: () => { throw new Error('Window card does not read workspaces') },
    usePanelInfo: () => { throw new Error('Window card does not read panel selection') },
    useSessions: () => { throw new Error('Window card does not read the Session list') },
    useSessionStatus: () => { throw new Error('Window card does not read Session activity') },
    useSessionRetainInfo: () => { throw new Error('Window card does not read Session retainers') },
    useSessionAccess: () => false,
    useRemoteAccess: () => false,
    useWorkspaceAccess: () => false,
    mountWindow: vi.fn(() => release), validateWindow: vi.fn(async () => {}),
    reconnectWindow: vi.fn(async (): Promise<WindowReconnectResult> => 'connected'),
    focusNode: vi.fn(), remove: vi.fn(), createChat: vi.fn(), command: vi.fn(async () => true),
    setResourceExpanded: vi.fn(), setResourcePreviewSize: vi.fn(),
    ...(available ? { chooseWindow: vi.fn() } : {}),
    t: ((key: ConvaxKey, values?: Record<string, string | number>) =>
      en[key].replace(/\{(\w+)\}/g, (_match, name: string) => String(values?.[name] ?? ''))) as WindowMirrorProps['t'],
  }
  return { props, release, bindingId }
}

it('shows a clear platform placeholder instead of an enabled no-op reselect action', () => {
  const b = fixture(false, false)
  render(<WindowMirror {...b.props} />)
  expect(screen.getByRole('status').textContent).toContain('Window mirroring is available in macOS Desktop')
  const reselect = screen.getByRole('button', { name: 'Choose another window' })
  expect(reselect.hasAttribute('disabled')).toBe(true)
  expect(b.props.mountWindow).not.toHaveBeenCalled()
})

it('mounts a read-only view, validates on pointer return, and releases only its view on collapse', () => {
  const b = fixture(true, true)
  const view = render(<WindowMirror {...b.props} />)
  expect(screen.getByText('Read-only')).toBeDefined()
  expect(b.props.mountWindow).toHaveBeenCalledOnce()
  const body = view.container.querySelector('[data-convax-window-preview]')!
  fireEvent.pointerEnter(body)
  fireEvent.click(body)
  fireEvent.keyDown(body, { key: 'a' })
  expect(b.props.validateWindow).toHaveBeenCalled()
  expect(b.props.command).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
  expect(b.props.createChat).toHaveBeenCalledExactlyOnceWith(undefined, b.props.node.id)
  view.rerender(<WindowMirror {...b.props} resourceExpanded={false} />)
  expect(b.release).toHaveBeenCalledOnce()
  expect(view.container.querySelector('[data-convax-window-preview]')).toBeNull()
})

it('resizes a live mirror without remounting its capture and retains its expanded height while collapsed', () => {
  const b = fixture(true, true)
  const view = render(<WindowMirror {...b.props} resourcePreviewWidth={480} resourcePreviewHeight={270} />)
  const viewport = view.container.querySelector('[data-convax-window-preview] > div')
  const grip = screen.getByRole('button', { name: 'Resize preview' })
  fireEvent.keyDown(grip, { key: 'ArrowRight' })
  expect(b.props.setResourcePreviewSize).toHaveBeenLastCalledWith({ width: 490, height: 270 })
  view.rerender(<WindowMirror {...b.props} resourcePreviewWidth={490} resourcePreviewHeight={270} />)
  expect(view.container.querySelector('[data-convax-window-preview] > div')).toBe(viewport)
  expect(b.props.mountWindow).toHaveBeenCalledOnce()
  expect(b.release).not.toHaveBeenCalled()
  view.rerender(<WindowMirror {...b.props} resourceExpanded={false} resourcePreviewWidth={490} resourcePreviewHeight={270} />)
  expect(screen.getByRole('button', { name: 'Resize preview' })).toBe(grip)
  fireEvent.keyDown(grip, { key: 'ArrowRight' })
  expect(b.props.setResourcePreviewSize).toHaveBeenLastCalledWith({ width: 500, height: 270 })
  fireEvent.keyDown(grip, { key: 'ArrowDown' })
  expect(b.props.setResourcePreviewSize).toHaveBeenCalledTimes(2)
})

it('assembles the real window Factory without passing framework hooks as duplicate owner props', async () => {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const locale = new LocaleRuntime(runtime.ctx)
  locale.setLocale('en')
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.mount({ inject: [...resourceInject], apply: applyResources })
  const b = fixture(true, false)
  const states = createSnapshotStore<Readonly<Record<string, WindowMirrorState>>>({})
  await runtime.mount({
    inject: ['slots'],
    apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'test: window dictionaries')
      ctx.slots.registerFactory({ name: 'convax.window.content', scope: 'root', locale: NS,
        inject: () => ({ mountWindow: b.props.mountWindow, validateWindow: b.props.validateWindow,
          reconnectWindow: b.props.reconnectWindow, hooks: { windowMirrors: states } }),
      }, WindowMirror)
      new ConvaxRenderer(ctx).registerNodeRenderer('convax.window' as CanvasNodeTypeId, { dataVersion: 1, component: WindowNode })
    },
  })
  await runtime.declare({ 'convax.node': { kind: 'keyed', scope: 'root' } })
  const owner: CanvasNodeOwner = {
    node: b.props.node, canvasId: b.props.canvasId, canvasRevision: b.props.canvasRevision,
    definition: b.props.definition, ports: b.props.ports, selected: false, busy: false, chat: undefined,
    remove: b.props.remove, command: b.props.command, openResource: b.props.openResource, openSource: b.props.openSource,
    createChat: b.props.createChat, chooseWindow: b.props.chooseWindow, focusSessionId: undefined,
    consumeFocus: b.props.consumeFocus, inputs: [], focusNode: b.props.focusNode,
    resourceExpanded: true, setResourceExpanded: b.props.setResourceExpanded, setResourcePreviewSize: b.props.setResourcePreviewSize,
  }
  const view = runtime.renderSlot('convax.node', owner, { entryKey: 'convax.window' })
  expect(view.view.getByText('Test document')).toBeDefined()
  expect(view.view.getByText('Read-only')).toBeDefined()
  expect(view.view.getByRole('status').textContent).toContain('Window mirror disconnected')
})

it('reconnects the current binding without opening a replacement picker', async () => {
  const b = fixture(true, false)
  render(<WindowMirror {...b.props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
  await waitFor(() => { expect(b.props.reconnectWindow).toHaveBeenCalledExactlyOnceWith(b.props.node.id, b.props.node.data.bindingId) })
  expect(b.props.chooseWindow).not.toHaveBeenCalled()
})

it('requires explicit selection when the original runtime source is no longer retained', async () => {
  const b = fixture(true, false)
  vi.mocked(b.props.reconnectWindow).mockResolvedValue('selection-required')
  render(<WindowMirror {...b.props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
  await waitFor(() => { expect(b.props.chooseWindow).toHaveBeenCalledExactlyOnceWith(b.props.node.id) })
})

it('disables reconnect and replacement while a capture is connecting and retains actions after failure', () => {
  const b = fixture(true, false)
  const states = (status: WindowMirrorState['status']): WindowMirrorProps['useWindowMirrors'] => selector => selector({
    [b.bindingId]: { nodeId: b.props.node.id, name: 'Test document', status },
  })
  const view = render(<WindowMirror {...b.props} useWindowMirrors={states('connecting')} />)
  expect(screen.getByRole('status').textContent).toContain('Connecting…')
  expect(screen.getByRole('button', { name: 'Reconnect' }).hasAttribute('disabled')).toBe(true)
  for (const button of screen.getAllByRole('button', { name: 'Choose another window' })) expect(button.hasAttribute('disabled')).toBe(true)
  view.rerender(<WindowMirror {...b.props} useWindowMirrors={states('failed')} />)
  expect(screen.getByRole('alert').textContent).toContain('Could not reconnect')
  expect(screen.getByRole('button', { name: 'Reconnect' }).hasAttribute('disabled')).toBe(false)
})

it('does not repeat a pending reconnect or open its picker after the card unmounts', async () => {
  const b = fixture(true, false)
  const result = Promise.withResolvers<WindowReconnectResult>()
  vi.mocked(b.props.reconnectWindow).mockReturnValue(result.promise)
  const view = render(<WindowMirror {...b.props} />)
  const button = screen.getByRole('button', { name: 'Reconnect' })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(b.props.reconnectWindow).toHaveBeenCalledOnce()
  view.unmount()
  await act(async () => { result.resolve('selection-required') })
  expect(b.props.chooseWindow).not.toHaveBeenCalled()
})
