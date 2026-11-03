---
description: "Convax 画布 Host、文件引用持久化和可独立启停的 Desktop renderer 包地图。"
kind: "package-group"
---

# packages/ — 应用级画布

[English](README.md) | 中文

## 概述

通过持久画布与浏览器式 Tab 组织本地文件、文件夹和 DSH 对话。Host 独立于 renderer 持久化图并恢复 thread 操作；停用画布界面后返回 DSH 原生界面。Chat 节点复用原生对话流与输入框。Convax 自己拥有 SQLite 事务、迁移和删除协调，使用 DSH 已有 Session API。提供方定义、数据升级和 agent 图工具共享 Host 命令。[Convax 设计](../libs/dsh/.agents/notes/proposed/feature/2026-10-28-convax-canvas.zh.md)记录所有权和恢复决策。

## 目录

- [包列表](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包列表

这些包共享 [Convax 子系统](../libs/dsh/docs/subsystems/convax.zh.md)，Host 与 renderer 生命周期相互独立。

| 包 | 职责 |
|---|---|
| [plugin-host](plugin-host/README.zh.md) | 自有 SQLite 图、单一 thread 恢复账本、删除协调、显式引用、交付恢复和类型化 Remote 命令。 |
| [plugin-renderer](plugin-renderer/README.zh.md) | 全窗口画布、嵌入式原生对话和可安装的产品组合。 |

<a id="related-documentation"></a>
## 相关文档

- [Convax 接入指南](../libs/dsh/docs/cookbook/convax-plugin-development.zh.md)与 [counter 示例](plugin-renderer/examples/counter/README.zh.md)——为已有 DSH 插件注册节点、展示卡片并保存状态。
- [随包开发 skill](plugin-host/skills/convax-plugin-development/SKILL.md) 和 [canvas-note 模板](plugin-host/templates/canvas-note/)——通过已有 DSH 注册和安装编写画布专用节点。
- [插件架构方案](../libs/dsh/.agents/notes/proposed/architecture/2026-10-30-convax-plugin-development.zh.md)——最少 DSH 改动、可选适配和 Convax 自有编写指导。
- [Slot](../libs/dsh/docs/subsystems/slots.zh.md)——应用组合。
- [存储](../libs/dsh/docs/subsystems/storage.zh.md)——可复用业务插件使用的 DSH 持久化服务；Convax 图使用自有数据库。
- [Desktop 开发](../libs/dsh/apps/desktop/README.zh.md#develop)——本地数据目录与启动命令。

<a id="dev-note"></a>
## 开发备注

无。
