# Agent Note: Convax 插件开发与 DSH 兼容方案

Status: proposed

[English](2026-10-30-convax-plugin-development.md) | 中文

## Problem

开发者需要同一条贡献路径来提供可复用的 DSH 能力和 Convax 卡片，AI 作者也需要使用相同的受支持 API 和安装路径。如果每个插件都必须加载完整画布，或者维护两套业务实现，原版 DSH 的兼容性就会变得脆弱。

[画布方案](../feature/2026-10-28-convax-canvas.zh.md)负责产品和图语义。本方案细化其中的插件开发决策，保留 DSH 现有的[插件管理](../../implemented/architecture/2026-09-14-current-profile-plugin-management.zh.md)和 [Client 加载](../../implemented/architecture/2026-07-23-client-plugin-loading-model.zh.md)决策。

## Proposal

DSH 继续负责插件运行、安装、依赖解析和 AI 编写流程。Convax 提供可选画布 API，并拥有产品专用协调。默认使用已有 API 和普通插件注册；修改 DSH 需要独立复现的缺陷或独立成立的通用需求。`dsh-convax-notes` 这样的包名不能保证兼容。

优先使用当前公开 Host 和 Client 注册。Host 随包提供[开发 skill](../../../../packages/convax/plugin-host/skills/convax-plugin-development/SKILL.md)和 [canvas-note 模板](../../../../packages/convax/plugin-host/templates/canvas-note/)，复用 DSH 已有文件系统 skill 提供方和 Plugin Manager 安装流程。仅声明辅助包或带原生 UI 的可移植 Notes 功能仍属于可选后续工作。[开发手册](../../../../docs/cookbook/convax-plugin-development.zh.md)拥有编写流程。

### 贡献方式与包结构

第三方功能可以放在独立仓库中，发布为普通 DSH bundle。共享 Convax API 和内置行为的改动通过本仓库的 pull request 贡献。两条路径都不要求通过独立的 Convax 插件市场发布。

默认使用一个业务插件包，包含 Host 逻辑、可复用 Client 组件、原版 DSH 入口和可选画布适配。只有能力或生命周期独立维护时才拆包。已有 DSH 插件可以新增独立的 Convax 桥接包，无须迁移业务数据。

| 插件组成 | 原版 DSH | Convax |
|---|---|---|
| Host 工具或业务服务 | 组合所需 DSH 依赖后可用 | 相同能力 |
| 仅原生面板 | 原生入口 | 需要当前画布布局支持的入口 |
| 仅画布适配 | 没有 Convax 时没有画布展示 | 画布卡片 |
| 业务服务与原生、画布两种适配 | 原生入口 | 使用同一服务的画布卡片 |

Host 适配通过 Cordis 可选注入 `convax`，Client 适配独立注入 `convaxRenderer`。注册跟随贡献作用域的生命周期。可移植业务插件不能让整个插件都等待其中任意服务。

Convax 声明使用仅类型导入。共享 UI 基础组件可以正常进行运行时导入，但为了一个辅助函数导入完整 Convax renderer 不属于可移植适配设计。安装业务功能不自动启用完整 Convax 产品 bundle。

### 现有 API 与可选贡献

当前 [Host 注册表](../../../../packages/convax/plugin-host/src/registry.ts)接受稳定类型 id、数据版本、解析器、具名端口、相邻版本的纯迁移函数和可选的可取消资源准备。[Client 注册表](../../../../packages/convax/plugin-renderer/src/client/node-renderers.tsx)为同一 id 和精确数据版本注册组件。Host 与 Client 注册的生命周期相互独立。

作者可使用导出的节点声明，无需导入产品私有文件。只有实际消费者需要时才抽取卡片或端口基础组件；说明已有注册不要求新增 Factory 或辅助包。原生 Conversation 通过已有 Factory 嵌入，外围布局由 Convax 拥有。

| 可选后续贡献 | 职责 |
|---|---|
| 节点创建贡献 | 本地化标题、图标和显式初始化器；接入现有创建控件、菜单或命令 |
| 节点工具栏贡献 | 在选中卡片上方注册操作，统一焦点与无障碍行为 |
| 资源接入贡献 | 识别支持的拖入资源并选择节点提供方 |
| 内嵌预览适配 | 复用已有预览提供方；只有实际消费者无法使用现有 Factory 时才增加接口 |
| 可移植功能示例与兼容测试 | 在随包画布专用笔记模板之外，增加原生 UI 与共享业务所有者 |

当前节点注册尚未实现这些可选注册表。随包 skill 和模板不依赖它们。保留底部居中的项目、文件和 Chat 控件，不增加通用“添加节点”主按钮。创建或工具栏元数据不能隐式执行节点。

### 数据、连线与执行

| 数据 | 所有者 |
|---|---|
| 笔记、任务等可复用业务实体 | 业务插件，根据自身需求使用 DSH 存储或自有实现 |
| 节点 id、类型、数据版本、位置尺寸、连线和 Chat 协调 | Convax Host 及其自有 SQLite 仓储 |
| Session 消息、执行、草稿和输入框 reference | DSH 已有服务；Convax 只拥有 thread 归属和恢复记录 |
| 选中状态与窗口展示偏好 | Client 展示所有者 |
| 凭据 | Host 上的 DSH 凭据服务 |

已有业务实体只在节点中保存 id 和展示设置。小型节点专用状态可保存在节点数据中。图通过带修订号和操作身份的 Convax 命令修改，不能增加另一图写入者。Convax 自有 SQLite 仓储同时拥有单一 thread 账本、Session 预留和删除意图；DSH 存储及 Session Controller 无需事务或耐久操作扩展。

Convax 开发组合通过 DSH 已有应用 home 覆盖机制传入仓库 `.convax`；插件通过各自持久化所有者访问数据，不硬编码路径。原版 DSH 与 Convax 可使用不同 home。包兼容不等于共享数据库；跨安装共享需要显式服务或导入导出，并遵守独占写入要求。

连线保存关系，输入框 reference 属于其输入草稿，删除 reference 不切断连线。保留在输入框中的 reference 决定下一条消息的输入。按钮、消息或显式工具触发执行；连接节点不自动启动工作流。

当前端口兼容要求 `valueKind` 字符串相等，资源准备产出经校验的文件或文件夹 reference。其他产物成为对话输入前需要显式 reference 协议。原生发送与入队协议保持不变；Convax 通过 `agent/pre-step` 拒绝删除中 Chat 及其 subagent 后代进入模型步骤。新增模型可见内容仍可从 Session 日志重建。

### 生命周期与兼容性

卸载适配时注销其贡献，并取消、等待所属异步工作结束，不删除节点、业务实体或 Session 历史。缺少提供方或 renderer 时保留可恢复的占位卡片；重新启用时使用已保存的数据和受支持的迁移。

npm 发布版本和节点数据版本用途不同。节点迁移失败保留源数据；Convax 数据库升级保留恢复副本，并单调推进版本。在元数据与文档中声明实际支持的 DSH 和 Convax API 版本，不能暗示尚未发布的辅助包已经执行兼容检查。

Host 插件作为受信任代码在 Host 中执行，Client 贡献也不是经过沙箱隔离的第三方组件。独立权限或隔离系统需要单独设计。本方案复用当前 DSH 信任模型。

### AI 生成插件兼容

DSH 当前的 [Creator 编写 skill](../../../../packages/preset/agent-preset/skills/cordis-plugin-development/SKILL.md)将普通 bundle 文件写入工作区，再通过 `plugin_manager` 的 `install_bundle` 安装其绝对目录，安装结果跨重启保留。Convax 复用该路径，不修改中央 Creator skill 或 API 目录生成器。

[Host 注册](../../../../packages/convax/plugin-host/src/development.ts)可选注入 `skills`，以 `convax-development` 名称挂载原有 `@deepseek-ai/dsh-skill-filesystem` 提供方，设置 `includeDefaultRoots: false`、明确的随包 skill 目录和 `watch: false`。随包 `skills/convax-plugin-development/SKILL.md` 教授当前节点注册，并指向 `templates/canvas-note/`。提供方注册随 Host 生命周期释放；默认用户与项目 skill 发现仍归原提供方。中央 Creator skill 和 DSH skill 协议均不修改。

选择扩展方式前，发现当前启用的 Host 和 Client API。Convax 缺失时，可移植功能可以使用原生入口；仅画布请求则明确提示需要启用 Convax。用户只要求业务插件时，AI 编写不能隐式激活整个画布。

通过当前 Loader 配置、实时 slot、可选注入以及 Convax README、skill 和模板发现能力。静态目录不能证明服务已经启用。当插件能够说明并检查已有注册时，中央目录未列出 `convaxRenderer` 不足以成为修改 DSH 生成器的理由。

画布 Chat 将原生 preset 选择传入 thread 创建，因此作者可明确创建 `cordis` thread 并复用 Creator。全局[创建插件入口](../../../../packages/client/ui-agent-preset/src/client/index.ts)保留原生导航。不能假设该导航创建已绑定 Chat，也不因 Convax 单独修改它；通过 Convax thread 命令验证画布入口。

生成的包与人工编写的包遵循相同的可选服务注入、存储所有权、数据版本、本地化元数据和 effect 清理要求。插件源码保留在工作区，通过 Plugin Manager 安装到 profile，不直接写 profile 清单或应用 home 文件。

随包 `@local/convax-note` 模板是仅画布可编辑笔记。独立的可选 Host/Client 适配注册 `local.note`；显式 `convax_note_create` 工具通过带修订号的命令创建卡片。它不提供原生笔记 UI 或创建工具栏入口，也不启用 Convax。安装后验证卡片、保存、重启和停用再启用行为；安装成功本身不能证明可见兼容。额外的创建或工具栏贡献仍需独立设计。

### 交付顺序

1. 说明导出注册及可选 Host/Client 注入，在所需服务存在和缺失时验证最小画布模板。
2. 通过普通 DSH 注册使用随包 Convax 自有 skill 和 canvas-note 模板，验证 Plugin Manager 安装及真实画布行为，不修改中央 Creator 或生成器。
3. 只有真实消费者需要时才考虑可移植 Notes 示例、共享声明、创建、工具栏或资源接入贡献；每项新增能力携带兼容与恢复测试。

## Alternatives considered

**独立的 Convax 插件运行时和 AI 生成器。** 这会重复安装、依赖解析、信任和生命周期处理，并让 AI 产物绑定单一外壳。可选适配保留同一套运行时与编写路径。

**要求每个插件安装完整 Convax bundle。** 这会让可复用业务功能改变原版 DSH 工作区，并阻止独立停用画布。业务依赖和产品激活保持分离。

**每张卡片保存一份重复业务记录。** 这会让原版 DSH 和 Convax 中的编辑发生分歧，并增加删除复杂度。实体引用保持单一业务所有者，节点专用状态仍归节点所有。

**将私有卡片组件作为公开扩展 API。** 这会让插件依赖产品布局和动态导入。当前声明与可选适配避免这项依赖；真实复用需求成立后再抽取基础组件。

## Acceptance criteria

- 开发者可在原版 DSH 与 Convax 安装可复用业务 bundle，通过两种适配使用同一业务所有者，在缺少两个 Convax 服务时保留原生行为。
- 分别停用 Host 或 renderer 后，其余预期能力仍可用；重新启用能恢复节点，不重建实体、不丢失图关系。
- 已有节点定义与渲染器通过公开 API 注册。后续创建、工具栏或资源接入贡献需实现和测试后，文档才能声称它们存在。
- 重启、源数据迁移失败、异步准备取消和插件替换均保留已提交数据，并拒绝过期结果。
- Convax 自有 skill 通过当前 API、Plugin Manager 安装和真实画布验证指导生成。原生插件生成保持可用，无需修改 DSH 中央编写资产。
- 不引入并行 Session 运行时、安装器、DSH 操作账本、全局输入准备协议、隐式连线执行或隐藏的图派生消息上下文。

## Risks

API 尚未稳定。教授私有导入、尚未提供的注册表或假定 UI 位置的模板会生成脆弱插件。发布编写指导前，验证导出、实际组合和生命周期行为。

原版 DSH 与 Convax 可能提供不同 UI 宿主，并使用不同存储 home。兼容承诺覆盖受支持的能力与适配，不包括自动 UI 放置或透明的跨应用数据同步。
