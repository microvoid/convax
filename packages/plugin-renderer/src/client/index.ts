/** Canvas kernel: graph state, reversible registrations and workspace presentation. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-general/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-shortcuts/client'
import contribution from '@deepseek-ai/dsh-convax-plugin-host/remote'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import { hostPathForFile } from './desktop-paths.ts'
import { ConvaxWorkspace } from './Workspace.tsx'
import { createCanvasViewStore } from './store.ts'
import { NS, dictionaries } from './locales.ts'
import type { WorkspaceInjected } from './props.ts'
import { ConvaxRenderer } from './node-renderers.tsx'
import { defaultCanvasInputMode } from './input-mode.ts'
import { CanvasGraphSurface } from './CanvasGraphSurface.tsx'
import { CanvasActivity } from './activity.ts'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { NoticeOverlay } from './notices/NoticeOverlay.tsx'
import type { NoticeOverlayInjected } from './notices/NoticeOverlay.tsx'
import { NoticeRuntime } from './notices/runtime.ts'
import { BrowserNoticeEnvironment, NoticeUpdateUnavailableError } from './notices/browser.ts'
import type { NoticeClientId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { DesktopUpdateBridge } from '@deepseek-ai/dsh-client-ui-settings-general/types'

export type { CanvasNodeRendererDefinition, IConvaxRenderer } from './node-renderers.tsx'
export type { CanvasNodeOwner, CanvasNodeRendererProps, CanvasChatPresentation, CanvasChatThreadOwner,
  ChatInjected, ChatProps, ChatSessionProps, ChatHeaderProps, ChatSettingsProps, ChatViewsProps,
  ChatThreadProps, ChatToolsProps, ChatResizeControls, ChatToolsLayout, CanvasConnectionOrigin, CanvasGraphOwner, WorkspaceInjected, WorkspaceProps } from './props.ts'
export type { CanvasCreationDefinition, CanvasCreationContext, CanvasRendererSnapshot, CanvasWorkspaceActions } from './contributions.ts'
export { ConvaxRenderer, NodePorts, NodePlaceholder } from './node-renderers.tsx'
export { CanvasHandle, CanvasHandlePosition, useCanvasNodeLayout } from './canvas-render-primitives.tsx'
export { CardToolbar } from './CardToolbar.tsx'
export { DiagnosticDetails } from './DiagnosticDetails.tsx'
export { CardResizeHandle } from './CardResizeHandle.tsx'
export { resourceAddress, resourcePath } from './resources.ts'
export type { ConvaxKey } from './locales.ts'
export { NS, dictionaries, en, zh } from './locales.ts'
export { createCanvasViewStore, createChatViewStore } from './store.ts'
export { ConvaxWorkspace } from './Workspace.tsx'
export { RESOURCE_CARD_WIDTH, RESOURCE_CARD_GAP, CHAT_CARD_WIDTH } from './placement.ts'
export { AUDIO_PREVIEW_HEIGHT, RESOURCE_MIN_PREVIEW_HEIGHT, RESOURCE_PREVIEW_HEIGHT, resizeResource } from './resource-size.ts'
export type { ResourceSize } from './resource-size.ts'
export { CHAT_MIN_WIDTH, CHAT_MIN_HEIGHT, resizeChat } from './chat-size.ts'
export type { ChatSize } from './chat-size.ts'
export { orderedChatThreads } from './thread-order.ts'
export { useTabReorder } from './use-tab-reorder.ts'

/** Kernel dependencies do not include node-specific Conversation or capture services. */
export const inject = ['remote', 'slots', 'locale', 'resources', 'settingsNavigation', 'pluginNavigation',
  'sessions', 'uiSession', 'shortcuts']

function isAborted(signal: AbortSignal): boolean { return signal.aborted }

/** Mount the authoritative graph feed and the workspace; node plugins contribute independently. */
export async function apply(ctx: Context): Promise<void> {
  await ctx.effect(async () => await ctx.remote.$mount(contribution), 'convax: Remote contribution')
  ctx.inject(['remote.convax', 'remote.session'], (scope) => {
    const renderer = new ConvaxRenderer(scope)
    scope.effect(() => scope.locale.register(NS, dictionaries), 'convax: dictionaries')
    const remote = scope.remote
    const convex = remote.convax
    const streams = new Set<{ dispose(): Promise<void> }>()
    const lifetime = new AbortController()
    scope.effect(() => async () => {
      lifetime.abort()
      await Promise.all([...streams].map(stream => stream.dispose()))
    }, 'convax: workspace stream disposal')
    let restart = (): void => {}
    const activity = new CanvasActivity()
    scope.inject(['remote.convaxNotices'], (noticeScope) => {
      const carrier = (globalThis as typeof globalThis & {
        dshDesktop?: { protocolVersion: number; updates?: DesktopUpdateBridge }
      }).dshDesktop
      const t = noticeScope.locale.bind(NS)
      const environment = new BrowserNoticeEnvironment({ document, window,
        running: () => [...noticeScope.uiSession.sessionStatus.getSnapshot().values()]
          .some(status => status.running === true || status.pendingInteraction !== undefined),
        capabilities: () => ['convax.canvas', ...Object.keys(renderer.getSnapshot().definitions)],
        updates: carrier?.protocolVersion === 1 ? carrier.updates : undefined,
      })
      const notices = new NoticeRuntime({ remote: noticeScope.remote.convaxNotices,
        clientId: randomUUID() as NoticeClientId, environment,
        actionFailed: error => t(error instanceof NoticeUpdateUnavailableError ? 'notices.updateUnavailable' : 'notices.actionFailed'),
        report: (error) => { noticeScope.logger.warn('Convax notice operation failed', error) },
      })
      noticeScope.effect(() => {
        void notices.start().catch((error: unknown) => { noticeScope.logger.warn('Convax notice observation could not start', error) })
        return () => notices.dispose()
      }, 'convax: window notice lifetime')
      noticeScope.slots.inject('shell.overlay', () => noticeScope.slots.register({
        name: 'shell.overlay', id: 'convax.notices', locale: NS,
        inject: (): NoticeOverlayInjected => ({ hooks: { notice: notices.state },
          shown: (id) => { notices.shown(id) }, close: (id) => { notices.close(id) },
          action: (id, actionId) => { notices.action(id, actionId) }, expired: (id) => { notices.expired(id) },
        }),
      }, NoticeOverlay))
    })
    const observeActivity = (): void => {
      const workspace = renderer.workspace.getSnapshot()
      if (workspace !== undefined) activity.observe(workspace,
        scope.uiSession.sessionStatus.getSnapshot(), scope.sessions.list.getSnapshot().byId)
    }
    scope.effect(() => {
      const releaseWorkspace = renderer.workspace.subscribe(observeActivity)
      const releaseStatus = scope.uiSession.sessionStatus.subscribe(observeActivity)
      const releaseSummaries = scope.sessions.list.subscribe(observeActivity)
      return () => { releaseWorkspace(); releaseStatus(); releaseSummaries(); activity.dispose() }
    }, 'convax: activity lifetime')
    scope.effect(() => scope.resources.register({
      protocol: 'convax-workspace',
      async *open(_address, { signal }) {
        const stream = remote.$stream({ name: 'Convax workspace', open: generation => convex.watch(generation),
          ended: accepted => accepted ? new RemoteStreamCarrierError('Convax workspace ended') : new Error('Convax workspace ended before its snapshot') })
        streams.add(stream)
        restart = () => { stream.restart() }
        const stop = (): void => { void stream.dispose() }
        signal.addEventListener('abort', stop, { once: true })
        try {
          if (isAborted(signal)) return
          for await (const frame of stream) {
            if (isAborted(signal)) return
            frame.accept()
            renderer.acceptWorkspace(frame.value)
            yield { ok: true as const, value: frame.value }
          }
        } catch (error) {
          if (!signal.aborted) yield { ok: false as const,
            error: remoteErrorOf(error) ?? new RemoteError('gateway/internal', 'Convax workspace could not be loaded', {}) }
        } finally {
          signal.removeEventListener('abort', stop)
          await stream.dispose()
          streams.delete(stream)
          restart = () => {}
        }
      },
    }), 'convax: workspace resource')
    const unavailable = (): never => { throw new Error('The node plugin is unavailable') }
    scope.slots.registerFactory({ name: 'convax.graph', scope: 'root', locale: NS, store: renderer.presentationStore,
      children: { 'convax.node': { kind: 'keyed', scope: 'root' } },
    }, CanvasGraphSurface)
    scope.slots.inject('shell.workspace', () => scope.slots.register({ name: 'shell.workspace', locale: NS, store: createCanvasViewStore(),
      inject: (): WorkspaceInjected => ({
        nodePlugins: renderer,
        hooks: { canvasActivity: { getSnapshot: activity.getSnapshot, subscribe: activity.subscribe } },
        markActivityRead: (ids) => { activity.markRead(ids); for (const id of ids) scope.uiSession.acknowledgeCompletion(id) },
        defaultInputMode: defaultCanvasInputMode(scope.shortcuts.platform),
        captureInput: id => renderer.getSnapshot().actions.captureInput?.(id),
        insertInputs: (...args) => renderer.getSnapshot().actions.insertInputs?.(...args) ?? Promise.resolve(false),
        initializeAutomation: (...args) => renderer.getSnapshot().actions.initializeAutomation?.(...args) ?? unavailable(),
        openSession: (...args) => renderer.getSnapshot().actions.openSession?.(...args) ?? unavailable(),
        execute: async (request) => {
          const result = await convex.execute(request)
          if (!result.ok) throw result.error
          renderer.acceptWorkspace(result.value.workspace)
          return result.value
        },
        ensureCanvasDirectory: async (id) => {
          const result = await convex.ensureCanvasDirectory(id)
          if (!result.ok) throw result.error
          return result.value
        },
        describe: async (path) => { const result = await convex.describe(path); if (!result.ok) throw result.error; return result.value },
        resolveFilePath: file => hostPathForFile(file) ?? '',
        refresh: () => { restart() },
        openSettings: () => { scope.settingsNavigation.open() },
        openPlugins: () => { scope.pluginNavigation.openList({ presentation: 'drawer' }) },
        openFolder: async (path) => { const result = await remote.session.openWorkspacePath({ path }); if (!result.ok) throw result.error },
        revealSource: async (path) => {
          const resource = await convex.describe(path, lifetime.signal)
          if (!resource.ok) throw resource.error
          const result = await remote.session.openWorkspacePath({ path: resource.value.path, action: 'reveal' }, lifetime.signal)
          if (!result.ok) throw result.error
        },
      }),
    }, ConvaxWorkspace))
  })
}
