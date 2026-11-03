---
description: "Desktop 壳与客户端功能共享的类型化窗口选择及采集预留声明。"
kind: "package-library"
---

# @deepseek-ai/dsh-util-desktop-capture

[English](README.md) | 中文

## 概述

客户端功能可选择具体 Desktop 窗口，为下一次仅视频流授权预留目标，并检查源是否仍可用。这些声明避免 Electron 对象进入客户端桥。该库不采集内容，也不拥有应用状态；实现由 Desktop 提供。

## 目录

- [使用此包](#use-this-package)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

在 macOS Desktop 主应用文档中，先检查可选的 `dshDesktop.windowCapture` 存在，再使用[类型化桥](src/index.ts)。尚未验证的 Windows/Linux provider 不暴露它。`list()` 返回名称、id 及可用的应用图标（PNG data URL），不含窗口缩略图。串行执行 `prepare(sourceId)` 和后续由 renderer 拥有的 `getDisplayMedia({ audio: false, video: true })`。每个文档仅允许一个未消费预留，主进程仅为该具体窗口授权一次。保留 lease，直到客户端停止 track 并调用 `release(lease.id)`；获取失败后也要释放。

`validate(lease.id)` 重新枚举原生窗口。源缺失时永久撤销其 lease。准备图片前后均进行校验：track 活跃不能证明关闭或最小化窗口仍提供当前像素。保存选择线索，不保存仅在进程内有效的源或 lease id。[Desktop](../../../apps/desktop/README.zh.md)拥有权限及原生授权；renderer 拥有流和像素。导航及 provider 释放会撤销预留。人工采集不授权 agent Computer Use 工具，也不切换其 preset。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- 该仅视频协议不录制音频，不转发指针或键盘输入，也不让原生 id 拥有耐久身份。平台可用性需要原生验证；客户端必须报告失败，不能替换为另一源或旧画面。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文</summary>

无。

</details>
