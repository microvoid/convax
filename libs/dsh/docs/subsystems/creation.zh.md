# Convax Creation 子系统

[English](creation.md) | 中文

Convax Creation 为连接到创作工作台的 Chat 提供已配置的图片、视频和音频生成能力。[Host 包](../../../../packages/plugin-creation-host/README.zh.md)负责 Provider 配置、任务执行和恢复。[Renderer 包](../../../../packages/plugin-creation-renderer/README.zh.md)提供工作台卡片；现有 Chat 和文件节点展示对话及交付的媒体。

## 工作台与连接

`WorkbenchRef` 标识画布及其中的工作台节点。`WorkbenchData` 包含标题，以及可选的图片、视频和音频路由。每条路由指定连接及可选模型/默认参数。卡片上的模型切换只作用于当前工作台；Host 将生效模型写入新任务快照，不改变基础连接或先前任务。`WorkbenchView` 将保存的配置与 Provider 当前可用状态组合起来；可用状态不会持久化到画布数据中。

`ConnectionId` 标识由 Host 管理的连接。`ConnectionView` 包含连接名称、Provider、版本、非敏感设置和凭证是否已配置。`SaveConnectionInput` 将新建或更新的连接归属到工作台，并可单独提供凭证。`ConnectAndApplyInput` 增加画布版本、重试身份、可选工作台草稿及可选的 `targetKind`；`ConnectAndApplyResult` 返回已提交的连接与工作区，或拒绝结果。画布成功提交后，连接变为可见。指定 `targetKind` 时要求对应能力可用，只替换该路由，清除其原模型覆盖与默认参数，并仅报告该类型已应用。其他路由及连接中非目标类型的模型设置保持不变。未指定目标时，填充其支持且尚未配置的路由。`ConnectionSnapshot` 固定任务使用的连接版本，只在 Host 内部使用；凭证不会进入 Chat 上下文或画布记录。

`ProviderId` 标识已注册的适配器。`ProviderDescriptor` 定义其身份、显示名称、媒体类型和设置字段，包括高级字段、模型归属，以及不向用户展示的 Host 托管字段。`ProviderPreparation` 报告设置所需的可用状态和模型候选项，不持久化连接。`ConnectionInspection` 报告可用状态及生成能力，或明确的配置/鉴权/可用性错误。`GenerationCapability` 声明一条媒体/模型路由、可选的目录显示名称、参数 JSON Schema、支持的参考素材角色和产物数量上限。`JsonObject` 是这些 Schema 和非敏感参数所用的可序列化对象形状。

`ProviderInstallation` 报告用户明确发起的 CLI 安装：检查、下载、安装、验证、就绪或失败，可带下载字节进度和失败信息。Host 持有安装任务，并对不同工作台的重复请求去重。关闭客户端弹窗不会取消安装。可执行文件就绪后仍需通过 `ProviderPreparation` 单独检查账号登录和可用模型；安装不会创建连接或发起生成。

## 生成生命周期

`ProviderAuthorization` 报告未开始、等待、已授权、过期、拒绝或失败的设备授权状态。官方验证 URL 可向客户端提供；Host 持有设备码及交换生命周期。`ProviderCanvasPage` 和 `ProviderCanvasResult` 保留为查询与创建 Provider 画布的设置 API 契约。即梦连接流程在模型验证后内部管理画布；重试保留固定项目身份，已有连接复用其项目。设置接口先验证所属工作台与可执行文件/Profile 身份，再访问 CLI。

`CreationInvocation` 来自真实 DSH 工具执行，包含 Session、轮次和调用 ID。Host 解析已绑定的来源 Chat 及其唯一创作工作台连接。`GenerateInput` 包含媒体类型、提示词、可选参数和文件/产物引用，不能选择其他 Chat 或账号。Host 校验所选能力，保存输入文件快照，然后记录后台任务。

Creation 的 `JobId` 标识持久化任务；服务签名使用别名 `CreationJobId`，与 DSH 独立 Jobs 子系统区分。Creation 的 `JobView` 通过别名 `CreationJobView` 暴露，报告任务状态、各产物交付状态及可处理的问题。`WorkbenchJobView` 增加提示词，用于工作台任务查看。`listWorkbenchJobs` 返回全部活动任务及最近二十项已结束任务，按稳定的接收顺序排列。生成、文件收集、Chat 发布和画布投影属于不同阶段。生成完成后仍可能需要恢复传输或交付。

`CancelReceipt` 分别记录后续自动交付的抑制状态，以及 Provider 的远端取消结果。抑制交付保留已经交付的文件。远端取消可能不受支持或结果不确定，并不保证 Provider 不收取费用。

`GenerationQuote` 是已保存草稿的积分上限。`GenerationApproval` 增加 Host 签发的报价版本，`PendingGenerationApproval` 将报价关联到所属任务、媒体类型和提示词。`awaiting-approval` 任务持久化草稿但不执行。只有工作台 Remote 批准可以记录用户同意；模型工具和重启不能批准。`approving` 在执行前持久化本次任务接受的积分上限。报价上涨时携新版本重新等待，旧版本批准会被拒绝。Renderer 仅将当前展示的任务/报价身份通过逐项批准调用组成批次，并按任务报告部分失败。后续报价不会加入已确认批次。可选报价字段保留已有任务记录的兼容性。

## Provider 扩展契约

`CreationProvider` 实例实现能力检查、单次提交、只读恢复、产物收集和如实报告取消结果。各插件管理自己注册的实例，并等待销毁完成。[公共声明](../../../../packages/plugin-creation-host/src/types.ts)定义请求、检查点、产物定位信息及传给适配器的运行时。

Host 提供任务私有目录、字节限制、本地取消信号，以及需要等待完成的检查点回调。适配器在依靠已知任务/资源身份恢复前，先将其持久化。检查点不含凭证或临时签名下载 URL。恢复只观察原生成任务，不能静默提交另一个付费请求。响应丢失且没有可恢复身份时，任务保持结果不确定。

成功收集仅写入指定暂存文件。Host 校验并导入媒体，通过现有[交付物子系统](deliverables.zh.md)发布，再由 [Convax 交付投影](convax.zh.md)创建普通文件节点及 Chat 连线。Provider 特有限制及安装前提由 [Host 包参考](../../../../packages/plugin-creation-host/README.zh.md#configure-providers)说明。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [CanvasCommandResult](convax.zh.md) · [CanvasOperationId](convax.zh.md)

Source: [`../../packages/plugin-creation-host/src/service.ts`](../../../../packages/plugin-creation-host/src/service.ts)
<!-- END GENERATED cordis-surface -->
