/** Window-owned workbench configuration workflows; React only renders their snapshots. */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { CanvasNodeId, CanvasOperationId, CanvasWorkspace } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type {
  ConnectionId, ConnectionView, CreationRemote, JobId, MediaKind, ProviderDescriptor, ProviderId, ProviderPreparation,
  SaveConnectionInput, WorkbenchData, WorkbenchRef, WorkbenchView,
} from '@deepseek-ai/dsh-convax-plugin-creation-host/types'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { CreationKey } from './locales.ts'
import { CreationInstallationObserver, installationActive, type InstallationObservation } from './installations.ts'
import { CreationAuthorizationObserver, authorizationActive, type AuthorizationObservation } from './authorizations.ts'
import { CreationApprovals, type ApprovalState, type DisplayedQuote } from './approvals.ts'
import { CreationModelSelection, providerSupportsKind, type ModelSelectionState } from './models.ts'

/** An unsaved connection; secrets and the idempotency key survive a retry, never dismissal. */
export interface ConnectionDraft {
  id?: ConnectionId
  providerId: ProviderId
  label: string
  settings: ConnectionView['settings']
  enabledKinds: readonly MediaKind[]
  credentialSource: 'key' | 'environment'
  credentialRef: string
  apiKey: string
  operationId: CanvasOperationId
  targetKind?: MediaKind
}

/** One node's visible configuration state. */
export interface WorkbenchState {
  open: boolean
  choosing: boolean
  loading: boolean
  saving: boolean
  preparing: boolean
  preparation: ProviderPreparation | undefined
  installation: InstallationObservation | undefined
  authorization: AuthorizationObservation | undefined
  tasksOpen: boolean
  chatPending: boolean
  models: ModelSelectionState | undefined
  approvals: ApprovalState | undefined
  error: CreationKey | null
  issue: string | undefined
  view: WorkbenchView | undefined
  draft: WorkbenchData | undefined
  providers: readonly ProviderDescriptor[]
  connections: readonly ConnectionView[]
  connectionDraft: ConnectionDraft | undefined
  targetKind: MediaKind | undefined
}

interface WorkbenchEntry {
  ref: WorkbenchRef
  revision: number
  epoch: number
  preparationEpoch: number
  installer: CreationInstallationObserver | undefined
  installationRequested: boolean
  resumeInstallation: { providerId: ProviderId; connectionId?: ConnectionId; requested: boolean; targetKind?: MediaKind } | undefined
  authorizer: CreationAuthorizationObserver | undefined
  models: CreationModelSelection | undefined
  resumeAuthorization: ConnectionDraft | undefined
  approvals: CreationApprovals | undefined
  state: SnapshotStore<WorkbenchState>
}

function defaults(provider: ProviderDescriptor): ConnectionView['settings'] {
  return Object.fromEntries((provider.configuration ?? [])
    .flatMap(field => field.default === undefined ? [] : [[field.key, field.default]]))
}

function enabledKinds(provider: ProviderDescriptor, settings: ConnectionView['settings']): MediaKind[] {
  const selected = (provider.configuration ?? [])
    .flatMap(field => field.mediaKind !== undefined && (field.required || settings[field.key]) ? [field.mediaKind] : [])
  return selected.length ? selected : provider.supportedKinds?.slice(0, 1) ?? []
}

function connectionInput(entry: WorkbenchEntry, draft: ConnectionDraft): SaveConnectionInput {
  const settings = structuredClone(draft.settings)
  const provider = entry.state.getSnapshot().providers.find(item => item.id === draft.providerId)
  for (const field of provider?.configuration ?? []) {
    if (field.mediaKind === undefined) continue
    if (draft.targetKind !== undefined && draft.targetKind !== field.mediaKind && draft.id !== undefined) continue
    if (!draft.enabledKinds.includes(field.mediaKind)) Reflect.deleteProperty(settings, field.key)
  }
  return { ref: entry.ref, connection: { ...(draft.id === undefined ? {} : { id: draft.id }), providerId: draft.providerId,
    label: draft.label.trim() || provider?.title || draft.providerId, settings,
    ...(draft.credentialSource === 'environment' && draft.credentialRef.trim() !== '' ? { credentialRef: draft.credentialRef.trim() } : {}),
  }, ...(draft.credentialSource === 'key' && draft.apiKey !== '' ? { apiKey: draft.apiKey } : {}) }
}

/** Owns asynchronous configuration independently of card remounts or active canvas selection. */
export class CreationWorkbenches {
  private readonly entries = new Map<CanvasNodeId, WorkbenchEntry>()
  private disposed = false

  /** @param remote - Unwrapped generated Remote methods. @param publish - Adopt committed graph snapshots. */
  constructor(private readonly remote: CreationRemote, private readonly publish: (workspace: CanvasWorkspace) => void,
    private readonly report: (error: unknown) => void, private readonly openExternal: (url: string) => void = () => {}) {}

  /** Track durable workbench membership without taking ownership of Chat or output nodes. */
  observe(workspace: CanvasWorkspace): void {
    if (this.disposed) return
    const present = new Set<CanvasNodeId>()
    for (const canvas of workspace.canvases) for (const node of canvas.nodes) {
      if (node.typeId !== 'convax.creation') continue
      present.add(node.id)
      const previous = this.entries.get(node.id)
      if (previous !== undefined) {
        if (previous.revision === node.revision) continue
        previous.revision = node.revision
        if (!previous.state.getSnapshot().open) void this.refresh(previous)
        continue
      }
      const entry: WorkbenchEntry = { ref: { canvasId: canvas.id, nodeId: node.id }, revision: node.revision, epoch: 0, preparationEpoch: 0,
        installer: undefined, installationRequested: false, resumeInstallation: undefined,
        authorizer: undefined, models: undefined, resumeAuthorization: undefined, approvals: undefined,
        state: createSnapshotStore<WorkbenchState>({ open: false, choosing: false, loading: true, saving: false,
          preparing: false, preparation: undefined, installation: undefined, authorization: undefined,
          tasksOpen: false, chatPending: false, models: undefined, approvals: undefined, error: null, issue: undefined,
          view: undefined, draft: undefined, providers: [], connections: [], connectionDraft: undefined, targetKind: undefined }) }
      this.entries.set(node.id, entry)
      entry.approvals = new CreationApprovals(this.remote, entry.ref,
        (approvals) => { entry.state.update((state) => { state.approvals = approvals }) }, this.report)
      entry.models = new CreationModelSelection(this.remote, entry.ref, () => entry.state.getSnapshot().view,
        () => entry.state.getSnapshot().providers,
        (models) => { entry.state.update((state) => { state.models = models }) },
        (updated) => {
          const epoch = entry.epoch
          this.publish(updated)
          if (entry.epoch === epoch) void this.refresh(entry)
        }, this.report)
      void entry.approvals.refresh()
      void this.refresh(entry)
    }
    for (const [id, entry] of this.entries) if (!present.has(id)) {
      entry.epoch += 1; entry.preparationEpoch += 1
      entry.installer?.dispose(); this.stopSetup(entry); entry.approvals?.dispose(); entry.models?.dispose(); this.entries.delete(id)
    }
  }

  /** @returns The node's framework-observable state. */
  state(id: CanvasNodeId): SnapshotStore<WorkbenchState> | undefined { return this.entries.get(id)?.state }

  /** Task status is independent of the service configuration dialog. */
  tasks(id: CanvasNodeId, open: boolean): void {
    const entry = this.entries.get(id)
    if (entry === undefined) return
    entry.state.update((state) => { state.tasksOpen = open })
    if (open) void entry.approvals?.refresh()
  }

  /** Confirm exactly the displayed quotes with one user action. */
  async approveBatch(id: CanvasNodeId, quotes: readonly DisplayedQuote[]): Promise<void> {
    await this.entries.get(id)?.approvals?.approveBatch(quotes)
  }
  /** Cancel a task before paid generation begins. */
  async rejectGeneration(id: CanvasNodeId, jobId: JobId): Promise<void> { await this.entries.get(id)?.approvals?.reject(jobId) }
  /** Retry a task-list read without rerunning generation. */
  async refreshTasks(id: CanvasNodeId): Promise<void> { await this.entries.get(id)?.approvals?.refresh() }

  /** Load models for only the media row the user opened. */
  async openModels(id: CanvasNodeId, kind: MediaKind): Promise<void> { await this.entries.get(id)?.models?.open(kind) }
  closeModels(id: CanvasNodeId): void { this.entries.get(id)?.models?.close() }
  async selectModel(id: CanvasNodeId, option: string): Promise<void> { await this.entries.get(id)?.models?.select(option) }

  /** Connect a missing service in the context of exactly one media row. */
  connectProvider(id: CanvasNodeId, kind: MediaKind, providerId: string): void {
    const entry = this.entries.get(id), state = entry?.state.getSnapshot()
    const provider = state?.providers.find(item => item.id === providerId)
    if (entry === undefined || state?.view === undefined || state.saving || state.models?.saving
      || provider === undefined || !providerSupportsKind(provider, kind, state.view)) return
    const view = state.view
    entry.models?.close()
    entry.epoch += 1
    entry.resumeAuthorization = undefined; entry.resumeInstallation = undefined
    entry.state.update((value) => {
      value.open = true; value.choosing = false; value.targetKind = kind; value.loading = false
      value.draft = structuredClone(view.data); value.error = null; value.issue = undefined
    })
    const saved = state.connections.find(connection => connection.providerId === provider.id)
    if (saved === undefined) this.newConnection(id, provider.id)
    else this.editConnection(id, saved.id)
  }

  /** Delegate native Chat creation to the graph owner and retain pending/error feedback here. */
  async newChat(id: CanvasNodeId, create: () => Promise<void>): Promise<void> {
    const entry = this.entries.get(id)
    if (entry === undefined || entry.state.getSnapshot().chatPending) return
    entry.state.update((state) => { state.chatPending = true; state.error = null })
    try { await create() }
    catch (error) { if (!this.disposed) entry.state.update((state) => { state.error = 'chatFailed' }); this.report(error) }
    finally { if (!this.disposed) entry.state.update((state) => { state.chatPending = false }) }
  }

  private current(entry: WorkbenchEntry, epoch: number): boolean {
    return !this.disposed && entry.epoch === epoch && this.entries.get(entry.ref.nodeId) === entry
  }

  private async refresh(entry: WorkbenchEntry, editing = false): Promise<void> {
    const epoch = ++entry.epoch
    entry.state.update((state) => { state.loading = true; state.error = null; state.issue = undefined })
    try {
      const [view, providers] = await Promise.all([this.remote.describeWorkbench(entry.ref), this.remote.listProviders()])
      if (!this.current(entry, epoch)) return
      entry.state.update((state) => {
        state.view = view; state.providers = providers; state.connections = view.connections.map(item => item.connection)
        if (editing) { state.draft = structuredClone(view.data); state.choosing = state.connections.length === 0 }
      })
    } catch (error) {
      if (this.current(entry, epoch)) entry.state.update((state) => { state.error = 'loadFailed' })
      this.report(error)
    } finally { if (this.current(entry, epoch)) entry.state.update((state) => { state.loading = false }) }
  }

  /** Open only the workbench's own configuration. */
  open(id: CanvasNodeId): void {
    const entry = this.entries.get(id)
    if (entry === undefined) return
    this.stopInstallation(entry)
    this.stopSetup(entry)
    const resume = entry.resumeInstallation
    const authorization = entry.resumeAuthorization
    entry.resumeInstallation = undefined
    entry.resumeAuthorization = undefined
    entry.preparationEpoch += 1
    entry.state.update((state) => {
      state.open = true; state.connectionDraft = undefined; state.preparation = undefined; state.preparing = false
      state.targetKind = authorization?.targetKind ?? resume?.targetKind
    })
    const refreshing = this.refresh(entry, true)
    const epoch = entry.epoch
    void refreshing.then(() => {
      if (authorization !== undefined && this.current(entry, epoch) && entry.state.getSnapshot().open
        && entry.state.getSnapshot().error === null) {
        entry.state.update((state) => { state.connectionDraft = authorization })
        const provider = entry.state.getSnapshot().providers.find(item => item.id === authorization.providerId)
        if (provider !== undefined) this.prepareService(entry, provider)
        return
      }
      if (resume === undefined || !this.current(entry, epoch) || !entry.state.getSnapshot().open
        || entry.state.getSnapshot().error !== null) return
      if (resume.connectionId === undefined) this.newConnection(id, resume.providerId)
      else this.editConnection(id, resume.connectionId)
      entry.installationRequested = resume.requested
    })
  }

  /** Clear transient configuration and credentials when the modal closes. */
  close(id: CanvasNodeId): void {
    const entry = this.entries.get(id)
    if (entry === undefined || entry.state.getSnapshot().saving) return
    const state = entry.state.getSnapshot()
    const observing = state.installation
    const connection = state.connectionDraft
    entry.resumeAuthorization = connection !== undefined && state.authorization !== undefined
      && (state.authorization.pending || state.authorization.statusUnavailable || authorizationActive(state.authorization.status))
      ? { ...structuredClone(connection), apiKey: '', credentialRef: '' } : undefined
    entry.resumeInstallation = connection !== undefined && observing !== undefined
      && (observing.pending || observing.statusUnavailable || installationActive(observing.status))
      ? { providerId: connection.providerId, requested: entry.installationRequested,
        ...(connection.id === undefined ? {} : { connectionId: connection.id }),
        ...(connection.targetKind === undefined ? {} : { targetKind: connection.targetKind }) } : undefined
    this.stopInstallation(entry)
    this.stopSetup(entry)
    entry.epoch += 1; entry.preparationEpoch += 1
    entry.state.update((state) => {
      state.open = false; state.loading = false; state.preparing = false; state.preparation = undefined
      state.draft = undefined; state.connectionDraft = undefined; state.targetKind = undefined; state.error = null; state.issue = undefined
    })
  }

  /** Show the service chooser without committing any workbench draft. */
  choose(id: CanvasNodeId, choosing: boolean): void {
    const entry = this.entries.get(id)
    if (entry === undefined || entry.state.getSnapshot().saving) return
    this.stopInstallation(entry)
    this.stopSetup(entry)
    entry.preparationEpoch += 1
    entry.state.update((state) => {
      state.choosing = choosing; state.connectionDraft = undefined; state.preparing = false
      state.preparation = undefined; state.error = null; state.issue = undefined
    })
  }

  private changed(entry: WorkbenchEntry): void {
    entry.state.update((state) => {
      if (state.connectionDraft !== undefined) state.connectionDraft.operationId = randomUUID() as CanvasOperationId
      state.error = null; state.issue = undefined
    })
  }

  /** Edit a title in the local draft; connection-and-apply includes it in the same commit. */
  title(id: CanvasNodeId, title: string): void {
    const entry = this.entries.get(id)
    if (entry === undefined) return
    entry.state.update((state) => { if (state.draft !== undefined) state.draft.title = title })
    this.changed(entry)
  }

  /** Start a descriptor-driven form; CLI checks run without saving a connection. */
  newConnection(id: CanvasNodeId, providerId: string): void {
    const entry = this.entries.get(id)
    if (entry === undefined || entry.state.getSnapshot().saving) return
    const provider = entry.state.getSnapshot().providers.find(value => value.id === providerId)
    if (provider === undefined) return
    this.stopInstallation(entry)
    this.stopSetup(entry)
    const settings = defaults(provider), targetKind = entry.state.getSnapshot().targetKind
    entry.preparationEpoch += 1
    entry.state.update((state) => {
      state.connectionDraft = { providerId: provider.id, label: provider.title, settings,
        enabledKinds: targetKind === undefined ? enabledKinds(provider, settings) : [targetKind],
        credentialSource: 'key', credentialRef: '', apiKey: '', operationId: randomUUID() as CanvasOperationId,
        ...(targetKind === undefined ? {} : { targetKind }) }
      state.error = null; state.issue = undefined; state.preparation = undefined; state.preparing = false
    })
    if (provider.connectionKind === 'cli') this.prepareService(entry, provider)
  }

  /** Edit safe configuration; stored credentials are represented only by their presence. */
  editConnection(id: CanvasNodeId, connectionId: ConnectionId, prepare = true): void {
    const entry = this.entries.get(id)
    const state = entry?.state.getSnapshot()
    const connection = state?.connections.find(value => value.id === connectionId)
    const provider = state?.providers.find(value => value.id === connection?.providerId)
    if (entry === undefined || state === undefined || connection === undefined || provider === undefined || state.saving) return
    this.stopInstallation(entry)
    this.stopSetup(entry)
    entry.preparationEpoch += 1
    const settings = structuredClone(connection.settings), targetKind = state.targetKind
    entry.state.update((value) => {
      value.connectionDraft = { id: connection.id, providerId: connection.providerId, label: connection.label,
        settings, enabledKinds: targetKind === undefined ? enabledKinds(provider, settings) : [targetKind],
        credentialSource: 'key', credentialRef: '', apiKey: '', operationId: randomUUID() as CanvasOperationId,
        ...(targetKind === undefined ? {} : { targetKind }) }
      value.error = null; value.issue = undefined; value.preparation = undefined; value.preparing = false
    })
    if (prepare) this.prepareService(entry, provider)
  }

  private stopInstallation(entry: WorkbenchEntry): void {
    entry.installer?.dispose(); entry.installer = undefined; entry.installationRequested = false
    entry.state.update((state) => { state.installation = undefined })
  }

  private stopSetup(entry: WorkbenchEntry): void {
    entry.authorizer?.dispose(); entry.authorizer = undefined
    entry.state.update((state) => { state.authorization = undefined })
  }

  private invalidateSetup(entry: WorkbenchEntry): void {
    this.stopSetup(entry)
    entry.preparationEpoch += 1
    entry.state.update((state) => {
      state.preparation = undefined; state.preparing = false

    })
  }

  private observeAuthorization(entry: WorkbenchEntry): void {
    if (entry.authorizer !== undefined) return
    const state = entry.state.getSnapshot()
    const draft = state.connectionDraft
    if (draft === undefined || !state.providers.find(provider => provider.id === draft.providerId)?.authorization) return
    entry.authorizer = new CreationAuthorizationObserver(this.remote, connectionInput(entry, draft),
      (authorization) => { entry.state.update((value) => { value.authorization = authorization }) },
      () => { void this.prepare(entry.ref.nodeId) }, this.openExternal, this.report)
    void entry.authorizer.resume()
  }

  /** Request browser authorization only on the user's explicit action. */
  async beginAuthorization(id: CanvasNodeId): Promise<void> {
    const entry = this.entries.get(id)
    if (entry === undefined || entry.state.getSnapshot().saving) return
    await entry.authorizer?.begin()
  }

  /** Recover observation of an existing challenge without creating another one. */
  async checkAuthorization(id: CanvasNodeId): Promise<void> { await this.entries.get(id)?.authorizer?.resume() }

  private prepareService(entry: WorkbenchEntry, provider: ProviderDescriptor): void {
    if (!provider.installation?.supported) { void this.prepare(entry.ref.nodeId); return }
    const selected = (): boolean => this.entries.get(entry.ref.nodeId) === entry
      && entry.state.getSnapshot().connectionDraft?.providerId === provider.id && !this.disposed
    entry.installer = new CreationInstallationObserver(this.remote, entry.ref, provider.id,
      (installation) => { if (selected()) entry.state.update((state) => { state.installation = installation }) },
      (status) => {
        if (!selected()) return
        if (status.state === 'ready' && status.executable !== undefined && entry.installationRequested) {
          this.connectionSetting(entry.ref.nodeId, 'executable', status.executable)
        }
        void this.prepare(entry.ref.nodeId)
      }, this.report)
    void entry.installer.resume()
  }

  /** Start the selected official installer only after the user's explicit button action. */
  async installProvider(id: CanvasNodeId): Promise<void> {
    const entry = this.entries.get(id)
    if (entry?.installer === undefined) return
    entry.installationRequested = true
    entry.preparationEpoch += 1
    entry.state.update((state) => { state.preparing = false; state.error = null; state.issue = undefined })
    await entry.installer.install()
  }

  /** Restore observation after a failed status read, without requesting another installation. */
  async checkInstallation(id: CanvasNodeId): Promise<void> {
    await this.entries.get(id)?.installer?.resume()
  }

  /** Reuse a saved connection and apply its available capabilities without another form. */
  async useConnection(id: CanvasNodeId, connectionId: ConnectionId): Promise<void> {
    this.editConnection(id, connectionId, false)
    await this.saveConnection(id)
  }

  /** Clear the transient form, including its unsaved key. */
  dismissConnection(id: CanvasNodeId): void {
    const kind = this.entries.get(id)?.state.getSnapshot().targetKind
    if (kind === undefined) { this.choose(id, true); return }
    this.close(id)
    void this.openModels(id, kind)
  }

  /** Set a mutually exclusive credential source and clear the unused secret field. */
  credentialSource(id: CanvasNodeId, source: 'key' | 'environment'): void {
    const entry = this.entries.get(id)
    if (entry === undefined) return
    this.invalidateSetup(entry)
    entry.state.update((state) => {
      const draft = state.connectionDraft
      if (draft === undefined) return
      draft.credentialSource = source
      if (source === 'key') draft.credentialRef = ''
      else draft.apiKey = ''
      state.preparation = undefined; state.preparing = false
    })
    this.changed(entry)
  }

  /** Update ordinary identity or transient credentials, never returning saved key contents. */
  connectionField(id: CanvasNodeId, field: 'label' | 'credentialRef' | 'apiKey', value: string): void {
    const entry = this.entries.get(id)
    if (entry === undefined) return
    if (field !== 'label') this.invalidateSetup(entry)
    entry.state.update((state) => {
      if (state.connectionDraft === undefined) return
      state.connectionDraft[field] = value
      if (field !== 'label') { state.preparation = undefined; state.preparing = false }
    })
    this.changed(entry)
  }

  /** Toggle one model-backed capability while retaining its draft value for re-enabling. */
  enableKind(id: CanvasNodeId, kind: MediaKind, enabled: boolean): void {
    const entry = this.entries.get(id)
    if (entry === undefined) return
    entry.state.update((state) => {
      const draft = state.connectionDraft
      if (draft === undefined) return
      draft.enabledKinds = enabled ? [...new Set([...draft.enabledKinds, kind])] : draft.enabledKinds.filter(value => value !== kind)
    })
    this.changed(entry)
  }

  /** Parse descriptor-owned setting types at the user-input boundary. */
  connectionSetting(id: CanvasNodeId, key: string, value: string | boolean): void {
    const entry = this.entries.get(id)
    if (entry === undefined) return
    const current = entry.state.getSnapshot()
    const field = current.providers.find(provider => provider.id === current.connectionDraft?.providerId)
      ?.configuration?.find(item => item.key === key)
    if (field === undefined || field.managed
      || (current.targetKind !== undefined && field.mediaKind !== undefined && field.mediaKind !== current.targetKind)) return
    entry.state.update((state) => {
      const draft = state.connectionDraft
      if (draft === undefined) return
      if (value === '') Reflect.deleteProperty(draft.settings, key)
      else if (field.type === 'number') {
        const number = Number(value)
        if (Number.isFinite(number)) draft.settings[key] = number
      } else draft.settings[key] = value
      if (field.mediaKind !== undefined) {
        draft.enabledKinds = value === '' ? draft.enabledKinds.filter(kind => kind !== field.mediaKind)
          : [...new Set([...draft.enabledKinds, field.mediaKind])]
      }
    })
    if (field.affectsSetup) this.invalidateSetup(entry)
    this.changed(entry)
  }

  /** Inspect a draft without creating a connection or generating content. */
  async prepare(id: CanvasNodeId): Promise<void> {
    const entry = this.entries.get(id)
    const draft = entry?.state.getSnapshot().connectionDraft
    if (entry === undefined || draft === undefined || entry.state.getSnapshot().saving) return
    const epoch = entry.epoch, preparationEpoch = ++entry.preparationEpoch
    const input = connectionInput(entry, draft)
    entry.state.update((state) => { state.preparing = true; state.preparation = undefined })
    try {
      const preparation = await this.remote.prepareConnection(input)
      if (!this.current(entry, epoch) || entry.preparationEpoch !== preparationEpoch) return
      entry.state.update((state) => { state.preparation = preparation })
      if (preparation.state === 'unavailable' && preparation.reason === 'not-authorized') this.observeAuthorization(entry)
    } catch (error) {
      if (this.current(entry, epoch) && entry.preparationEpoch === preparationEpoch) entry.state.update((state) => { state.error = 'checkFailed' })
      this.report(error)
    } finally {
      if (this.current(entry, epoch) && entry.preparationEpoch === preparationEpoch) {
        entry.state.update((state) => { state.preparing = false })
      }
    }
  }

  private complete(entry: WorkbenchEntry, workspace: CanvasWorkspace): void {
    this.stopInstallation(entry)
    this.stopSetup(entry)
    this.publish(workspace)
    entry.preparationEpoch += 1
    entry.state.update((state) => {
      state.open = false; state.saving = false; state.preparing = false
      state.preparation = undefined; state.draft = undefined; state.connectionDraft = undefined; state.targetKind = undefined
    })
    void this.refresh(entry)
  }

  /** Refresh a conflicting workbench while retaining its connection form and non-conflicting edits. */
  async refreshForRetry(id: CanvasNodeId): Promise<void> {
    const entry = this.entries.get(id)
    const previous = entry?.state.getSnapshot()
    if (entry === undefined || previous?.view === undefined || previous.draft === undefined || previous.saving) return
    const epoch = entry.epoch
    entry.state.update((state) => { state.saving = true })
    try {
      const view = await this.remote.describeWorkbench(entry.ref)
      if (!this.current(entry, epoch)) return
      const draft = structuredClone(view.data)
      if (previous.draft.title !== previous.view.data.title) draft.title = previous.draft.title
      entry.state.update((state) => {
        state.view = view; state.draft = draft; state.connections = view.connections.map(item => item.connection)
        if (state.connectionDraft !== undefined) state.connectionDraft.operationId = randomUUID() as CanvasOperationId
        state.error = null; state.issue = undefined
      })
    } catch (error) {
      if (this.current(entry, epoch)) entry.state.update((state) => { state.error = 'loadFailed' })
      this.report(error)
    } finally { if (this.current(entry, epoch)) entry.state.update((state) => { state.saving = false }) }
  }

  /** Validate, save and bind through one Host operation. Keep the same operation id for retries. */
  async saveConnection(id: CanvasNodeId): Promise<void> {
    const entry = this.entries.get(id)
    const state = entry?.state.getSnapshot()
    if (entry === undefined || state?.connectionDraft === undefined || state.view === undefined
      || state.draft === undefined || state.saving || state.preparing || state.installation?.pending
      || state.installation?.statusUnavailable || installationActive(state.installation?.status)
      || state.authorization?.pending || state.authorization?.statusUnavailable || authorizationActive(state.authorization?.status)) return
    if (state.preparation?.state === 'unavailable'
      && (state.preparation.reason === 'not-installed' || state.preparation.reason === 'not-authorized')) return
    const epoch = entry.epoch
    const draft = state.connectionDraft
    if (draft.credentialSource === 'environment' && draft.credentialRef.trim() === '') {
      entry.state.update((value) => { value.error = 'credentialRequired'; value.issue = undefined })
      return
    }
    entry.preparationEpoch += 1
    entry.state.update((value) => { value.saving = true; value.preparing = false; value.error = null; value.issue = undefined })
    try {
      const result = await this.remote.connectAndApply({ ...connectionInput(entry, draft), expectedRevision: state.view.canvasRevision,
        operationId: draft.operationId, data: state.draft,
        ...(draft.targetKind === undefined ? {} : { targetKind: draft.targetKind }) })
      if (!this.current(entry, epoch)) return
      if (!result.ok) {
        entry.state.update((value) => {
          value.error = result.code === 'conflict' ? 'changed' : 'connectionFailed'
          value.issue = result.inspection?.message
          if (result.inspection !== undefined) value.preparation = result.inspection
        })
        return
      }
      this.complete(entry, result.workspace)
    } catch (error) {
      if (this.current(entry, epoch)) entry.state.update((value) => { value.error = 'connectionFailed' })
      this.report(error)
    } finally { if (this.current(entry, epoch)) entry.state.update((value) => { value.saving = false }) }
  }

  /** Probe a saved Provider and retain the result alongside existing configuration. */
  async inspect(id: CanvasNodeId, connectionId: ConnectionId): Promise<void> {
    const entry = this.entries.get(id)
    if (entry === undefined || entry.state.getSnapshot().saving) return
    const epoch = entry.epoch
    entry.state.update((state) => { state.saving = true; state.error = null; state.issue = undefined })
    try {
      const inspection = await this.remote.inspectConnection(entry.ref, connectionId)
      if (!this.current(entry, epoch)) return
      entry.state.update((state) => {
        const connection = state.connections.find(item => item.id === connectionId)
        if (state.view !== undefined && connection !== undefined) state.view.connections = [
          ...state.view.connections.filter(item => item.connection.id !== connectionId), { connection, inspection },
        ]
      })
    } catch (error) {
      if (this.current(entry, epoch)) entry.state.update((state) => { state.error = 'connectionFailed' })
      this.report(error)
    } finally { if (this.current(entry, epoch)) entry.state.update((state) => { state.saving = false }) }
  }

  /** Save the workbench name without changing its media routes. */
  async save(id: CanvasNodeId): Promise<void> {
    const entry = this.entries.get(id)
    const state = entry?.state.getSnapshot()
    if (entry === undefined || state?.draft === undefined || state.view === undefined || state.saving || state.loading) return
    const epoch = entry.epoch
    entry.state.update((value) => { value.saving = true; value.error = null; value.issue = undefined })
    try {
      const result = await this.remote.configureWorkbench({ ref: entry.ref, expectedRevision: state.view.canvasRevision,
        operationId: randomUUID() as CanvasOperationId, data: state.draft })
      if (!this.current(entry, epoch)) return
      if (!result.ok) { entry.state.update((value) => { value.error = result.code === 'conflict' ? 'changed' : 'saveFailed' }); return }
      this.complete(entry, result.workspace)
    } catch (error) {
      if (this.current(entry, epoch)) entry.state.update((value) => { value.error = 'saveFailed' })
      this.report(error)
    } finally { if (this.current(entry, epoch)) entry.state.update((value) => { value.saving = false }) }
  }

  /** Discard window state; Provider jobs and files are owned by the Host. */
  dispose(): void {
    this.disposed = true
    for (const entry of this.entries.values()) {
      entry.epoch += 1; entry.preparationEpoch += 1
      entry.installer?.dispose(); this.stopSetup(entry); entry.approvals?.dispose(); entry.models?.dispose()
    }
    this.entries.clear()
  }
}
