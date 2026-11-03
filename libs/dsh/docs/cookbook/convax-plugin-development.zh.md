# 实操手册：为 DSH 插件添加 Convax 适配器

[English](convax-plugin-development.md) | 中文

## 摘要

通过 Convax 的 Host 节点注册表、Client 渲染器注册表和带版本校验的图命令，为已有 DSH 能力添加画布展示。本页先说明可用 Convax API，再通过可运行计数器示例串起注册、创建、保存和卸载恢复。普通 DSH 插件的打包和开发仍由 DSH 文档说明。

## 目录

- [前提](#choose-the-contribution)
- [参考：可用 Convax 能力](#convax-capabilities)
- [教程：运行并改造计数器示例](#counter-example)
- [参考：兼容性与当前限制](#compatibility-limits)
- [进一步探索](#further-exploration)
- [开发说明](#dev-note)

-----

<a id="choose-the-contribution"></a>
## 前提

已有 DSH 插件，或熟悉 [DSH 插件教程](../user/develop/basic/index.zh.md)、[Client 模块打包](../../packages/client/modules/README.zh.md)和[组合包安装](../user/develop/basic/publish.zh.md)。普通插件开发、包与构建设置、安装机制由这些参考文档负责。Convax 使用相同的插件运行时和组合包格式；本手册只说明在此基础上增加的适配器与画布能力。

对已有业务插件，保留其服务与原生入口。通过可选 Host `ctx.inject(['convax'], scope => ...)` 和 Client `ctx.inject(['convaxRenderer'], scope => ...)` 作用域添加画布适配器。画布节点可以引用已有业务实体，而不复制它。仅画布插件无需编造原生功能；下方计数器示例有意将少量状态只保存在节点中。

<a id="convax-capabilities"></a>
## 参考：可用 Convax 能力

以下 API 已存在于当前代码中。表格说明使用入口及重要限制；完整声明由链接的包和源码负责。

| 能力 | 当前入口 | 适配器用途与限制 |
|---|---|---|
| 节点定义 | Host `ctx.convax.registerNodeType` 与[提供方定义](../../../../packages/plugin-host/src/registry.ts) | 提供稳定类型 ID、载荷版本、解析器、可选迁移及具名端口；注册不会创建节点。 |
| 节点展示 | Client `ctx.convaxRenderer.registerNodeRenderer` 与[节点所属组件属性](../../../../packages/plugin-renderer/src/client/props.ts) | 渲染匹配类型和确切数据版本；提供的回调修改所属图。组件自行提供卡片 UI。 |
| 图 UI 组合 | [所属组件属性](../../../../packages/plugin-renderer/src/client/props.ts)中声明的 Client `convax.graph` Factory | 在 DSH UI 组合中，按声明的属性与存储复用图渲染；它不是独立嵌入 SDK。 |
| 画布状态与变更 | [Host API](../../../../packages/plugin-host/src/index.ts) 的 `workspace`、`watch`、`execute`，及[命令类型](../../../../packages/plugin-host/src/types.ts) | 读取持久化画布，提交带版本校验的节点与连线编辑，包括原子 `add-subgraph`；不直接写数据库。 |
| 具名连线 | 提供方 `ports` 与 Host 连线校验 | 输出、输入的 `valueKind` 必须完全相同。连线记录关系，不运行下游工作。 |
| 文件、文件夹与预览 | Host `describe`、目录和内容读取及监听、`readDocument`、`mediaSource` | 复用组合文件系统访问和资源预览；校验绝对路径，读取不创建 Session。参见[资源行为](../../../../packages/plugin-host/README.zh.md)。 |
| 输入框引用 | Host `prepareReference` 与提供方 `prepareInput` | 将显式源解析为校验过的文件或文件夹资源。解析不发送提示词；输入插入与保留由现有输入框负责。 |
| Chat 与 thread | 内置 `convax.chat`、Host `createThread` 与 [Chat 协调器](../../../../packages/plugin-host/src/chats.ts) | 创建或 fork 持久化 DSH Session 绑定；使用现有对话和输入框渲染。只有图记录的 Chat 节点不代表已创建 Session。 |
| 持久化与升级 | Convax [仓储](../../../../packages/plugin-host/src/repository.ts)和[迁移协调器](../../../../packages/plugin-host/src/migrations.ts) | 图封装记录的持久化独立于渲染器生命周期；节点相邻纯迁移失败时保留原数据。 |
| agent（智能体）图操作 | Host 注册的五个[图工具](../../../../packages/plugin-host/src/tools.ts) | 无需打开视图，即可查询画布、添加已有文件、连线、移动与排列节点。自定义节点创建仍需自有操作或工具。 |

<a id="connect-data-and-user-actions"></a>
### 图与输入语义

图请求携带 `canvasId`、`expectedRevision` 与 `operationId`。相同请求重试复用同一操作标识；版本被拒绝后，需先读取当前状态再提交修订意图。区分结果未知与确认拒绝。图事务不包含任意业务服务或文件系统写入；[Host 命令语义](../../../../packages/plugin-host/README.zh.md#use-this-package)说明回执和原子操作。

可复用实体在节点中保存实体 ID 与展示字段，通过业务服务保存实体。少量节点专属值可以使用 `update-node`。DSH 负责 Session 消息、草稿及引用提交。删除输入框引用不影响连线；图连线不能提供隐藏模型上下文或扩大可写项目根目录。

<a id="counter-example"></a>
## 教程：运行并改造计数器示例

示例位于 [examples/counter](../../../../packages/plugin-renderer/examples/counter/README.zh.md)。它是嵌套在渲染器包中的独立本地 DSH 组合包，不是另一个工作区包。其普通 ESM Host 和浏览器产物无需转译。它通过已有公共 API 增加一个自定义计数器节点及显式创建面板，不增加通用创建栏扩展。

<a id="install-the-development-bundle"></a>
### 1. 在已启用 Convax 的配置档案中加载示例

使用已启用 Convax 的运行中 Web 或 Desktop 配置档案。在**插件**中将 `packages/plugin-renderer/examples/counter` 的绝对目录作为本地包添加。操作卡片前先完成报告要求的重启。加载此示例不会安装或启用 Convax 本身；完整设置与验证说明由[示例 README](../../../../packages/plugin-renderer/examples/counter/README.zh.md)负责。

在右上角**计数器示例**面板点击**刷新**，选择**目标画布**，再点击**添加计数器**。使用新的空画布更方便；打开选定画布，卡片不在当前视野时使用**适应画布**。面板选择明确的画布 ID，不从全局 UI 焦点猜测目标，也不调用尚未实现的创建注册表。

<a id="organize-the-package"></a>
### 2. 定位适配器文件

| 示例文件 | Convax 职责 |
|---|---|
| [package.json](../../../../packages/plugin-renderer/examples/counter/package.json) | 普通组合包与 Client 入口声明；没有单独的 Convax 包格式。 |
| [cordis.patch.yml](../../../../packages/plugin-renderer/examples/counter/cordis.patch.yml) | 激活此示例自有插件配置项。 |
| [index.js](../../../../packages/plugin-renderer/examples/counter/index.js) | 可选 Host 节点提供方及当前计数器载荷校验。 |
| [client.js](../../../../packages/plugin-renderer/examples/counter/client.js) | 可选带版本渲染器、创建面板、图读取及命令提交。 |

结合示例 README 阅读这些文件。改造已有 DSH 插件时，保留原业务入口并增加相关可选注册，而不是替换应用工作区或复制功能服务。

<a id="register-the-host-node-type"></a>
### 3. 注册 Host 定义

示例 Host 入口等待 `convax`，并通过 `scope.effect(() => scope.convax.registerNodeType(definition))` 注册 `example.convax.counter`。定义在数据版本一接受安全整数 `value`。它不声明端口，因为计数器状态不是文件系统资源，也不是隐式对话引用。

随解析器发布 `description` 与 JSON Schema `dataSchema`，让 `convax_graph` 能向 Agent 描述节点。通过 `convax_commit` 的 `node.add` 创建，使用已发现的类型、数据版本和载荷 schema；通过 `node.set` 修改。专用创建工具是可选项。[图工具参考](../subsystems/convax-graph-tools.zh.md) 定义完整替换、事务和重试语义。

定义其他节点时，一起替换示例类型 ID 与解析器。仅为有意义且受支持的连线添加稳定具名端口；持久化载荷变化时添加相邻纯迁移。注册返回的异步 dispose（资源释放）函数取消并等待提供方工作结束；卸载保留已存节点记录及关系。

<a id="register-the-optional-canvas-display"></a>
### 4. 注册 Client 适配器并保存

浏览器入口等待 `convaxRenderer` 和已有 `remote.convax` 贡献，再注册相同的类型 ID 与 `dataVersion`。卡片从 `props.node.data` 读取值，其 **−** 和 **+** 操作通过提供的 `command` 回调提交 `update-node`。带版本校验的保存由画布负责，因此卡片不写 SQLite，也不为计数值维护另一份权威副本。

示例创建面板读取 `remote.convax.workspace`，通过 `remote.convax.execute` 针对选定画布版本提交 `add-node`。这是示例自有可见操作，不是注册渲染器就自动具备的功能。端口渲染、卡片操作和额外注入状态需遵循实际 API；示例避免仅为取得辅助函数就运行时导入完整渲染器。

<a id="verify-and-contribute"></a>
### 5. 观察持久化与适配器移除

创建计数器、修改值，刷新图并重新打开画布。确认恢复了保存值。不删除节点，停用并重新启用示例：缺失提供方或展示的占位卡片应恢复为原计数器卡片。重启持久化是单独观察项；属于示例验证范围时通过受支持应用路径执行。

按示例 README 的[验证步骤](../../../../packages/plugin-renderer/examples/counter/README.zh.md#verify-the-example)运行自动化检查，再通过受支持应用验证可见入口、保存与恢复。

<a id="compatibility-limits"></a>
## 参考：兼容性与当前限制

计数器是仅画布适配器示例。缺少 Convax 服务时，可选注册不执行；它不提供原生计数器 UI。已有原版 DSH 实用行为的插件应保留这些行为，仅将画布适配器设为可选。同一包安装到两个应用，不会让两者自动共享存储目录或业务数据库。

Convax 拥有其配置的图数据库，独立于 DSH 存储路由。当前产品组合使用 `storages/convax-canvas.sqlite`；Convax Desktop 包装器提供开发数据目录。功能插件通过所属服务持久化业务数据，不硬编码 `.convax`，也不写该图数据库。参见 [Host 存储行为](../../../../packages/plugin-host/README.zh.md)和 [Convax 开发启动](../../../../packages/plugin-renderer/README.zh.md)。

通用第三方创建栏项目、卡片工具栏操作与资源接入贡献仍为提议中的扩展。当前节点注册 API 不添加这些入口。Client `NodePorts` 辅助组件是渲染器运行时导出，不是独立公共 UI SDK。使用明确受支持的基础组件或专门增加的共享 API，不要导入私有组件。

Host 与 Client 可用性相互独立。缺失提供方、渲染器及不兼容数据会保留可恢复占位卡片；新的业务数据操作需要兼容提供方。Client 元数据不能代替 Cordis 服务注入。静态 Host Service 目录不能证明服务已启用；当前 Client Service 发现目录未包含 `convaxRenderer`，实际声明仍可从包中读取。

<a id="debug-by-owning-source"></a>
### 示例不显示或无法保存时

先检查创建操作和目标画布，再检查已启用 Host 类型、匹配渲染器与数据版本，以及命令结果。示例**重试创建**保留结果不确定的请求标识；**刷新**检查其节点是否已经提交。确认的版本冲突需要新快照；载荷升级失败需要修复迁移并通过受支持路径重试，同时保留源数据。不要清除节点、为结果不确定的工作编造新操作标识，或直接向 `convax.node` slot 注册以绕过注册表。

-----

<a id="further-exploration"></a>
## 进一步探索

- [计数器示例](../../../../packages/plugin-renderer/examples/counter/README.zh.md)——可运行适配器及示例专属说明。
- [Convax Host](../../../../packages/plugin-host/README.zh.md) 和[渲染器](../../../../packages/plugin-renderer/README.zh.md)——当前完整行为。
- [Convax 接入架构](../developer/convax-plugin-contributing.zh.md)——架构与集成顺序。
- [Convax 开发 skill](../../../../packages/plugin-host/skills/convax-plugin-development/SKILL.md) 与[笔记模板](../../../../packages/plugin-host/templates/canvas-note/README.zh.md)——已有 DSH Creator 工作流可读取的接入资源。
- [扩展方案](../../.agents/notes/proposed/architecture/2026-10-30-convax-plugin-development.zh.md)——超出现有 API 的提议能力。

<a id="dev-note"></a>
## 开发说明

无。
