# Convax Creation subsystem

English | [中文](creation.zh.md)

Convax Creation supplies configured image, video and audio generation to Chats connected to a creation workbench. The [Host package](../../../../packages/plugin-creation-host/README.md) owns Provider setup, task execution and recovery. The [renderer package](../../../../packages/plugin-creation-renderer/README.md) supplies the workbench card; existing Chat and file nodes display the conversation and delivered media.

## Workbenches and connections

`WorkbenchRef` identifies one canvas and workbench node. `WorkbenchData` contains a title and optional image, video and audio routes. Each route names a connection and optional model/default parameters. Inline model changes apply to that workbench only; the Host captures the effective model in new job snapshots without changing the base connection or earlier jobs. `WorkbenchView` combines the saved configuration with current Provider availability; availability is not persisted in canvas data.

`ConnectionId` identifies a Host-owned connection. `ConnectionView` contains its label, Provider, revision, nonsecret settings and whether a credential is configured. `SaveConnectionInput` associates a new or updated connection with its owning workbench and can supply a credential separately. `ConnectAndApplyInput` adds the graph revision, retry identity, optional workbench draft and optional `targetKind`; `ConnectAndApplyResult` reports a committed connection and workspace or a rejection. Its successful graph commit makes the connection visible. With `targetKind`, it requires that capability to be ready, replaces only that route, clears its previous model override/defaults and reports only that kind as applied. Other routes and non-target connection model settings remain unchanged. Without a target, it fills supported, unconfigured routes. `ConnectionSnapshot` fixes the connection revision used by a job and remains Host-private; credentials do not enter Chat context or canvas records.

`ProviderId` identifies a registered adapter. `ProviderDescriptor` defines its identity, display name, media kinds and settings fields, including advanced fields, model ownership and Host-managed fields omitted from user setup. `ProviderPreparation` reports setup readiness and model choices without persisting a connection. `ConnectionInspection` reports either availability plus generation capabilities or an explicit configuration/authentication/availability failure. `GenerationCapability` declares one media/model route, its optional catalog display name, parameter JSON Schema, supported reference roles and output count limit. `JsonObject` is the serializable object shape used for those schemas and nonsecret parameters.

`ProviderInstallation` reports an explicitly requested CLI installation: checking, downloading, installing, verifying, ready or failed, with optional byte progress and a failure message. The Host owns and deduplicates installation work across workbenches. Closing a client dialog does not cancel it. A ready executable still requires a separate `ProviderPreparation` check for account login and available models; installation never creates a connection or starts generation.

## Generation lifecycle

`ProviderAuthorization` reports idle, waiting, authorized, expired, rejected or failed device authorization. Its official verification URL is public; the Host owns the device code and exchange lifecycle. `ProviderCanvasPage` and `ProviderCanvasResult` remain setup API contracts for Provider canvas inspection and creation. The Jimeng connection flow manages its canvas internally after model validation; retries retain a stable project identity and existing connections reuse their project. Setup calls validate the owning workbench and executable/profile identity before accessing the CLI.

`CreationInvocation` comes from the actual DSH tool execution: Session, turn and call ID. The Host resolves the bound source Chat and its single creation-workbench connection. `GenerateInput` contains the requested media kind, prompt, optional parameters and file/asset references; it cannot choose another Chat or account. The Host validates the selected capability and snapshots input files before recording the background task.

Creation's `JobId` identifies that durable task; service signatures use the alias `CreationJobId` to distinguish it from DSH's separate Jobs subsystem. Creation's `JobView` is exposed as `CreationJobView`: it reports task state, per-output delivery state and actionable issues. `WorkbenchJobView` adds the prompt for workbench task review. `listWorkbenchJobs` returns all active tasks and the latest twenty settled tasks in stable admission order. Generation, file collection, Chat publication and canvas projection are distinct stages. A completed generation can still require transfer or delivery recovery.

`CancelReceipt` records suppression of future automatic delivery and the Provider's remote-cancellation result separately. Suppression preserves already delivered files. Remote cancellation can be unsupported or uncertain and does not guarantee that the Provider avoids charges.

`GenerationQuote` is the credit upper bound for a saved draft. `GenerationApproval` adds a Host-issued quote revision, and `PendingGenerationApproval` associates it with the owning task, media kind and prompt. An `awaiting-approval` job persists its draft without running it. Only the workbench Remote approval can record consent; model tools and restart cannot approve it. `approving` persists the accepted job-scoped ceiling before execution. A higher quote returns to waiting with a new revision; stale approval is rejected. The renderer batches only the displayed job/quote identities through individual approval calls and reports partial failures per task. Later quotes do not join an already confirmed batch. Optional quote fields preserve existing job records.

## Provider extension contract

`CreationProvider` instances implement capability inspection, one submission, read-only reconciliation, output collection and truthful cancellation reporting. Each plugin owns its registered instance and awaits disposal. The [public declarations](../../../../packages/plugin-creation-host/src/types.ts) define requests, checkpoints, output locators and the runtime passed to an adapter.

The Host supplies a private job directory, byte limits, a local cancellation signal and an awaited checkpoint callback. Adapters persist known task/resource identities before relying on them for recovery. Checkpoints contain neither credentials nor temporary signed download URLs. Reconciliation observes the original generation and cannot silently submit another paid request. A lost response without a recoverable identity remains uncertain.

Successful collection writes only the requested staging file. The Host validates and imports the media, publishes through the existing [deliverables subsystem](deliverables.md), and lets [Convax delivery projection](convax.md) create ordinary file nodes and Chat connections. Provider-specific limitations and installation prerequisites belong to the [Host package reference](../../../../packages/plugin-creation-host/README.md#configure-providers).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxconvaxcreation--convaxcreationhost"></a>

### `ctx.convaxCreation` — `ConvaxCreationHost`

Owns workbench routing and durable generation; only workbench configuration is remotely callable.

```ts cordis-catalog
/** Register a Host adapter and resume its unfinished jobs.
 * @param provider - Adapter owned by the mounting plugin.
 * @returns Disposer that unregisters the adapter and drains local operations without cancelling remote jobs.
 */
registerProvider(provider: CreationProvider): () => Promise<void>

/** Resolve an adapter for a captured job connection.
 * @param id - Registered Provider identifier.
 * @returns Loaded adapter, or undefined while its plugin is absent.
 */
provider(id: string): CreationProvider | undefined

/** List installed adapters without probing credentials or remote availability.
 * @returns Public configuration descriptors.
 */
@Remote listProviders(): Promise<ProviderDescriptor[]>

/** Start an explicitly requested installation from the audited built-in distribution.
 * @param ref - Workbench whose configuration initiated installation.
 * @param providerId - Loaded built-in CLI Provider.
 * @returns Current Host-owned progress; readiness does not imply account login.
 */
@Remote installProvider(ref: WorkbenchRef, providerId: ProviderId): Promise<ProviderInstallation>

/** Observe installation without initiating a download or authentication flow.
 * @param ref - Existing workbench requesting the observation.
 * @param providerId - Loaded Provider identity.
 * @returns Latest attempt state; safe to query after reopening the settings.
 */
@Remote installationStatus(ref: WorkbenchRef, providerId: ProviderId): Promise<ProviderInstallation>

/** Start or resume device authorization after an explicit workbench action.
 * @param input - Unsaved CLI settings; credentials are never returned.
 * @returns Safe browser link and Host-owned progress, never the device code.
 */
@Remote beginAuthorization(input: SaveConnectionInput): Promise<ProviderAuthorization>

/** Observe a scoped authorization without initiating login or logging out.
 * @param input - The same executable, directory and profile as the initial request.
 * @returns Current safe authorization state.
 */
@Remote authorizationStatus(input: SaveConnectionInput): Promise<ProviderAuthorization>

/** Read one page of accessible provider canvases without selecting or creating one.
 * @param input - Current unsaved Provider connection settings.
 * @param cursor - Opaque continuation from the preceding page.
 * @returns Safe canvas summaries and an optional continuation.
 */
@Remote listProviderCanvases(input: SaveConnectionInput, cursor?: string): Promise<ProviderCanvasPage>

/** Create a canvas only from the explicit create action, retaining its retry identity.
 * @param input - Current Provider settings.
 * @param request - Name and stable UUID reused when the outcome is unknown.
 * @returns Created canvas summary or a safe recoverable failure.
 */
@Remote createProviderCanvas(input: SaveConnectionInput, request: { name: string; requestId: string }): Promise<ProviderCanvasResult>

/** List connections owned by an existing workbench.
 * @param ref - Workbench node identity.
 * @returns Safe configuration values and credential-presence flags, excluding secrets.
 */
@Remote async listConnections(ref: WorkbenchRef): Promise<ConnectionView[]>

/** Discover local readiness and model choices without saving configuration or credentials.
 * @param input - Partial connection settings and an optional transient key.
 * @returns Setup observations without creating a Provider connection.
 */
@Remote async prepareConnection(input: SaveConnectionInput): Promise<ProviderPreparation>

/** Connect a service and apply one selected media route or its supported empty routes.
 * @param input - Connection settings and current workbench edits sharing a retry identity.
 * @returns A committed workspace and connection, or a rejection retaining the existing configuration.
 */
@Remote async connectAndApply(input: ConnectAndApplyInput): Promise<ConnectAndApplyResult>

/** Save a versioned Provider connection; running jobs keep their captured configuration.
 * @param input - Workbench, settings and optional new credential.
 * @returns Safe connection view after durable storage succeeds.
 */
@Remote async saveConnection(input: SaveConnectionInput): Promise<ConnectionView>

/** Probe configuration without starting a generation or logging in.
 * @param ref - Owning workbench.
 * @param id - Connection to inspect.
 * @returns Available capabilities or a configuration diagnosis.
 */
@Remote async inspectConnection(ref: WorkbenchRef, id: ConnectionId): Promise<ConnectionInspection>

/** Read workbench configuration and current Provider inspections.
 * @param ref - Workbench node identity.
 * @returns Node data, graph revision and safe connection observations.
 */
@Remote async describeWorkbench(ref: WorkbenchRef): Promise<WorkbenchView>

/** Commit routes through the ordinary versioned canvas transaction.
 * @param input - Node data with the expected graph revision and operation identity.
 * @returns Existing graph command result, including revision conflicts.
 */
@Remote async configureWorkbench(input: { ref: WorkbenchRef expectedRevision: number operationId: CanvasOperationId data: WorkbenchData }): Promise<CanvasCommandResult>

/** Resolve the workbench connected to the Session's owning Chat.
 * @param sessionId - Original DSH Session.
 * @returns One capability source, or undefined when disconnected or deleting.
 */
resolveWorkbench(sessionId: CreationInvocation['sessionId']): WorkbenchRef | undefined

/** Admit one generation per real tool invocation and start its Host-owned task.
 * @param raw - Media request and references, validated against the selected Provider.
 * @param caller - Trusted Session and tool coordinates supplied by the Host tool adapter.
 * @returns Stable admission receipt; generation and automatic delivery continue independently.
 */
async generate(raw: GenerateInput, caller: CreationInvocation): Promise<{ jobId: CreationJobId; state: 'queued' }>

/** Expose selected generation capabilities without connection settings or credentials.
 * @param caller - Trusted Session context.
 * @returns Parameter schemas, reference roles and configured defaults for selected routes.
 */
async describe(caller: CreationInvocation): Promise<{ capability: GenerationCapability; defaults: JsonObject }[]>

/** Retain task tools for prior work after its workbench is disconnected.
 * @param sessionId - Session whose task ownership is checked.
 * @returns Whether the Session owns any durable Creation job.
 */
hasJobs(sessionId: CreationInvocation['sessionId']): boolean

/** Read one job without polling or resubmitting to a Provider.
 * @param id - Durable job identity.
 * @param caller - Session owner; cross-Session access is rejected.
 * @returns Generation, file and delivery status without private Provider state.
 */
getJob(id: CreationJobId, caller: CreationInvocation): Promise<CreationJobView>

/** Resume status queries, transfer or publication for an existing job.
 * @param id - Durable job identity.
 * @param caller - Session owner.
 * @returns Status after scheduling recovery; never starts a second paid generation.
 */
async retryJob(id: CreationJobId, caller: CreationInvocation): Promise<CreationJobView>

/** Suppress future deliveries and request remote cancellation where supported.
 * @param id - Durable job identity.
 * @param caller - Session owner.
 * @returns Local suppression receipt and the separate Provider cancellation result.
 */
async cancelJob(id: CreationJobId, caller: CreationInvocation): Promise<CancelReceipt>

/** Read pending quotes belonging to this workbench without accepting any charge.
 * @param ref - Existing workbench whose pending generations are shown.
 * @returns User-reviewable prompts and current quotes only.
 */
@Remote listPendingApprovals(ref: WorkbenchRef): Promise<readonly PendingGenerationApproval[]>

/** Observe active tasks and the latest twenty settled tasks without polling or mutating the Provider.
 * @param ref - Workbench owning the task history.
 * @returns Admission order, with stable identity order for legacy records, and safe task metadata.
 */
@Remote listWorkbenchJobs(ref: WorkbenchRef): Promise<readonly WorkbenchJobView[]>

/** Accept the exact displayed quote for one owned generation.
 * @param input - Workbench, generation and current quote identity from the explicit approval action.
 * @returns After approval is durably accepted; generation continues under the existing job.
 */
@Remote async approveGeneration(input: { ref: WorkbenchRef; jobId: CreationJobId; quoteId: string }): Promise<void>

/** Decline one owned generation and suppress its future delivery.
 * @param input - Workbench and generation identity from the explicit decline action.
 * @returns After the cancellation request is recorded.
 */
@Remote async rejectGeneration(input: { ref: WorkbenchRef; jobId: CreationJobId }): Promise<void>

/** Include committed background asset references in the next model turn.
 * @param sessionId - Session receiving the context.
 * @returns Configured media and recent tasks, or an empty string for unrelated Sessions.
 */
runtimeContext(sessionId: CreationInvocation['sessionId']): string

/** Resolve the captured credential only inside a trusted Host adapter.
 * @param connection - Versioned connection snapshot owned by a job or inspection.
 * @returns Secret value, or undefined if unconfigured; never exposed through Remote methods.
 */
async readCredential(connection: ConnectionSnapshot): Promise<string | undefined>

/** Drain local operations before the owning plugin closes storage.
 * @returns Once local tasks and accepted configuration mutations have settled.
 */
async close(): Promise<void>
```

Types: [CanvasCommandResult](convax.md) · [CanvasOperationId](convax.md)

Source: [`../../packages/plugin-creation-host/src/service.ts`](../../../../packages/plugin-creation-host/src/service.ts)
<!-- END GENERATED cordis-surface -->
