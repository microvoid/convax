---
description: "为连接的 Convax Chat 配置图片、视频和音频生成，并恢复自动交付的媒体产物。"
kind: "package-reference"
---

# @deepseek-ai/dsh-convax-plugin-creation-host

[English](README.md) | 中文

## 摘要

通过连接到创作工作台的 Chat 生成图片、视频和音频。在工作台为各类媒体分别选择 Provider 和模型，连接的 Chat 直接使用这些选择。生成完成的媒体会成为普通 Chat 交付物，并作为现有文件节点连到来源 Chat。所选 Provider 可能收取生成费用。

## 目录

- [使用此包](#use-this-package)
- [配置 Provider](#configure-providers)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办事项](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>

## 使用此包

Creation 已包含在 [Convax 组合](../plugin-renderer/cordis.patch.yml)中，无需单独安装插件。[Creation Renderer](../plugin-creation-renderer/README.zh.md) 提供工作台卡片；Chat 和文件节点沿用现有界面。

1. 在画布新增创作工作台，打开其设置。
2. 点击**连接创作服务**，选择 Provider，只填写一次必要设置和模型。**连接并应用**会检查连接，并在同一次操作中将支持的能力应用到尚未配置的媒体路由。具体尺寸、时长等生成要求在 Chat 中描述。
3. 点击工作台上的 **新建 Chat** 创建并连接普通 Chat，也可以连接已有 Chat。一个 Chat 使用且只使用一个连接的创作工作台。
4. 在 Chat 中提出媒体生成要求。打开**任务**查看需要确认的报价，一次确认当前展示的批次。同一面板保留生成进度和已完成结果。成功产物会自动导入，并连接到发起任务的 Chat。
5. 后续生成时，可以将已交付文件或产物 asset ID 作为参考素材，前提是 Provider 支持该媒体角色。

工作台按媒体类型显示服务与模型。打开对应行，先选 Provider，再从其子菜单选择模型。尚未连接的 Provider 提供当前媒体类型的连接表单。例如，图片可以使用 LibTV，视频使用即梦。修改一行会保留其他路由和已提交任务的原配置。Chat 不重复配置 Provider。从画布移除产物不会要求 Provider 再次生成。

Host 组合接受两个资源限制参数。Provider 连接参数在工作台中另行配置。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `maxBytes` | `536870912` | 单个导入媒体文件或参考素材的最大字节数。 |
| `pollMs` | `3000` | 运行中异步任务的状态观察间隔。 |

<a id="configure-providers"></a>

## 配置 Provider

每个连接拥有自己的设置及可选凭证引用。API Key 填写在凭证字段中，不要放进 URL、模型 ID 或路由默认参数。CLI 设置会检测现有可执行文件和登录态。缺少可执行文件时，**安装 CLI** 会将支持的官方版本下载到 Host 私有目录。只有点击该按钮才开始安装；安装不启动登录流程。

连接弹窗显示安装进度并提供重试。关闭弹窗后，已经发起的安装继续运行；重新打开会读取当前状态。安装成功后自动复检，仍可能提示需要登录。已安装的可执行文件在 Host 重启后仍可使用，无需修改用户的 Shell 配置。

托管安装使用即梦 `1_0_0_60` 和 LibTV `1.2.0`，保存在 `DSH_HOME/creation/cli` 下，不自动升级。优先使用 PATH 中已有的可执行文件；明确指定的可执行文件路径保持有效。安装器选择对应平台的产物，验证后才移入正式目录，失败时保留已有安装。不支持的平台仍提供自定义路径字段和官方安装入口。Host 关闭时停止未完成的下载，之后可重新尝试。

设置流程将 CLI 安装和登录检查与生成参数分开。模型发现返回适配器支持的候选项，同时保留手填模型 ID。连接和工作台修改一起提交。Provider 不可用时保留可编辑表单，不发布新连接。已有路由保留选定连接；编辑该连接会更新其模型，无需再在路由上选择一次。

| Provider | 媒体类型 | 必要配置 |
| --- | --- | --- |
| `jimeng-cli` | 由所选模型目录决定的图片、视频和音频生成 | 授权 CLI，并至少选择 `imageModel`、`videoModel` 或 `audioModel` 中的一项。Host 自动管理 `projectId`。可选非负整数 `creditCeiling`、`executable`、绝对路径 `cwd` 和 `profile`。 |
| `libtv-cli` | 由所选模型 Schema 决定的图片、视频、音频 | `projectUuid`、布尔值 `watermark`，以及至少一个模型字段。可选 `executable`、绝对路径 `cwd` 和 LibTV Token 凭证，也可以使用 CLI 现有登录态。 |
| `openai` | GPT Image 图片生成/编辑及语音合成 | API Key，以及 `imageModel` 和/或 `audioModel`。可选 `baseUrl`，默认为 `https://api.openai.com/v1`。 |
| `volcengine-ark` | 视频生成 | API Key 和 `videoModel`（模型 ID 或 Endpoint ID）。可选 `baseUrl`，默认为 `https://ark.cn-beijing.volces.com/api/v3`。 |

即梦默认可执行文件为 `dreamina-canvas`。授权按钮打开官方授权页；Host 等待设备授权交换，成功后加载模型显示名称。关闭设置仅停止观察，不取消授权。请求过期或被拒绝后，可以明确重新发起。**连接并应用**在校验所选模型后内部创建 Provider 画布，重试沿用相同身份。已有连接保留原画布，用户无需选择或命名。

即梦先保存每项生成草稿，再获取本次实际积分报价。未明确设置积分上限时，**任务**展示待确认的提示词与最高总费用。**确认本批并生成**仅批准点击时展示的报价，新增或上涨的报价需要再次确认。已配置上限时，仅允许报价不超过上限的任务自动执行。确认后继续使用原节点和提交身份。重启和重试不会授予批准。

即梦各类模型独立选择，只需配置需要的媒体类型。`creation_describe` 返回所选模型当前的模式、参数限制和参考素材要求。目录允许时，支持图片 `t2i`/`i2i`、视频 `t2v`/`first_last_frame`/`m2v`，以及音频 `tts`/`music`。首尾帧视频通过 `reference` 图片按首帧、尾帧顺序输入。文本朗读需要一个目录音色，通过 `voice-id` 或 `voice-name` 提供；适配器会读取所选模型的音色目录。其他语音场景遵循目录中的参考素材要求。音色、时长等生成选项在 Chat 中描述，无需重复配置模型。

LibTV 默认可执行文件为 `libtv`。工作目录不得带有生效中的 LibTV 分组绑定。`watermark` 断言下载文件是否带社区水印：非会员使用 `true`，会员使用 `false`。CLI 会校验会员状态；适配器不会绕过检查。此适配器每次生成导入一个产物，不支持强制批量生成的模型。

OpenAI 语音要求 `voice`；可选 `response_format` 为 `mp3`、`opus`、`aac`、`flac` 或 `wav`。GPT Image 支持角色为 `reference` 的参考图编辑，并提供 `n`、`size`、`quality`、`background` 和 `output_format` 参数。产物先保存到本地，再自动交付。官方 Videos API 已停用，因此不声明 OpenAI 视频能力。

方舟创建异步视频任务。适配器接受 `first-frame` 和 `last-frame` 图片参考素材；使用尾帧时必须同时提供首帧。参数采用官方 API 名称，包括 `duration`、`ratio` 和 `resolution`，具体组合以所选模型的支持范围为准。此适配器不提供本地视频/音频参考素材输入。

<a id="understand-the-implementation"></a>

## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

工作台保存路由，Host 管理的连接记录保存 Provider 设置和凭证引用。原生 DSH 工具调用提供真实的 Session、轮次和调用身份。Host 在提交后台任务前固定调用来源和连接版本。Provider 实现获得取消信号、任务私有目录、字节限制，以及需要等待完成的持久化检查点回调。

外部插件实现 [types.ts](src/types.ts) 中的 `CreationProvider`，并通过 `ctx.convaxCreation.registerProvider` 注册实例。所属插件销毁时必须等待返回的注销函数完成。`describe` 声明实际能力和 Schema；`submit` 发起一次生成；`reconcile` 查询原任务；`collect` 写入指定暂存路径。`cancel` 必须如实报告 Provider 支持的行为。凭证和临时下载 URL 不得写入检查点或画布数据。

即梦在生成前持久化明确的节点和提交 ID。LibTV 创建新节点、保存其 Key，再执行一次生成。方舟保存返回的任务 ID。OpenAI 保存同步响应字节和本地回执，恢复时读取该回执。如果提交响应丢失，且尚未保存可恢复身份或回执，任务会保持结果不确定。恢复操作不会静默重新提交生成。

即梦三种媒体共用官方 `resource get` 和 `resource download` 路径。下载前校验资源身份、媒体种类和完成状态，下载后将回执中的资源 ID、目标路径、字节数及 SHA-256 与实际文件逐项核对。导入前检查媒体容器和种类。传输或校验失败时，可通过原任务恢复，不会提交替代生成。

Host 校验收集到的媒体，通过 DSH 现有交付物路径发布，再由 Convax 现有交付投影创建文件节点及 Chat 连线。发布和投影重试复用持久化身份。取消操作阻止后续产物自动交付；已经交付的文件保留。

| 源文件 | 职责 |
| --- | --- |
| [service.ts](src/service.ts) | 工作台路由、调用上下文作用域、连接及参考素材准备。 |
| [runner.ts](src/runner.ts) | 持久化任务恢复、文件收集和交付。 |
| [providers](src/providers/index.ts) | 内置 Provider 实例创建及外部 API/CLI 适配。 |
| [适配器测试](tests/providers/adapters.spec.ts) | 本地 HTTP 和真实子进程夹具，包括提交结果不确定时的恢复。 |

[真实收集检查](tests/jimeng-download.e2e.ts)使用你拥有或获准访问的已有资源，执行正式即梦收集适配器。在仓库根目录运行：

```sh
pnpm exec vitest run --config libs/dsh/vitest.e2e.config.ts packages/plugin-creation-host/tests/jimeng-download.e2e.ts
```

未配置资源时，三个用例全部跳过；跳过不代表真实收集成功。启用某个用例时，将 `CONVAX_JIMENG_EXECUTABLE` 设为已安装 CLI 的绝对路径，将 `CONVAX_JIMENG_PROJECT_ID` 设为自己的画布 UUID，并通过对应的 `CONVAX_JIMENG_IMAGE_RESOURCE_ID`、`CONVAX_JIMENG_VIDEO_RESOURCE_ID` 或 `CONVAX_JIMENG_AUDIO_RESOURCE_ID` 提供一个已成功的资源。可选的 `CONVAX_JIMENG_PROFILE` 和 `CONVAX_JIMENG_CWD` 用于保持相同的已授权配置和工作目录，默认分别为 `default` 和当前目录。`CONVAX_JIMENG_MAX_BYTES` 默认 512 MiB。测试不登录、不生成媒体；它校验资源种类、文件容器、大小与 SHA-256，只输出不含秘密的媒体信息，并清理临时下载。

</details>

<a id="further-exploration"></a>

## 进一步阅读

- [Convax Host](../plugin-host/README.zh.md) — 现有 Chat 绑定、图事务及交付投影。
- [DSH 架构](../../libs/dsh/docs/architecture.zh.md) — Host 组合与插件生命周期。
- [即梦官方 CLI Skill](https://jimeng.jianying.com/canvas-cli/install/1_0_0_60/skill.tar.gz) 和 [LibTV 官方 CLI Skill](https://liblibai-web-static.liblib.cloud/cli/1.2.0/libtv-cli-skill.zip) — 已核对的命令与 Schema 参考。
- [OpenAI Images](https://developers.openai.com/api/reference/resources/images/methods/generate) 和 [Speech](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create) — 模型 API 契约。
- [方舟视频生成](https://docs.volcengine.com/docs/ark/video-generation-tutorial) 和 [取消/删除语义](https://docs.volcengine.com/docs/ark/cancel-or-delete-video-generation-tasks-api) — 任务生命周期及远端取消限制。

<a id="model-experience"></a>

## 模型体验

### 已连接 Chat 的上下文

#### 模型看到的内容

绑定到一个创作工作台的 Chat 会获得工作台上下文；拥有已有任务的 Chat 在断开工作台后仍保留任务上下文。上下文提供已配置的媒体路由和近期任务，包括可用 asset ID 及路径。动态字段及其数量限制由 [service.ts](src/service.ts) 管理。

##### 生成指令

```markdown
Creation uses the connected workbench. Generated files are delivered automatically; do not present them again.
```

#### Token 影响

已连接 Chat 的模型请求会增加固定指令，以及有数量限制、会变化的工作台和任务数据。

#### KV Cache 影响

路由或近期任务状态变化会替换上下文 Token，可能使该位置之后的请求前缀缓存失效。没有工作台或已有任务的 Chat 不获得 Creation 上下文。

### Creation 工具

#### 模型看到的内容

Chat 连接一个创作工作台时，[工具 Schema](../../libs/dsh/docs/tool-catalog.zh.md#deepseek-aidsh-convax-plugin-creation-host) 提供能力查询和生成操作。拥有已有任务的 Chat 仍可查询任务状态、恢复和取消。Host 从实际调用推导来源 Chat；模型不提供画布或账号身份。

#### Token 影响

符合条件的请求包含工具 Schema。工具结果会将任务状态、产物标识和恢复信息加入对话。

#### KV Cache 影响

连接或断开工作台会改变可用工具集合，可能使工具 Schema 前缀的缓存复用失效。每次工具调用后的结果会扩展对话。

## 已知限制与待办事项

<a id="known-limitations-and-deferred-work"></a>

- Provider 可用性、账号权限和模型支持范围通过其 API 或 CLI 检查。本地夹具测试覆盖适配器行为；这些测试不执行真实账号鉴权后的付费生成。
- 内置适配器不取消远端生成。方舟 DELETE 同时可删除已完成任务记录，无法安全地实现条件取消。已在 Convax 取消的任务仍可能产生 Provider 费用。
- OpenAI 无法恢复本地回执保存前丢失的字节。LibTV 中断的 `--run` 可能未将远端结果写回。这两种情况均保留不确定状态，不会自动重新生成并产生费用。
- 即梦 CLI 自行控制下载字节上限；适配器在传输后、导入前检查 Host 的 `maxBytes`。Host 上限不是传入 CLI 的下载参数。
- LibTV 仅导入单产物节点。方舟仅提供首尾帧图片输入。模型 Schema 可能拒绝端点级 Schema 允许的参数。

### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
