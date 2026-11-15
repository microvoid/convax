/**
 * Creation workbench wire contracts and Host provider extension points.
 */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { CredentialRef, CredentialKey } from '@deepseek-ai/dsh-credentials/types'
import type {
  CanvasId, CanvasNodeId, CanvasOperationId, CanvasCommandResult, CanvasData, CanvasWorkspace,
} from '@deepseek-ai/dsh-convax-plugin-host/types'

export type MediaKind = 'image' | 'video' | 'audio'
export type ProviderId = Branded<'CreationProviderId'>
export type ConnectionId = Branded<'CreationConnectionId'>
export type JobId = Branded<'CreationJobId'>
export type AssetId = Branded<'CreationAssetId'>
export type OperationId = Branded<'CreationOperationId'>
export type JsonObject = CanvasData

/** The node envelope already owns dataVersion and revision. */
export interface WorkbenchData {
  title: string
  routes: Partial<Record<MediaKind, CreationRoute>>
}

export interface CreationRoute {
  connectionId: ConnectionId
  modelId?: string
  /** Validated by the selected capability's parameterSchema. No credentials. */
  defaults?: JsonObject
}

export interface WorkbenchRef {
  canvasId: CanvasId
  nodeId: CanvasNodeId
}

/** A reference to an existing output or an ordinary DSH filesystem resource. */
export interface CreationReference {
  source: { assetId: AssetId } | { path: string }
  /** Declared by the selected capability, e.g. reference / first-frame / voice. */
  role: string
}

/** Model-facing input; origin, workbench and Provider are resolved by the Host. */
export interface GenerateInput {
  kind: MediaKind
  prompt: string
  references?: readonly CreationReference[]
  /** Canonical names and bounds come from the resolved capability. */
  parameters?: JsonObject
}

export interface GenerationCapability {
  kind: MediaKind
  /** Omitted only when the adapter deliberately exposes its implicit model. */
  modelId?: string
  /** Human-readable catalog name; use modelId when the Provider does not supply one. */
  modelLabel?: string
  parameterSchema: JsonObject
  inputs: readonly {
    role: string
    kinds: readonly MediaKind[]
    minItems: number
    maxItems: number
  }[]
  maxOutputs: number
}

export interface ProviderDescriptor {
  id: ProviderId
  title: string
  supportedKinds?: readonly MediaKind[]
  /** Generation is withheld when the official provider cannot export its result for canvas delivery. */
  unsupportedKinds?: readonly { kind: MediaKind; reason: 'export-unavailable'; message: string }[]
  connectionKind?: 'cli' | 'api'
  configuration?: readonly {
    key: string
    label: string
    type: 'text' | 'url' | 'number' | 'boolean'
    required?: boolean
    placeholder?: string
    advanced?: boolean
    /** Host-owned setting retained in saved connections, without a user-facing input. */
    managed?: boolean
    /** Changing this field invalidates authorization and resource/model discovery for the draft. */
    affectsSetup?: boolean
    default?: string | number | boolean
    mediaKind?: MediaKind
  }[]
  usesApiKey?: boolean
  credentialOptional?: boolean
  /** Product-owned installation is available only for audited built-in CLI distributions. */
  installation?: { supported: boolean; helpUrl: string; reason?: string }
  /** Device authorization is started only by an explicit user action. */
  authorization?: boolean
  /** Remote canvas selection replaces an opaque identifier input. */
  canvasSelection?: { settingKey: string }
}

export interface ConnectionView {
  id: ConnectionId
  providerId: ProviderId
  label: string
  revision: number
  settings: JsonObject
  credentialConfigured: boolean
}

export interface SaveConnectionInput {
  ref: WorkbenchRef
  connection: { id?: ConnectionId; providerId: ProviderId; label: string; settings: JsonObject; credentialRef?: string }
  apiKey?: string
}

export interface ConnectAndApplyInput extends SaveConnectionInput {
  expectedRevision: number
  operationId: CanvasOperationId
  /** Replace only this media route; omit to fill the connection's supported empty routes. */
  targetKind?: MediaKind
  /** Include current workbench edits in the same graph commit. */
  data?: WorkbenchData
}

export type ConnectAndApplyResult =
  | {
    ok: true
    workspace: CanvasWorkspace
    connection: ConnectionView
    inspection: Extract<ConnectionInspection, { state: 'ready' }>
    applied: MediaKind[]
  }
  | (Extract<CanvasCommandResult, { ok: false }> & { inspection?: Extract<ConnectionInspection, { state: 'unavailable' }> })

export type ProviderPreparation =
  | { state: 'ready'; models: readonly { id: string; label: string; kind: MediaKind }[] }
  | Extract<ConnectionInspection, { state: 'unavailable' }>

/** Installation readiness is separate from account login and generation readiness. */
export interface ProviderInstallation {
  state: 'idle' | 'checking' | 'downloading' | 'installing' | 'verifying' | 'ready' | 'failed'
  receivedBytes?: number
  totalBytes?: number
  executable?: string
  message?: string
}

export type ProviderSetupReason = 'not-installed' | 'not-authorized' | 'invalid-configuration' | 'unreachable'
  | 'unsafe-url' | 'provider-unloaded' | 'authorization-failed' | 'request-conflict'

/** Contains only browser-safe challenge facts; device codes and credentials remain in the Host. */
export interface ProviderAuthorization {
  state: 'idle' | 'starting' | 'waiting' | 'authorized' | 'expired' | 'rejected' | 'failed'
  verificationUrl?: string
  userCode?: string
  expiresAt?: string
  reason?: ProviderSetupReason
  message?: string
}

export interface ProviderSetupFailure {
  state: 'unavailable'
  reason: ProviderSetupReason
  message: string
}

export interface ProviderCanvas {
  id: string
  label: string
  webUrl?: string
}

export type ProviderCanvasPage = { state: 'ready'; items: readonly ProviderCanvas[]; nextCursor?: string } | ProviderSetupFailure
export type ProviderCanvasResult = { state: 'ready'; canvas: ProviderCanvas } | ProviderSetupFailure

export type ConnectionInspection =
  | {
    state: 'ready'
    capabilities: readonly GenerationCapability[]
    submissionRecovery: 'idempotency-key' | 'recoverable-resource' | 'unsupported'
    cancellation: 'supported' | 'best-effort' | 'unsupported'
  }
  | {
    state: 'unavailable'
    reason: 'not-installed' | 'not-authorized' | 'provider-unloaded' | 'invalid-configuration' | 'unreachable'
    message: string
  }

export interface WorkbenchView {
  ref: WorkbenchRef
  canvasRevision: number
  data: WorkbenchData
  /** Runtime observations; not persisted in node data. */
  connections: readonly { connection: ConnectionView; inspection: ConnectionInspection }[]
}

/** Typert Remote face consumed only by the new workbench settings. */
export interface CreationRemote {
  describeWorkbench(ref: WorkbenchRef): Promise<WorkbenchView>
  prepareConnection(input: SaveConnectionInput): Promise<ProviderPreparation>
  installProvider(ref: WorkbenchRef, providerId: ProviderId): Promise<ProviderInstallation>
  installationStatus(ref: WorkbenchRef, providerId: ProviderId): Promise<ProviderInstallation>
  beginAuthorization(input: SaveConnectionInput): Promise<ProviderAuthorization>
  authorizationStatus(input: SaveConnectionInput): Promise<ProviderAuthorization>
  listProviderCanvases(input: SaveConnectionInput, cursor?: string): Promise<ProviderCanvasPage>
  /** Reuse requestId for retries, including an unknown network outcome. */
  createProviderCanvas(input: SaveConnectionInput, request: { name: string; requestId: string }): Promise<ProviderCanvasResult>
  listPendingApprovals(ref: WorkbenchRef): Promise<readonly PendingGenerationApproval[]>
  listWorkbenchJobs(ref: WorkbenchRef): Promise<readonly WorkbenchJobView[]>
  approveGeneration(input: { ref: WorkbenchRef; jobId: JobId; quoteId: string }): Promise<void>
  rejectGeneration(input: { ref: WorkbenchRef; jobId: JobId }): Promise<void>
  connectAndApply(input: ConnectAndApplyInput): Promise<ConnectAndApplyResult>
  saveConnection(input: SaveConnectionInput): Promise<ConnectionView>
  listProviders(): Promise<readonly ProviderDescriptor[]>
  listConnections(ref: WorkbenchRef): Promise<readonly ConnectionView[]>
  inspectConnection(ref: WorkbenchRef, id: ConnectionId): Promise<ConnectionInspection>
  /** Business validation followed by the EXISTING canvas node.set transaction. */
  configureWorkbench(input: {
    ref: WorkbenchRef
    expectedRevision: number
    operationId: CanvasOperationId
    data: WorkbenchData
  }): Promise<CanvasCommandResult>
}

/** Constructed by the Host tool adapter from a real ToolExecution, never RPC/model data. */
export interface CreationInvocation {
  readonly sessionId: SessionId
  readonly turn: number
  readonly callId: ToolCallId
}

/** The Host resolves and captures this when it accepts the generation request. */
export interface CreationOrigin {
  canvasId: CanvasId
  chatNodeId: CanvasNodeId
  workbenchNodeId: CanvasNodeId
  sessionId: SessionId
  turn: number
  callId: ToolCallId
}

export type JobState = 'queued' | 'submitting' | 'running' | 'reconciling'
  | 'awaiting-approval' | 'approving'
  | 'materializing' | 'publishing' | 'completed' | 'failed' | 'cancelled' | 'blocked'

/** Exact upper bound quoted for a saved generation draft, not a reusable account allowance. */
export interface GenerationQuote {
  credits: number
  unit: 'credits'
  message: string
}

export interface GenerationApproval extends GenerationQuote {
  /** Host-issued revision; approving an outdated quote is rejected. */
  quoteId: string
}

export interface PendingGenerationApproval {
  jobId: JobId
  kind: MediaKind
  prompt: string
  approval: GenerationApproval
}

export interface CreationIssue {
  stage: 'configuration' | 'submission' | 'generation' | 'materialization' | 'publication' | 'projection' | 'cancellation'
  code: string
  message: string
  recovery: 'check-status' | 'retry-transfer' | 'retry-publication' | 'retry-projection' | 'retry-cancellation'
    | 'configure-provider' | 'new-generation' | 'none'
}

export interface AssetView {
  assetId: AssetId
  kind: MediaKind
  filename: string
  /** Only populated after the Host has verified and imported the file. */
  file?: {
    path: string
    mimeType: string
    bytes: number
    width?: number
    height?: number
    durationSeconds?: number
  }
  delivery: 'pending' | 'published' | 'projected' | 'suppressed' | 'failed'
  issues: readonly CreationIssue[]
}

export interface JobView {
  jobId: JobId
  kind: MediaKind
  state: JobState
  /** Completed means local output processing/publication settled, not necessarily canvas projection. */
  outcome?: 'all-succeeded' | 'partially-succeeded' | 'none-succeeded'
  outputs: readonly AssetView[]
  issues: readonly CreationIssue[]
  cancellation?: CancelReceipt
  approval?: GenerationApproval
}

/** Workbench task history contains user prompts, but never private Provider checkpoints or settings. */
export interface WorkbenchJobView extends JobView {
  prompt: string
}

export type ProviderCancelResult =
  | { state: 'requested' | 'confirmed' | 'unsupported' | 'already-terminal' }
  | { state: 'unknown' | 'failed'; issue: CreationIssue }

export interface CancelReceipt {
  jobId: JobId
  /** Durable suppression of future auto-delivery; already published files remain. */
  futureDelivery: 'suppressed' | 'already-settled'
  provider: ProviderCancelResult
}

/** Host service: these execution/registration methods are NOT @Remote methods. */
export interface CreationService {
  registerProvider(provider: CreationProvider): () => Promise<void>
  describe(caller: CreationInvocation): Promise<readonly { capability: GenerationCapability; defaults: JsonObject }[]>
  /** One real tool call maps to one durable job; replay with different input is rejected. */
  generate(input: GenerateInput, caller: CreationInvocation): Promise<{ jobId: JobId; state: 'queued' }>
  getJob(jobId: JobId, caller: CreationInvocation): Promise<JobView>
  /** Resume query/import/publication/projection only. Does not create a new generation or clear cancellation. */
  retryJob(jobId: JobId, caller: CreationInvocation): Promise<JobView>
  cancelJob(jobId: JobId, caller: CreationInvocation): Promise<CancelReceipt>
}

/** Model tool argument/output mapping; supplied call context is not an argument. */
export interface CreationToolContract {
  creation_describe: { input: Record<string, never>
    output: { capabilities: readonly { capability: GenerationCapability; defaults: JsonObject }[] } }
  creation_generate: { input: GenerateInput; output: { jobId: JobId; state: 'queued' } }
  creation_status: { input: { jobId: JobId }; output: JobView }
  creation_retry: { input: { jobId: JobId }; output: JobView }
  creation_cancel: { input: { jobId: JobId }; output: CancelReceipt }
}

/** Host-private connection snapshot; never sent to Chat, Renderer or canvas data. */
export interface ConnectionSnapshot {
  id: ConnectionId
  providerId: ProviderId
  revision: number
  /** Stable account/tenant identity; credential refresh must not change this identity. */
  accountBinding: string
  settings: JsonObject
  credential?: { kind: 'env'; ref: CredentialRef } | { kind: 'record'; key: CredentialKey }
}

export interface ProviderRequest {
  kind: MediaKind
  prompt: string
  modelId?: string
  parameters: JsonObject
  references: readonly {
    role: string
    /** Owned by the Host; authorized inputs resolved before the adapter runs. */
    path: string
    kind: MediaKind
    mimeType: string
  }[]
}

export interface ProviderCheckpoint {
  version: number
  /** Stable project/node/task identity and recovery facts; never secrets or signed URLs. */
  data: JsonObject
}

export interface ProviderRuntime {
  operationId: OperationId
  connection: ConnectionSnapshot
  /** Durable private directory for this job, including adapter-owned recovery receipts. */
  workDirectory: string
  maxBytes: number
  /** Cancels this local operation; by itself does not cancel the remote generation. */
  signal: AbortSignal
  /** Resolves only after checkpoint persistence; await before relying on a recovery handle. */
  checkpoint(value: ProviderCheckpoint): Promise<void>
}

export interface ProviderOutput {
  /** Stable across polling, resume and downloads, unique inside one operation. */
  outputId: string
  kind: MediaKind
  /** Adapter-owned resource address; Host-only, supports obtaining a fresh download URL. */
  locator: JsonObject
  suggestedFilename?: string
}

export type ProviderSnapshot =
  | { state: 'awaiting-approval'; checkpoint: ProviderCheckpoint; approval: GenerationQuote }
  | { state: 'running'; checkpoint: ProviderCheckpoint; outputs?: readonly ProviderOutput[] }
  | { state: 'completed'; outputs: readonly ProviderOutput[] }
  | { state: 'failed'; issue: CreationIssue; outputs?: readonly ProviderOutput[] }
  | { state: 'submission-unknown'; message: string }
  /** Definitive evidence permitting submission when safe idempotent replay is unavailable. */
  | { state: 'not-submitted' }

export interface CreationProvider {
  readonly descriptor: ProviderDescriptor
  readonly checkpointVersion: number
  /** Inspect environment and model choices before project/model settings are complete; never persists the supplied key. */
  prepare?(connection: ConnectionSnapshot, signal: AbortSignal, apiKey?: string): Promise<ProviderPreparation>
  describe(connection: ConnectionSnapshot, signal: AbortSignal): Promise<ConnectionInspection>
  /**
   * Initial execution; may return a task handle or wait for a CLI to complete.
   * Exact replay is allowed only with the same operationId and immutable request
   * when the adapter guarantees idempotency-key semantics. Runs under Host ownership.
   */
  submit(request: ProviderRequest, runtime: ProviderRuntime): Promise<ProviderSnapshot>
  /** Explicit, job-scoped user approval. Recover the same draft; never create a replacement generation. */
  approve?(request: ProviderRequest, checkpoint: ProviderCheckpoint,
    creditCeiling: number, runtime: ProviderRuntime): Promise<ProviderSnapshot>
  /** Read/recover existing work. Must not start a new paid generation. */
  reconcile(
    request: ProviderRequest,
    checkpoint: ProviderCheckpoint | undefined,
    runtime: ProviderRuntime,
  ): Promise<ProviderSnapshot>
  /** Write only the Host-supplied staging path. Host verifies and imports the resulting bytes. */
  collect(output: ProviderOutput, destination: { path: string }, runtime: ProviderRuntime): Promise<void>
  cancel(checkpoint: ProviderCheckpoint | undefined, runtime: ProviderRuntime): Promise<ProviderCancelResult>
}
