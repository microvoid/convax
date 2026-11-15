/** A workbench's direct model choice changes one route without editing its shared connection. */
import type { CanvasOperationId, CanvasWorkspace } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { ConnectionId, CreationRemote, MediaKind, ProviderDescriptor, ProviderId, WorkbenchRef, WorkbenchView } from '@deepseek-ai/dsh-convax-plugin-creation-host/types'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { CreationKey } from './locales.ts'

export interface WorkbenchModelOption {
  id: string
  connectionId: ConnectionId
  modelId: string
  label: string
  service: string
}

export interface WorkbenchModelProvider {
  id: ProviderId
  title: string
  connectionIds: readonly ConnectionId[]
  options: readonly WorkbenchModelOption[]
  failed: boolean
}

/** Descriptor support includes kinds that have not been enabled on a saved connection yet. */
export function providerSupportsKind(provider: ProviderDescriptor, kind: MediaKind, view: WorkbenchView | undefined): boolean {
  if (provider.unsupportedKinds?.some(item => item.kind === kind)) return false
  return provider.supportedKinds?.includes(kind) === true || provider.configuration?.some(field => field.mediaKind === kind) === true
    || view?.connections.some(item => item.connection.providerId === provider.id && item.inspection.state === 'ready'
      && item.inspection.capabilities.some(capability => capability.kind === kind)) === true
}

export interface ModelSelectionState {
  kind: MediaKind | undefined
  loading: boolean
  saving: boolean
  options: readonly WorkbenchModelOption[]
  providers: readonly WorkbenchModelProvider[]
  error: CreationKey | undefined
}

/** Owned by the mounted workbench; stale catalogue reads never replace another media selection. */
export class CreationModelSelection {
  private value: ModelSelectionState = { kind: undefined, loading: false, saving: false, options: [], providers: [], error: undefined }
  private epoch = 0
  private disposed = false
  private attempt: { optionId: string; revision: number; operationId: CanvasOperationId } | undefined

  constructor(private readonly remote: Pick<CreationRemote, 'prepareConnection' | 'configureWorkbench'>,
    private readonly ref: WorkbenchRef, private readonly view: () => WorkbenchView | undefined,
    private readonly descriptors: () => readonly ProviderDescriptor[],
    private readonly publish: (state: ModelSelectionState) => void,
    private readonly accept: (workspace: CanvasWorkspace) => void, private readonly report: (error: unknown) => void) {}

  private active(): boolean { return !this.disposed }

  private update(patch: Partial<ModelSelectionState>): void {
    if (this.disposed) return
    this.value = { ...this.value, ...patch }; this.publish(this.value)
  }

  /** Read the current account's catalogue only when the user opens a model choice. */
  async open(kind: MediaKind): Promise<void> {
    if (this.disposed || this.value.saving) return
    const view = this.view()
    if (view === undefined) return
    const epoch = ++this.epoch
    const providers = this.descriptors().filter(provider => providerSupportsKind(provider, kind, view)).map(provider => ({
      id: provider.id, title: provider.title, connectionIds: view.connections
        .filter(item => item.connection.providerId === provider.id).map(item => item.connection.id),
      options: [] as readonly WorkbenchModelOption[], failed: false,
    }))
    this.update({ kind, loading: true, options: [], providers, error: undefined })
    const connections = view.connections.filter(item => providers.some(provider => provider.id === item.connection.providerId))
    const results = await Promise.allSettled(connections.map(async ({ connection }) => {
      const preparation = await this.remote.prepareConnection({ ref: this.ref, connection: {
        id: connection.id, providerId: connection.providerId, label: connection.label, settings: connection.settings,
      } })
      if (preparation.state !== 'ready') throw new Error(preparation.message)
      return preparation.models.filter(model => model.kind === kind).map(model => ({
        id: JSON.stringify([connection.id, model.id]), connectionId: connection.id, modelId: model.id,
        label: model.label, service: connection.label,
      }))
    }))
    if (!this.active() || this.epoch !== epoch) return
    const grouped = providers.map(provider => ({ ...provider, options: [] as WorkbenchModelOption[] }))
    for (const [index, { connection }] of connections.entries()) {
      const provider = grouped.find(item => item.id === connection.providerId)
      const result = results[index]
      if (provider === undefined) continue
      if (result?.status === 'fulfilled') provider.options.push(...result.value)
      else if (result?.status === 'rejected') { provider.failed = true; this.report(result.reason) }
    }
    this.update({ loading: false, providers: grouped, options: grouped.flatMap(provider => provider.options),
      error: grouped.some(provider => provider.failed) ? 'modelsFailed' : undefined })
  }

  close(): void {
    if (this.value.saving) return
    this.epoch += 1
    this.update({ kind: undefined, loading: false, error: undefined })
  }

  /** Keep the displayed choice until the Host commits; a failed request retains the same receipt key. */
  async select(optionId: string): Promise<void> {
    const view = this.view(), option = this.value.options.find(item => item.id === optionId), kind = this.value.kind
    if (this.disposed || this.value.saving || this.value.loading || view === undefined || option === undefined || kind === undefined) return
    const route = view.data.routes[kind]
    const capability = view.connections.find(item => item.connection.id === route?.connectionId)?.inspection
    const current = route?.modelId ?? (capability?.state === 'ready' ? capability.capabilities.find(item => item.kind === kind)?.modelId : undefined)
    if (route?.connectionId === option.connectionId && current === option.modelId) { this.close(); return }
    if (this.attempt?.optionId !== optionId || this.attempt.revision !== view.canvasRevision) {
      this.attempt = { optionId, revision: view.canvasRevision, operationId: randomUUID() as CanvasOperationId }
    }
    const data = structuredClone(view.data)
    data.routes[kind] = { connectionId: option.connectionId, modelId: option.modelId }
    this.update({ saving: true, error: undefined })
    try {
      const result = await this.remote.configureWorkbench({ ref: this.ref, expectedRevision: view.canvasRevision,
        operationId: this.attempt.operationId, data })
      if (!this.active()) return
      if (!result.ok) {
        this.update({ error: result.code === 'conflict' ? 'changed' : 'modelChangeFailed' })
        if (result.code === 'conflict') this.accept(result.workspace)
        return
      }
      this.attempt = undefined
      this.update({ kind: undefined })
      this.accept(result.workspace)
    } catch (error) { this.update({ error: 'modelChangeFailed' }); this.report(error) }
    finally { this.update({ saving: false }) }
  }

  dispose(): void { this.disposed = true; this.epoch += 1 }
}
