---
description: "运行一个小型 DSH bundle，通过 Convax 注册计数器、创建卡片，并用图命令保存节点数据。"
kind: "package-bundle"
---

# 示例：将计数器接入 Convax

[English](README.md) | 中文

## 摘要

将这个本地 bundle 安装到已经启用 Convax 的应用中，即可获得计数器节点和一个小型创建面板。创建卡片、修改数值、重开画布以及恢复插件时，都保留已保存的节点。示例使用其他 DSH 插件同样可用的 API，无需模型或 API key，也没有构建步骤。

## 目录

- [从零跑通](#run-from-zero-to-one)
- [理解实现](#understand-the-implementation)
- [验证示例](#verify-the-example)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="run-from-zero-to-one"></a>
## 从零跑通

先准备一个运行中的 Convax Web 或 Desktop 应用。[产品 README](../../README.zh.md#use-this-package)负责 Convax 的启用与启动，本示例不隐式启用它。DSH 插件打包与安装约定参见 [DSH 编写参考](../../../../libs/dsh/packages/preset/agent-preset/skills/cordis-plugin-development/references/host-plugin.md)。

1. 打开**插件**，添加本包的绝对目录，路径以 `packages/plugin-renderer/examples/counter` 结尾。也可使用本地 `link:/absolute/path/to/counter` 来源。本目录不需要执行安装或编译命令，Host ESM 入口和浏览器 factory 都是随示例提供的文件。
2. 检查安装与应用结果，必要时启用 bundle；管理器要求重启时，先完成重启。
3. 打开空画布，在右上角的**计数器示例**面板中点击**刷新**更新列表，再选择这个**目标画布**。
4. 点击**添加计数器**，所选画布出现显示 `0` 的卡片。当前视口看不到其位置时，点击**适应画布**。
5. 点击 **+** 或 **−**，卡片发送 `update-node` 并采用已提交快照，不将数值保存到组件状态或第二个数据库。
6. 重启应用并重新打开该画布，数值和节点位置仍保留。
7. 在**插件**中停用再启用本示例 bundle，按报告完成必要重启。提供方或显示组件不可用时，已保存节点保持可恢复；恢复后数值相同。

示例面板显式选择目标，因为注册节点 renderer 不会自动增加通用创建栏贡献。没有画布时，用现有 Convax 控件创建一个，再刷新面板。

创建返回冲突时，先刷新再发起新请求。传输失败导致结果未知时，**重试创建**复用完整请求和 operation id；**刷新**可以找回回复丢失前已提交的节点。面板保留未解决请求，不静默创建另一个计数器。

<a id="understand-the-implementation"></a>
## 理解实现

这些文件展示了普通 DSH bundle 如何增加 Convax 适配。按顺序阅读，无需导入 renderer 私有实现，也不需要额外插件运行时。

| 文件 | Convax 接入内容 |
|---|---|
| [package.json](package.json)、[cordis.patch.yml](cordis.patch.yml) | 普通 DSH 激活和浏览器模块发现。 |
| [index.js](index.js) | 可选注入 `convax`，通过 effect 注册 `example.convax.counter`。 |
| [client.js](client.js)——节点注册 | 可选注入 `convaxRenderer`，为载荷版本 1 提供组件。 |
| [client.js](client.js)——创建面板 | 使用现有 DSH `shell.overlay` 入口，以及 Convax `workspace`/`execute` Remote 调用。 |
| [client.js](client.js)——计数操作 | 通过 Convax 传入的节点 `command` 回调更新完整 `{ value }` 载荷。 |
| [locale/](locale)、[icon.svg](icon.svg) | 插件列表元数据和图形资源；UI 文案归 Client 本地化字典所有。 |

Host 解析器接受安全整数并返回 `{ value }`。这个小型计数器完全属于节点，因此由 Convax 负责持久化。可复用业务实体则应保持自己的服务，节点只保存实体标识。计数器没有端口，也不伪装成文件或文件夹 reference。

创建面板将所选画布 id、当前 revision 和唯一 operation id 传给 `execute`。卡片更新使用 Convax 传入的 `command` 回调，由其补齐请求封装。Host 与 Client 注册跟随独立 Cordis 生命周期；Client 作用域释放时取消写入调用，并等待其跟踪请求结束。

<a id="verify-the-example"></a>
## 验证示例

仓库通过实际示例文件进行自动验证。以下命令在仓库根目录运行，无需模型 key：

```sh
pnpm exec vitest run packages/plugin-host/tests/counter-example-loader.spec.ts packages/plugin-renderer/tests/counter-example.host.spec.ts packages/plugin-renderer/tests/counter-example.client.spec.tsx
```

Loader 检查运行真实隔离 profile，保存 `0 → 1`，拒绝小数且不写入，移除和恢复提供方，再让 Host 从已保存图中恢复。Client 检查加载随示例提供的浏览器 factory，执行卡片和创建操作。上面的运行步骤还用于检查安装后应用的实际入口与展示。

-----

<a id="further-exploration"></a>
## 进一步阅读

- [Convax 接入指南](../../../../libs/dsh/docs/cookbook/convax-plugin-development.zh.md)——能力说明与完整适配流程。
- [Convax Host](../../../plugin-host/README.zh.md)——命令、资源、迁移和失败行为。
- [DSH 插件编写](../../../../libs/dsh/packages/preset/agent-preset/skills/cordis-plugin-development/SKILL.md)——普通 bundle 约定。

<a id="model-experience"></a>
## 模型体验

本示例不增加工具、提示词或对话输入。已有 Convax 图查询工具在被显式调用时，可以返回其保存的节点和类型元数据；点击计数器不启动模型轮次。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

这是仅画布示例，缺少 Convax 服务时不提供卡片或创建面板。它展示注册、显式创建和持久化载荷更新；资源引用、Chat 集成和版本迁移使用各自的 Convax API。

原生创建栏没有通用第三方注册 API。示例面板是它自己的 DSH UI 贡献，不修改产品创建栏。卡片外框、交互和文案由示例提供，节点注册本身不会补齐所有内置卡片控件。

<a id="dev-note"></a>
### 开发备注

无。
