---
description: "Convax 默认节点界面"
kind: "package-reference"
---

# @deepseek-ai/dsh-convax-plugin-inernal-nodes-renderer

[English](README.md) | 中文

## Summary

预览文件和文件夹，使用包含多个 thread 的原生 DSH 对话，运行终端和浏览器卡片，将所选应用窗口镜像连到 Chat。停用这些界面后画布仍然可用。已保存卡片以占位保留位置及连线。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

[Convax 产品配置](../plugin-renderer/cordis.patch.yml)将此界面插件与[节点 Host](../plugin-inernal-nodes-host/README.zh.md)分别挂载。手动组合时，在画布 Renderer 和节点 Host 旁挂载以下配置行。安装此插件不会启用整个产品 bundle。

```yaml
- id: convax-inernal-nodes-renderer
  name: '@deepseek-ai/dsh-convax-plugin-inernal-nodes-renderer'
```

终端和浏览器卡片复用 DSH 内容与控件。终端使用画布目录，或输入文件夹、文件资源对应的目录启动。切换画布和关闭画布标签保留运行中的终端及已挂载网页。删除卡片使用原生终端或浏览器关闭链路；撤销恢复配置，不复活已关闭的实例。

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>注册与生命周期</summary>

节点界面、创建操作、文件预览、媒体播放、窗口采集和 Chat 与 DSH 的 UI 组合归属本插件。它通过公开画布渲染注册表提供能力，使用与第三方节点相同的展示及创建 API。画布底座保留通用图交互、持久化命令及插件缺失占位。

停用插件会释放预览读取、媒体播放器和实时窗口采集。原生 DSH 草稿及运行任务继续由 DSH 拥有。重新启用后恢复节点界面。实时绑定已释放的窗口需要明确重新选择。本插件保留输入框引用归属、发送时截图及原生模式选择，不改变 Computer Use 挂载规则。

</details>

<a id="model-experience"></a>
## Model Experience

### 节点与消息

#### What the model sees

模型接收原生 DSH 用户消息。保留的文件和文件夹引用仍使用原生引用。保留的窗口引用在发送时增加最新不可变 `PNG` 截图。预览或连接卡片本身不发送消息。

#### Token effect

窗口图片和保留的引用文本会增加发送输入的大小。卡片尺寸、创建控件和预览不增加模型输入。

#### KV Cache effect

已接纳的消息及截图保留原生历史和重试身份。改变卡片布局或停用界面不会重写请求前缀。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

窗口镜像保持只读，需要 macOS Desktop 采集权限。采集选择与 Computer Use 授权保持独立。音视频播放受浏览器和操作系统编解码支持限制。不支持的来源保留系统打开操作。

<a id="dev-note"></a>
### Dev Note

None.
