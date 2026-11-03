# Convax 画布子系统

[English](convax.md) | 中文

Convax 拥有应用级画布记录、节点定义、引用连线和带修订号的图命令。[Host 包](../../../../packages/plugin-host/README.zh.md)自己拥有 SQLite 数据库、事务、迁移和恢复协调。DSH 存储与 Session API 保持不变。[renderer 包](../../../../packages/plugin-renderer/README.zh.md)提供全窗口画布与 Chat 工作台，可以独立停用。

## 记录与命令

`CanvasDocument` 拥有节点、连线和单调修订号。`CanvasWorkspace` 是已保存画布、当前可用 Host 节点类型与 Chat 到 Session 绑定的独立快照。[客户端安全声明](../../../../packages/plugin-host/src/types.ts)定义记录与可判别命令，Typert 根据 Host 方法生成传输。

`CanvasResource` 描述文件或目录元数据。`CanvasDocumentPreview` 携带解析后的 `path`、`name`、可为 null 的字节 `size`、文件系统 `version`、`mimeType` 和完整的临时 `bytes`；Office 转换可附加 `renderedAs: 'pdf'` 与 `missingFonts`，同时保留源路径。`watchResource` 监听元数据；一元 `readDocument` 调用通过已组合文件系统读取内容，不使用 Session。[Host 包](../../../../packages/plugin-host/README.zh.md#use-this-package)拥有字节限制、转换可用性和读取失败。

`CanvasMediaSource` 携带解析后的文件元数据（`path`、`name`、可为 null 的 `size`、`version` 与 `mimeType`），用于固定来源版本的媒体请求。经过认证的 Connection 路由通过已组合文件系统读取传输 HTTP 字节范围，不创建 Session，不转码，也不缓冲完整来源。[Host 包](../../../../packages/plugin-host/README.zh.md#use-this-package)定义响应生命周期、字节窗口及失败行为。

每次修改携带操作身份和预期画布修订号。Convax 仓储在同一 SQLite 事务中提交图状态及回执。重复重试不重复修改；冲突保留耐久状态。运行时定义校验新数据和端口；定义缺失时保留存储数据及可编辑位置。插件安装与启停继续归属 DSH。

`CanvasWindowBindingId` 独立于原生句柄标识一次窗口选择。第一版 `convax.window` payload 仅包含 `bindingId` 与 `name`，当前 Desktop renderer 拥有实时采集。存储或复制的节点数据不建立有效的运行时选择，也不授予窗口访问。[Host 包](../../../../packages/plugin-host/README.zh.md#use-this-package)拥有 payload 校验，[renderer 包](../../../../packages/plugin-renderer/README.zh.md#use-this-package)拥有重新连接与镜像展示。

## UI 组合

`shell.workspace` slot 归 DSH 布局所有者拥有。Convax 占用该位置，全局面板、设置、主题和浮层仍由 DSH 承载。移除 renderer 后恢复原生对话，不移除 Host。Chat 卡片持有显式 Session 引用，嵌入已有 `conversation.content` Factory；Convax 拥有卡片布局、thread 选择和工具面板位置。共享 DSH 草稿保留未发送文本和附件。这项复用不建立新的 DSH dock API；已有 UI 适配另行评估。[renderer 包](../../../../packages/plugin-renderer/README.zh.md#use-this-package)拥有导航与资源打开交互。

资源卡片通过 `document.preview` 展示文档，通过独立的 root Factory `convax.media.preview` 展示音频与视频。媒体播放归窗口拥有，不归卡片实例拥有：悬停播放在指针移开时暂停，明确手动播放则在卡片折叠和画布导航后继续，并提供后台暂停控件。来源替换、移除或插件卸载时释放播放器。音频波形分析逐步读取和解码，累积到固定峰值分组；波形失败时保留原生播放。不支持的编解码提供系统打开。这些展示不创建 Session 或添加模型可见内容。[renderer 包](../../../../packages/plugin-renderer/README.zh.md#use-this-package)拥有控件和交互细节。

## Chat Session 与输入

每个 thread 对应一个 DSH Session，并具有唯一 Convax Chat 绑定。单一 Convax thread 账本拥有不可变请求、固定 Session 预留和固定 fork 前缀。物化器使用原生 Session preparation、persistence、Workspace 关联及 fork API，记录 Session 完成后再绑定图。重启重试保留实际身份，不重新发送输入，也不重建用户主动移除的 Workspace 关联。Session 消息与执行仍归 DSH。

文件或文件夹新连线通过 Host 显式解析来源，并向当前草稿插入一次原生引用。从文件夹创建 Chat 时，以该文件夹作为默认项目并加入首个草稿。删除引用保留连线；已有连线不在后续发送时添加隐藏上下文，也不授予可写根目录。原生 Web、SDK、ACP 和 headless 发送协议保持不变。Convax 使用既有 `agent/pre-step` hook 拒绝删除中或绑定目标缺失的 Chat 及其 subagent 后代进入模型步骤；不承诺入队前拒绝。

窗口连线向同一原生草稿插入来源拥有的 reference。提交时，准备过程将确切节点与绑定解析为最新不可变图片及来源文本，再进入普通 DSH 附件接纳。队列投递和模型重试复用已接纳图片。原生窗口选择与采集不改变 thread 的项目、preset 或 Computer Use 授权。预览帧属于临时数据；已接纳截图历史仍归 DSH 拥有，且重放不依赖实时窗口。

## 交付与删除

Host 专用 Session 投影从活动或持久化历史恢复明确交付的文件。每个完整事件在同一事务中提交文件节点、交付连线、逐文件回执与重放游标。移除输出后保留回执；独立事件即使路径相同也分别保留。Host 启用后补齐遗漏交付，不重新执行任务。

Convax 在等待任务结束前持久化删除目标及未完成创建身份。协调器使用原生 Workspace 归档、停止事件和活动查询，等待 Agent 与所属 job，并包含发现的 subagent 后代。已归档 Session 明确重试停止。只有确认归档且无活动后才移除图并记录墓碑；失败可重试，晚到创建结果在不绑定的情况下完成处理。关闭视图或停用 renderer 不请求删除。

## 提供方、迁移与 agent 工具

Host 提供方注册版本化解析器、命名端口、相邻版本纯迁移和可选的可取消引用准备。Client 渲染器独立注册；注册缺失或不兼容时，以占位保留数据、位置和连线。Convax 数据库导入经校验的前驱快照，将匹配 Session 预留合并到 thread 账本，保留前驱数据并报告未匹配 id。自有升级保留恢复副本。节点升级只在源修订号及提供方注册匹配时原子保留新旧数据。[Host 包](../../../../packages/plugin-host/README.zh.md)拥有失败与恢复细节。

Host 通过 `convax_graph` 提供选择性读取和提供方 schema，通过 `convax_commit` 提供有序语义编辑。[图工具参考](convax-graph-tools.zh.md) 定义操作、原子性、历史及兼容适配器。工具默认使用调用 Session 所绑定的 Chat 画布，也可指定显式目标；可用性随 Host 生命周期变化，独立于 renderer。

## 插件编写

Host 在 `skills` 可用时可选挂载 DSH 已有文件系统 skill 提供方。其 `convax-development` 提供方暴露随包[开发 skill](../../../../packages/plugin-host/skills/convax-plugin-development/SKILL.md)，并随 Host 注销。[canvas-note 模板](../../../../packages/plugin-host/templates/canvas-note)使用普通 bundle 安装、可选节点适配和显式创建工具，不提供原生笔记 UI 或创建工具栏贡献。中央 Creator 资产和 DSH 发现协议保持不变。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxconvax--convaxhost"></a>

### `ctx.convax` — `ConvaxHost`

Host Remote namespace for canvases, Chat operations and resource access.

```ts cordis-catalog
/**
 * Read the current graph and runtime provider metadata.
 * @returns Current committed canvases and available Host node types.
 */
@Remote workspace(): CanvasWorkspace

/**
 * Register a Host node provider independently of its client renderer.
 * @param definition - Stable type identity, current payload parser and optional pure upgrades.
 * @returns Effect disposer that cancels and drains this provider's asynchronous work.
 */
registerNodeType(definition: CanvasNodeDefinition): () => Promise<void>

/**
 * Retry incompatible nodes using the current provider without discarding original data.
 * @returns Once each attempted transform settles; failures remain in workspace diagnostics.
 */
@Remote async retryMigrations(): Promise<void>

/**
 * Commit one graph mutation or return an explicit rejection.
 * @param request - Retry identity, expected revision and command.
 * @param signal - Optional cancellation before a graph commit; deletion intentions remain recoverable.
 * @returns Mutation outcome with a complete current snapshot.
 */
@Remote async execute(request: CanvasCommandRequest, signal?: AbortSignal): Promise<CanvasCommandResult>

/**
 * Return the canvas's local default working directory, creating it if needed.
 * @param canvasId - Existing canvas identity; existing Chat directories remain unchanged.
 * @param signal - Optional caller cancellation; Host shutdown cancels and drains the operation.
 * @returns Absolute directory usable by the composed filesystem, or an explicit failure.
 */
@Remote ensureCanvasDirectory(canvasId: CanvasId, signal?: AbortSignal): Promise<string>

/**
 * Validate and commit ordered graph edits under one durable retry identity.
 * Resource creation checks do not repeat after a receipt or lifecycle intention exists.
 * @param input - One canvas version, retry identity and ordered semantic operations.
 * @param signal - Cancellation before graph publication; pending lifecycle work remains recoverable.
 * @returns Current workspace or an explicit conflict, failed operation, or recoverable lifecycle state.
 */
async commit(input: CanvasCommitRequest, signal?: AbortSignal): Promise<CanvasCommandResult>

/**
 * Create or fork a durable thread inside one Chat without sending input.
 * @param request - Chat target, expected revision and stable retry identity.
 * @returns Actual DSH Session binding, or a recoverable failure.
 */
@Remote createThread(request: CanvasThreadRequest): Promise<CanvasThreadResult>

/**
 * Open an original Session on a canvas, retaining its messages and schedule identity.
 * @param request - Existing Session, preferred canvas and retained Chat placement identity.
 * @returns Unique Chat location and complete workspace, or a rejection without creating a Session.
 */
@Remote({ resources: { session: (request: CanvasOpenSessionRequest) => request.sessionId } }) openSession(request: CanvasOpenSessionRequest): Promise<CanvasOpenSessionResult>

/**
 * Retry unfinished Chat operations and delivery catch-up using their saved identities.
 * @returns Once every retry has settled or exposed a retained failure.
 */
@Remote async retryOperations(): Promise<void>

/**
 * Follow committed workspace snapshots until cancellation or Host shutdown.
 * @param signal - Caller lifetime supplied by the Remote carrier.
 * @returns Initial snapshot followed by coalesced committed snapshots.
 */
@Remote({ mode: 'stream' }) async *watch(signal: AbortSignal): AsyncIterable<CanvasWorkspace>

/**
 * Resolve a resource explicitly chosen by the user without a hidden Session.
 * @param path - Absolute path in the composed filesystem world.
 * @param signal - Optional cancellation; absent reads run to completion.
 * @returns Existing file or directory metadata.
 */
@Remote describe(path: string, signal?: AbortSignal): Promise<CanvasResource>

/**
 * Resolve one node into an explicit composer reference without sending input.
 * The provider and node must remain current until resolution completes.
 * @param canvasId - Canvas containing the source node.
 * @param nodeId - Source node chosen by the connection gesture.
 * @param signal - Optional cancellation; absent work follows the Host lifetime.
 * @returns Filesystem-validated file or folder metadata; no graph or project mutation.
 */
@Remote prepareReference(canvasId: CanvasId, nodeId: CanvasNodeId, signal?: AbortSignal): Promise<CanvasResource>

/**
 * Read direct children of an explicitly selected folder.
 * @param path - Absolute directory path.
 * @param signal - Optional cancellation; absent reads run to completion.
 * @returns Sorted metadata; reading does not add nodes or change real files.
 */
@Remote listDirectory(path: string, signal?: AbortSignal): Promise<CanvasDirectory>

/**
 * Preview UTF-8 text through the composed filesystem's existing access policy.
 * @param path - Absolute file path.
 * @param signal - Optional cancellation; absent reads run to completion.
 * @returns Text window with explicit truncation.
 */
@Remote previewFile(path: string, signal?: AbortSignal): Promise<CanvasPreview>

/**
 * Read complete document bytes through the filesystem policy, converting Word and PowerPoint files with the shared service.
 * @param path - Absolute source path, independent of any Session.
 * @param signal - Optional caller cancellation; Host shutdown also cancels and drains the read.
 * @returns Caller-owned binary content and source metadata; oversized or changed sources reject.
 */
@Remote readDocument(path: string, signal?: AbortSignal): Promise<CanvasDocumentPreview>

/**
 * Authorize media content access without buffering the file or creating a Session.
 * @param path - Absolute source path.
 * @param signal - Optional caller cancellation; Host shutdown cancels and drains the authorization read.
 * @returns Metadata used by the version-pinned authenticated media URL.
 */
@Remote mediaSource(path: string, signal?: AbortSignal): Promise<CanvasMediaSource>

/**
 * Observe resource metadata without reading file content.
 * @param path - Absolute file or folder reference.
 * @param signal - Remote consumer lifetime.
 * @returns Initial metadata and refreshed metadata after filesystem invalidations.
 */
@Remote({ mode: 'stream' }) watchResource(path: string, signal: AbortSignal): AsyncIterable<CanvasResource>

/**
 * Observe directory contents without importing changed files into the canvas.
 * @param path - Absolute directory reference.
 * @param signal - Remote consumer lifetime.
 * @returns Initial listing and refreshed listings after filesystem invalidations.
 */
@Remote({ mode: 'stream' }) watchDirectory(path: string, signal: AbortSignal): AsyncIterable<CanvasDirectory>

/**
 * Observe a file preview without modifying its original content.
 * @param path - Absolute file reference.
 * @param signal - Remote consumer lifetime.
 * @returns Initial preview and refreshed previews after filesystem invalidations.
 */
@Remote({ mode: 'stream' }) watchFile(path: string, signal: AbortSignal): AsyncIterable<CanvasPreview>

/**
 * Cancel and drain ancestry checks, Chat coordination, resource reads and observations before dependencies unload.
 * @returns Resolution after accepted work and watcher cleanup settle; independent of stream pulls.
 */
close(): Promise<void>
```

Types: [CanvasCommitRequest](convax-graph-tools.zh.md)

Source: [`../../packages/plugin-host/src/index.ts`](../../../../packages/plugin-host/src/index.ts)
<!-- END GENERATED cordis-surface -->
