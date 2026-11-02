// @vitest-environment jsdom
/** Window cards display retained captures without forwarding input to native applications. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import type { CanvasId, CanvasNodeId, CanvasNodeTypeId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { WindowMirror, WindowNode } from '../src/client/WindowNode.tsx'
import type { WindowMirrorProps } from '../src/client/window-contract.ts'
import { en, zh, NS, type ConvaxKey } from '../src/client/locales.ts'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as applyResources, inject as resourceInject } from '@deepseek-ai/dsh-client-resources/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { ConvaxRenderer } from '../src/client/node-renderers.tsx'
import type { CanvasNodeOwner } from '../src/client/props.ts'
import type { WindowMirrorState } from '../src/client/window-contract.ts'

vi.mock('@xyflow/react', () => ({
  NodeToolbar: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Position: { Left: 'left', Right: 'right', Top: 'top' }, useUpdateNodeInternals: () => () => {},
  Handle: () => <span />,
}))

afterEach(cleanup)

function fixture(available: boolean, live: boolean) {
  const nodeId = 'window-node' as CanvasNodeId
  const bindingId = 'a63cbf5a-bcaa-420b-b744-32496a769c72'
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
    focusNode: vi.fn(), remove: vi.fn(), createChat: vi.fn(), command: vi.fn(async () => true),
    setResourceExpanded: vi.fn(), setResourcePreviewSize: vi.fn(),
    ...(available ? { chooseWindow: vi.fn() } : {}),
    t: ((key: ConvaxKey, values?: Record<string, string | number>) =>
      en[key].replace(/\{(\w+)\}/g, (_match, name: string) => String(values?.[name] ?? ''))) as WindowMirrorProps['t'],
  }
  return { props, release }
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
        inject: () => ({ mountWindow: b.props.mountWindow, validateWindow: b.props.validateWindow, hooks: { windowMirrors: states } }),
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
  expect(view.view.getByRole('status').textContent).toContain('Reselect the window to resume its mirror')
})
