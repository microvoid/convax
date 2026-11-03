/** Browser workspace composition over generated Convax Remote contributions. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-general/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-shortcuts/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type {} from '@deepseek-ai/dsh-client-ui-schedule/client'
import contribution from '@deepseek-ai/dsh-convax-plugin-host/remote'
import { RemoteError, remoteErrorOf, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import { hostPathForFile } from './desktop-paths.ts'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import { ConvaxWorkspace } from './Workspace.tsx'
import { createCanvasViewStore, createChatViewStore } from './store.ts'
import { NS, en, zh } from './locales.ts'
import { resourcePath } from './resources.ts'
import type { ChatInjected, WorkspaceInjected } from './props.ts'
import { ChatCard, ChatHeader, ChatSession, ChatThread, ChatTools, ChatViews } from './ChatCard.tsx'
import { ChatSettings } from './ChatSettings.tsx'
import { createThreadProvider } from './thread-resource.ts'
import { ConvaxRenderer, ResourceNode, ChatNode } from './node-renderers.tsx'
import type { CanvasNodeId, CanvasNodeTypeId, CanvasWindowBindingId, CanvasWorkspace } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { CanvasDraftReferences } from './draft-references.ts'
import { CanvasMediaPlayback } from './media-playback.ts'
import { MediaPreview } from './MediaPreview.tsx'
import { MediaPlaybackDock } from './MediaPlaybackDock.tsx'
import type { MediaPreviewInjected } from './media-contract.ts'
import { mediaKind } from './media-kind.ts'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { CanvasOperationId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { defaultCanvasInputMode } from './input-mode.ts'
import { CanvasInitialThreads } from './initial-threads.ts'
import { CanvasGraphSurface } from './CanvasGraphSurface.tsx'
import { CanvasWindowMirrors, desktopWindowCapture } from './window-mirrors.ts'
import { WindowMirror, WindowNode } from './WindowNode.tsx'
import type { WindowMirrorInjected } from './window-contract.ts'
import { parseWindowReference, WINDOW_REFERENCE_SOURCE } from './window-reference.ts'
import { CanvasActivity } from './activity.ts'

export type { CanvasNodeRendererDefinition, IConvaxRenderer } from './node-renderers.tsx'
export type { CanvasNodeOwner, CanvasNodeRendererProps } from './props.ts'
export { NodePorts } from './node-renderers.tsx'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** Visible Convax thread occurrence; releasing it never stops Host work. */
    convaxChat: unknown
  }
}

/** Browser services needed before mounting the generated Remote namespace. */
export const inject = [
  'remote', 'slots', 'locale', 'resources', 'settingsNavigation', 'pluginNavigation', 'sessions', 'uiWorkspace', 'workspaces', 'uiSession', 'layout', 'shortcuts', 'conversation', 'inputTriggers',
]

function isAborted(signal: AbortSignal): boolean { return signal.aborted }

/** Mount the generated API, resources, and the reversible whole-window Slot entry. */
export async function apply(ctx: Context): Promise<void> {
  await ctx.effect(async () => await ctx.remote.$mount(contribution), 'convax: Remote contribution')
  ctx.inject(['remote.convax', 'remote.session'], (scope) => {
    const remote = scope.remote
    const convex = remote.convax
    const resources = scope.resources
    const sessions = scope.sessions
    const mirrors = new CanvasWindowMirrors(desktopWindowCapture())
    scope.effect(() => async () => { await mirrors.dispose() }, 'convax: window mirror lifetime')
    let currentWorkspace: CanvasWorkspace | undefined
    const activity = new CanvasActivity()
    const observeActivity = (): void => {
      if (currentWorkspace !== undefined) activity.observe(currentWorkspace,
        scope.uiSession.sessionStatus.getSnapshot(), sessions.list.getSnapshot().byId)
    }
    scope.effect(() => {
      const releaseStatus = scope.uiSession.sessionStatus.subscribe(observeActivity)
      const releaseSummaries = sessions.list.subscribe(observeActivity)
      return () => { releaseStatus(); releaseSummaries(); activity.dispose() }
    }, 'convax: activity lifetime')
    const observeWorkspace = (workspace: CanvasWorkspace): void => {
      currentWorkspace = workspace
      observeActivity()
      initialThreads.observe(workspace)
      mirrors.reconcile(workspace.canvases.flatMap(canvas => canvas.nodes))
    }
    const createThread: ChatInjected['createThread'] = async (request) => {
      const result = await convex.createThread(request)
      if (!result.ok) throw result.error
      observeWorkspace(result.value.workspace)
      if (result.value.ok) await sessions.refresh()
      return result.value
    }
    const initialThreads = new CanvasInitialThreads(createThread,
      sessionId => scope.workspaces.list.getSnapshot().archivedSessionIds.includes(sessionId))
    scope.effect(() => () => { initialThreads.dispose() }, 'convax: initial thread lifetime')
    const playback = new CanvasMediaPlayback()
    scope.effect(() => () => { playback.dispose() }, 'convax: media playback lifetime')
    let mediaPaths = new Set<string>()
    const lifetime = new AbortController()
    scope.effect(() => () => { lifetime.abort() }, 'convax: draft reference lifetime')
    const draftReferences = new CanvasDraftReferences(sessions, scope.conversation, lifetime.signal)
    const bindInput: ChatInjected['bindInput'] = (nodeId, sessionId) => draftReferences.bind(nodeId, sessionId)
    const streams = new Set<{ dispose(): Promise<void> }>()
    let restart = (): void => {}
    scope.effect(() => async () => {
      await Promise.all([...streams].map(stream => stream.dispose()))
    }, 'convax: stream disposal')
    scope.effect(() => scope.locale.register(NS, { zh, en }), 'convax: dictionaries')
    const t = scope.locale.bind(NS)
    const windowSource: InputTriggerSource = {
      trigger: '@', name: WINDOW_REFERENCE_SOURCE,
      candidates: () => Promise.resolve([]), onPick: () => undefined,
      codec: {
        clipboardText: ref => mirrors.getSnapshot()[parseWindowReference(ref).bindingId]?.name ?? t('window.add'),
        serialize: () => Promise.reject(new Error(t('window.referenceFailed'))),
        prepare: async (ref, signal) => {
          try { return await mirrors.prepare(parseWindowReference(ref), signal) }
          catch (error) { signal.throwIfAborted(); throw new Error(t('window.referenceFailed'), { cause: error }) }
        },
      },
    }
    scope.effect(() => scope.inputTriggers.registerSource(windowSource), 'convax: window composer references')
    async function* watch<Item>(
      name: string,
      signal: AbortSignal,
      open: (generationSignal: AbortSignal) => AsyncIterable<Item>,
      receiveRestart?: (refresh: () => void) => void,
    ): AsyncGenerator<RemoteResult<Item>> {
      const stream = remote.$stream<Item>({
        name,
        open,
        ended: accepted => accepted
          ? new RemoteStreamCarrierError(`${name} ended`)
          : new Error(`${name} ended before its snapshot`),
      })
      streams.add(stream)
      receiveRestart?.(() => { stream.restart() })
      const stop = (): void => { void stream.dispose() }
      signal.addEventListener('abort', stop, { once: true })
      try {
        if (isAborted(signal)) return
        for await (const item of stream) {
          if (isAborted(signal)) return
          item.accept()
          yield { ok: true, value: item.value }
        }
      } catch (error) {
        if (!signal.aborted) yield {
          ok: false,
          error: remoteErrorOf(error) ?? new RemoteError('gateway/internal', `${name} could not be loaded`, {}),
        }
      } finally {
        signal.removeEventListener('abort', stop)
        await stream.dispose()
        streams.delete(stream)
        receiveRestart?.(() => {})
      }
    }
    const workspaceProvider: ResourceProvider<'convax-workspace'> = {
      protocol: 'convax-workspace',
      async *open(_address, { signal }) {
        for await (const result of watch('Convax workspace', signal,
          generationSignal => convex.watch(generationSignal), (refresh) => { restart = refresh })) {
          if (result.ok) {
            observeWorkspace(result.value)
            const paths = new Set(result.value.canvases.flatMap(canvas => canvas.nodes.flatMap(node =>
              node.typeId === 'convax.file' && typeof node.data.path === 'string' && mediaKind(node.data.path) !== undefined
                ? [node.data.path] : [])))
            const detached = Object.keys(playback.getSnapshot()).filter(path => !mediaPaths.has(path))
            playback.reconcile(new Set([...paths, ...detached]))
            mediaPaths = paths
          }
          yield result
        }
      },
    }
    scope.effect(() => resources.register(workspaceProvider), 'convax: workspace resource')
    scope.effect(() => resources.register({
      protocol: 'convax-directory',
      open: (address, { signal }) => watch('Convax directory', signal,
        generationSignal => convex.watchDirectory(resourcePath(address), generationSignal)),
    }), 'convax: directory resources')
    scope.effect(() => resources.register({
      protocol: 'convax-preview',
      open: (address, { signal }) => watch('Convax preview', signal,
        generationSignal => convex.watchFile(resourcePath(address), generationSignal)),
    }), 'convax: preview resources')
    scope.effect(() => resources.register({
      protocol: 'convax-resource',
      open: (address, { signal }) => watch('Convax resource metadata', signal,
        generationSignal => convex.watchResource(resourcePath(address), generationSignal)),
    }), 'convax: resource metadata')
    scope.effect(() => resources.register({
      protocol: 'convax-document',
      async *open(address, { signal }) {
        const path = resourcePath(address)
        for await (const frame of watch('Convax document metadata', signal,
          generationSignal => convex.watchResource(path, generationSignal))) {
          if (!frame.ok) { yield frame; continue }
          const document = await convex.readDocument(path, signal)
          if (signal.aborted) return
          yield document
        }
      },
    }), 'convax: document resources')
    scope.effect(() => resources.register({
      protocol: 'convax-media',
      async *open(address, { signal }) {
        const path = resourcePath(address)
        for await (const frame of watch('Convax media metadata', signal,
          generationSignal => convex.watchResource(path, generationSignal))) {
          if (!frame.ok) { yield frame; continue }
          const source = await convex.mediaSource(path, signal)
          if (signal.aborted) return
          if (!source.ok) { yield source; continue }
          const kind = mediaKind(path)
          if (kind === undefined) throw new RemoteError('gateway/bad-request', 'The resource is not a media file', {})
          const url = new URL('api/convax/media', document.baseURI)
          url.searchParams.set('path', path)
          url.searchParams.set('version', source.value.version)
          yield { ok: true, value: { path, url: url.href,
            mimeType: source.value.mimeType, version: source.value.version, kind } }
        }
      },
    }), 'convax: media resources')
    const mediaActions: MediaPreviewInjected = {
      mountMedia: (source, viewportId) => playback.mount(source, viewportId),
      hoverMedia: (path, hovered) => { playback.hover(path, hovered) },
      toggleMedia: (path) => { playback.toggle(path) },
      seekMedia: (path, seconds) => { playback.seek(path, seconds) },
      setMediaVolume: (path, volume) => { playback.volume(path, volume) },
      fullscreenMedia: path => playback.fullscreen(path),
      openSystem: async (path) => {
        const result = await remote.session.openWorkspacePath({ path }, lifetime.signal)
        if (!result.ok) throw result.error
      },
      hooks: { mediaPlayback: { getSnapshot: playback.getSnapshot, subscribe: playback.subscribe } },
    }
    scope.slots.registerFactory({ name: 'convax.media.preview', scope: 'root', locale: NS,
      inject: () => mediaActions,
    }, MediaPreview)
    scope.slots.inject('shell.overlay', () => scope.slots.register({ name: 'shell.overlay', id: 'convax-media-playback', locale: NS,
      inject: () => ({ hooks: mediaActions.hooks, toggleMedia: mediaActions.toggleMedia }),
    }, MediaPlaybackDock))
    scope.effect(() => resources.register(createThreadProvider(sessions)), 'convax: thread resources')
    const store = createCanvasViewStore()
    const chatStore = createChatViewStore()
    scope.slots.registerFactory({
      name: 'convax.graph', scope: 'root', locale: NS, store: chatStore,
      children: { 'convax.node': { kind: 'keyed', scope: 'root' } },
    }, CanvasGraphSurface)
    const mirrorActions: WindowMirrorInjected = {
      mountWindow: (nodeId, bindingId, viewportId) => mirrors.mount(nodeId, bindingId, viewportId),
      validateWindow: (nodeId, bindingId) => mirrors.validate(nodeId, bindingId),
      reconnectWindow: (nodeId, bindingId) => mirrors.reconnect(nodeId, bindingId),
      hooks: { windowMirrors: { getSnapshot: mirrors.getSnapshot, subscribe: mirrors.subscribe } },
    }
    scope.slots.registerFactory({ name: 'convax.window.content', scope: 'root', locale: NS,
      inject: () => mirrorActions,
    }, WindowMirror)
    scope.slots.registerFactory({
      name: 'convax.chat.content', scope: 'root', locale: NS, store: chatStore,
      children: {
        'convax.chat.header': { kind: 'single', scope: 'session' },
        'convax.chat.views': { kind: 'single', scope: 'session' },
      },
      inject: (): ChatInjected => ({
        bindInput,
        focusSession: (sessionId) => { scope.layout.focusWorkspaceSession(sessionId) },
        acknowledgeCompletion: (sessionId) => { scope.uiSession.acknowledgeCompletion(sessionId) },
        createThread,
        ensureInitialThread: (request, stage) => initialThreads.ensure(request, stage),
      }),
    }, ChatCard)
    scope.slots.inject('convax.chat.header', () => scope.slots.register({ name: 'convax.chat.header' }, ChatHeader))
    scope.slots.inject('convax.chat.views', () => scope.slots.register({ name: 'convax.chat.views' }, ChatViews))
    scope.slots.registerFactory({
      name: 'convax.chat.settings', scope: 'session', locale: NS,
    }, ChatSettings)
    scope.slots.registerFactory({
      name: 'convax.chat.thread', scope: 'root', locale: NS,
      children: {
        'convax.chat.session': { kind: 'single', scope: 'session' },
        'convax.chat.tools': { kind: 'single', scope: 'session' },
      },
    }, ChatThread)
    scope.slots.inject('convax.chat.session', () => scope.slots.register({ name: 'convax.chat.session' }, ChatSession))
    scope.slots.inject('convax.chat.tools', () => scope.slots.register({ name: 'convax.chat.tools' }, ChatTools))
    const renderer = new ConvaxRenderer(scope)
    for (const typeId of ['convax.file', 'convax.folder']) renderer.registerNodeRenderer(typeId as CanvasNodeTypeId, {
      dataVersion: 1, component: ResourceNode,
    })
    renderer.registerNodeRenderer('convax.chat' as CanvasNodeTypeId, { dataVersion: 1, component: ChatNode })
    renderer.registerNodeRenderer('convax.window' as CanvasNodeTypeId, { dataVersion: 1, component: WindowNode })
    scope.slots.inject('shell.workspace', () => scope.slots.register({
      name: 'shell.workspace', locale: NS, store,
      inject: (): WorkspaceInjected => ({
        hooks: { canvasActivity: { getSnapshot: activity.getSnapshot, subscribe: activity.subscribe } },
        markActivityRead: (sessionIds) => {
          activity.markRead(sessionIds)
          for (const sessionId of sessionIds) scope.uiSession.acknowledgeCompletion(sessionId)
        },
        windowsAvailable: mirrors.available,
        listWindows: () => mirrors.list(),
        bindWindow: (nodeId, bindingId, sourceId) => mirrors.bind(nodeId, bindingId, sourceId),
        releaseWindow: bindingId => mirrors.release(bindingId),
        captureInput: nodeId => draftReferences.capture(nodeId),
        insertInputs: async (canvasId, revision, inputs) => {
          const created = new Map<CanvasNodeId, SessionId>()
          const unresolved = new Set<CanvasNodeId>()
          let currentRevision = revision
          let accepted = true
          for (const input of inputs) {
            if (unresolved.has(input.nodeId)) { accepted = false; continue }
            try {
              const canvas = currentWorkspace?.canvases.find(value => value.id === canvasId)
              const source = canvas?.nodes.find(node => node.id === input.sourceId)
              const window = source?.typeId === 'convax.window' ? source : undefined
              const resource = window === undefined
                ? await convex.prepareReference(canvasId, input.sourceId, lifetime.signal) : undefined
              if (resource !== undefined && !resource.ok) throw resource.error
              let target = input.sessionId ?? created.get(input.nodeId)
              if (target === undefined) {
                unresolved.add(input.nodeId)
                const result = await initialThreads.ensure({
                  canvasId, nodeId: input.nodeId, expectedRevision: currentRevision,
                  operationId: randomUUID() as CanvasOperationId, kind: 'create',
                })
                if (!result.ok) { accepted = false; continue }
                target = result.sessionId
                created.set(input.nodeId, target)
                unresolved.delete(input.nodeId)
                const canvas = result.workspace.canvases.find(item => item.id === canvasId)
                if (canvas === undefined) { accepted = false; continue }
                currentRevision = canvas.revision
              }
              if (window !== undefined) {
                if (!await draftReferences.insertWindow(target, {
                  nodeId: window.id, bindingId: window.data.bindingId as CanvasWindowBindingId,
                }, window.data.name as string)) accepted = false
              } else if (resource?.ok && !await draftReferences.insert(target, resource.value)) accepted = false
            } catch (_referenceFailure) {
              accepted = false
              if (lifetime.signal.aborted) break
            }
          }
          return accepted
        },
        defaultInputMode: defaultCanvasInputMode(scope.shortcuts.platform),
        execute: async (request) => {
          const result = await convex.execute(request)
          if (!result.ok) throw result.error
          observeWorkspace(result.value.workspace)
          return result.value
        },
        ensureCanvasDirectory: async (canvasId) => {
          const result = await convex.ensureCanvasDirectory(canvasId)
          if (!result.ok) throw result.error
          return result.value
        },
        describe: async (path) => {
          const result = await convex.describe(path)
          if (!result.ok) throw result.error
          return result.value
        },
        resolveFilePath: file => hostPathForFile(file) ?? '',
        refresh: () => { restart() },
        openSettings: () => { scope.settingsNavigation.open() },
        openPlugins: () => { scope.pluginNavigation.openList({ presentation: 'drawer' }) },
        openSession: async (request) => {
          const result = await convex.openSession(request)
          if (!result.ok) throw result.error
          observeWorkspace(result.value.workspace)
          return result.value
        },
        initializeAutomation: async (request, prompt) => {
          const result = await initialThreads.ensure(request)
          if (!result.ok) return result
          const reference = sessions.retain(result.sessionId, { source: 'convaxChat', signal: lifetime.signal })
          try {
            await reference.ready
            lifetime.signal.throwIfAborted()
            const binding = sessions.binding(result.sessionId)
            if (binding === undefined) throw new Error('The automation conversation is unavailable')
            const initialized = scope.conversation.input.requestDraftInitialization(binding, { prompt, whenDraftExists: 'keep' })
            if (initialized === 'blocked') throw new Error('The automation draft could not be initialized')
          } finally { reference.release() }
          return result
        },
        openFolder: async (path) => {
          const result = await remote.session.openWorkspacePath({ path })
          if (!result.ok) throw result.error
        },
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
