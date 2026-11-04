---
description: "Convax 默认节点提供方"
kind: "package-reference"
---

# @deepseek-ai/dsh-convax-plugin-inernal-nodes-host

[English](README.md) | 中文

## Summary

在已有画布上使用文件、文件夹、Chat 和所选窗口节点。Chat thread 保留原生 DSH Session、执行和持久化。停用此插件会保留节点、连线及 Session 绑定。重新启用兼容提供方后恢复可用性。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

[Convax 产品配置](../plugin-renderer/cordis.patch.yml)将本提供方、画布 Host 和节点 Renderer 分别挂载。手动组合时，在已有 Convax Host 旁挂载以下配置行。它不会启用画布界面。

```yaml
- id: convax-inernal-nodes-host
  name: '@deepseek-ai/dsh-convax-plugin-inernal-nodes-host'
```

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>注册与生命周期</summary>

四个版本化定义沿用 `convax.file`、`convax.folder`、`convax.chat` 和 `convax.window` 身份及数据格式。提供方使用与其他节点插件相同的公开注册 API。画布 Host 拥有图事务、历史、迁移及持久归属记录。本插件拥有节点校验、DSH Session 和交付适配。消息、草稿和 Agent 执行继续归属 DSH。

这些节点不新增数据库。停用本插件会取消并等待自身适配操作结束，不停止 DSH Agent，也不删除其日志。依赖提供方的新操作在重新启用前不可用。明确确认的删除操作继续使用独立的停止与归档语义。

</details>

<a id="model-experience"></a>
## Model Experience

### 节点与消息

#### What the model sees

节点描述及数据 schema 可通过 `convax_graph` 读取。图连线不添加隐藏消息上下文。原生消息只包含输入框保留的引用。

#### Token effect

请求的节点元数据与明确引用通过已有工具和消息产生 token。注册提供方不会为每次发送增加图文本。

#### KV Cache effect

图编辑和提供方重启不会重写已接纳的消息。请求前缀和持久 Session 历史继续由 DSH 保留。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

原生窗口采集需要节点 Renderer 及受支持的 Desktop 权限。停用节点提供方不会授予、撤销或改变 Computer Use 授权及预设默认值。

<a id="dev-note"></a>
### Dev Note

None.
