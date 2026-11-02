/** Convax Host: transactional graph commands and application-level resource reads. */
import { basename, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import configSchema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { CanvasRepository } from './repository.ts'
import { CanvasNodeRegistry } from './registry.ts'
import type { CanvasNodeDefinition } from './registry.ts'
import { CanvasMigrationCoordinator } from './migrations.ts'
import { registerCanvasTools } from './tools.ts'
import { registerGraphTools } from './graph-tools.ts'
import { registerConvaxDevelopment } from './development.ts'
import { CanvasDatabase } from './database.ts'
import { CanvasWorkingDirectories } from './directories.ts'
import { CanvasChatCoordinator } from './chats.ts'
import { CanvasDeliveryCoordinator } from './deliveries.ts'
import { registerCanvasAdmission } from './admission.ts'
import { canvasCommitRequestSchema } from './schema.ts'
import { readCanvasDocument } from './documents.ts'
import { CanvasMediaResponses, readCanvasMediaSource } from './media.ts'
import type {
  CanvasCommandRequest, CanvasCommandResult, CanvasDirectory, CanvasId, CanvasNodeId, CanvasNodeTypeId,
  CanvasPreview, CanvasDocumentPreview, CanvasMediaSource, CanvasResource, CanvasWorkspace, CanvasThreadRequest, CanvasThreadResult,
  CanvasOpenSessionRequest, CanvasOpenSessionResult,
  CanvasCommitRequest,
} from './types.ts'

export type * from './types.ts'
export { layoutGrid } from './layout.ts'
export type { CanvasGridLayout, CanvasLayoutNode } from './layout.ts'
export { CanvasNodeRegistry } from './registry.ts'
export type { CanvasNodeDefinition, CanvasNodeMigration } from './registry.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Authoritative canvas commands and resource reads, independent of renderer lifetime. */
    convax: ConvaxHost
  }
}

/** Cordis plugin name. */
export const name = 'convax-plugin-host'
/** Generic capabilities required by the Host. */
export const inject = [ 'fs', 'agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'tools', 'remoteAccess']

/** Deployment limits for one resource preview. */
export interface Config {
  /** Absolute path of the Convax-owned SQLite database. */
  databasePath: string
  /** Optional read-only graph source imported only when the owned database is new. */
  legacyDatabasePath?: string
  /** Absolute local parent for new canvases' default Chat working directories. */
  canvasDirectoryRoot: string
  /** Maximum UTF-8 preview bytes; the response explicitly marks truncation. */
  previewBytes: number
  /** Maximum complete source or rendered document bytes; oversized reads reject. */
  documentBytes: number
  /** Largest filesystem window buffered by one media response pull. */
  mediaChunkBytes: number
}
/** Validated resource-read configuration. */
export const Config: configSchema<Config> = configSchema.object({
  databasePath: configSchema.string().required(),
  legacyDatabasePath: configSchema.string(),
  canvasDirectoryRoot: configSchema.string().default(join(homedir(), 'Documents', 'convax')),
  previewBytes: configSchema.number().step(1).min(1).default(256 * 1024),
  documentBytes: configSchema.number().step(1).min(1).default(50 * 1024 * 1024),
  mediaChunkBytes: configSchema.number().step(1).min(1).default(256 * 1024),
})

/** Coordination owned by the composing plugin rather than Remote callers. */
interface HostIntegrations {
  directories?: CanvasWorkingDirectories
  admission?: () => Promise<void>
  chats?: CanvasChatCoordinator
  deliveries?: CanvasDeliveryCoordinator
  migrations?: CanvasMigrationCoordinator
  media?: () => Promise<void>
}

/** Host Remote namespace for canvases, Chat operations and resource access. */
export class ConvaxHost extends TypertRemoteService {
  private readonly documentScope = randomUUID()
  private readonly streams = new Set<() => void>()
  private readonly observations = new Set<{ close: () => Promise<void> }>()
  private readonly reads = new Set<Promise<unknown>>()
  private readonly lifetime = new AbortController()
  private closing: Promise<void> | undefined
  private closed = false

  /**
   * @param ctx - Owner context with generic filesystem access.
   * @param repository - Ready durable graph repository.
   * @param config - Validated resource limits.
   * @param integrations - Plugin-owned coordinators; absent capabilities remain unavailable.
   */
  constructor(
    ctx: Context, readonly repository: CanvasRepository, private readonly config: Pick<Config, 'previewBytes' | 'documentBytes' | 'mediaChunkBytes'>,
    private readonly integrations: HostIntegrations = {},
  ) {
    super(ctx, 'convax')
  }

  /**
   * Read the current graph and runtime provider metadata.
   * @returns Current committed canvases and available Host node types.
   */
  @Remote
  workspace(): CanvasWorkspace {
    const snapshot = this.repository.snapshot()
    if (this.ctx.get('sessionQuery') === undefined || this.ctx.get('workspaceRegistry') === undefined) {
      for (const chat of snapshot.chats) {
        chat.issue ??= 'Chat creation and deletion are unavailable in this profile'
      }
    }
    return snapshot
  }

  /**
   * Register a Host node provider independently of its client renderer.
   * @param definition - Stable type identity, current payload parser and optional pure upgrades.
   * @returns Effect disposer that cancels and drains this provider's asynchronous work.
   */
  registerNodeType(definition: CanvasNodeDefinition): () => Promise<void> {
    return this.repository.nodeTypes.register(definition)
  }

  /**
   * Retry incompatible nodes using the current provider without discarding original data.
   * @returns Once each attempted transform settles; failures remain in workspace diagnostics.
   */
  @Remote
  async retryMigrations(): Promise<void> {
    await this.integrations.migrations?.retry()
  }

  /**
   * Commit one graph mutation or return an explicit rejection.
   * @param request - Retry identity, expected revision and command.
   * @param signal - Optional cancellation before a graph commit; deletion intentions remain recoverable.
   * @returns Mutation outcome with a complete current snapshot.
   */
  @Remote
  async execute(request: CanvasCommandRequest, signal?: AbortSignal): Promise<CanvasCommandResult> {
    const combined = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
    const preparing = this.integrations.directories?.prepare(request, combined)
    if (preparing === undefined) return this.integrations.chats === undefined
      ? this.repository.execute(request, combined) : this.integrations.chats.execute(request, combined)
    return this.readResource(combined, async (operationSignal) => {
      await preparing
      return this.integrations.chats === undefined
        ? this.repository.execute(request, operationSignal) : this.integrations.chats.execute(request, operationSignal)
    })
  }

  /**
   * Return the canvas's local default working directory, creating it if needed.
   * @param canvasId - Existing canvas identity; existing Chat directories remain unchanged.
   * @param signal - Optional caller cancellation; Host shutdown cancels and drains the operation.
   * @returns Absolute directory usable by the composed filesystem, or an explicit failure.
   */
  @Remote
  ensureCanvasDirectory(canvasId: CanvasId, signal?: AbortSignal): Promise<string> {
    return this.readResource(signal, async (operationSignal) => {
      if (this.integrations.directories === undefined) throw new RemoteError('canvas-directory/unavailable', 'Canvas working directories are unavailable in this profile', {})
      return this.integrations.directories.ensure(canvasId, operationSignal)
    })
  }

  /**
   * Validate and commit ordered graph edits under one durable retry identity.
   * Resource creation checks do not repeat after a receipt or lifecycle intention exists.
   * @param input - One canvas version, retry identity and ordered semantic operations.
   * @param signal - Cancellation before graph publication; pending lifecycle work remains recoverable.
   * @returns Current workspace or an explicit conflict, failed operation, or recoverable lifecycle state.
   */
  async commit(input: CanvasCommitRequest, signal?: AbortSignal): Promise<CanvasCommandResult> {
    const request = canvasCommitRequestSchema.parse(input)
    const first = request.ops[0]
    const command: CanvasCommandRequest = {
      canvasId: request.canvasId, expectedRevision: request.expectedRevision, operationId: request.operationId,
      ...(request.confirmed === undefined ? {} : { confirmed: request.confirmed }),
      command: first?.op === 'history'
        ? { kind: 'history', targetOperationId: first.targetOperationId, direction: first.direction }
        : { kind: 'batch', ops: request.ops },
    }
    if (!this.repository.hasOperation(request.operationId)) {
      const types = new Map(this.workspace().canvases.find(canvas => canvas.id === request.canvasId)
        ?.nodes.map(node => [node.id, node.typeId]) ?? [])
      for (const op of request.ops) {
        if (op.op === 'node.add') types.set(op.id, op.typeId)
        if ((op.op === 'node.add' || op.op === 'node.set') && op.data !== undefined) {
          const type = types.get(op.id)
          if ((type === 'convax.file' || type === 'convax.folder') && typeof op.data.path === 'string') {
            const resource = await this.describe(op.data.path, signal)
            if (resource.kind !== (type === 'convax.file' ? 'file' : 'folder')) throw new RemoteError('gateway/bad-request', 'Resource kind does not match the node type', {})
          }
        }
        if (op.op === 'node.remove') types.delete(op.id)
      }
    }
    return this.execute(command, signal)
  }

  /**
   * Create or fork a durable thread inside one Chat without sending input.
   * @param request - Chat target, expected revision and stable retry identity.
   * @returns Actual DSH Session binding, or a recoverable failure.
   */
  @Remote
  createThread(request: CanvasThreadRequest): Promise<CanvasThreadResult> {
    if (this.integrations.chats === undefined) throw new RemoteError('gateway/bad-request', 'This profile does not provide Chat Session coordination', {})
    return this.integrations.chats.createThread(request)
  }

  /**
   * Open an original Session on a canvas, retaining its messages and schedule identity.
   * @param request - Existing Session, preferred canvas and retained Chat placement identity.
   * @returns Unique Chat location and complete workspace, or a rejection without creating a Session.
   */
  @Remote({ resources: { session: (request: CanvasOpenSessionRequest) => request.sessionId } })
  openSession(request: CanvasOpenSessionRequest): Promise<CanvasOpenSessionResult> {
    if (!this.ctx.remoteAccess.allows({ kind: 'global' })) throw new RemoteError('gateway/bad-request', 'Canvas workspace access is required', {})
    if (this.integrations.chats === undefined) throw new RemoteError('gateway/bad-request', 'This profile does not provide Chat Session coordination', {})
    return this.integrations.chats.openSession(request)
  }

  /**
   * Retry unfinished Chat operations and delivery catch-up using their saved identities.
   * @returns Once every retry has settled or exposed a retained failure.
   */
  @Remote
  async retryOperations(): Promise<void> {
    await this.integrations.chats?.recover()
    await this.integrations.deliveries?.retry()
  }

  /**
   * Follow committed workspace snapshots until cancellation or Host shutdown.
   * @param signal - Caller lifetime supplied by the Remote carrier.
   * @returns Initial snapshot followed by coalesced committed snapshots.
   */
  @Remote({ mode: 'stream' })
  async *watch(signal: AbortSignal): AsyncIterable<CanvasWorkspace> {
    let changed = true
    let wake: (() => void) | undefined
    const notify = (): void => { changed = true; wake?.() }
    const unsubscribe = this.repository.subscribe(notify)
    const stop = (): void => { unsubscribe(); wake?.() }
    this.streams.add(stop)
    signal.addEventListener('abort', stop, { once: true })
    try {
      while (!signal.aborted && !this.closed) {
        if (changed) {
          changed = false
          yield this.workspace()
        } else {
          await new Promise<void>((resolve) => { wake = resolve })
          wake = undefined
        }
      }
    } finally {
      unsubscribe()
      this.streams.delete(stop)
      signal.removeEventListener('abort', stop)
    }
  }

  /**
   * Resolve a resource explicitly chosen by the user without a hidden Session.
   * @param path - Absolute path in the composed filesystem world.
   * @param signal - Optional cancellation; absent reads run to completion.
   * @returns Existing file or directory metadata.
   */
  @Remote
  describe(path: string, signal?: AbortSignal): Promise<CanvasResource> {
    return this.readResource(signal, async (readSignal) => {
      if (!isAbsolute(path)) throw new RemoteError('gateway/bad-request', 'An absolute resource path is required', {})
      const target = await this.ctx.fs.resolve(path, { signal: readSignal })
      const info = await this.ctx.fs.stat(target, readSignal)
      if (info === undefined) throw new RemoteError('gateway/bad-request', `Resource is unavailable: ${path}`, {})
      const absolute = this.ctx.fs.processPath(target)
      return { path: absolute, name: basename(absolute) || absolute, kind: info.type === 'directory' ? 'folder' : info.type, size: info.size ?? null }
    })
  }

  /**
   * Resolve one node into an explicit composer reference without sending input.
   * The provider and node must remain current until resolution completes.
   * @param canvasId - Canvas containing the source node.
   * @param nodeId - Source node chosen by the connection gesture.
   * @param signal - Optional cancellation; absent work follows the Host lifetime.
   * @returns Filesystem-validated file or folder metadata; no graph or project mutation.
   */
  @Remote
  prepareReference(canvasId: CanvasId, nodeId: CanvasNodeId, signal?: AbortSignal): Promise<CanvasResource> {
    return this.readResource(signal, async (readSignal) => {
      const snapshot = this.repository.snapshot()
      const node = snapshot.canvases.find(canvas => canvas.id === canvasId)?.nodes.find(value => value.id === nodeId)
      if (node === undefined || snapshot.nodeIssues.some(issue => issue.nodeId === nodeId)) {
        throw new RemoteError('gateway/bad-request', 'The connected resource is unavailable or incompatible', {})
      }
      const definition = this.repository.nodeTypes.get(node.typeId)
      if (definition === undefined) {
        throw new RemoteError('gateway/bad-request', 'The connected resource provider is unavailable', {})
      }
      if (definition.dataVersion !== node.dataVersion) {
        throw new RemoteError('gateway/bad-request', 'The connected resource requires migration', {})
      }
      const prepare = async (providerSignal: AbortSignal): Promise<CanvasResource> => {
        const prepared = structuredClone(node)
        prepared.data = definition.parse(prepared.data)
        const path = definition.prepareInput === undefined ? prepared.data.path
          : (await definition.prepareInput(prepared, providerSignal)).path
        providerSignal.throwIfAborted()
        if (typeof path !== 'string') throw new RemoteError('gateway/bad-request', 'The connected node does not provide a resource path', {})
        const resource = await this.describe(path, providerSignal)
        if (resource.kind !== 'file' && resource.kind !== 'folder') {
          throw new RemoteError('gateway/bad-request', 'The connected resource is not a file or folder', {})
        }
        return resource
      }
      const resource = await this.repository.nodeTypes.use(definition, readSignal, prepare)
      const current = this.repository.snapshot()
      const currentNode = current.canvases.find(canvas => canvas.id === canvasId)?.nodes.find(value => value.id === nodeId)
      if (!isDeepStrictEqual(currentNode, node) || this.repository.nodeTypes.get(node.typeId) !== definition
        || current.nodeIssues.some(issue => issue.nodeId === nodeId)) {
        throw new RemoteError('gateway/bad-request', 'The connected resource changed while preparing its reference', {})
      }
      return resource
    })
  }

  /**
   * Read direct children of an explicitly selected folder.
   * @param path - Absolute directory path.
   * @param signal - Optional cancellation; absent reads run to completion.
   * @returns Sorted metadata; reading does not add nodes or change real files.
   */
  @Remote
  listDirectory(path: string, signal?: AbortSignal): Promise<CanvasDirectory> {
    return this.readResource(signal, async (readSignal) => {
      const directory = await this.describe(path, readSignal)
      if (directory.kind !== 'folder') throw new RemoteError('gateway/bad-request', 'Resource is not a directory', {})
      const target = await this.ctx.fs.resolve(directory.path, { signal: readSignal })
      const children = await this.ctx.fs.listDir(target, readSignal)
      const entries: CanvasResource[] = children.map(entry => ({
        path: this.ctx.fs.processPath(entry.target), name: entry.name,
        kind: entry.type === 'directory' ? 'folder' : entry.type === 'file' ? 'file' : 'other', size: entry.size ?? null,
      }))
      entries.sort((a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || a.name.localeCompare(b.name))
      return { path: directory.path, entries }
    })
  }

  /**
   * Preview UTF-8 text through the composed filesystem's existing access policy.
   * @param path - Absolute file path.
   * @param signal - Optional cancellation; absent reads run to completion.
   * @returns Text window with explicit truncation.
   */
  @Remote
  previewFile(path: string, signal?: AbortSignal): Promise<CanvasPreview> {
    return this.readResource(signal, async (readSignal) => {
      const resource = await this.describe(path, readSignal)
      if (resource.kind !== 'file') throw new RemoteError('gateway/bad-request', 'Resource is not a regular file', {})
      const target = await this.ctx.fs.resolve(resource.path, { signal: readSignal })
      const chunks = await this.ctx.fs.streamText(target, readSignal)
      let text = ''
      let bytes = 0
      let truncated = false
      for await (const chunk of chunks) {
        readSignal.throwIfAborted()
        for (const character of chunk) {
          const size = Buffer.byteLength(character)
          if (bytes + size > this.config.previewBytes) { truncated = true; break }
          text += character
          bytes += size
        }
        if (truncated) break
      }
      return { path: resource.path, text, truncated }
    })
  }

  /**
   * Read complete document bytes through the filesystem policy, converting Word and PowerPoint files with the shared service.
   * @param path - Absolute source path, independent of any Session.
   * @param signal - Optional caller cancellation; Host shutdown also cancels and drains the read.
   * @returns Caller-owned binary content and source metadata; oversized or changed sources reject.
   */
  @Remote
  readDocument(path: string, signal?: AbortSignal): Promise<CanvasDocumentPreview> {
    return this.readResource(signal, readSignal =>
      readCanvasDocument(this.ctx, path, this.config.documentBytes, this.documentScope, readSignal,
        (upstream, read) => this.readResource(upstream, read)))
  }

  /**
   * Authorize media content access without buffering the file or creating a Session.
   * @param path - Absolute source path.
   * @param signal - Optional caller cancellation; Host shutdown cancels and drains the authorization read.
   * @returns Metadata used by the version-pinned authenticated media URL.
   */
  @Remote
  mediaSource(path: string, signal?: AbortSignal): Promise<CanvasMediaSource> {
    return this.readResource(signal, readSignal => readCanvasMediaSource(this.ctx, path, readSignal))
  }

  /**
   * Observe resource metadata without reading file content.
   * @param path - Absolute file or folder reference.
   * @param signal - Remote consumer lifetime.
   * @returns Initial metadata and refreshed metadata after filesystem invalidations.
   */
  @Remote({ mode: 'stream' })
  watchResource(path: string, signal: AbortSignal): AsyncIterable<CanvasResource> {
    return this.observe(path, readSignal => this.describe(path, readSignal), signal)
  }

  /**
   * Observe directory contents without importing changed files into the canvas.
   * @param path - Absolute directory reference.
   * @param signal - Remote consumer lifetime.
   * @returns Initial listing and refreshed listings after filesystem invalidations.
   */
  @Remote({ mode: 'stream' })
  watchDirectory(path: string, signal: AbortSignal): AsyncIterable<CanvasDirectory> {
    return this.observe(path, readSignal => this.listDirectory(path, readSignal), signal)
  }

  /**
   * Observe a file preview without modifying its original content.
   * @param path - Absolute file reference.
   * @param signal - Remote consumer lifetime.
   * @returns Initial preview and refreshed previews after filesystem invalidations.
   */
  @Remote({ mode: 'stream' })
  watchFile(path: string, signal: AbortSignal): AsyncIterable<CanvasPreview> {
    return this.observe(path, readSignal => this.previewFile(path, readSignal), signal)
  }

  private readResource<T>(signal: AbortSignal | undefined, read: (readSignal: AbortSignal) => Promise<T>): Promise<T> {
    const readSignal = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
    const pending = Promise.resolve().then(() => {
      readSignal.throwIfAborted()
      return read(readSignal)
    }).then((value) => {
      readSignal.throwIfAborted()
      return value
    })
    this.reads.add(pending)
    void pending.then(() => { this.reads.delete(pending) }, () => { this.reads.delete(pending) })
    return pending
  }

  private async *observe<T>(path: string, read: (readSignal: AbortSignal) => Promise<T>, signal: AbortSignal): AsyncIterable<T> {
    const controller = new AbortController()
    const readSignal = AbortSignal.any([signal, this.lifetime.signal, controller.signal])
    let changed = true
    let failure: Error | undefined
    let wake: (() => void) | undefined
    let closeWatch: (() => Promise<void>) | undefined
    let closing: Promise<void> | undefined
    const observation = {
      close: (): Promise<void> => {
        closing ??= Promise.resolve().then(async () => {
          controller.abort()
          wake?.()
          await ready.then(() => {}, () => {})
          await closeWatch?.()
          this.observations.delete(observation)
        })
        return closing
      },
    }
    this.observations.add(observation)
    const ready = this.readResource(readSignal, async (watchSignal) => {
      await this.describe(path, watchSignal)
      const target = await this.ctx.fs.resolve(path, { signal: watchSignal })
      closeWatch = await this.ctx.fs.watch(target, (error) => {
        failure = error
        changed = true
        wake?.()
      }, watchSignal)
    })
    const stop = (): void => {
      void observation.close().catch((error: unknown) => {
        failure = error instanceof Error ? error : new Error(String(error))
        wake?.()
      })
    }
    readSignal.addEventListener('abort', stop, { once: true })
    try {
      await ready
      while (!readSignal.aborted && !this.closed) {
        if (failure !== undefined) throw failure
        if (changed) {
          changed = false
          yield await read(readSignal)
        } else {
          await new Promise<void>((resolve) => { wake = resolve })
          wake = undefined
        }
      }
    } finally {
      readSignal.removeEventListener('abort', stop)
      await observation.close()
    }
  }

  /**
   * Cancel and drain ancestry checks, Chat coordination, resource reads and observations before dependencies unload.
   * @returns Resolution after accepted work and watcher cleanup settle; independent of stream pulls.
   */
  close(): Promise<void> {
    this.closing ??= this.finishClose()
    return this.closing
  }

  private async finishClose(): Promise<void> {
    this.closed = true
    this.lifetime.abort()
    const coordination = Promise.allSettled([
      this.integrations.admission?.(), this.integrations.chats?.close(),
      this.integrations.deliveries?.close(), this.integrations.migrations?.close(),
      this.integrations.media?.(),
    ])
    for (const stop of this.streams) stop()
    this.streams.clear()
    const observations = await Promise.allSettled([...this.observations].map(observation => observation.close()))
    await Promise.allSettled([...this.reads])
    const coordinators = await coordination
    this.repository.close()
    const failures = [...observations, ...coordinators].filter(result => result.status === 'rejected').map((result): unknown => result.reason)
    if (failures.length > 0) throw new AggregateError(failures, 'Canvas resource observations failed to close')
  }
}

/**
 * Open durable state and install built-in providers under the Host lifecycle.
 * @param ctx - Composed Host context.
 * @param config - Validated plugin configuration.
 * @returns Once the repository and Remote service are ready.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  registerConvaxDevelopment(ctx)
  if (!isAbsolute(config.databasePath)) throw new Error('Convax databasePath must be absolute')
  if (config.legacyDatabasePath !== undefined && !isAbsolute(config.legacyDatabasePath)) throw new Error('Convax legacyDatabasePath must be absolute')
  if (!isAbsolute(config.canvasDirectoryRoot)) throw new Error('Convax canvasDirectoryRoot must be absolute')
  const domain = await CanvasDatabase.open({ path: config.databasePath, legacyPath: config.legacyDatabasePath })
  for (const warning of domain.migrationWarnings) ctx.logger.warn(warning)
  const resources: { service?: ConvaxHost } = {}
  let closeResources: () => Promise<void>
  try {
    closeResources = ctx.effect(() => async () => {
      try { await resources.service?.close() } finally { await domain.close() }
    }, 'convax: Host resources')
  } catch (error) {
    await domain.close()
    throw error
  }
  const reportObserverFailure = (error: unknown): void => { ctx.logger.error('Canvas observer failed after publication', error) }
  const registry = new CanvasNodeRegistry(reportObserverFailure)
  const resourceData = z.looseObject({ path: z.string().min(1) })
  for (const id of ['convax.file', 'convax.folder']) {
    ctx.effect(() => registry.register({
      id: id as CanvasNodeTypeId, dataVersion: 1,
      description: id === 'convax.file' ? 'Reference to an existing file; file contents remain in the filesystem.' : 'Reference to an existing folder; directory entries are read on demand.',
      dataSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1, description: 'Absolute path to an existing resource.' } }, required: ['path'], additionalProperties: true },
      ports: [{ id: 'input', direction: 'input', valueKind: 'resource' }, { id: 'output', direction: 'output', valueKind: 'resource' }],
      parse: data => ({ ...data, path: resourceData.parse(data).path }),
    }))
  }
  const windowData = z.strictObject({ bindingId: z.uuid(), name: z.string().trim().min(1) })
  ctx.effect(() => registry.register({
    id: 'convax.window' as CanvasNodeTypeId, dataVersion: 1,
    description: 'Selected application window. Live capture belongs to the current Desktop; graph data does not grant capture or input access.',
    dataSchema: { type: 'object', properties: {
      bindingId: { type: 'string', format: 'uuid', description: 'Selection identity; no native window or process handle.' },
      name: { type: 'string', minLength: 1, description: 'Display name of the explicitly selected window.' },
    }, required: ['bindingId', 'name'], additionalProperties: false },
    ports: [{ id: 'input', direction: 'input', valueKind: 'resource' }, { id: 'output', direction: 'output', valueKind: 'resource' }],
    parse: data => windowData.parse(data),
  }))
  const chatData = z.object({ title: z.string().trim().min(1), cwd: z.string().refine(isAbsolute, 'An absolute project directory is required') })
  ctx.effect(() => registry.register({
    id: 'convax.chat' as CanvasNodeTypeId, dataVersion: 1,
    description: 'Chat container with a project directory and independently created DSH Session threads.',
    dataSchema: { type: 'object', properties: { title: { type: 'string', minLength: 1 }, cwd: { type: 'string', description: 'Absolute project directory.' } }, required: ['title', 'cwd'], additionalProperties: false },
    ports: [{ id: 'input', direction: 'input', valueKind: 'resource' }, { id: 'output', direction: 'output', valueKind: 'resource' }],
    parse: data => chatData.parse(data),
  }))
  const repository = new CanvasRepository(domain, registry, reportObserverFailure)
  const integrations: HostIntegrations = { directories: new CanvasWorkingDirectories(ctx, domain, repository, config.canvasDirectoryRoot) }
  const service = new ConvaxHost(ctx, repository, config, integrations)
  resources.service = service
  const mediaResponses = new Set<CanvasMediaResponses>()
  integrations.media = async () => { await Promise.all([...mediaResponses].map(responses => responses.close())) }
  ctx.inject(['connection'], (scope) => {
    scope.effect(function* () {
      const responses = new CanvasMediaResponses(scope, config.mediaChunkBytes)
      yield scope.effect(() => {
        mediaResponses.add(responses)
        return async () => { await responses.close(); mediaResponses.delete(responses) }
      }, 'convax: media response bodies')
      yield scope.connection.fetch.register({
        path: '/api/convax/media', methods: ['GET', 'HEAD'], requestBody: 'buffered',
        fetch: request => responses.fetch(request),
      })
    }, 'convax: media HTTP route')
  })
  const migrations = new CanvasMigrationCoordinator(repository, reportObserverFailure)
  integrations.migrations = migrations
  await migrations.start()
  registerCanvasTools(ctx, service)
  registerGraphTools(ctx, service)
  ctx.effect(function* () {
    yield closeResources
    const removeAdmission = registerCanvasAdmission(ctx, repository)
    let admissionClosing: Promise<void> | undefined
    integrations.admission = () => admissionClosing ??= removeAdmission()
    yield removeAdmission
  }, 'convax: admission before resource close')
  const deliveries = new CanvasDeliveryCoordinator(ctx, repository)
  integrations.deliveries = deliveries
  await deliveries.start()
  ctx.inject(['workspaceRegistry', 'sessionQuery'], async (scope) => {
    const coordinator = new CanvasChatCoordinator(scope, repository)
    scope.effect(() => {
      integrations.chats = coordinator
      return async () => {
        await coordinator.close()
        if (integrations.chats === coordinator) delete integrations.chats
      }
    }, 'convax: Chat coordination')
    await coordinator.recover()
  })
}
