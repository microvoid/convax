---
description: "在 Convax 创作工作台配置媒体生成，并连接原生 Chat。"
kind: "package-reference"
---

# @deepseek-ai/dsh-convax-plugin-creation-renderer

[English](README.md) | 中文

## Summary

在创作工作台为图片、视频和音频分别选择 Provider 和模型。连接普通 Chat 卡片后，通过对话请求生成媒体。完成的文件沿用现有资源展示出现在画布上。配套 Host 负责 Provider 可用性和凭据。

## Table of Contents

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## 使用此包

[Convax 产品组合](../plugin-renderer/cordis.patch.yml) 已启用此展示插件和配套 Host，无需单独安装。手动组合时，在 Creation Host 与画布 Renderer 旁挂载以下配置行：

```yaml
- id: convax-creation-renderer
  name: '@deepseek-ai/dsh-convax-plugin-creation-renderer'
```

此插件没有包级配置。新建工作台，点击**连接创作服务**，选择服务。填写必要设置，每个模型只选一次。**连接并应用**会保存连接，将支持的能力应用到工作台尚未配置的路由，然后关闭弹窗。已有路由保留选定服务。

CLI 设置会自动检查安装和现有登录态。缺少 CLI 时在同一弹窗提供安装按钮、进度和重试；安装成功后重新检查可用状态。关闭弹窗后，已发起的安装在 Host 中继续运行。API 服务支持密钥或环境变量引用；模型发现可获取兼容候选项。可执行文件路径、工作目录和 API 地址位于高级设置。连接失败时保留表单供修正。**管理**用于编辑连接详情和工作台名称。各媒体行负责选择自己的 Provider 和模型。

即梦可在同一弹窗发起授权，再选择至少一项图片、视频或音频模型。模型使用目录中的显示名称。**连接并应用**内部管理 Provider 画布，无需选择或命名。工作台用三个独立的媒体行显示服务和模型。下拉菜单第一级列出 Provider，子菜单列出该 Provider 的模型。尚未连接的服务可点击**连接 {provider}**，表单只选择当前媒体类型，**连接并应用**仅更新这一行。图片可以使用 LibTV，视频使用即梦。切换一行不会改变其他行和已提交任务。

点击工作台上的 **新建 Chat**，即可创建已连接的普通 Chat。输出端拖拽和连接已有 Chat 的操作仍可使用。Chat 直接继承工作台的创作能力，无需再次配置。通过对话生成媒体，完成的文件沿用现有交付和画布资源展示，并自动连接到发起生成的 Chat。

**任务**独立于**管理**，展示待确认报价、生成进度和最近完成的结果。**确认本批并生成**一次批准当前展示的报价，并显示最高总积分。后续新增或上涨的报价需要再次确认。失败项保持可见，不会隐藏其他结果。可选的自动批准积分上限仍位于连接的高级设置。

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>配置归属与验证</summary>

窗口持有的[控制器](src/client/workbenches.ts)负责草稿、Remote 调用和画布版本。注册的 Slot factory 渲染其可观察状态。API 密钥只作为临时表单输入；Host 保存凭据，仅返回是否已配置。关闭配置或保存连接后，输入会被清除。

能力连线与附件连线具有不同用途。画布 Host 校验来源声明，防止同一 Chat 重复绑定同一种能力的 Provider，历史回放也执行此检查。Renderer 从来源端口判断连线用途，展示兼容的创建操作。

在仓库根目录运行配置与连线的定向测试：

```sh
pnpm exec vitest run --config libs/dsh/vitest.config.ts packages/plugin-creation-renderer/tests/workbenches.spec.ts packages/plugin-renderer/tests/connection-creation.client.spec.tsx
```

[浏览器场景](../../libs/dsh/apps/web/tests/convax-creation.e2e.ts)保留真实配置、原生 Chat 提交和文件发布链路。夹具 Provider 覆盖基础设置，内置即梦和 LibTV 适配器通过受控的外部 CLI 边界验证分层模型选择、混合 Provider、批量确认及图片、视频和音频交付。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [Creation Host](../plugin-creation-host/README.zh.md)：Provider、凭据和生成生命周期。
- [画布 Renderer](../plugin-renderer/README.zh.md)：图操作和扩展契约。
- [默认节点展示](../plugin-inernal-nodes-renderer/README.zh.md)：原生 Chat 与媒体预览。

<a id="model-experience"></a>
## Model Experience

### 工作台配置

#### What the model sees

此 Client 插件不增加提示词或工具。配套 Host 向符合条件的 Session 提供 `creation_describe` 和生成工具。保存配置或连接卡片本身不会发送消息。

#### Token effect

工作台配置和卡片布局不增加模型输入。Host 负责创作工具的 schema 与结果，原生 Chat 负责提交的对话内容。

#### KV Cache effect

Client 布局和配置编辑不改写 Session 历史。可用创作工具或生成结果的变化由 Host 负责。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

设置界面用于选择连接和模型。生成参数通过 Chat 提供，路由默认参数可通过 Host API 设置。CLI 安装和账号授权使用 [Host 支持的 Provider 设置流程](../plugin-creation-host/README.zh.md#configure-providers)。配置的 Provider 必须支持所选媒体种类和模型。

<a id="dev-note"></a>
### Dev Note

无。
