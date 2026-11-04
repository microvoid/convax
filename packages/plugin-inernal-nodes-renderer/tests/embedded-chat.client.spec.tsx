// @vitest-environment jsdom
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { SlotTestRuntime, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { apply as applyConversation, inject as conversationInject, type ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { apply as applyChat, inject as chatInject } from '@deepseek-ai/dsh-client-ui-chat/client'
import { apply as applyPresets, inject as presetInject } from '@deepseek-ai/dsh-client-ui-agent-preset/client'
import { apply as applyResources, inject as resourceInject } from '@deepseek-ai/dsh-client-resources/client'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { CanvasChat, CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasNodeTypeInfo } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { ReactNode } from 'react'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import { createSidebarRightStore } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/stores.ts'
import { ChatCard, ChatHeader, ChatSession, ChatThread, ChatTools, ChatViews } from '../src/client/ChatCard.tsx'
import { ChatSettings } from '../src/client/ChatSettings.tsx'
import { createChatViewStore } from '@deepseek-ai/dsh-convax-plugin-renderer/client'
import { createThreadProvider } from '../src/client/thread-resource.ts'
import { NS, en, zh } from '@deepseek-ai/dsh-convax-plugin-renderer/client'
import { ConvaxRenderer } from '@deepseek-ai/dsh-convax-plugin-renderer/client'
import { ChatNode } from '../src/client/nodes.tsx'

vi.mock('@xyflow/react', () => ({ NodeToolbar: ({ children, role, 'aria-label': label }: { children: ReactNode; role?: 'toolbar'; 'aria-label'?: string }) => <div role={role} aria-label={label}>{children}</div>, Handle: () => null, Position: { Left: 'left', Right: 'right', Top: 'top' }, useUpdateNodeInternals: () => () => {} }))

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear() })

function ToolsProbe(props: FactoryComponentPropsOf<'sidebar.right.embedded'>) {
  return <div data-tools-session={props.sessionId} data-tools-active={props.active} />
}

function TrajectoryProbe({ sessionId }: ConvViewProps) {
  return <output data-trajectory-session={sessionId}>Trajectory content</output>
}

describe('Convax embedded Conversation compatibility', () => {
  it('renders independent retained Sessions through the native embedded Conversation and Chat plugins', async () => {
    const rangeRect = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect')
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect() })
    onTestFinished(() => {
      if (rangeRect === undefined) Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect')
      else Object.defineProperty(Range.prototype, 'getBoundingClientRect', rangeRect)
    })
    const fonts = Object.getOwnPropertyDescriptor(document, 'fonts')
    Object.defineProperty(document, 'fonts', { configurable: true, value: new EventTarget() })
    onTestFinished(() => {
      if (fonts === undefined) Reflect.deleteProperty(document, 'fonts')
      else Object.defineProperty(document, 'fonts', fonts)
    })
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    })
    const runtime = await SlotTestRuntime.create()
    onTestFinished(() => runtime.dispose())
    const openSession = vi.fn()
    const openWorkspace = vi.fn()
    runtime.ctx.provide('uiWorkspace', { openSession, openWorkspace } as never)
    const toolsSettings = stubConfigForm<{ enabled: boolean }>()
    toolsSettings.publish({ status: 'ready', value: { enabled: true } })
    const presetSettings = stubConfigForm<{ default: string }>()
    presetSettings.publish({ status: 'ready', value: { default: 'standard' } })
    runtime.ctx.provide('configForms', {
      developerTools: { enabled: createSnapshotStore(true) },
      get: (namespace: string) => namespace === 'ui-settings' ? toolsSettings.scope : presetSettings.scope,
    } as never)
    runtime.ctx.provide('connection', { state: createSnapshotStore('connected') } as never)
    runtime.ctx.provide('layout', { openRightbar: vi.fn(), closeRightbar: vi.fn() } as never)
    runtime.ctx.provide('sidebarRight', { openResource: vi.fn(), openTab: vi.fn() } as never)
    runtime.ctx.provide('sidebarRightTabs', {
      register: () => () => {}, get: () => undefined, subscribe: () => () => {},
    } as never)
    runtime.ctx.provide('fileDrag', {
      actions: { prepare: async () => ({ start: () => true, release: () => {} }), reportFailure: () => {} },
      read: () => undefined,
    })
    const selectPreset = vi.fn(async (_id: SessionId, agentPreset: string) => ({ ok: true as const, value: agentPreset }))
    const updateSettings = vi.fn()
    runtime.remote.provideNamespaces({
      session: { openWorkspacePath: vi.fn() },
      agentPresets: {
        list: async () => ({ ok: true as const, value: { presets: [
          { id: 'standard', isDefault: true }, { id: 'ptc', isDefault: false },
        ] } }),
        select: selectPreset,
      },
      settings: { update: updateSettings },
    })
    const locale = new LocaleRuntime(runtime.ctx)
    locale.setLocale('en')
    runtime.ctx.provide('locale', locale)
    runtime.slots.installLocale(locale)
    const sessionId = 'existing-convax-conversation' as SessionId
    const prompt = vi.fn()
    await runtime.sessions.add({
      id: sessionId,
      summary: { title: 'Existing conversation', displayTitle: 'Existing conversation', cwd: '/project/first', projectionValues: { agentPreset: 'standard' } },
      session: { prompt },
      events: [{
        type: 'event',
        event: {
          type: 'user/message', seq: 1 as SessionSeq, time: 1, surfaceOp: 'append',
          data: { id: 'existing-message' as never, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Existing canvas conversation' }] },
        },
      }],
    })
    const secondId = 'second-convax-conversation' as SessionId
    await runtime.sessions.add({
      id: secondId,
      summary: { title: 'Independent conversation', displayTitle: 'Independent conversation', cwd: '/project/second', projectionValues: { agentPreset: 'standard' } },
      events: [{ type: 'event', event: {
        type: 'user/message', seq: 1 as SessionSeq, time: 1, surfaceOp: 'append',
        data: { id: 'second-message' as never, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Independent canvas conversation' }] },
      } }],
    })
    const alternateId = 'alternate-convax-conversation' as SessionId
    await runtime.sessions.add({ id: alternateId, summary: { title: 'Alternate thread', displayTitle: 'Alternate thread' } })
    const blankId = 'blank-convax-conversation' as SessionId
    await runtime.sessions.add({
      id: blankId, summary: { blank: true, cwd: '/project/blank', projectionValues: { agentPreset: 'standard' } }, snapshot: { blank: true },
    })
    const chats: CanvasChat[] = [sessionId, secondId, blankId].map((id, index) => ({
      canvasId: 'independent-chats' as CanvasId, nodeId: `chat-${index}` as CanvasNodeId,
      title: `Project ${index}`, cwd: '/project', deleting: false, issue: null,
      threads: [{ sessionId: id, parentSessionId: null, inheritedEventCount: 0 }],
    }))
    chats[0]!.threads.push({ sessionId: alternateId, parentSessionId: null, inheritedEventCount: 0 })
    const definition: CanvasNodeTypeInfo = {
      id: 'convax.chat' as CanvasNodeTypeId, dataVersion: 1,
      ports: [{ id: 'input', direction: 'input', valueKind: 'resource' }, { id: 'output', direction: 'output', valueKind: 'resource' }],
    }
    await runtime.root.declare({
      main: { kind: 'keyed', scope: 'root' },
      'shell.overlay': { kind: 'list', scope: 'root' },
      'settings.general.item': { kind: 'list', scope: 'root' },
      'conversation.approval.detail': { kind: 'single', scope: 'session' },
      'convax.node': { kind: 'keyed', scope: 'root' },
    }, ({ renderSlot }) => (
      <div data-testid="convax-compatibility-proof">
        {chats.map(chat => <div key={chat.nodeId}>{renderSlot('convax.node', {
          chat, canvasRevision: 1, inputs: [], focusNode: () => {}, remove: () => {}, consumeFocus: () => {},
          node: {
            id: chat.nodeId, typeId: definition.id, dataVersion: 1, data: { title: chat.title, cwd: chat.cwd },
            position: { x: 0, y: 0 }, revision: 1,
          },
          definition, canvasId: chat.canvasId, ports: definition.ports,
          selected: false, busy: false, focusSessionId: undefined,
          resourceExpanded: false, setResourceExpanded: () => {}, setResourcePreviewSize: () => {},
          command: async () => true, openResource: () => {}, openSource: () => {}, createChat: () => {},
        }, { entryKey: definition.id })}</div>)}
      </div>
    ))
    await runtime.mount({ inject: [...resourceInject], apply: applyResources })
    await runtime.mount({ inject: [...conversationInject], apply: applyConversation })
    await runtime.mount({ inject: [...chatInject], apply: applyChat })
    await runtime.mount({ inject: [...presetInject], apply: applyPresets })
    const createThread = vi.fn(async () => ({
      ok: false as const, code: 'operation-pending' as const, message: 'pending',
      workspace: { revision: 1, canvases: [], chats, nodeTypes: [], nodeIssues: [] },
    }))
    await runtime.mount({
      inject: ['slots', 'resources'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'test: Convax dictionaries')
        ctx.effect(() => ctx.resources.register(createThreadProvider(ctx.sessions)), 'test: Convax thread provider')
        new ConvaxRenderer(ctx).registerNodeRenderer(definition.id, { dataVersion: 1, component: ChatNode })
        ctx.slots.register({ name: 'conversation.view', id: 'trajectory', label: 'Trajectory' }, TrajectoryProbe)
        ctx.slots.registerFactory({
          name: 'convax.chat.content', scope: 'root', locale: NS, store: createChatViewStore(),
          children: {
            'convax.chat.header': { kind: 'single', scope: 'session' },
            'convax.chat.views': { kind: 'single', scope: 'session' },
          },
          inject: () => ({
            bindInput: () => () => {}, focusSession: () => {}, acknowledgeCompletion: () => {},
            createThread,
            ensureInitialThread: (request, stage) => { stage(request); return createThread() },
          }),
        }, ChatCard)
        ctx.slots.register({ name: 'convax.chat.header' }, ChatHeader)
        ctx.slots.register({ name: 'convax.chat.views' }, ChatViews)
        ctx.slots.registerFactory({
          name: 'convax.chat.settings', scope: 'session', locale: NS,
        }, ChatSettings)
        ctx.slots.registerFactory({
          name: 'convax.chat.thread', scope: 'root', locale: NS,
          children: {
            'convax.chat.session': { kind: 'single', scope: 'session' },
            'convax.chat.tools': { kind: 'single', scope: 'session' },
          },
        }, ChatThread)
        ctx.slots.registerFactory({
          name: 'sidebar.right.embedded', scope: 'session',
          store: createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' })),
          inject: () => ({ mount: () => () => {}, retainTab: () => () => {} }),
        }, ToolsProbe)
        ctx.slots.register({ name: 'convax.chat.session' }, ChatSession)
        ctx.slots.register({ name: 'convax.chat.tools' }, ChatTools)
      },
    })
    const view = runtime.renderRoot()
    await waitFor(() => { expect(view.getByText('Existing canvas conversation')).toBeDefined() })
    expect(view.getByText('Independent canvas conversation')).toBeDefined()
    expect(view.container.querySelectorAll('[data-conversation-content]')).toHaveLength(3)
    expect(view.container.querySelector('[data-conversation-content]')?.getAttribute('data-conversation-session')).toBe(sessionId)
    for (const content of view.container.querySelectorAll('[data-conversation-content]')) {
      const transcript = content.querySelector('[data-conversation-scroll]')!
      const composer = content.querySelector('[data-composer-seat]')!
      expect(transcript.contains(composer)).toBe(false)
      expect(transcript.nextElementSibling).toBe(composer)
      expect(composer.closest('[data-convax-chat]')).toBe(content.closest('[data-convax-chat]'))
    }
    expect(prompt).not.toHaveBeenCalled()
    expect(openSession).not.toHaveBeenCalled()
    const blankBody = view.container.querySelector<HTMLElement>(`[data-conversation-session="${blankId}"]`)!
    await waitFor(() => { expect(within(blankBody).getByRole('textbox').getAttribute('contenteditable')).toBe('true') })
    expect(within(blankBody).queryByRole('button', { name: 'Choose workspace' })).toBeNull()
    expect(view.queryByRole('button', { name: /Working directory:/ })).toBeNull()
    expect(view.queryByRole('button', { name: /connected inputs/ })).toBeNull()
    expect(createThread).not.toHaveBeenCalled()
    expect(openWorkspace).not.toHaveBeenCalled()
    expect(openSession).not.toHaveBeenCalled()
    const conversation = runtime.ctx.get('conversation')!
    const firstInput = conversation.input.for(runtime.sessions.binding(sessionId)!.ctx)
    const secondInput = conversation.input.for(runtime.sessions.binding(secondId)!.ctx)
    const blankInput = conversation.input.for(runtime.sessions.binding(blankId)!.ctx)
    act(() => {
      firstInput.setDraft('first thread draft')
      secondInput.setDraft('second thread draft')
      blankInput.setDraft('blank thread draft')
    })
    const firstChat = view.container.querySelector<HTMLElement>(`[data-convax-chat="${chats[0]!.nodeId}"]`)!
    const blankMode = await within(blankBody).findByRole('button', { name: 'Agent mode: Standard mode' })
    fireEvent.click(blankMode)
    fireEvent.click(view.getByRole('menuitem', { name: /^PTC mode/ }))
    await waitFor(() => { expect(selectPreset).toHaveBeenCalledExactlyOnceWith(blankId, 'ptc') })
    await runtime.sessions.updateSummary(blankId, { projectionValues: { agentPreset: 'ptc' } })
    await within(blankBody).findByRole('button', { name: 'Agent mode: PTC mode' })
    expect(within(firstChat).getByRole('button', { name: 'Agent mode: Standard mode' })).toBeDefined()
    expect(blankInput.state.getSnapshot().draft).toBe('blank thread draft')
    expect(updateSettings).not.toHaveBeenCalled()
    const titleRow = firstChat.querySelector<HTMLElement>('[data-convax-chat-drag]')!
    expect(titleRow.querySelector('[data-conversation-header-toolbar]')).not.toBeNull()
    expect(titleRow.querySelectorAll('[role="tablist"]')).toHaveLength(1)
    expect(titleRow.querySelector('[data-conversation-tabs]')).toBeNull()
    expect(within(titleRow).queryByText(chats[0]!.title)).toBeNull()
    expect(firstChat.querySelector('[data-conversation-content] [data-conversation-header-toolbar]')).toBeNull()
    const toolbar = within(firstChat).getByRole('toolbar', { name: `Actions for ${chats[0]!.title}` })
    expect(within(toolbar).queryByRole('button', { name: 'Conversation actions' })).toBeNull()
    const settingsAnchor = within(titleRow).getByRole('button', { name: 'Current thread actions' })
    fireEvent.click(settingsAnchor)
    fireEvent.click(view.getByRole('menuitem', { name: 'Conversation settings' }))
    await waitFor(() => { expect(view.getByRole('dialog', { name: 'Conversation settings' })).toBeTruthy() })
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await waitFor(() => { expect(view.queryByRole('dialog', { name: 'Conversation settings' })).toBeNull() })
    expect(document.activeElement).toBe(settingsAnchor)
    const originalEditor = firstChat.querySelector(`[data-conversation-session="${sessionId}"] [data-composer-input]`)
    const originalTools = firstChat.querySelector(`[data-tools-session="${sessionId}"]`)
    fireEvent.click(within(titleRow).getByRole('button', { name: 'Current thread actions' }))
    expect(view.getByRole('menuitem', { name: 'Chat' }).getAttribute('aria-current')).toBe('page')
    fireEvent.click(view.getByRole('menuitem', { name: 'Trajectory' }))
    await waitFor(() => { expect(firstChat.querySelector(`[data-trajectory-session="${sessionId}"]`)).not.toBeNull() })
    expect(view.queryByRole('menuitem', { name: 'Trajectory' })).toBeNull()
    expect(view.getByText('Independent canvas conversation')).toBeDefined()
    expect(firstChat.querySelector(`[data-conversation-session="${sessionId}"] [data-composer-input]`)).toBe(originalEditor)
    fireEvent.click(within(firstChat).getByRole('tab', { name: 'Alternate thread' }))
    await waitFor(() => { expect(firstChat.querySelector(`[data-tools-session="${alternateId}"]`)).not.toBeNull() })
    fireEvent.click(within(titleRow).getByRole('button', { name: 'Current thread actions' }))
    expect(view.getByRole('menuitem', { name: 'Chat' }).getAttribute('aria-current')).toBe('page')
    fireEvent.click(view.getByRole('menuitem', { name: 'Chat' }))
    expect(firstChat.querySelector(`[data-conversation-session="${sessionId}"] [data-composer-input]`)).toBe(originalEditor)
    expect(originalTools?.getAttribute('data-tools-active')).toBe('false')
    fireEvent.click(within(firstChat).getByRole('tab', { name: 'Existing conversation' }))
    fireEvent.click(within(titleRow).getByRole('button', { name: 'Current thread actions' }))
    expect(view.getByRole('menuitem', { name: 'Trajectory' }).getAttribute('aria-current')).toBe('page')
    fireEvent.click(view.getByRole('menuitem', { name: 'Chat' }))
    await waitFor(() => { expect(within(firstChat).getByText('Existing canvas conversation')).toBeDefined() })
    expect(firstChat.querySelector(`[data-tools-session="${sessionId}"]`)).toBe(originalTools)
    expect(originalTools?.getAttribute('data-tools-active')).toBe('true')
    expect(firstInput.state.getSnapshot().draft).toBe('first thread draft')
    fireEvent.click(within(firstChat).getByRole('button', { name: 'Agent mode: Standard mode' }))
    expect(view.getByText('This conversation has started. Choose a mode to start another conversation.')).toBeDefined()
    fireEvent.click(view.getByRole('menuitem', { name: /^New conversation in PTC mode/ }))
    await waitFor(() => { expect(createThread).toHaveBeenCalledOnce() })
    expect(createThread.mock.calls[0]).toEqual([expect.objectContaining({
      kind: 'create', nodeId: chats[0]!.nodeId, agentPreset: 'ptc',
    })])
    expect(selectPreset).toHaveBeenCalledExactlyOnceWith(blankId, 'ptc')
    expect(firstChat.querySelector(`[data-conversation-session="${sessionId}"] [data-composer-input]`)).toBe(originalEditor)
    expect(firstInput.state.getSnapshot().draft).toBe('first thread draft')
    expect(updateSettings).not.toHaveBeenCalled()
    view.unmount()
    await waitFor(() => { expect(runtime.sessions.retainInfo(sessionId).getSnapshot().retainedBy.convaxChat).toBeUndefined() })
    expect(runtime.sessions.retainInfo(secondId).getSnapshot().retainedBy.convaxChat).toBeUndefined()
    expect(runtime.sessions.binding(sessionId)).toBeDefined()
    expect(runtime.sessions.binding(secondId)).toBeDefined()
    expect(firstInput.state.getSnapshot().draft).toBe('first thread draft')
    expect(secondInput.state.getSnapshot().draft).toBe('second thread draft')
  })
})
