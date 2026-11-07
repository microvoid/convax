// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import type { ResourceProvider, ResourceProtocol } from '@deepseek-ai/dsh-client-resources/client'
import type {
  CanvasDirectory, CanvasDocumentPreview, CanvasId, CanvasMediaSource, CanvasNodeId, CanvasNodeTypeId,
  CanvasOperationId, CanvasResource, CanvasThreadRequest, CanvasThreadResult, CanvasWorkspace,
} from '@deepseek-ai/dsh-convax-plugin-host/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { PropsRenderSlots, PropsRuntime, SlotRendererHost } from '@deepseek-ai/dsh-client-ui-slots'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { apply, inject, CanvasWindowMirrors } from '../src/client/index.ts'
import { apply as applyKernel, inject as injectKernel } from '@deepseek-ai/dsh-convax-plugin-renderer/client'
import { TestSessions } from '@deepseek-ai/dsh-client-test-runtime'
import { resourceAddress } from '@deepseek-ai/dsh-convax-plugin-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionInput, SessionInputResolver } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatInjected, WorkspaceInjected } from '@deepseek-ai/dsh-convax-plugin-renderer/client'
import type { MediaPreviewInjected, MediaSource } from '../src/client/media-contract.ts'
import { InputTriggerService } from '@deepseek-ai/dsh-client-ui-input-trigger/client'

async function fixture(namespace: object = {}, sessionNamespace: object = {}, provideSession = true) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({ name: 'root', children: {
    'shell.workspace': { kind: 'single', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' },
  } },
  ({ renderSlot }: PropsRuntime<'root'> & PropsRenderSlots<'shell.workspace'>) => renderSlot('shell.workspace', {}))
  const providers = new Map<string, ResourceProvider<ResourceProtocol>>()
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('resources', {
    register: (provider: ResourceProvider<ResourceProtocol>) => {
      providers.set(provider.protocol, provider)
      return () => { providers.delete(provider.protocol) }
    },
    pin: () => {},
    source: () => ({
      getSnapshot: () => ({ status: 'none' as const, value: undefined, failure: undefined }),
      subscribe: () => () => {},
    }),
  })
  ctx.provide('settingsNavigation', { open: vi.fn() })
  const openPluginList = vi.fn()
  ctx.provide('pluginNavigation', { openList: openPluginList })
  const sessions = new TestSessions(async (operation) => { await operation() }, ctx)
  ctx.provide('sessions', sessions)
  await ctx.plugin(InputTriggerService).await()
  const pickDirectory = vi.fn(async (): Promise<string | null> => null)
  ctx.provide('uiWorkspace', { pickDirectory } as never)
  const archiveState = { archivedSessionIds: [] as SessionId[] }
  ctx.provide('workspaces', { list: { getSnapshot: () => archiveState, subscribe: () => () => {} } } as never)
  ctx.provide('uiSession', { acknowledgeCompletion: vi.fn(), sessionStatus: {
    getSnapshot: () => new Map(), subscribe: () => () => {},
  } } as never)
  const selectPanel = vi.fn()
  ctx.provide('layout', { focusWorkspaceSession: vi.fn(), selectPanel } as never)
  ctx.provide('shortcuts', { platform: 'macos' } as never)
  const addReferences = vi.fn<SessionInput['addReferences']>(() => true)
  const initializeDraft = vi.fn<SessionInputResolver['requestDraftInitialization']>(() => 'applied')
  ctx.provide('conversation', { input: { for: vi.fn(() => ({ addReferences })), requestDraftInitialization: initializeDraft } } as never)
  onTestFinished(async () => { await sessions.disposeScopes() })
  const unmount = vi.fn()
  const aborts: AbortController[] = []
  class RemoteService extends Service {
    readonly convex = namespace
    readonly session = sessionNamespace
    constructor(owner: Context) { super(owner, 'remote') }
    async $mount() { return async () => { unmount() } }
    $stream<Item>(options: RemoteStreamOptions<Item>) {
      const abort = new AbortController()
      aborts.push(abort)
      return {
        async *[Symbol.asyncIterator]() {
          for await (const value of options.open(abort.signal)) {
            yield { value, accept: () => {} }
          }
        },
        dispose: async () => { abort.abort() },
        restart: () => {},
      }
    }
  }
  new RemoteService(ctx)
  ctx.provide('remote.convax', namespace)
  if (provideSession) ctx.provide('remote.session', sessionNamespace)
  const fiber = ctx.plugin({ inject: injectKernel, apply: applyKernel })
  await fiber.await()
  const nodeFiber = ctx.plugin({ inject, apply })
  if (provideSession) await nodeFiber.await()
  return { ctx, providers, fiber, nodeFiber, unmount, aborts, sessions,
    addReferences, initializeDraft, pickDirectory, openPluginList, selectPanel }
}

function mediaFace(ctx: Context): MediaPreviewInjected {
  let host: SlotRendererHost | undefined
  ctx.slots.install({ renderRoot: (value) => { host = value; return null } })
  ctx.slots.renderSlot('root', {})
  if (host === undefined) throw new Error('Renderer host was not supplied')
  const factory = host.factoryOf('convax.media.preview')
  if (factory === undefined) throw new Error('Media preview Factory was not registered')
  return (factory.inject as () => MediaPreviewInjected & Record<string, unknown>)()
}

describe('Convax browser contribution', () => {
  it('retires window captures when their Host provider becomes unavailable without removing saved nodes', async () => {
    const reconcile = vi.spyOn(CanvasWindowMirrors.prototype, 'reconcile')
    onTestFinished(() => { reconcile.mockRestore() })
    const b = await fixture()
    const canvasId = 'window-board' as CanvasId
    const node = { id: 'window' as CanvasNodeId, typeId: 'convax.window' as CanvasNodeTypeId,
      dataVersion: 1, revision: 1, position: { x: 10, y: 20 }, data: { bindingId: 'saved-binding', name: 'Document' } }
    const workspace: CanvasWorkspace = { revision: 1, chats: [], nodeIssues: [],
      canvases: [{ id: canvasId, title: 'Board', revision: 1, nodes: [node], connections: [] }],
      nodeTypes: [{ id: node.typeId, dataVersion: 1, ports: [] }] }
    b.ctx.convaxRenderer.acceptWorkspace(workspace)
    expect(reconcile).toHaveBeenLastCalledWith([node])
    b.ctx.convaxRenderer.acceptWorkspace({ ...workspace, nodeTypes: [] })
    expect(reconcile).toHaveBeenLastCalledWith([])
    expect(workspace.canvases[0]?.nodes).toEqual([node])
  })
  it('unloads the default node UI independently while the canvas, saved graph feed and Session owner remain', async () => {
    const stop = vi.fn()
    const b = await fixture({}, { stop })
    const before = b.ctx.convaxRenderer.getSnapshot()
    expect(Object.keys(before.definitions).sort()).toEqual(['convax.browser', 'convax.chat', 'convax.file', 'convax.folder', 'convax.terminal', 'convax.window'])
    expect(before.creations.map(entry => entry.id)).toEqual(['project', 'files', 'terminal', 'browser', 'chat'])
    await b.nodeFiber.dispose()
    expect(b.ctx.slots.entries('shell.workspace')).toHaveLength(1)
    expect(b.ctx.convaxRenderer.getSnapshot()).toEqual({ definitions: {}, creations: [], actions: {} })
    expect([...b.providers.keys()]).toEqual(['convax-workspace'])
    expect(b.ctx.slots.snapshot('factory:convax.chat.content')).toEqual([])
    expect(b.ctx.slots.snapshot('factory:convax.window.content')).toEqual([])
    expect(b.ctx.slots.snapshot('factory:convax.media.preview')).toEqual([])
    expect(stop).not.toHaveBeenCalled()
    const enabled = b.ctx.plugin({ inject, apply })
    await enabled.await()
    expect(Object.keys(b.ctx.convaxRenderer.getSnapshot().definitions)).toHaveLength(6)
    expect(b.ctx.slots.entries('shell.workspace')).toHaveLength(1)
  })
  it('shares one Chat preference handle between the graph Factory and Chat cards', async () => {
    const b = await fixture()
    let host: SlotRendererHost | undefined
    b.ctx.slots.install({ renderRoot: (value) => { host = value; return null } })
    b.ctx.slots.renderSlot('root', {})
    const graph = host?.factoryOf('convax.graph')
    const chat = host?.factoryOf('convax.chat.content')
    expect(graph?.store).toBeDefined()
    expect(graph?.store).toBe(chat?.store)
    expect(graph?.children).toEqual({ 'convax.node': { kind: 'keyed', scope: 'root' } })
    expect(b.ctx.slots.entries('shell.workspace')[0]?.children).toBeUndefined()
    await b.fiber.dispose()
    expect(host?.factoryOf('convax.graph')).toBeUndefined()
  })

  it('waits for the Session Remote namespace before mounting file actions', async () => {
    const b = await fixture({}, {}, false)
    expect(b.ctx.slots.entries('shell.workspace')).toHaveLength(0)
    b.ctx.provide('remote.session', {})
    await vi.waitFor(() => { expect(b.ctx.slots.entries('shell.workspace')).toHaveLength(1) })
  })

  it('reveals the resolved source path while folder opening keeps its default action', async () => {
    const openWorkspacePath = vi.fn(async () => ({ ok: true as const, value: { opened: true } }))
    const describe = vi.fn(async () => ({ ok: true as const, value: {
      path: '/private/project/中文 clip.mp4', name: '中文 clip.mp4', kind: 'file' as const, size: 12,
    } }))
    const b = await fixture({ describe }, { openWorkspacePath })
    const injected = (b.ctx.slots.entries('shell.workspace')[0]!.inject as () => WorkspaceInjected & Record<string, unknown>)()
    await injected.revealSource('/project/中文 clip.mp4')
    expect(describe).toHaveBeenCalledExactlyOnceWith('/project/中文 clip.mp4', expect.any(AbortSignal))
    expect(openWorkspacePath).toHaveBeenLastCalledWith(
      { path: '/private/project/中文 clip.mp4', action: 'reveal' }, expect.any(AbortSignal),
    )
    await injected.openFolder('/project')
    expect(openWorkspacePath).toHaveBeenLastCalledWith({ path: '/project' })
  })

  it('reports a refused source reveal to the initiating workspace control', async () => {
    const error = new RemoteError('gateway/bad-request', 'Path has no verified Host path', {})
    const describe = vi.fn(async () => ({ ok: true as const, value: {
      path: '/missing/clip.mp4', name: 'clip.mp4', kind: 'file' as const, size: null,
    } }))
    const b = await fixture({ describe }, { openWorkspacePath: vi.fn(async () => ({ ok: false as const, error })) })
    const injected = (b.ctx.slots.entries('shell.workspace')[0]!.inject as () => WorkspaceInjected & Record<string, unknown>)()
    await expect(injected.revealSource('/missing/clip.mp4')).rejects.toBe(error)
  })

  it('stops a source reveal when its resource can no longer be resolved', async () => {
    const error = new RemoteError('gateway/bad-request', 'Resource is missing', {})
    const openWorkspacePath = vi.fn()
    const b = await fixture({ describe: vi.fn(async () => ({ ok: false as const, error })) }, { openWorkspacePath })
    const injected = (b.ctx.slots.entries('shell.workspace')[0]!.inject as () => WorkspaceInjected & Record<string, unknown>)()
    await expect(injected.revealSource('/missing/clip.mp4')).rejects.toBe(error)
    expect(openWorkspacePath).not.toHaveBeenCalled()
  })

  it('opens plugin management in a drawer without selecting a workspace panel', async () => {
    const b = await fixture()
    const injected = (b.ctx.slots.entries('shell.workspace')[0]!.inject as () => WorkspaceInjected & Record<string, unknown>)()
    injected.openPlugins()
    expect(b.openPluginList).toHaveBeenCalledExactlyOnceWith({ presentation: 'drawer' })
    expect(b.selectPanel).not.toHaveBeenCalled()
  })

  it('leaves directory interaction to the composed Factory instead of a native-only callback', async () => {
    const b = await fixture()
    const injected = (b.ctx.slots.entries('shell.workspace')[0]!.inject as () => WorkspaceInjected & Record<string, unknown>)()
    expect(injected).not.toHaveProperty('chooseDirectory')
    expect(b.pickDirectory).not.toHaveBeenCalled()
  })

  it('uses the Host canvas directory without opening the native directory picker', async () => {
    const ensureCanvasDirectory = vi.fn(async (_canvasId: CanvasId) => ({ ok: true as const, value: '/canvas/default' }))
    const b = await fixture({ ensureCanvasDirectory })
    const injected = (b.ctx.slots.entries('shell.workspace')[0]!.inject as () => WorkspaceInjected & Record<string, unknown>)()
    const canvasId = 'canvas-directory' as CanvasId
    await expect(injected.ensureCanvasDirectory(canvasId)).resolves.toBe('/canvas/default')
    expect(ensureCanvasDirectory).toHaveBeenCalledExactlyOnceWith(canvasId)
    expect(b.pickDirectory).not.toHaveBeenCalled()
  })

  it('preserves a Host directory failure for the workspace to report', async () => {
    const error = new RemoteError('gateway/bad-request', 'The canvas directory is unavailable', {})
    const ensureCanvasDirectory = vi.fn(async (_canvasId: CanvasId) => ({ ok: false as const, error }))
    const b = await fixture({ ensureCanvasDirectory })
    const injected = (b.ctx.slots.entries('shell.workspace')[0]!.inject as () => WorkspaceInjected & Record<string, unknown>)()
    await expect(injected.ensureCanvasDirectory('canvas-directory' as CanvasId)).rejects.toBe(error)
    expect(b.pickDirectory).not.toHaveBeenCalled()
  })

  it.each(['applied', 'preserved'] as const)('initializes an automation through the retained native draft and accepts its %s result', async (outcome) => {
    const canvasId = 'automation-canvas' as CanvasId
    const nodeId = 'automation-chat' as CanvasNodeId
    const sessionId = 'automation-thread' as SessionId
    const workspace: CanvasWorkspace = {
      revision: 8, nodeTypes: [], nodeIssues: [],
      canvases: [{ id: canvasId, title: 'Automation', revision: 8, nodes: [], connections: [] }],
      chats: [{ canvasId, nodeId, title: 'Automation', cwd: '/project', deleting: false, issue: null,
        threads: [{ sessionId, parentSessionId: null, inheritedEventCount: 0 }] }],
    }
    const result: CanvasThreadResult = { ok: true, sessionId, workspace }
    const createThread = vi.fn(async (_request: CanvasThreadRequest) => ({ ok: true as const, value: result }))
    const b = await fixture({ createThread })
    await b.sessions.add({ id: sessionId })
    b.initializeDraft.mockImplementation((binding, options) => {
      expect(binding.sessionId).toBe(sessionId)
      expect(options).toEqual({ prompt: 'Create an automation task: ', whenDraftExists: 'keep' })
      expect(b.sessions.retainInfo(sessionId).getSnapshot().retainedBy.convaxChat).toBe(1)
      return outcome
    })
    const injected = (b.ctx.slots.entries('shell.workspace')[0]!.inject as () => WorkspaceInjected & Record<string, unknown>)()
    const request: CanvasThreadRequest = {
      canvasId, nodeId, expectedRevision: 7, operationId: 'automation-attempt' as CanvasOperationId, kind: 'create', cwd: '/project',
    }
    expect(await injected.initializeAutomation(request, 'Create an automation task: ')).toEqual(result)
    expect(createThread).toHaveBeenCalledExactlyOnceWith(request)
    expect(b.initializeDraft).toHaveBeenCalledOnce()
    expect(b.sessions.retainInfo(sessionId).getSnapshot().referenceCount).toBe(0)
  })

  it('releases the retained automation Session when native draft initialization is blocked', async () => {
    const sessionId = 'blocked-automation-thread' as SessionId
    const workspace: CanvasWorkspace = { revision: 0, canvases: [], nodeTypes: [], nodeIssues: [], chats: [] }
    const createThread = vi.fn(async (_request: CanvasThreadRequest) => ({
      ok: true as const, value: { ok: true as const, sessionId, workspace },
    }))
    const b = await fixture({ createThread })
    await b.sessions.add({ id: sessionId })
    b.initializeDraft.mockReturnValue('blocked')
    const injected = (b.ctx.slots.entries('shell.workspace')[0]!.inject as () => WorkspaceInjected & Record<string, unknown>)()
    await expect(injected.initializeAutomation({
      canvasId: 'canvas' as CanvasId, nodeId: 'chat' as CanvasNodeId, expectedRevision: 1,
      operationId: 'blocked-automation-attempt' as CanvasOperationId, kind: 'create', cwd: '/project',
    }, 'Create an automation task: ')).rejects.toThrow('The automation draft could not be initialized')
    expect(b.initializeDraft).toHaveBeenCalledOnce()
    expect(b.sessions.retainInfo(sessionId).getSnapshot().referenceCount).toBe(0)
  })

  it('releases its workspace occupant and resource providers when its fiber unloads', async () => {
    const { ctx, providers, fiber, unmount } = await fixture()
    expect(ctx.slots.entries('shell.workspace')).toHaveLength(1)
    expect([...providers.keys()].sort()).toEqual([
      'convax-directory', 'convax-document', 'convax-media', 'convax-preview', 'convax-resource', 'convax-thread', 'convax-workspace',
    ])
    await fiber.dispose()
    expect(ctx.slots.entries('shell.workspace')).toHaveLength(0)
    expect(providers.size).toBe(0)
    expect(unmount).toHaveBeenCalledOnce()
  })

  it('releases its media Factory, overlay and retained native players when unloaded', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    const viewport = document.createElement('div')
    viewport.id = 'plugin-media-viewport'
    document.body.append(viewport)
    const bodyChildren = document.body.childElementCount
    const openWorkspacePath = vi.fn(async (_request: { path: string }, _signal: AbortSignal) => ({ ok: true as const, value: undefined }))
    const b = await fixture({}, { openWorkspacePath })
    onTestFinished(async () => {
      await b.fiber.dispose()
      viewport.remove()
      play.mockRestore(); pause.mockRestore(); load.mockRestore()
    })
    const face = mediaFace(b.ctx)
    expect(b.ctx.slots.snapshot('factory:convax.media.preview')).toMatchObject([{ type: 'factory', scope: 'root', name: 'convax.media.preview' }])
    expect(b.ctx.slots.entries('shell.overlay')).toHaveLength(1)
    const source: MediaSource = { path: '/project/movie.mp4', version: '1', url: '/api/convax/media?version=1', mimeType: 'video/mp4', kind: 'video' }
    const release = face.mountMedia(source, viewport.id)
    const video = viewport.querySelector('video')!
    face.toggleMedia(source.path)
    await Promise.resolve()
    release()
    await Promise.resolve()
    expect(face.hooks.mediaPlayback.getSnapshot()[source.path]).toMatchObject({ intent: 'manual', status: 'playing', presented: false })
    expect(video.isConnected).toBe(true)
    await face.openSystem(source.path)
    expect(openWorkspacePath).toHaveBeenCalledWith({ path: source.path }, expect.any(AbortSignal))
    const lifetime = openWorkspacePath.mock.calls[0]![1]
    await b.fiber.dispose()
    expect(lifetime.aborted).toBe(true)
    expect(b.ctx.slots.snapshot('factory:convax.media.preview')).toEqual([])
    expect(b.ctx.slots.entries('shell.overlay')).toHaveLength(0)
    expect(face.hooks.mediaPlayback.getSnapshot()).toEqual({})
    expect(video.isConnected).toBe(false)
    expect(video.hasAttribute('src')).toBe(false)
    expect(document.body.childElementCount).toBe(bodyChildren)
    expect(load).toHaveBeenCalledOnce()
  })

  it.each([
    ['alias movie.MP4', 'video/mp4', 'video'], ['alias audio.MP3', 'audio/mpeg', 'audio'],
  ] as const)('creates a versioned media URL while retaining the original %s resource identity', async (name, mimeType, kind) => {
    const path = `/project/中文/${name}`
    const canonicalPath = `/private/actual/${name}`
    const version = 'v2 / ? &' as CanvasMediaSource['version']
    const value: CanvasMediaSource = { path: canonicalPath, name, size: 100, mimeType, version }
    const base = document.createElement('base')
    base.href = 'http://127.0.0.1:3080/workspace/'
    document.head.prepend(base)
    onTestFinished(() => { base.remove() })
    const watchResource = vi.fn(async function* (_path: string, signal: AbortSignal) {
      yield { path, name, kind: 'file' as const, size: 100 }
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    })
    const mediaSource = vi.fn(async (_path: string, _signal: AbortSignal) => ({ ok: true as const, value }))
    const { providers, aborts } = await fixture({ watchResource, mediaSource })
    const provider = providers.get('convax-media') as ResourceProvider<'convax-media'>
    const lifetime = new AbortController()
    onTestFinished(() => { lifetime.abort() })
    const iterator = provider.open(resourceAddress('convax-media', path), { signal: lifetime.signal })[Symbol.asyncIterator]()
    const result = await iterator.next()
    if (result.done || !result.value.ok) throw new Error('Media source was not published')
    expect(result.value.value).toMatchObject({ path, mimeType, version, kind })
    const url = new URL(result.value.value.url)
    expect(url.pathname).toBe('/workspace/api/convax/media')
    expect(url.searchParams.get('path')).toBe(path)
    expect(url.searchParams.get('version')).toBe(version)
    expect(mediaSource).toHaveBeenCalledExactlyOnceWith(path, lifetime.signal)
    expect(watchResource.mock.calls[0]?.[0]).toBe(path)
    const pending = iterator.next()
    lifetime.abort()
    expect(await pending).toEqual({ done: true, value: undefined })
    expect(aborts[0]?.signal.aborted).toBe(true)
  })

  it('recovers media metadata after a source failure and discards a late reply after cancellation', async () => {
    const path = '/project/audio.mp3'
    const changed = Promise.withResolvers<undefined>()
    const sourceStarted = Promise.withResolvers<undefined>()
    const late = Promise.withResolvers<RemoteResult<CanvasMediaSource>>()
    const value: CanvasMediaSource = { path, name: 'audio.mp3', size: 10, mimeType: 'audio/mpeg', version: 'v2' as CanvasMediaSource['version'] }
    const watchResource = vi.fn(async function* (_path: string, signal: AbortSignal) {
      yield { path, name: value.name, kind: 'file' as const, size: 5 }
      await changed.promise
      if (!signal.aborted) yield { path, name: value.name, kind: 'file' as const, size: 10 }
      if (!signal.aborted) yield { path, name: value.name, kind: 'file' as const, size: 11 }
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    })
    const failure = new RemoteError('gateway/internal', 'Metadata read failed', {})
    const mediaSource = vi.fn<(path: string, signal: AbortSignal) => Promise<RemoteResult<CanvasMediaSource>>>()
      .mockResolvedValueOnce({ ok: false, error: failure })
      .mockResolvedValueOnce({ ok: true, value })
      .mockImplementationOnce(async () => { sourceStarted.resolve(undefined); return await late.promise })
    const { providers, aborts } = await fixture({ watchResource, mediaSource })
    const provider = providers.get('convax-media') as ResourceProvider<'convax-media'>
    const lifetime = new AbortController()
    onTestFinished(() => { lifetime.abort(); changed.resolve(undefined); late.resolve({ ok: true, value }) })
    const iterator = provider.open(resourceAddress('convax-media', path), { signal: lifetime.signal })[Symbol.asyncIterator]()
    expect(await iterator.next()).toMatchObject({ value: { ok: false, error: failure } })
    const recovering = iterator.next()
    changed.resolve(undefined)
    expect(await recovering).toMatchObject({ value: { ok: true, value: { path, version: value.version, kind: 'audio' } } })
    const pending = iterator.next()
    await sourceStarted.promise
    lifetime.abort()
    late.resolve({ ok: true, value })
    expect(await pending).toEqual({ done: true, value: undefined })
    expect(aborts[0]?.signal.aborted).toBe(true)
    expect(mediaSource.mock.calls.map(([requested, signal]) => [requested, signal.aborted])).toEqual([
      [path, true], [path, true], [path, true],
    ])
  })

  it('stops a retained alias-path player when its canvas file node is removed', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    const viewport = document.createElement('div')
    viewport.id = 'alias-media-viewport'
    document.body.append(viewport)
    const path = '/project/alias.mp4'
    const initial: CanvasWorkspace = { revision: 1, chats: [], nodeTypes: [], nodeIssues: [], canvases: [{
      id: 'canvas' as CanvasId, title: 'Board', revision: 1, connections: [], nodes: [{
        id: 'alias-node' as CanvasNodeId, typeId: 'convax.file' as CanvasNodeTypeId,
        dataVersion: 1, data: { path }, position: { x: 0, y: 0 }, revision: 1,
      }],
    }] }
    const changed = Promise.withResolvers<undefined>()
    const watch = vi.fn(async function* (signal: AbortSignal) {
      yield initial
      await changed.promise
      if (!signal.aborted) yield { ...initial, revision: 2, canvases: [{ ...initial.canvases[0]!, nodes: [], revision: 2 }] }
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    })
    const b = await fixture({ watch })
    const lifetime = new AbortController()
    onTestFinished(async () => {
      lifetime.abort(); changed.resolve(undefined)
      await b.fiber.dispose()
      viewport.remove()
      play.mockRestore(); pause.mockRestore(); load.mockRestore()
    })
    const provider = b.providers.get('convax-workspace') as ResourceProvider<'convax-workspace'>
    const iterator = provider.open(resourceAddress('convax-workspace', '/'), { signal: lifetime.signal })[Symbol.asyncIterator]()
    expect(await iterator.next()).toMatchObject({ value: { ok: true, value: initial } })
    const face = mediaFace(b.ctx)
    const release = face.mountMedia({ path, version: '1', url: '/api/convax/media?path=alias.mp4', mimeType: 'video/mp4', kind: 'video' }, viewport.id)
    const video = viewport.querySelector('video')!
    face.toggleMedia(path)
    await Promise.resolve()
    release()
    await Promise.resolve()
    expect(face.hooks.mediaPlayback.getSnapshot()[path]).toMatchObject({ presented: false, intent: 'manual', status: 'playing' })
    const removed = iterator.next()
    changed.resolve(undefined)
    expect(await removed).toMatchObject({ value: { ok: true, value: { revision: 2 } } })
    expect(face.hooks.mediaPlayback.getSnapshot()).toEqual({})
    expect(video.isConnected).toBe(false)
    expect(video.hasAttribute('src')).toBe(false)
    const pending = iterator.next()
    lifetime.abort()
    expect(await pending).toEqual({ done: true, value: undefined })
  })

  it('publishes watched directory changes and stops pending delivery when its resource is released', async () => {
    const next = Promise.withResolvers<undefined>()
    const path = '/project'
    const initial: CanvasDirectory = { path, entries: [] }
    const changed: CanvasDirectory = { path, entries: [{ path: '/project/new.txt', name: 'new.txt', kind: 'file', size: 4 }] }
    const watchDirectory = vi.fn(async function* (requested: string, signal: AbortSignal) {
      expect(requested).toBe(path)
      yield initial
      await next.promise
      if (!signal.aborted) yield changed
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    })
    const { providers, aborts } = await fixture({ watchDirectory })
    const provider = providers.get('convax-directory') as ResourceProvider<'convax-directory'>
    const lifetime = new AbortController()
    const iterator = provider.open(resourceAddress('convax-directory', path), { signal: lifetime.signal })[Symbol.asyncIterator]()
    expect(await iterator.next()).toMatchObject({ value: { ok: true, value: initial } })
    next.resolve(undefined)
    expect(await iterator.next()).toMatchObject({ value: { ok: true, value: changed } })
    const pending = iterator.next()
    lifetime.abort()
    expect(await pending).toEqual({ done: true, value: undefined })
    expect(aborts[0]?.signal.aborted).toBe(true)
    expect(watchDirectory).toHaveBeenCalledOnce()
  })

  it('owns a visible thread reference only until its resource closes', async () => {
    const { providers, sessions } = await fixture()
    const id = 'resource-thread' as SessionId
    await sessions.add({ id })
    const provider = providers.get('convax-thread') as ResourceProvider<'convax-thread'>
    const lifetime = new AbortController()
    const iterator = provider.open(resourceAddress('convax-thread', id), { signal: lifetime.signal })[Symbol.asyncIterator]()
    const opened = await iterator.next()
    expect(opened.value).toMatchObject({ ok: true, value: { reference: { sessionId: id } } })
    expect(sessions.retainInfo(id).getSnapshot().retainedBy.convaxChat).toBe(1)
    const pending = iterator.next()
    lifetime.abort()
    expect(await pending).toEqual({ done: true, value: undefined })
    expect(sessions.retainInfo(id).getSnapshot().referenceCount).toBe(0)
  })

  it('watches resource metadata without reading document content', async () => {
    const path = '/project/image.png'
    const resource: CanvasResource = { path, name: 'image.png', kind: 'file', size: 20 }
    const readDocument = vi.fn()
    const watchResource = vi.fn(async function* (requested: string, signal: AbortSignal) {
      expect(requested).toBe(path)
      yield resource
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    })
    const { providers, aborts } = await fixture({ watchResource, readDocument })
    const provider = providers.get('convax-resource') as ResourceProvider<'convax-resource'>
    const lifetime = new AbortController()
    onTestFinished(() => { lifetime.abort() })
    const iterator = provider.open(resourceAddress('convax-resource', path), { signal: lifetime.signal })[Symbol.asyncIterator]()
    expect(await iterator.next()).toMatchObject({ value: { ok: true, value: resource } })
    expect(readDocument).not.toHaveBeenCalled()
    const pending = iterator.next()
    lifetime.abort()
    expect(await pending).toEqual({ done: true, value: undefined })
    expect(aborts[0]?.signal.aborted).toBe(true)
  })

  it('reads document bytes through unary calls and recovers from a failed read after metadata invalidation', async () => {
    const path = '/project/notes.md'
    const resource: CanvasResource = { path, name: 'notes.md', kind: 'file', size: 7 }
    const document: CanvasDocumentPreview = {
      path, name: resource.name, size: resource.size, version: 'v2',
      bytes: new Uint8Array([35, 32, 78, 111, 116, 101, 115]), mimeType: 'text/markdown',
    }
    const changed = Promise.withResolvers<undefined>()
    const watchResource = vi.fn(async function* (_path: string, signal: AbortSignal) {
      yield resource
      await changed.promise
      if (!signal.aborted) yield { ...resource, size: 8 }
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    })
    const failure = new RemoteError('canvas-resource/source-changed', 'Source changed', { path })
    const readDocument = vi.fn<(path: string, signal: AbortSignal) => Promise<RemoteResult<CanvasDocumentPreview>>>()
      .mockResolvedValueOnce({ ok: false, error: failure })
      .mockResolvedValueOnce({ ok: true, value: document })
    const { providers, aborts } = await fixture({ watchResource, readDocument })
    const provider = providers.get('convax-document') as ResourceProvider<'convax-document'>
    const lifetime = new AbortController()
    onTestFinished(() => { lifetime.abort(); changed.resolve(undefined) })
    const iterator = provider.open(resourceAddress('convax-document', path), { signal: lifetime.signal })[Symbol.asyncIterator]()
    expect(await iterator.next()).toMatchObject({ value: { ok: false, error: failure } })
    const refreshed = iterator.next()
    changed.resolve(undefined)
    const result = await refreshed
    expect(result).toMatchObject({ value: { ok: true, value: document } })
    expect(readDocument.mock.calls).toEqual([[path, lifetime.signal], [path, lifetime.signal]])
    expect(watchResource).toHaveBeenCalledOnce()
    const pending = iterator.next()
    lifetime.abort()
    expect(await pending).toEqual({ done: true, value: undefined })
    expect(aborts[0]?.signal.aborted).toBe(true)
  })

  it('cancels the metadata watch and suppresses document bytes returned after the resource is released', async () => {
    const path = '/project/notes.txt'
    const document: CanvasDocumentPreview = {
      path, name: 'notes.txt', size: 4, version: 'v1', bytes: new Uint8Array([108, 97, 116, 101]), mimeType: 'text/plain',
    }
    const started = Promise.withResolvers<AbortSignal>()
    const read = Promise.withResolvers<RemoteResult<CanvasDocumentPreview>>()
    const readDocument = vi.fn(async (_path: string, signal: AbortSignal) => {
      started.resolve(signal)
      return await read.promise
    })
    const watchResource = vi.fn(async function* (_path: string, signal: AbortSignal) {
      yield { path, name: document.name, kind: 'file' as const, size: document.size }
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    })
    const { providers, aborts } = await fixture({ watchResource, readDocument })
    const provider = providers.get('convax-document') as ResourceProvider<'convax-document'>
    const lifetime = new AbortController()
    onTestFinished(() => { lifetime.abort(); read.resolve({ ok: true, value: document }) })
    const iterator = provider.open(resourceAddress('convax-document', path), { signal: lifetime.signal })[Symbol.asyncIterator]()
    const pending = iterator.next()
    const readSignal = await started.promise
    expect(readSignal.aborted).toBe(false)
    lifetime.abort()
    expect(readSignal.aborted).toBe(true)
    read.resolve({ ok: true, value: document })
    expect(await pending).toEqual({ done: true, value: undefined })
    expect(aborts[0]?.signal.aborted).toBe(true)
    expect(readDocument).toHaveBeenCalledExactlyOnceWith(path, lifetime.signal)
  })

  it('creates one thread per empty Chat in an input batch and advances the committed revision', async () => {
    const canvasId = 'batch-canvas' as CanvasId
    const firstChat = 'empty-chat-a' as CanvasNodeId
    const secondChat = 'empty-chat-b' as CanvasNodeId
    const createThread = vi.fn<(request: CanvasThreadRequest) => Promise<{ ok: true; value: CanvasThreadResult }>>()
    const prepareReference = vi.fn(async (_canvasId: CanvasId, sourceId: CanvasNodeId) => ({
      ok: true as const,
      value: { path: `/project/${sourceId}`, name: sourceId, kind: 'file' as const, size: 1 },
    }))
    const b = await fixture({ createThread, prepareReference })
    let revision = 5
    createThread.mockImplementation(async (request) => {
      expect(request.expectedRevision).toBe(revision)
      const sessionId = `batch-thread-${createThread.mock.calls.length}` as SessionId
      await b.sessions.add({ id: sessionId })
      revision += 1
      const workspace: CanvasWorkspace = {
        revision: 100 + revision, nodeTypes: [], nodeIssues: [], chats: [],
        canvases: [{ id: canvasId, title: 'Board', revision, nodes: [], connections: [] }],
      }
      return { ok: true, value: { ok: true, sessionId, workspace } }
    })
    const injected = (b.ctx.slots.entries('shell.workspace')[0]!.inject as () => WorkspaceInjected & Record<string, unknown>)()
    expect(await injected.insertInputs(canvasId, 5, [
      { nodeId: firstChat, sourceId: 'source-a' as CanvasNodeId },
      { nodeId: firstChat, sourceId: 'source-b' as CanvasNodeId },
      { nodeId: secondChat, sourceId: 'source-c' as CanvasNodeId },
    ])).toBe(true)
    expect(createThread.mock.calls.map(([request]) => [request.nodeId, request.expectedRevision])).toEqual([
      [firstChat, 5], [secondChat, 6],
    ])
    expect(prepareReference).toHaveBeenCalledTimes(3)
    expect(b.addReferences).toHaveBeenCalledTimes(3)
    expect(b.addReferences.mock.calls.map(([references]) => references[0]!.label)).toEqual(['source-a', 'source-b', 'source-c'])
  })

  it('shares an initial thread between the mounted Chat and a connection being added', async () => {
    const canvasId = 'initial-canvas' as CanvasId
    const nodeId = 'initial-chat' as CanvasNodeId
    const sessionId = 'initial-thread' as SessionId
    const initialRequest: CanvasThreadRequest = {
      canvasId, nodeId, expectedRevision: 5, operationId: 'initial-attempt' as CanvasOperationId, kind: 'create',
    }
    const started = Promise.withResolvers<CanvasThreadRequest>()
    const reply = Promise.withResolvers<{ ok: true; value: CanvasThreadResult }>()
    const createThread = vi.fn(async (request: CanvasThreadRequest) => {
      started.resolve(request)
      return await reply.promise
    })
    const prepareReference = vi.fn(async (_canvasId: CanvasId, sourceId: CanvasNodeId) => ({
      ok: true as const,
      value: { path: `/project/${sourceId}`, name: sourceId, kind: 'folder' as const, size: null },
    }))
    const b = await fixture({ createThread, prepareReference })
    onTestFinished(() => { reply.resolve({ ok: true, value: {
      ok: false, code: 'operation-pending', message: 'fixture disposed', workspace: {
        revision: 0, canvases: [], nodeTypes: [], nodeIssues: [], chats: [],
      },
    } }) })
    let rendererHost: SlotRendererHost | undefined
    b.ctx.slots.install({ renderRoot: (host) => { rendererHost = host; return null } })
    b.ctx.slots.renderSlot('root', {})
    const definition = rendererHost?.factoryOf('convax.chat.content')
    expect(definition).toBeDefined()
    const chat = (definition!.inject as () => ChatInjected & Record<string, unknown>)()
    const workspace = (b.ctx.slots.entries('shell.workspace')[0]!.inject as () => WorkspaceInjected & Record<string, unknown>)()
    const stage = vi.fn()
    const initial = chat.ensureInitialThread(initialRequest, stage)
    expect(await started.promise).toEqual(initialRequest)
    const inserted = workspace.insertInputs(canvasId, 5, [
      { nodeId, sourceId: 'source-folder' as CanvasNodeId },
      { nodeId, sourceId: 'another-folder' as CanvasNodeId },
    ])
    await b.sessions.add({ id: sessionId })
    const committed: CanvasWorkspace = {
      revision: 6, nodeTypes: [], nodeIssues: [],
      canvases: [{ id: canvasId, title: 'Board', revision: 6, nodes: [], connections: [] }],
      chats: [{ canvasId, nodeId, title: 'Chat', cwd: '/project', deleting: false, issue: null,
        threads: [{ sessionId, parentSessionId: null, inheritedEventCount: 0 }] }],
    }
    reply.resolve({ ok: true, value: { ok: true, sessionId, workspace: committed } })
    expect(await initial).toEqual({ ok: true, sessionId, workspace: committed })
    expect(await inserted).toBe(true)
    expect(createThread).toHaveBeenCalledExactlyOnceWith(initialRequest)
    expect(stage).toHaveBeenCalledExactlyOnceWith(initialRequest)
    expect(b.addReferences).toHaveBeenCalledTimes(2)
    expect(b.addReferences.mock.calls.map(([references]) => references[0]!.label)).toEqual([
      'source-folder/', 'another-folder/',
    ])
  })


  it.each(['operation-pending', 'transport failure'] as const)(
    'does not retry an unresolved target with a new creation identity after %s', async (failure) => {
      const canvasId = 'uncertain-batch-canvas' as CanvasId
      const unresolvedChat = 'unresolved-chat' as CanvasNodeId
      const independentChat = 'independent-chat' as CanvasNodeId
      const workspace: CanvasWorkspace = {
        revision: 50, nodeTypes: [], nodeIssues: [], chats: [],
        canvases: [{ id: canvasId, title: 'Board', revision: 5, nodes: [], connections: [] }],
      }
      const createThread = vi.fn<(request: CanvasThreadRequest) => Promise<{ ok: true; value: CanvasThreadResult }>>()
      const prepareReference = vi.fn(async (_canvasId: CanvasId, sourceId: CanvasNodeId) => ({
        ok: true as const,
        value: { path: `/project/${sourceId}`, name: sourceId, kind: 'file' as const, size: 1 },
      }))
      const b = await fixture({ createThread, prepareReference })
      createThread.mockImplementation(async (request) => {
        expect(request.expectedRevision).toBe(5)
        if (request.nodeId === unresolvedChat) {
          if (failure === 'transport failure') throw new Error('Reply lost')
          return { ok: true, value: { ok: false, code: 'operation-pending', message: 'pending', workspace } }
        }
        const sessionId = 'independent-thread' as SessionId
        await b.sessions.add({ id: sessionId })
        return { ok: true, value: {
          ok: true, sessionId, workspace: { ...workspace, canvases: [{ ...workspace.canvases[0]!, revision: 6 }] },
        } }
      })
      const injected = (b.ctx.slots.entries('shell.workspace')[0]!.inject as () => WorkspaceInjected & Record<string, unknown>)()
      expect(await injected.insertInputs(canvasId, 5, [
        { nodeId: unresolvedChat, sourceId: 'source-a' as CanvasNodeId },
        { nodeId: unresolvedChat, sourceId: 'source-b' as CanvasNodeId },
        { nodeId: independentChat, sourceId: 'source-c' as CanvasNodeId },
      ])).toBe(false)
      expect(createThread.mock.calls.map(([request]) => request.nodeId)).toEqual([unresolvedChat, independentChat])
      expect(prepareReference.mock.calls.map(([, sourceId]) => sourceId)).toEqual(['source-a', 'source-c'])
      expect(b.addReferences).toHaveBeenCalledOnce()
      expect(b.addReferences.mock.calls[0]![0][0]!.label).toBe('source-c')
    },
  )

})
