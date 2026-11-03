---
description: "通过普通 DSH 插件安装添加可编辑的纯画布笔记。"
kind: "package-bundle"
---

# 画布笔记示例

[English](README.md) | 中文

## 概述

向 Convax 画布添加可编辑笔记。此普通 DSH Bundle 使用可选 Host 与 Client 注册。没有 Convax 时仍可加载，但不会添加画布界面或创建工具，也不会启用 Convax 产品 Bundle。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

将本包复制到工作区，重命名包、类型、工具和本地化标识，再通过 Plugin Manager 安装绝对目录。纯 JavaScript Client factory 沿用 DSH Creator 已提供的打包格式，无需构建。

通过 `convax_graph` 的 `include: ["nodeTypes"]` 发现 `local.note`，再通过 `convax_commit` 的 `node.add` 创建，指定 `dataVersion: 1` 和 `data: {text: "..."}`。可选便利工具 `convax_note_create` 接受目标标识／版本、稳定操作与节点标识、文本及坐标。保存提交带版本的更新；移除删除卡片并保留其他节点。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

配置补丁插入一个 Host 条目，其可选 Convax 作用域拥有节点提供方与创建工具；Client 模块可选注册对应 renderer。笔记文本仅属于节点数据。空端口不会隐式添加输入引用，也不会启动对话。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [Host 提供方与工具](index.js)。
- [Client factory](client.js)。
- [Bundle 配置补丁](cordis.patch.yml)。

<a id="model-experience"></a>
## 模型体验

创建工具添加普通工具交互。笔记文本属于图数据，不会成为隐藏的对话上下文。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

节点不会自动加入内置创建 Dock。缺少兼容提供方或 renderer 时，保存的笔记显示为占位卡片。此示例没有原生 DSH 笔记视图。分发衍生插件前，验证保存及冲突反馈、重启、停用后恢复与本地化元数据；当示例图标不再符合能力时替换它。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
