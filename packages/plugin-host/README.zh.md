---
description: "保存画布，将 Chat thread 绑定到 DSH Session，解析显式输入框引用并投影交付文件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-convax-plugin-host

[English](README.md) | 中文

## 概述

保存多张画布，组织来自不同项目的文件和文件夹引用。通过带修订号的命令修改节点和连线，自动持久化独立于画布界面。使用已组合的文件系统浏览目录并读取预览内容。移除引用保留原文件。Chat 节点包含多个 DSH Session thread，并复用原生对话 UI。消息使用原生输入框引用，明确交付的文件生成输出节点。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

通过 [Convax 产品组合](../plugin-renderer/cordis.patch.yml)挂载 Host。Convax 独占配置的应用 home 下的 `storages/convax-canvas.sqlite`，DSH 保留已有存储路由。Host 需要文件系统、Agent、Session 持久化、投影、工具与 Remote 访问控制服务；Chat 创建还需要 Workspace 和 Session 查询服务。renderer 的启用独立于 Host。

存在 DSH 技能注册表时，本 Host 通过已有文件系统技能提供方暴露打包的 [Convax 开发技能](skills/convax-plugin-development/SKILL.md)。结合原有 Creator 工作流，将可运行的[画布笔记 Bundle](templates/canvas-note/README.zh.md)复制到工作区，再通过 Plugin Manager 安装。模板属于纯画布能力，没有 Convax 时可加载，但不提供原生笔记视图。Host API 发布为公开的 `lib/types/index.d.ts`；Client 节点 API 由 renderer 的公开 `./client` 声明提供。这些可选注册不依赖静态中央目录。

新画布在 `canvasDirectoryRoot` 下获得本机工作目录，默认根目录为 `~/Documents/convax`。目录名使用稳定的画布身份，因此重命名或归档画布不会移动目录。`ensureCanvasDirectory` 返回可用的绝对路径；旧画布在首次请求时补建目录。已有分配不随配置变化而改变。目录准备先于图创建，包括图工具批量创建和画布复制。失败的创建可能保留空目录分配，但目录准备失败时不会发布新画布。Host 使用组合的文件系统校验本机目录；不兼容或访问被拒绝时明确报错，不替换为其他路径。

`previewBytes` 限制既有 UTF-8 文本预览的字节数，超出窗口时报告 `truncated`。`documentBytes` 默认为 52,428,800 字节（50 MiB），分别限制完整源文件字节和转换后 PDF 字节。完整文档读取在文件过大或来源变化时拒绝，不返回部分内容。资源路径必须为绝对路径。读取遵循已组合文件系统的策略，不修改文件，并向调用方报告失败。

`mediaSource` 授权媒体访问并返回带版本的元数据，不缓冲完整文件。经过认证的 Connection 路由 `/api/convax/media` 使用同一文件系统策略处理 GET 和 HEAD 请求。已知大小的来源支持单段 HTTP 字节范围，供播放与定位使用；大小未知时顺序传输。`mediaChunkBytes` 默认为 262,144 字节（256 KiB），在响应背压下限制每次文件系统读取的大小。媒体流不使用 `documentBytes`，不创建 Session，也不转码文件。来源变化或消费者取消时终止对应读取；Host 关闭时取消响应正文，并等待文件系统工作结束。

图命令需要目标画布身份、预期修订号和操作身份。过期修订返回冲突，不产生写入。相同重试通过耐久回执识别，返回当前工作台状态，不重复修改。使用不同参数复用操作身份会被拒绝。事务同时包含图和回执，不包含 Session 或文件系统写入。

重试相等性比较序列化后的请求字段。对象属性顺序及值为 `undefined` 的可选字段，不会区分其他字段相同的请求。操作运行期间与回执持久化之后使用同一比较方式。

`set-archived` 持久化用于整理的画布 `archived` 标志，缺省表示未归档。归档或恢复画布保留图、Session 绑定、运行中的工作及原生 Session 归档状态，不产生图撤销记录。`duplicate` 接收 `newCanvasId` 和 `title`，检查源画布修订号后，原子创建具有全新节点和连线身份的未归档画布。即使提供方不可用，也保留坐标、文件路径、提供方数据及连线端口；画布和节点修订号从一开始。不复制源 Chat 的 Session、未完成创建、输入框草稿、运行任务或图历史。新 Chat 容器没有绑定的 thread。使用源画布默认目录的 Chat 副本改用复制画布的目录；显式文件夹目录保持不变。复制画布不复制文件系统内容。删除或永久删除画布均保留已分配的目录与文件。

`purge` 通过既有停止、归档协调器等待 Chat thread 及未完成创建结束，再永久移除画布图和全部图撤销记录。涉及 thread 时需要确认。失败保留图、撤销记录及持久重试意图；图移除、历史移除与最终回执共同提交。源文件和 DSH Session 日志保留。操作回执、Session 绑定及删除墓碑继续用于识别重试和抑制晚到输出；已永久删除的画布身份不能复用。旧 `delete` 命令保持原有行为。

`add-subgraph` 在一个画布修订中提交多个新节点及其连线。调用方分配全局唯一的节点和连线身份，新节点修订号从一开始。Host 先校验每个节点的提供方、数据版本和内容，再校验连线端点与端口。批量请求被拒绝时图保持不变，操作身份仍可用于修正后的请求。此命令不创建 Session 绑定或输入框引用，添加 Chat 容器时也不例外。

`history` 通过 `targetOperationId` 和 `direction: 'undo' | 'redo'` 指向已提交的图操作，自身操作身份保证重试幂等。Host 只应用记录的字段，保留无关 Agent 编辑；被修改字段已变化或出现新连接时，整个转换原子拒绝。恢复的节点保留身份和提供方载荷，修订号递增，提供方不可用时也一样。批次的画布创建和移除保留可恢复生命周期快照，旧生命周期命令保留原有历史语义。重放连线不会插入输入框引用或重放交付回执。

历史操作移除 Chat 时使用既有确认与停止、归档协调器。恢复时保留原 Session 绑定，仅取消本次移除造成的归档，包括发现的子代理；不会恢复已停止的工作。原生归档恢复先记录持久意图，完成前不发布恢复的图。外部失败保留意图，供 `retryOperations` 或 Host 启动恢复。原先已归档的 Session，以及已抑制的交付或创建记录保持不变。

`createThread` 在重试时保留操作身份。Convax 在调用 DSH 公开 Session 持久化 API 前，将固定 Session 身份、解析后的目录和 preset，以及精确 fork 位置保存在同一 thread 意图中。先记录 Session 与 Workspace 完成状态，再绑定 Chat，因此绑定回复丢失不会重建 Session 或恢复已移除的 Workspace 成员关系。请求可选择 `agentPreset`，省略时只解析一次 DSH 默认值。fork 继承源 Session 投影中的 preset，保留继承前缀，避免将历史交付当作新输出。从文件夹创建的 Chat 使用该文件夹作为默认项目，后续输入连线保留已有 thread 的目录。

`openSession` 将已有原生 Session 放到画布上，不创建、fork 或启动 Agent。请求提供原始 `sessionId`、优先 `canvasId`、`expectedRevision`、调用方预分配的 `nodeId` 与 `position`。Host 验证原会话存在、未归档且具有绝对工作目录。已绑定到有效 Chat 的 Session 返回实际位置，包括其他画布上的 Chat 或丢失回复后的重试。否则在一个事务中新增 Chat 与唯一 Session 绑定，观察者不会看到需要初始化的空 Chat。原对话日志、Workspace 成员关系和自动化绑定保持不变。历史交付按观察到的 Session 游标视为已消费。版本冲突、Chat 身份已占用、提供方不可用或原生绑定尚未完成时，拒绝操作且不留下部分图写入。Remote 调用方必须同时具有原 Session 和完整画布工作区的访问权限。

文件或文件夹连线动作可调用一次 `prepareReference(canvasId, nodeId)`，将来源解析为显式原生输入框引用。解析会检查当前提供方、节点数据、兼容性及已组合文件系统，取消或来源变化时拒绝。仅发送输入框中保留的引用。删除引用保留连线；发送并清空草稿不会重新补入引用。已绑定 Session 和 DSH 原生 Session 都不接收隐藏的图派生内容。Host 通过原有 `agent/pre-step` hook 在所属 Chat 删除期间拒绝模型步骤，并从活动或持久化头信息追溯子智能体归属；输入入队继续使用 DSH 原生 API。

`convax.window` 节点仅存储 `bindingId`（UUID 选择身份）及 `name`；payload 拒绝原生窗口或进程 id 与采集句柄。当前 Desktop renderer 拥有用户明确选中的采集及发送时截图 reference。Host 持久化窗口节点和连线，不启动采集、不授予输入访问，也不通过文件系统 `prepareReference` 解析窗口。复制或恢复图数据不恢复采集权限；renderer 必须拥有匹配的实时选择，否则展示重新连接操作。

关闭视图不会停止 thread。删除包含 thread 的 Chat 或画布需要明确确认。Convax 记录删除意图，使用原生 Workspace 归档和停止请求，等待所属 Agent 与后台任务结束后再移除图记录。实际子智能体后代一并处理，独立分叉不受影响。残留活动、停止失败和取消均保留已归档 Session、图记录与可见的重试意图。重试已归档 thread 时会再次请求停止。失败或晚到的创建、删除工作保留原操作身份以便重试。`retryOperations` 继续未完成操作与交付恢复。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

仓储拥有自己的版本化 SQLite 数据库，仅在持久化成功后发布独立的图快照。提供方定义位于 effect 所有的注册表；耐久封装独立于提供方可用性保留类型身份与完整数据。内置文件、文件夹、窗口与 Chat 定义使用同一注册表。提供方缺失时仍可修改位置或移除引用，新的业务数据操作需要兼容提供方。客户端传输由 Host 的 Typert Remote 方法生成。`watchResource` 独立于内容传输元数据流；`readDocument` 通过一元 Remote 调用返回完整、带版本的字节，不创建 Session。Word 与 PowerPoint 源文件（`.doc`、`.docx`、`.ppt`、`.pptx`）使用可选的 [Office 转换器](../../libs/dsh/packages/document/office-to-pdf/README.zh.md)，返回 PDF 字节，同时保留原路径和缺失字体元数据。缺少转换服务或转换失败时报告明确错误。表格保留原始字节，供浏览器渲染。

工作区快照与单个 Chat 读取共用同一纯 Chat 投影，输入为独立的绑定、thread 操作及删除记录。每次读取单独构建索引，不跨提交保留缓存。thread 按序号与 Session 身份排序；失败保留耐久键顺序，并依次优先报告 thread 创建、活动删除及交付错误。被抑制的 thread 创建不进入可见 thread 列表及其交付错误。

`ctx.convax.registerNodeType` 通过提供方拥有的 Cordis effect 注册节点类型。定义声明稳定端口、当前数据解析器、逐版本纯 `migrations`，以及仅由显式引用解析调用的可选、可取消 `prepareInput`。移除提供方会取消并等待转换和准备工作结束，替代注册不能提交旧注册的结果。显式引用解析要求存在兼容的活动提供方。

仓储升级由 Convax 负责，变更版本前保留 SQLite 恢复副本。前驱 `storages/convax.sqlite` 在一致快照下读取并保持不变，其写入租约阻止旧 Host 同时使用。schema 七接受版本一至六的存储，保留已有图、历史和协调记录，并新增耐久的画布目录分配。目录分配独立于图撤销历史，并在图移除后保留。旧 Host 拒绝新版本，避免丢弃画布归档状态或误读新命令回执。旧 Session 预留记录合入对应 thread 意图；未匹配操作保留在前驱中，启动时明确警告。节点升级转换独立数据副本、验证结果，再原子保留新旧载荷及修订号。路径缺失、输出无效或取消时保留原数据；`retryMigrations` 使用当前提供方重试。

Host 专用 `convaxDeliveries` Session 投影归约明确的 `deliverables/presented` 事实。恢复读取活动或已持久化的 Session，不驱动 Agent。全部文件节点、交付连线、逐文件回执和事件游标共同提交。移除输出引用保留墓碑，删除抑制晚到输出。停用 renderer 后，这个所有者继续运行。已删除的画布身份保持退役。被移除的节点与连线身份只能通过自身图历史恢复，保留的 Session 绑定始终属于原 Chat。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Convax 包](../README.zh.md)——Host 与 renderer 职责。
- [Session 持久化](../../libs/dsh/packages/session/session-persistence/README.zh.md)——原生 Session 记录与句柄。
- [仓储迁移](../../libs/dsh/docs/upgrade-guide/v0.2.1-rc.3/convax-owned-storage/guide.zh.md)——前驱导入、验证与回退。
- [Convax 提案](../../libs/dsh/.agents/notes/proposed/feature/2026-10-28-convax-canvas.zh.md)——完整产品设计与剩余实施内容。

<a id="model-experience"></a>
## 模型体验

### 显式输入框引用

#### 模型看到的内容

模型接收原生用户消息，包括用户保留在输入框中的文件或文件夹引用。画布连线不会在发送时附加资源元数据或文件夹内容。显式图工具的结果仍通过普通工具日志对模型可见。

#### Token 影响

引用文本通过普通原生消息计入 token。Host 不为每次发送附加图上下文文本。

#### KV Cache 影响

原生消息历史决定请求前缀。修改连线不会重写已接纳消息，也不会向后续消息插入新上下文。

### Canvas 图工具

#### 模型看到的内容

Host 通过 `convax_graph` 提供选择性读取与提供方 schema，通过 `convax_commit` 提供有序语义编辑。成功批次只推进一次画布修订号，并记录一条回执和一条历史。旧五个工具保留兼容。[图工具参考](../../libs/dsh/docs/subsystems/convax-graph-tools.zh.md) 定义选择器、操作、版本条件及生命周期恢复。工具注册与默认 Session 到 Chat 的目标解析独立于 renderer。

#### Token 影响

Host 启用时，两个通用工具及五个旧工具 schema 加入工具集。存在技能注册表时，标准技能目录提供 Convax 开发摘要，加载时才读取完整说明。通用读取只返回请求的集合与字段；提交回执包含身份、结果修订号及适用时的明确拒绝。旧编辑回执保留目标图。调用及渲染后的 JSON 进入普通 Session 历史，不复制源文件内容。

#### KV Cache 影响

图编辑追加工具交互，不重写此前 Session 历史。画布变化时 schema 保持稳定；启用或卸载 Host 通过普通工具注册改变可用工具集。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 完整文档读取受 `documentBytes` 限制；Word 与 PowerPoint 预览需要活动的 Office 转换提供方。支持的展示格式由 [renderer](../plugin-renderer/README.zh.md) 拥有。

<a id="dev-note"></a>
### 开发备注

无。
