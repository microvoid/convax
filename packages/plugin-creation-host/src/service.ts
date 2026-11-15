/** Workbench routing and admitted media requests share one Host owner. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { CredentialKey, CredentialRef } from '@deepseek-ai/dsh-credentials/types'
import type { CanvasCommandResult, CanvasCommitRequest, CanvasOperationId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type {} from '@deepseek-ai/dsh-convax-plugin-host'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-fs'
import { CreationStore } from './store.ts'
import { CreationJobRunner } from './runner.ts'
import { CreationSerial } from './serial.ts'
import { connectAndApplyInput, generateInput, jsonObject, saveConnectionInput, workbenchData, workbenchRef, jobRecord } from './schema.ts'
import type { ConnectionRecord, JobRecord } from './schema.ts'
import { inspectMedia } from './media.ts'
import type { CreationCliInstallations } from './installations.ts'
import type { CreationProviderSetup } from './setup.ts'
import type { CancelReceipt, ConnectAndApplyInput, ConnectAndApplyResult, ConnectionId, ConnectionInspection, ConnectionSnapshot,
  ConnectionView, CreationInvocation, CreationProvider, PendingGenerationApproval,
  ProviderAuthorization, ProviderCanvasPage, ProviderCanvasResult,
  GenerateInput, GenerationCapability, JobId as CreationJobId, JobView as CreationJobView, JsonObject, MediaKind, OperationId, ProviderDescriptor, ProviderId, ProviderInstallation, ProviderPreparation, ProviderRequest, SaveConnectionInput, WorkbenchData, WorkbenchJobView, WorkbenchRef, WorkbenchView } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { convaxCreation: ConvaxCreationHost }
}

/** Owns workbench routing and durable generation; only workbench configuration is remotely callable. */
export class ConvaxCreationHost extends TypertRemoteService {
  private readonly providers = new Map<ProviderId, CreationProvider>()
  private readonly mutations = new CreationSerial()
  private readonly transientCredentials = new Map<CredentialKey, string>()
  constructor(ctx: Context, private readonly store: CreationStore,
    private readonly runner: CreationJobRunner, private readonly maxBytes: number,
    private readonly installations?: CreationCliInstallations, private readonly setup?: CreationProviderSetup) {
    super(ctx, 'convaxCreation')
  }

  /** Register a Host adapter and resume its unfinished jobs.
   * @param provider - Adapter owned by the mounting plugin.
   * @returns Disposer that unregisters the adapter and drains local operations without cancelling remote jobs.
   */
  registerProvider(provider: CreationProvider): () => Promise<void> {
    const id = provider.descriptor.id
    if (this.providers.has(id)) throw new Error(`Creation Provider ${id} is already registered`)
    this.providers.set(id, provider)
    this.runner.recover()
    return async () => { this.providers.delete(id); await this.runner.suspendProvider(id) }
  }
  /** Resolve an adapter for a captured job connection.
   * @param id - Registered Provider identifier.
   * @returns Loaded adapter, or undefined while its plugin is absent.
   */
  provider(id: string): CreationProvider | undefined { return this.providers.get(id as ProviderId) }

  /** List installed adapters without probing credentials or remote availability.
   * @returns Public configuration descriptors.
   */
  @Remote
  listProviders(): Promise<ProviderDescriptor[]> {
    return Promise.resolve([...this.providers.values()].map((provider) => {
      const installation = this.installations?.descriptor(provider.descriptor.id)
      return { ...provider.descriptor, ...this.setup?.descriptor(provider.descriptor.id),
        ...(installation === undefined ? {} : { installation }) }
    }))
  }

  /** Start an explicitly requested installation from the audited built-in distribution.
   * @param ref - Workbench whose configuration initiated installation.
   * @param providerId - Loaded built-in CLI Provider.
   * @returns Current Host-owned progress; readiness does not imply account login.
   */
  @Remote
  installProvider(ref: WorkbenchRef, providerId: ProviderId): Promise<ProviderInstallation> {
    this.requireWorkbench(ref)
    if (this.provider(providerId) === undefined || this.installations === undefined) throw new Error('CLI installation is not available')
    return Promise.resolve(this.installations.start(providerId))
  }

  /** Observe installation without initiating a download or authentication flow.
   * @param ref - Existing workbench requesting the observation.
   * @param providerId - Loaded Provider identity.
   * @returns Latest attempt state; safe to query after reopening the settings.
   */
  @Remote
  installationStatus(ref: WorkbenchRef, providerId: ProviderId): Promise<ProviderInstallation> {
    this.requireWorkbench(ref)
    if (this.provider(providerId) === undefined) throw new Error('The Provider is not loaded')
    return Promise.resolve(this.installations?.status(providerId) ?? { state: 'idle' })
  }

  /** Start or resume device authorization after an explicit workbench action.
   * @param input - Unsaved CLI settings; credentials are never returned.
   * @returns Safe browser link and Host-owned progress, never the device code.
   */
  @Remote
  beginAuthorization(input: SaveConnectionInput): Promise<ProviderAuthorization> {
    const { ref, connection, setup } = this.setupConnection(input)
    return setup.begin(ref, connection)
  }

  /** Observe a scoped authorization without initiating login or logging out.
   * @param input - The same executable, directory and profile as the initial request.
   * @returns Current safe authorization state.
   */
  @Remote
  authorizationStatus(input: SaveConnectionInput): Promise<ProviderAuthorization> {
    const { ref, connection, setup } = this.setupConnection(input)
    return setup.status(ref, connection)
  }

  /** Read one page of accessible provider canvases without selecting or creating one.
   * @param input - Current unsaved Provider connection settings.
   * @param cursor - Opaque continuation from the preceding page.
   * @returns Safe canvas summaries and an optional continuation.
   */
  @Remote
  listProviderCanvases(input: SaveConnectionInput, cursor?: string): Promise<ProviderCanvasPage> {
    const { ref, connection, setup } = this.setupConnection(input)
    return setup.list(ref, connection, cursor)
  }

  /** Create a canvas only from the explicit create action, retaining its retry identity.
   * @param input - Current Provider settings.
   * @param request - Name and stable UUID reused when the outcome is unknown.
   * @returns Created canvas summary or a safe recoverable failure.
   */
  @Remote
  createProviderCanvas(input: SaveConnectionInput, request: { name: string; requestId: string }): Promise<ProviderCanvasResult> {
    const { ref, connection, setup } = this.setupConnection(input)
    return setup.create(ref, connection, request)
  }

  private setupConnection(input: SaveConnectionInput): { ref: WorkbenchRef; connection: ConnectionSnapshot; setup: CreationProviderSetup } {
    const parsed = saveConnectionInput.parse(input)
    this.requireWorkbench(parsed.ref)
    const provider = this.provider(parsed.connection.providerId)
    if (provider === undefined || this.setup === undefined) throw new Error('Integrated Provider setup is not available')
    this.validateSettings(provider.descriptor, parsed.connection.settings, false)
    const previous = parsed.connection.id === undefined ? undefined : this.connectionOf(parsed.ref, parsed.connection.id)
    return { ref: parsed.ref, setup: this.setup,
      connection: this.connectionCandidate(parsed, parsed.connection.id ?? randomUUID() as ConnectionId, previous) }
  }

  /** List connections owned by an existing workbench.
   * @param ref - Workbench node identity.
   * @returns Safe configuration values and credential-presence flags, excluding secrets.
   */
  @Remote
  async listConnections(ref: WorkbenchRef): Promise<ConnectionView[]> {
    this.requireWorkbench(ref)
    return this.mutations.run('connections', async () => {
      await this.reconcileConnections(ref)
      return Promise.all([...this.store.connections.entries()].flatMap(([, value]) => {
        const visible = this.visibleConnection(value)
        return visible === undefined ? [] : [visible]
      })
        .filter(value => value.owner.canvasId === ref.canvasId && value.owner.nodeId === ref.nodeId)
        .map(value => this.connectionView(value)))
    })
  }

  /** Discover local readiness and model choices without saving configuration or credentials.
   * @param input - Partial connection settings and an optional transient key.
   * @returns Setup observations without creating a Provider connection.
   */
  @Remote
  async prepareConnection(input: SaveConnectionInput): Promise<ProviderPreparation> {
    const parsed = saveConnectionInput.parse(input)
    if (parsed.apiKey !== undefined && parsed.connection.credentialRef !== undefined) throw new Error('Choose an API key or an environment variable')
    this.requireWorkbench(parsed.ref)
    const provider = this.provider(parsed.connection.providerId)
    if (provider === undefined) return { state: 'unavailable', reason: 'provider-unloaded', message: 'The Provider is not loaded' }
    this.validateSettings(provider.descriptor, parsed.connection.settings, false)
    const previous = parsed.connection.id === undefined ? undefined : this.connectionOf(parsed.ref, parsed.connection.id)
    const candidate = this.connectionCandidate(parsed, parsed.connection.id ?? randomUUID() as ConnectionId, previous)
    return provider.prepare?.(candidate, AbortSignal.timeout(30_000), parsed.apiKey) ?? { state: 'ready', models: [] }
  }

  /** Connect a service and apply one selected media route or its supported empty routes.
   * @param input - Connection settings and current workbench edits sharing a retry identity.
   * @returns A committed workspace and connection, or a rejection retaining the existing configuration.
   */
  @Remote
  async connectAndApply(input: ConnectAndApplyInput): Promise<ConnectAndApplyResult> {
    const parsed = connectAndApplyInput.parse(input)
    if (parsed.apiKey !== undefined && parsed.connection.credentialRef !== undefined) throw new Error('Choose an API key or an environment variable')
    return this.mutations.run('connections', async () => {
      const { canvas, data } = this.requireWorkbench(parsed.ref)
      const id = parsed.connection.id ?? createHash('sha256').update(`${parsed.ref.canvasId}\0${parsed.ref.nodeId}\0${parsed.operationId}`).digest('hex') as ConnectionId
      const fingerprint = createHash('sha256').update(JSON.stringify(parsed)).digest('hex')
      const stored = this.store.connections.get(id)
      if (stored?.application?.operationId === parsed.operationId) {
        if (stored.application.fingerprint !== fingerprint) throw new Error('This operation already uses different connection settings')
        return this.commitConnection(stored)
      }
      if (this.ctx.convax.repository.hasOperation(parsed.operationId)) throw new Error('This operation identity has already been used')
      if (canvas.revision !== parsed.expectedRevision) return { ok: false, code: 'conflict',
        message: 'The canvas changed. Reload the workbench before connecting.', workspace: this.ctx.convax.workspace() }
      const previous = stored === undefined ? undefined : this.visibleConnection(stored)
      if (parsed.connection.id !== undefined && previous === undefined) throw new Error('Provider connection does not belong to this workbench')
      const provider = this.provider(parsed.connection.providerId)
      if (provider === undefined) return { ok: false, code: 'provider-unavailable', message: 'The Provider is not loaded', workspace: this.ctx.convax.workspace() }
      const candidate = this.connectionCandidate(parsed, id, previous)
      if (parsed.targetKind !== undefined && previous !== undefined) {
        for (const field of provider.descriptor.configuration ?? []) {
          if (field.mediaKind === undefined || field.mediaKind === parsed.targetKind) continue
          const value = previous.settings[field.key]
          if (value === undefined) Reflect.deleteProperty(candidate.settings, field.key)
          else candidate.settings[field.key] = value
        }
      }
      this.validateSettings(provider.descriptor, candidate.settings)
      const managedCanvas = candidate.providerId === 'jimeng-cli' && !candidate.settings.projectId
      const setup = managedCanvas ? this.setup : undefined
      if (managedCanvas && setup === undefined) throw new Error('Managed Provider setup is unavailable')
      if (setup !== undefined) {
        candidate.settings = { ...candidate.settings, projectId: await setup.managedCanvasId(parsed.ref, candidate) }
      }
      const credentialKey = parsed.apiKey === undefined ? undefined : `convax-creation/${id}-${candidate.revision}-${parsed.operationId}` as CredentialKey
      if (credentialKey !== undefined && parsed.apiKey !== undefined) {
        candidate.credential = { kind: 'record', key: credentialKey }
        this.transientCredentials.set(credentialKey, parsed.apiKey)
      }
      let staged = false
      try {
        const inspection = await provider.describe(candidate, AbortSignal.timeout(30_000))
        if (inspection.state !== 'ready') return { ok: false, code: 'provider-unavailable', message: inspection.message,
          inspection, workspace: this.ctx.convax.workspace() }
        if (inspection.capabilities.length === 0) return { ok: false, code: 'invalid-command', message: 'Select at least one generation model', workspace: this.ctx.convax.workspace() }
        if (parsed.targetKind !== undefined && !inspection.capabilities.some(value => value.kind === parsed.targetKind)) {
          return { ok: false, code: 'invalid-command', message: 'The selected Provider/model does not support this media type', workspace: this.ctx.convax.workspace() }
        }
        if (setup !== undefined) {
          const canvasSetup = await setup.ensureManagedCanvas(parsed.ref, candidate)
          if (canvasSetup.state !== 'ready') return { ok: false, code: 'provider-unavailable',
            message: canvasSetup.message, workspace: this.ctx.convax.workspace() }
        }
        const next = workbenchData.parse(parsed.data ?? data)
        const supported = new Set(inspection.capabilities.map(value => value.kind))
        const applied: MediaKind[] = []
        for (const kind of ['image', 'video', 'audio'] as const) {
          const route = next.routes[kind]
          if (parsed.targetKind !== undefined) {
            if (kind === parsed.targetKind) { next.routes[kind] = { connectionId: id }; applied.push(kind) }
            else if (route !== undefined) this.connectionOf(parsed.ref, route.connectionId)
            continue
          }
          if (route !== undefined && route.connectionId !== id) { this.connectionOf(parsed.ref, route.connectionId); continue }
          if (!supported.has(kind)) { Reflect.deleteProperty(next.routes, kind); continue }
          const modelField = provider.descriptor.configuration?.find(field => field.mediaKind === kind)?.key
          const modelChanged = previous !== undefined && modelField !== undefined
            && previous.settings[modelField] !== candidate.settings[modelField]
          next.routes[kind] = { connectionId: id,
            ...(route?.modelId === undefined || modelChanged ? {} : { modelId: route.modelId }),
            ...(route?.defaults === undefined || modelChanged ? {} : { defaults: route.defaults }) }
          applied.push(kind)
        }
        // Persist the candidate before the graph transaction. Readers use its receipt as the sole visibility boundary.
        const record: ConnectionRecord = { ...candidate, application: { phase: 'staged', operationId: parsed.operationId, fingerprint,
          expectedRevision: parsed.expectedRevision, data: next, inspection, applied,
          ...(previous === undefined ? {} : { previous }) } }
        if (credentialKey !== undefined && parsed.apiKey !== undefined) {
          const key = parsed.apiKey
          await this.ctx.credentials.modifyRecord(credentialKey, () => Promise.resolve({ kind: 'api-key', key }))
        }
        await this.store.connections.put(id, record)
        staged = true
        return await this.commitConnection(record)
      } finally {
        if (credentialKey !== undefined) {
          this.transientCredentials.delete(credentialKey)
          if (!staged) {
            // An unknown-state domain rejects reads: retain its credential until the durable candidate can be recovered.
            let candidateAbsent = false
            try { candidateAbsent = this.store.connections.get(id)?.application?.operationId !== parsed.operationId }
            catch { /* Quarantined storage owns recovery. */ }
            if (candidateAbsent) await this.ctx.credentials.deleteRecord(credentialKey)
          }
        }
      }
    })
  }

  private connectionCandidate(
    input: ReturnType<typeof saveConnectionInput.parse>, id: ConnectionId, previous?: ConnectionRecord,
  ): ConnectionRecord {
    if (previous !== undefined && (previous.owner.canvasId !== input.ref.canvasId || previous.owner.nodeId !== input.ref.nodeId)) throw new Error('The connection belongs to another workbench')
    if (previous !== undefined && previous.providerId !== input.connection.providerId) throw new Error('Create a new connection to change its Provider')
    const credential = input.connection.credentialRef === undefined ? previous?.credential
      : { kind: 'env' as const, ref: input.connection.credentialRef as CredentialRef }
    const settings = { ...input.connection.settings }
    if (input.connection.providerId === 'jimeng-cli' && settings.projectId === undefined && previous?.settings.projectId !== undefined) {
      settings.projectId = previous.settings.projectId
    }
    return { id, providerId: input.connection.providerId, label: input.connection.label, settings,
      revision: (previous?.revision ?? 0) + 1, accountBinding: previous?.accountBinding ?? id, owner: input.ref,
      ...(credential === undefined ? {} : { credential }) }
  }

  private async commitConnection(record: ConnectionRecord): Promise<ConnectAndApplyResult> {
    const application = record.application
    if (application === undefined) throw new Error('Missing connection application')
    const result = await this.ctx.convax.commit(this.applicationCommit(record))
    if (!result.ok) {
      if (application.phase !== 'applied') await this.discardConnection(record)
      return result
    }
    if (application.phase !== 'applied') {
      try { await this.store.connections.put(record.id, { ...record, application: { ...application, phase: 'applied' } }) }
      catch (error) { this.ctx.logger.warn('Creation connection committed; finalization will resume on retry', error) }
    }
    return { ok: true, workspace: this.ctx.convax.workspace(), connection: await this.connectionView(record),
      inspection: application.inspection, applied: application.applied }
  }

  private visibleConnection(record: ConnectionRecord): ConnectionRecord | undefined {
    if (record.application?.phase === 'staged' && !this.connectionCommitted(record)) return record.application.previous
    const { application: _application, ...visible } = record
    return visible
  }

  private connectionCommitted(record: ConnectionRecord): boolean {
    const request = this.applicationCommit(record)
    return this.ctx.convax.repository.hasCommittedOperation({ canvasId: request.canvasId, operationId: request.operationId,
      expectedRevision: request.expectedRevision, command: { kind: 'batch', ops: request.ops } })
  }

  private async discardConnection(record: ConnectionRecord): Promise<void> {
    const previous = record.application?.previous
    if (previous === undefined) await this.store.connections.delete(record.id)
    else await this.store.connections.put(record.id, previous)
    if (record.credential?.kind === 'record' && (previous?.credential?.kind !== 'record'
      || record.credential.key !== previous.credential.key)) await this.ctx.credentials.deleteRecord(record.credential.key)
  }

  /** Called under the mutation queue: never races an accepted in-flight configuration. */
  private async reconcileConnections(ref: WorkbenchRef): Promise<void> {
    for (const [, record] of this.store.connections.entries()) {
      if (record.owner.canvasId !== ref.canvasId || record.owner.nodeId !== ref.nodeId || record.application?.phase !== 'staged') continue
      if (this.connectionCommitted(record)) await this.store.connections.put(record.id, { ...record,
        application: { ...record.application, phase: 'applied' } })
      else await this.discardConnection(record)
    }
  }

  private applicationCommit(record: ConnectionRecord): CanvasCommitRequest {
    const application = record.application
    if (application === undefined) throw new Error('Missing connection application')
    return { canvasId: record.owner.canvasId, expectedRevision: application.expectedRevision, operationId: application.operationId,
      ops: [{ op: 'node.set', id: record.owner.nodeId, dataVersion: 1, data: jsonObject.parse(application.data) }] }
  }

  /** Save a versioned Provider connection; running jobs keep their captured configuration.
   * @param input - Workbench, settings and optional new credential.
   * @returns Safe connection view after durable storage succeeds.
   */
  @Remote
  async saveConnection(input: SaveConnectionInput): Promise<ConnectionView> {
    const parsed = saveConnectionInput.parse(input)
    if (parsed.apiKey !== undefined && parsed.connection.credentialRef !== undefined) throw new Error('Choose an API key or an environment variable')
    this.requireWorkbench(parsed.ref)
    const provider = this.provider(parsed.connection.providerId)
    if (provider === undefined) throw new Error('This Creation Provider is not loaded')
    this.validateSettings(provider.descriptor, parsed.connection.settings)
    return this.mutations.run('connections', async () => {
      const id = parsed.connection.id ?? randomUUID() as ConnectionId
      const stored = this.store.connections.get(id)
      const previous = stored === undefined ? undefined : this.visibleConnection(stored)
      if (previous !== undefined && (previous.owner.canvasId !== parsed.ref.canvasId || previous.owner.nodeId !== parsed.ref.nodeId)) throw new Error('The connection belongs to another workbench')
      if (previous !== undefined && previous.providerId !== parsed.connection.providerId) throw new Error('Create a new connection to change its Provider')
      const revision = (previous?.revision ?? 0) + 1
      let credential = parsed.connection.credentialRef === undefined ? previous?.credential
        : { kind: 'env' as const, ref: parsed.connection.credentialRef as CredentialRef }
      if (parsed.apiKey !== undefined) {
        const apiKey = parsed.apiKey
        const key = `convax-creation/${id}-${revision}` as CredentialKey
        await this.ctx.credentials.modifyRecord(key, () => Promise.resolve({ kind: 'api-key', key: apiKey }))
        credential = { kind: 'record', key }
      }
      const record: ConnectionRecord = { id, providerId: parsed.connection.providerId, label: parsed.connection.label,
        revision, settings: parsed.connection.settings, owner: parsed.ref, accountBinding: id,
        ...(credential === undefined ? {} : { credential }) }
      await this.store.connections.put(id, record)
      return this.connectionView(record)
    })
  }

  /** Probe configuration without starting a generation or logging in.
   * @param ref - Owning workbench.
   * @param id - Connection to inspect.
   * @returns Available capabilities or a configuration diagnosis.
   */
  @Remote
  async inspectConnection(ref: WorkbenchRef, id: ConnectionId): Promise<ConnectionInspection> {
    this.requireWorkbench(ref)
    const connection = this.effectiveConnection(ref, id)
    const provider = this.provider(connection.providerId)
    if (provider === undefined) return { state: 'unavailable', reason: 'provider-unloaded', message: 'The Provider is not loaded' }
    return provider.describe(connection, AbortSignal.timeout(30_000))
  }

  /** Read workbench configuration and current Provider inspections.
   * @param ref - Workbench node identity.
   * @returns Node data, graph revision and safe connection observations.
   */
  @Remote
  async describeWorkbench(ref: WorkbenchRef): Promise<WorkbenchView> {
    const connections = await this.listConnections(ref)
    const { canvas, data } = this.requireWorkbench(ref)
    return { ref, canvasRevision: canvas.revision, data, connections: await Promise.all(connections.map(async connection => ({
      connection, inspection: await this.inspectConnection(ref, connection.id),
    }))) }
  }

  /** Commit routes through the ordinary versioned canvas transaction.
   * @param input - Node data with the expected graph revision and operation identity.
   * @returns Existing graph command result, including revision conflicts.
   */
  @Remote
  async configureWorkbench(input: {
    ref: WorkbenchRef
    expectedRevision: number
    operationId: CanvasOperationId
    data: WorkbenchData
  }): Promise<CanvasCommandResult> {
    const current = this.requireWorkbench(input.ref)
    const data = workbenchData.parse(input.data)
    const request: CanvasCommitRequest = {
      canvasId: input.ref.canvasId, expectedRevision: input.expectedRevision, operationId: input.operationId,
      ops: [{ op: 'node.set', id: input.ref.nodeId, dataVersion: 1, data: jsonObject.parse(data) }],
    }
    if (this.ctx.convax.repository.hasCommittedOperation({ canvasId: request.canvasId, expectedRevision: request.expectedRevision,
      operationId: request.operationId, command: { kind: 'batch', ops: request.ops } })) return this.ctx.convax.commit(request)
    for (const [kind, route] of Object.entries(data.routes)) {
      const connection = this.effectiveConnection(input.ref, route.connectionId, data)
      const previous = current.data.routes[kind as MediaKind]
      if (previous?.connectionId === route.connectionId && previous.modelId === route.modelId) continue
      const provider = this.provider(connection.providerId)
      if (provider === undefined) throw new Error('The configured Creation Provider is unavailable')
      const inspection = await provider.describe(connection, AbortSignal.timeout(30_000))
      if (inspection.state !== 'ready') throw new Error(inspection.message)
      if (!inspection.capabilities.some(value => value.kind === kind && (route.modelId === undefined || value.modelId === route.modelId))) {
        throw new Error('The selected Provider/model does not support this media type')
      }
    }
    return this.ctx.convax.commit(request)
  }

  /** Resolve the workbench connected to the Session's owning Chat.
   * @param sessionId - Original DSH Session.
   * @returns One capability source, or undefined when disconnected or deleting.
   */
  resolveWorkbench(sessionId: CreationInvocation['sessionId']): WorkbenchRef | undefined {
    const binding = this.ctx.convax.repository.bindingOf(sessionId)
    if (binding === undefined || this.ctx.convax.repository.isDeleting(binding.canvasId, binding.nodeId)) return undefined
    const canvas = this.ctx.convax.workspace().canvases.find(value => value.id === binding.canvasId)
    if (!canvas?.nodes.some(node => node.id === binding.nodeId)) return undefined
    const edges = canvas.connections.filter(edge => edge.target === binding.nodeId && edge.purpose === 'capability'
      && canvas.nodes.some(node => node.id === edge.source && node.typeId === 'convax.creation'))
    return edges.length === 1 && edges[0] !== undefined ? { canvasId: binding.canvasId, nodeId: edges[0].source } : undefined
  }

  /** Admit one generation per real tool invocation and start its Host-owned task.
   * @param raw - Media request and references, validated against the selected Provider.
   * @param caller - Trusted Session and tool coordinates supplied by the Host tool adapter.
   * @returns Stable admission receipt; generation and automatic delivery continue independently.
   */
  async generate(raw: GenerateInput, caller: CreationInvocation): Promise<{ jobId: CreationJobId; state: 'queued' }> {
    const input = generateInput.parse(raw)
    const id = createHash('sha256').update(`${caller.sessionId}\0${caller.turn}\0${caller.callId}`).digest('hex') as CreationJobId
    return this.mutations.run(id, async () => {
      const prior = this.store.jobs.get(id)
      if (prior !== undefined) {
        this.ownJob(id, caller)
        if (JSON.stringify(prior.input) !== JSON.stringify(input)) throw new Error('This invocation already submitted a different generation request')
        return { jobId: id, state: 'queued' }
      }
      const ref = this.resolveWorkbench(caller.sessionId)
      if (ref === undefined) throw new Error('Connect this Chat to a Creation workbench before generating media')
      const { data } = this.requireWorkbench(ref)
      const binding = this.ctx.convax.repository.bindingOf(caller.sessionId)
      if (binding === undefined) throw new Error('The source Chat is no longer available')
      const route = data.routes[input.kind]
      if (route === undefined) throw new Error(`Configure ${input.kind} generation in the connected Creation workbench`)
      const connection = this.effectiveConnection(ref, route.connectionId)
      const provider = this.provider(connection.providerId)
      if (provider === undefined) throw new Error('The configured Creation Provider is unavailable')
      const inspection = await provider.describe(connection, AbortSignal.timeout(30_000))
      if (inspection.state !== 'ready') throw new Error(inspection.message)
      const capability = inspection.capabilities.find(value => value.kind === input.kind
        && (route.modelId === undefined || value.modelId === route.modelId))
      if (capability === undefined) throw new Error('The selected Provider/model does not support this media type')
      const parameters = { ...route.defaults, ...input.parameters }
      const errors = validateJsonSchemaValue(capability.parameterSchema, parameters)
      if (errors.length > 0) throw new Error(`Unsupported generation parameters: ${errors.join('; ')}`)
      const references = input.references ?? []
      for (const reference of references) if (!capability.inputs.some(value => value.role === reference.role)) throw new Error(`Unsupported reference role: ${reference.role}`)
      for (const rule of capability.inputs) {
        const count = references.filter(value => value.role === rule.role).length
        if (count < rule.minItems || count > rule.maxItems) throw new Error(`Reference role ${rule.role} requires ${rule.minItems}–${rule.maxItems} files`)
      }
      const directory = join(await this.ctx.convax.ensureCanvasDirectory(ref.canvasId), '.creation', id)
      await mkdir(directory, { recursive: true })
      const request: ProviderRequest = { kind: input.kind, prompt: input.prompt, parameters, references: [],
        ...(capability.modelId === undefined ? {} : { modelId: capability.modelId }) }
      const prepared: ProviderRequest['references'][number][] = []
      for (const [index, reference] of references.entries()) {
        const path = 'path' in reference.source ? reference.source.path : this.assetPath(reference.source.assetId, caller)
        const chat = this.ctx.convax.repository.getChat(ref.canvasId, binding.nodeId)
        const target = await this.ctx.fs.resolve(path, chat?.cwd === undefined ? {} : { cwd: chat.cwd })
        const info = await this.ctx.fs.stat(target)
        if (info?.type !== 'file' || info.size === undefined || info.size <= 0 || info.size > this.maxBytes) throw new Error('Reference must be a readable media file within the byte limit')
        const destination = join(directory, `reference-${index}`)
        const output = await open(destination, 'w', 0o600)
        try {
          for (let offset = 0; offset < info.size; offset += 1024 * 1024) {
            const bytes = await this.ctx.fs.readByteRange(target, { offset, length: Math.min(1024 * 1024, info.size - offset) })
            if (bytes.length === 0) throw new Error('Reference file changed while reading')
            await output.write(bytes)
          }
          await output.sync()
        } finally { await output.close() }
        const media = await inspectMedia(destination, this.maxBytes)
        const rule = capability.inputs.find(value => value.role === reference.role)
        if (!rule?.kinds.includes(media.kind)) throw new Error(`Reference ${reference.role} does not support ${media.kind}`)
        prepared.push({ role: reference.role, path: destination, kind: media.kind, mimeType: media.mimeType })
      }
      const job = jobRecord.parse({ id, operationId: id as string as OperationId, input, admittedAt: Date.now(),
        origin: { canvasId: ref.canvasId, chatNodeId: binding.nodeId, workbenchNodeId: ref.nodeId,
          sessionId: caller.sessionId, turn: caller.turn, callId: caller.callId },
        connection, request: { ...request, references: prepared }, directory, maxOutputs: capability.maxOutputs, state: 'queued', generationDone: false, outputs: [], issues: [] })
      await this.store.jobs.put(id, job)
      this.runner.start(id)
      return { jobId: id, state: 'queued' }
    })
  }

  /** Expose selected generation capabilities without connection settings or credentials.
   * @param caller - Trusted Session context.
   * @returns Parameter schemas, reference roles and configured defaults for selected routes.
   */
  async describe(caller: CreationInvocation): Promise<{ capability: GenerationCapability; defaults: JsonObject }[]> {
    const ref = this.resolveWorkbench(caller.sessionId)
    if (ref === undefined) throw new Error('Connect this Chat to a Creation workbench before generating media')
    const { data } = this.requireWorkbench(ref)
    const result: { capability: GenerationCapability; defaults: JsonObject }[] = []
    for (const [kind, route] of Object.entries(data.routes)) {
      const inspection = await this.inspectConnection(ref, route.connectionId)
      if (inspection.state !== 'ready') throw new Error(inspection.message)
      const capability = inspection.capabilities.find(value => value.kind === kind
        && (route.modelId === undefined || route.modelId === value.modelId))
      if (capability !== undefined) result.push({ capability, defaults: route.defaults ?? {} })
    }
    return result
  }

  /** Retain task tools for prior work after its workbench is disconnected.
   * @param sessionId - Session whose task ownership is checked.
   * @returns Whether the Session owns any durable Creation job.
   */
  hasJobs(sessionId: CreationInvocation['sessionId']): boolean {
    return [...this.store.jobs.entries()].some(([, job]) => job.origin.sessionId === sessionId)
  }

  /** Read one job without polling or resubmitting to a Provider.
   * @param id - Durable job identity.
   * @param caller - Session owner; cross-Session access is rejected.
   * @returns Generation, file and delivery status without private Provider state.
   */
  getJob(id: CreationJobId, caller: CreationInvocation): Promise<CreationJobView> {
    return Promise.resolve(this.view(this.ownJob(id, caller)))
  }
  /** Resume status queries, transfer or publication for an existing job.
   * @param id - Durable job identity.
   * @param caller - Session owner.
   * @returns Status after scheduling recovery; never starts a second paid generation.
   */
  async retryJob(id: CreationJobId, caller: CreationInvocation): Promise<CreationJobView> {
    this.ownJob(id, caller)
    await this.runner.retry(id)
    return this.view(this.store.get(id))
  }
  /** Suppress future deliveries and request remote cancellation where supported.
   * @param id - Durable job identity.
   * @param caller - Session owner.
   * @returns Local suppression receipt and the separate Provider cancellation result.
   */
  async cancelJob(id: CreationJobId, caller: CreationInvocation): Promise<CancelReceipt> {
    this.ownJob(id, caller)
    return this.runner.cancel(id)
  }

  /** Read pending quotes belonging to this workbench without accepting any charge.
   * @param ref - Existing workbench whose pending generations are shown.
   * @returns User-reviewable prompts and current quotes only.
   */
  @Remote
  listPendingApprovals(ref: WorkbenchRef): Promise<readonly PendingGenerationApproval[]> {
    this.requireWorkbench(ref)
    return Promise.resolve([...this.store.jobs.entries()].flatMap(([, job]) =>
      job.origin.canvasId === ref.canvasId && job.origin.workbenchNodeId === ref.nodeId
        && job.state === 'awaiting-approval' && job.approval !== undefined
        ? [{ jobId: job.id, kind: job.request.kind, prompt: job.request.prompt, approval: job.approval }] : []))
  }

  /** Observe active tasks and the latest twenty settled tasks without polling or mutating the Provider.
   * @param ref - Workbench owning the task history.
   * @returns Admission order, with stable identity order for legacy records, and safe task metadata.
   */
  @Remote
  listWorkbenchJobs(ref: WorkbenchRef): Promise<readonly WorkbenchJobView[]> {
    this.requireWorkbench(ref)
    const jobs = [...this.store.jobs.entries()].map(([, job]) => job)
      .filter(job => job.origin.canvasId === ref.canvasId && job.origin.workbenchNodeId === ref.nodeId)
      .sort((left, right) => (left.admittedAt ?? 0) - (right.admittedAt ?? 0) || left.id.localeCompare(right.id))
    const settled = new Set(jobs.filter(job => ['completed', 'failed', 'cancelled'].includes(job.state)).slice(-20).map(job => job.id))
    return Promise.resolve(jobs.filter(job => !['completed', 'failed', 'cancelled'].includes(job.state) || settled.has(job.id))
      .map(job => ({ ...this.view(job), prompt: job.request.prompt })))
  }

  /** Accept the exact displayed quote for one owned generation.
   * @param input - Workbench, generation and current quote identity from the explicit approval action.
   * @returns After approval is durably accepted; generation continues under the existing job.
   */
  @Remote
  async approveGeneration(input: { ref: WorkbenchRef; jobId: CreationJobId; quoteId: string }): Promise<void> {
    this.workbenchJob(input.ref, input.jobId)
    await this.runner.approve(input.jobId, input.quoteId)
  }

  /** Decline one owned generation and suppress its future delivery.
   * @param input - Workbench and generation identity from the explicit decline action.
   * @returns After the cancellation request is recorded.
   */
  @Remote
  async rejectGeneration(input: { ref: WorkbenchRef; jobId: CreationJobId }): Promise<void> {
    this.workbenchJob(input.ref, input.jobId)
    await this.runner.cancel(input.jobId)
  }

  /** Include committed background asset references in the next model turn.
   * @param sessionId - Session receiving the context.
   * @returns Configured media and recent tasks, or an empty string for unrelated Sessions.
   */
  runtimeContext(sessionId: CreationInvocation['sessionId']): string {
    const ref = this.resolveWorkbench(sessionId)
    const jobs = [...this.store.jobs.entries()].map(([, job]) => job).filter(job => job.origin.sessionId === sessionId).slice(-4)
    if (ref === undefined && jobs.length === 0) return ''
    const kinds = ref === undefined ? [] : Object.keys(this.requireWorkbench(ref).data.routes)
    return [
      'Creation uses the connected workbench. Generated files are delivered automatically; do not present them again.',
      `Configured media: ${kinds.join(', ') || 'none'}. creation_describe supplies current parameter schemas and reference roles.`,
      'An awaiting-approval task has not started paid generation. User consent is recorded in the workbench; resubmitting cannot replace that consent.',
      `Recent creation tasks: ${JSON.stringify(jobs.map(job => ({ jobId: job.id, kind: job.request.kind, state: job.state,
        outputs: job.outputs.slice(0, 4).map(output => ({ assetId: output.assetId, kind: output.output.kind, path: output.file?.path })) })))}`,
    ].join('\n')
  }

  /** Resolve the captured credential only inside a trusted Host adapter.
   * @param connection - Versioned connection snapshot owned by a job or inspection.
   * @returns Secret value, or undefined if unconfigured; never exposed through Remote methods.
   */
  async readCredential(connection: ConnectionSnapshot): Promise<string | undefined> {
    if (connection.credential === undefined) return undefined
    if (connection.credential.kind === 'env') return (await this.ctx.credentials.resolve(connection.credential.ref))?.value
    const transient = this.transientCredentials.get(connection.credential.key)
    if (transient !== undefined) return transient
    const record = await this.ctx.credentials.readRecord(connection.credential.key)
    return record?.kind === 'api-key' ? record.key : undefined
  }

  private async connectionView(record: ConnectionRecord): Promise<ConnectionView> {
    const credentialConfigured = record.credential === undefined ? false : record.credential.kind === 'env'
      ? (await this.ctx.credentials.describe(record.credential.ref)).configured
      : (await this.ctx.credentials.describeRecord(record.credential.key)).configured
    return { id: record.id, providerId: record.providerId, label: record.label,
      revision: record.revision, settings: record.settings, credentialConfigured }
  }
  private connectionOf(ref: WorkbenchRef, id: ConnectionId): ConnectionRecord {
    const stored = this.store.connections.get(id)
    const record = stored === undefined ? undefined : this.visibleConnection(stored)
    if (record === undefined || record.owner.canvasId !== ref.canvasId || record.owner.nodeId !== ref.nodeId) throw new Error('Provider connection does not belong to this workbench')
    return record
  }
  private effectiveConnection(ref: WorkbenchRef, id: ConnectionId, data = this.requireWorkbench(ref).data): ConnectionRecord {
    const connection = this.connectionOf(ref, id)
    const settings = { ...connection.settings }
    const fields = this.provider(connection.providerId)?.descriptor.configuration ?? []
    for (const [kind, route] of Object.entries(data.routes)) {
      if (route.connectionId !== id || route.modelId === undefined) continue
      const field = fields.find(value => value.mediaKind === kind)
      if (field !== undefined) settings[field.key] = route.modelId
    }
    return { ...connection, settings }
  }
  private requireWorkbench(raw: WorkbenchRef) {
    const ref = workbenchRef.parse(raw)
    const canvas = this.ctx.convax.workspace().canvases.find(value => value.id === ref.canvasId)
    const node = canvas?.nodes.find(value => value.id === ref.nodeId && value.typeId === 'convax.creation')
    if (canvas === undefined || node === undefined) throw new Error('Creation workbench was not found')
    return { canvas, node, data: workbenchData.parse(node.data) }
  }
  private ownJob(id: CreationJobId, caller: CreationInvocation): JobRecord {
    const job = this.store.get(id)
    if (job.origin.sessionId !== caller.sessionId) throw new Error('This task belongs to another conversation')
    return job
  }
  private workbenchJob(ref: WorkbenchRef, id: CreationJobId): JobRecord {
    this.requireWorkbench(ref)
    const job = this.store.get(id)
    if (job.origin.canvasId !== ref.canvasId || job.origin.workbenchNodeId !== ref.nodeId) {
      throw new Error('This generation belongs to another workbench')
    }
    return job
  }
  private assetPath(id: string, caller: CreationInvocation): string {
    for (const [, job] of this.store.jobs.entries()) {
      if (job.origin.sessionId !== caller.sessionId) continue
      const asset = job.outputs.find(value => value.assetId === id)
      if (asset?.file !== undefined) return asset.file.path
    }
    throw new Error('Media reference is unavailable in this conversation; attach the file to use it here')
  }
  private view(job: JobRecord): CreationJobView {
    const succeeded = job.outputs.filter(value => value.delivery === 'published' || value.delivery === 'projected').length
    return { jobId: job.id, kind: job.request.kind, state: job.state,
      ...(job.state === 'awaiting-approval' && job.approval !== undefined ? { approval: job.approval } : {}),
      ...(job.state === 'completed' || job.state === 'failed' ? { outcome: succeeded > 0 && succeeded === job.outputs.length && job.issues.length === 0 ? 'all-succeeded' as const : succeeded > 0 ? 'partially-succeeded' as const : 'none-succeeded' as const } : {}),
      outputs: job.outputs.map(value => ({ assetId: value.assetId, kind: value.output.kind, filename: value.filename,
        ...(value.file === undefined ? {} : { file: value.file }), delivery: value.delivery, issues: value.issues })), issues: job.issues,
      ...(job.cancellation === undefined ? {} : { cancellation: job.cancellation }) }
  }
  private validateSettings(descriptor: ProviderDescriptor, settings: ConnectionSnapshot['settings'], requireFields = true): void {
    for (const key of Object.keys(settings)) if (!descriptor.configuration?.some(field => field.key === key)) throw new Error(`Unknown Provider setting: ${key}`)
    for (const field of descriptor.configuration ?? []) {
      const value = settings[field.key]
      if (value === undefined || value === '') { if (requireFields && field.required) throw new Error(`${field.label} is required`); continue }
      const type = field.type === 'url' ? 'string' : field.type === 'text' ? 'string' : field.type
      if (typeof value !== type) throw new Error(`Invalid ${field.label}`)
    }
  }
  /** Drain local operations before the owning plugin closes storage.
   * @returns Once local tasks and accepted configuration mutations have settled.
   */
  async close(): Promise<void> {
    await this.setup?.close()
    await this.installations?.close()
    await this.runner.close()
    await this.mutations.drain()
  }
}
