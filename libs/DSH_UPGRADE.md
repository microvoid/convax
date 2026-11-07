# DSH 上游与升级记录

本文记录 Convax 使用的 DeepSeek Harness 源码基线、保留的本地适配以及升级检查入口。`libs/dsh/` 是受当前仓库版本控制的源码副本，不是 Git submodule；Convax 自有包位于根目录 `packages/`。

## 固定基线

| 项目 | 值 |
| --- | --- |
| 官方仓库 | <https://github.com/deepseek-ai/deepseek-harness> |
| 依赖的上游 commit | [`22ddee3792402c3e70ec5f86a63c3e3e895a2f60`](https://github.com/deepseek-ai/deepseek-harness/commit/22ddee3792402c3e70ec5f86a63c3e3e895a2f60) |
| 上游提交时间 | 2026-10-23 19:48:59 +08:00 |
| 上游提交标题 | `Merge pull request #7075 from deepseek-harness/worktree-chatgap` |
| 上游 package version | `0.2.1-rc.3` |
| 上游完整根 tree | `98266a99ba0e9bf6bac8ea39434f48605e40b368` |
| 本地最初导入快照 | `74a39d921df7d028f2e202d19150651987e354d8` |
| 本次目录迁移前的 Convax 快照 | `f6dcd88e4a4060454892fab0117587f2682feac4` |

基线通过完整 Git tree 校验：官方上游 `22ddee3792402c3e70ec5f86a63c3e3e895a2f60^{tree}` 与本地最初导入快照 `74a39d921df7d028f2e202d19150651987e354d8^{tree}` 都是 `98266a99ba0e9bf6bac8ea39434f48605e40b368`，包含文件内容、路径和文件模式。最初导入提交属于旧项目历史，当前 `main` 的初始发布提交重新建立了历史；新克隆不一定拥有该旧提交，因此升级以官方 commit 和 tree 为依据。

迁移前快照包含三项后续 Convax 提交：全卡片尺寸调整 `1a236ffb8bf1358014857af1bc9f6170e4d5925d`、窗口重连 `805c4d06ad34f92405f79e50f965df25cb260e63`、双语演示文档 `f6dcd88e4a4060454892fab0117587f2682feac4`。这些是本仓库变更，不是 DSH 的上游版本。

## 目录与依赖归属

| 迁移前路径 | 当前路径 | 归属 |
| --- | --- | --- |
| `apps/`、`native/`、`python/`、`vendor/`、`website/` | `libs/dsh/` 下的同名目录 | DSH 应用、运行时及依赖源码 |
| `packages/` 下除 `convax/` 外的各组 | `libs/dsh/packages/` | DSH 包及 Convax 所需的 DSH 适配 |
| DSH 的 `scripts/`、`docs/`、`snapshots/`、`.agents/` 与构建配置 | `libs/dsh/` 下的同名路径 | DSH 的构建、规范、测试及文档 |
| `packages/convax/plugin-host/` | [`packages/plugin-host/`](../packages/plugin-host/) | Convax Host |
| `packages/convax/plugin-renderer/` | [`packages/plugin-renderer/`](../packages/plugin-renderer/) | Convax Renderer |
| 根 `README.md`、`README.zh.md` | 根目录保留 | Convax 产品说明 |
| 原始 DSH `README.md`、`README.zh.md` 及配对记录 | [`libs/dsh/README.md`](dsh/README.md) 及同级文件 | 上述上游基线的原始 DSH 说明 |

整个仓库使用根 `pnpm-workspace.yaml` 与一份 `pnpm-lock.yaml`。DSH 的内部包和 Convax 包属于同一个 pnpm workspace；`libs/dsh/package.json` 保留 DSH 的脚本与工具声明，不作为额外的父 workspace 包，也不在该目录单独维护依赖锁文件。Turborepo 从根目录编排任务，DSH 原有构建仍由其自身脚本执行。Convax 两个包保留既有包名及公开入口，目录迁移不改变 plugin id、Session 或画布存储格式。

依赖分类沿用 DSH 规则：Convax Renderer 的 `lucide-react` 仅供浏览器打包，声明位于该包的 `devDependencies`，根锁文件同步反映这一归属。这是依赖归类修正，没有为 Convax 增加规则豁免。

## 内置节点插件归属

Convax 画布底座与默认节点实现分别位于 `packages/plugin-host`、`packages/plugin-renderer` 和 `packages/plugin-inernal-nodes-host`、`packages/plugin-inernal-nodes-renderer`。产品 patch 独立挂载四行，保留原有 Host 与 Renderer 包身份。节点包复用公开注册、能力声明和界面贡献，不修改 DSH 的执行模式或 Computer Use 默认挂载。旧节点类型、payload、SQLite 与 Session 记录继续沿用。升级时保留新增包的 source alias、Host/Client 项目引用及构建发现；节点契约分别见[节点 Host](../packages/plugin-inernal-nodes-host/README.zh.md)和[节点 Renderer](../packages/plugin-inernal-nodes-renderer/README.zh.md)。

DSH 脚本容器本身不是 workspace 成员。其中 Desktop、Web 与 website 的 pnpm 命令通过 `--dir` 指向实际成员目录。这样独立 DSH 与外层 Convax workspace 都从目标包执行，不依赖 pnpm 从脚本容器猜测工作区。

## Convax macOS 安装包

在 Apple Silicon Mac 上安装根工作区依赖后，从仓库根目录执行以下命令生成本地测试用 DMG。

```sh
DSH_DESKTOP_PRODUCT=convax pnpm --dir libs/dsh/apps/desktop run package:mac:arm64:unsigned
```

产物位于 `libs/dsh/apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts/`。Convax 的应用标识为 `io.microvoid.convax`，图标源文件与官网共用。首次启动从包内加载 Convax bundle，直接进入画布。默认数据目录为 Electron 的 `userData/data`，可通过 `DSH_HOME` 覆盖。

Convax 安装包的版本由仓库根目录的 [`package.json`](../package.json) 管理。[DSH Desktop 清单](dsh/apps/desktop/package.json)保留上游包的版本。

从 GitHub 发布 macOS 安装包时，先将 Convax 的 `version` 更新并合入 `main`，再为对应提交创建并推送版本标签。标签名由 `v` 和该提交的 Convax 版本组成，例如 `v0.1.0`。标签推送会从 `main` 触发 [Convax Desktop Package](../.github/workflows/convax-desktop-package.yml)，流水线核对标签与 Convax 版本，并使用标签指向的提交构建。

Apple Silicon runner 使用 Developer ID Application 签名，将 DMG 提交 Apple 公证并附加公证票据。流水线验证签名、公证票据和 Gatekeeper 后，从 DMG 安装应用，在空用户数据目录下确认首启进入画布，再创建画布和 Chat 并重启检查数据。验收通过后，流水线将同一次运行生成的 DMG 和 SHA-256 校验文件发布到该标签的 GitHub Release。带预发布后缀的版本标记为预发布。重跑流水线会保留已发布的附件。

日常验证可在 **Convax Desktop Package → Run workflow** 手动构建。默认使用 `unsigned`，也可在 `main` 选择 `signed` 验证签名和公证。手动打包的 DMG 和 SHA-256 校验文件位于该次运行的 **Artifacts**，保留 14 天。

签名凭据配置在仓库的 `convax-macos-release` 环境中。团队的证书与公证密钥分别在 Apple Developer 和 App Store Connect 管理。[创建 Developer ID 证书](https://developer.apple.com/help/account/certificates/create-developer-id-certificates) · [创建 App Store Connect API 密钥](https://developer.apple.com/documentation/AppStoreConnectAPI/creating-api-keys-for-app-store-connect-api)

| 环境 Secret | 值 |
| --- | --- |
| `MAC_CSC_LINK` | 包含 Developer ID Application 证书和私钥的 `.p12`，以 Base64 编码 |
| `MAC_CSC_KEY_PASSWORD` | 导出 `.p12` 时设置的密码 |
| `MACOS_SIGNING_IDENTITY` | 证书名称，形如 `Name (TEAMID)`，省略 `Developer ID Application:` 前缀 |
| `MACOS_TEAM_ID` | 证书所属的 Apple Developer Team ID |
| `APPLE_API_KEY` | App Store Connect 团队 API 密钥 `.p8`，以 Base64 编码 |
| `APPLE_API_KEY_ID` | 团队 API 密钥的 Key ID |
| `APPLE_API_ISSUER` | App Store Connect 团队 API 的 Issuer ID |

升级 DSH 时保留安装包依赖闭包中的 Convax Renderer bundle、根 workspace 与锁文件发现，以及 [Desktop 首启](dsh/apps/desktop/src/main.ts)和 [Profile 初始化](dsh/apps/desktop/src/project-manager.ts)的产品配置。Convax 的 [Desktop Host](dsh/apps/desktop-host/src/index.ts)从包内运行时清单解析默认 bundle 和客户端插件。

## 需要保留或逐项替代的 DSH 适配

下表中的路径均相对于 `libs/dsh/`。它是升级复核清单，具体实现和对应测试以源码为准。上游升级后若提供等价能力，应迁移消费者并删除不再需要的本地适配。

| 适配 | 主要入口 | 升级时检查 |
| --- | --- | --- |
| 原生对话、草稿及输入框嵌入 | [`ui-conversation`](dsh/packages/client/ui-conversation/) 的 `src/client/contract/`、`skeleton/ConversationSession.tsx`、`skeleton/InputBar.tsx`、`draft.ts`、`service.ts`；[`ui-chat`](dsh/packages/client/ui-chat/) | 多个 Chat/thread 保留独立会话与草稿；输入框在卡片下方；会话切换不重建当前编辑器 |
| 连线引用与发送准备 | [`ui-input-trigger`](dsh/packages/client/ui-input-trigger/) 的 `src/client/controller.ts`、`service.ts`；[`ui-attachment`](dsh/packages/client/ui-attachment/) 的 `ReferenceCard.tsx`、`client/ComposerAttachments.tsx`；[`session-controller`](dsh/packages/api/session-controller/) 的 `src/client/sessions/manager.ts` | 文件或窗口引用进入目标草稿；删除引用不删除连线；发送窗口引用时重新采集；失败保留草稿；历史保留发送时附件 |
| 输入法、焦点与文字选择 | [`ui-conversation`](dsh/packages/client/ui-conversation/) 的 `src/client/input/editor/runtime.ts`、`input/machine.ts`、`skeleton/ConversationRoot.module.css`；[`ui-attachment`](dsh/packages/client/ui-attachment/) 的 `client/drop-events.ts`；[`ui-primitives`](dsh/packages/client/ui-primitives/) 的 `src/Modal.tsx` | macOS 系统拼音的首次 composition 不丢字；卡片正文支持框选和复制；前台弹层拥有键盘事件和焦点恢复 |
| 会话模式与权限默认值 | [`ui-agent-preset`](dsh/packages/client/ui-agent-preset/) 的 `src/client/AgentPresetInput.tsx`、`seat-store.ts`；[`ui-permission-presets`](dsh/packages/client/ui-permission-presets/)；Convax 的 [`cordis.patch.yml`](../packages/plugin-renderer/cordis.patch.yml) 与 [`Session materializer`](../packages/plugin-inernal-nodes-host/src/session-materializer.ts) | 新会话初始 PTC 与工作区可修改；输入栏成功选择后通过原生 Settings 保存新会话默认值；刷新、重启及已开始会话中的新建路径沿用选择；新建操作保留权限快照，冷创建及部分写入重试沿用该快照；失败不覆盖默认值；已有会话保留自己的配置 |
| 工作模式输入栏座位 | [`ui-agent-preset`](dsh/packages/client/ui-agent-preset/) 的 `src/client/AgentPresetInput.tsx`、`AgentPresetSeat.tsx`、`seat-store.ts` | 模式选择复用 DSH 预设逻辑；切换行为、会话默认值和原生工具挂载规则保持一致 |
| 嵌入式工具面板与局部布局 | [`ui-sidebar-right`](dsh/packages/client/ui-sidebar-right/) 的 `src/client/embedded-hosts.ts`、`shell/EmbeddedSidebar.tsx`、`shell/EmbeddedSidebarResizeHandle.tsx`、`contract/slots.ts`；[`ui-dockkit`](dsh/packages/client/ui-dockkit/) 的 `src/components/coordinates.ts`、`measure.ts` | 每个 Chat 在自身右侧展示工具；缩放后坐标与拖拽正确；工具面板不改变正文高度；隐藏面板保留其资源生命周期 |
| 画布终端与浏览器 | [`api-terminal-controller`](dsh/packages/api/terminal-controller/) 的 `runtime.ts`、泛型 Client model；[`ui-sidebar-terminal`](dsh/packages/client/ui-sidebar-terminal/) 的 `terminal.content`；[`ui-sidebar-browser`](dsh/packages/client/ui-sidebar-browser/) 的 `browserViews`、`browser.content` 与共享导航视图 | 画布终端复用用户终端运行及关闭实现，目录取画布或资源连线；浏览器复用原生页面和导航；切画布、关闭画布标签保留运行，删除卡片关闭资源，撤销恢复配置 |
| 独立文件预览 | [`ui-sidebar-documentpreview`](dsh/packages/client/ui-sidebar-documentpreview/) 的 `src/client/embedded/` 及各格式 Body | 文本、代码、Markdown、HTML、图片、PDF、表格可在文件卡片内显示；预览不创建额外 Session/Sidebar 标签；滚动、缩放及 HTML 内容交互可退出 |
| 插件、设置和自动化入口 | [`ui-plugin-manager`](dsh/packages/client/ui-plugin-manager/) 的 `PluginManagerSurface.tsx`、`navigation-store.ts`、`slot-contract.ts`；[`ui-settings-general`](dsh/packages/client/ui-settings-general/) 的 `src/client/index.ts`；[`ui-schedule`](dsh/packages/client/ui-schedule/) 的 `src/client/factories.ts` | 打开插件或设置不替换 Convax 工作区；自动化可定位已有 Chat/thread；关闭弹层保留画布和视口 |
| 工作区、目录选择和系统拖放 | [`ui-workspace`](dsh/packages/client/ui-workspace/) 的 `src/client/DirectoryPicker.tsx`、`contract/slots.ts`；[`ui-directory-picker-native`](dsh/packages/client/ui-directory-picker-native/)、[`ui-directory-picker-browse`](dsh/packages/client/ui-directory-picker-browse/) | 原生拖入保留文件系统路径；选择器可在画布中使用；Web E2E 保持显式的 in-page picker overlay |
| 桌面标题栏与宿主入口 | [`ui-layout`](dsh/packages/client/ui-layout/) 的 `src/client/AppFrame.tsx`、`AppFrame.module.css`；[`ui-entry-customization`](dsh/packages/client/ui-entry-customization/)；[`apps/desktop`](dsh/apps/desktop/) 的 `src/main.ts`、`web-document.ts`、`welcome-backend.ts`、`account-backend.ts` | macOS 原生窗口按钮留白、透明画布顶栏和宿主入口有效；顶部空白拖窗与 Tab 重排、画布平移互不冲突；标签溢出保留当前项和拖窗留白；独立的用户数据目录不被重置 |
| 应用窗口镜像 | [`apps/desktop/src/window-capture.ts`](dsh/apps/desktop/src/window-capture.ts)、`ipc.ts`、`preload-app.ts`；[`packages/util/desktop-capture`](dsh/packages/util/desktop-capture/) | 枚举具体窗口及应用图标；采集和权限失败可见；关闭、重新绑定或卸载释放资源；重连不偷偷替换为同名窗口；镜像仍只读 |
| 外层 workspace 与构建 | [`scripts/workspace-package-globs.ts`](dsh/scripts/workspace-package-globs.ts)、`client-build-environment.ts`、`generate-typert.ts`；[`Typert generator`](dsh/packages/typert/generator/) 的 `analyzer.ts`、`workspace.ts`、`worker.ts`、`build-output-guard.ts`、`cordis-catalog.ts`；TypeScript、tsdown 和测试配置 | 使用 `dshWorkspacePackages` 显式发现外部包；`sourceRoots` 允许已被聚合项目引用的外部源码；源码检查仍拒绝偷读产物；根 pnpm 负责依赖解析 |
| 文档目录与包分类 | [`scripts/gen-config-catalog.ts`](dsh/scripts/gen-config-catalog.ts)、`gen-client-catalog.ts`、`gen-cordis-catalog.ts`、`gen-doc-graphs.ts`、`gen-plugin-packages.ts`、`package-graph.ts`、`gen-module-graph.ts`、`verify-package-readme-model-experience.ts`、`verify-product-use.ts`、`verify-package-dependencies.ts`、`verify-package-paths.ts`、`product-package-policy.ts` | Convax 服务、配置、Slot、依赖和文档继续参与目录生成及分类检查；外部包的 schema、缺失 peer 和失效源码路径不因迁移而跳过校验 |
| 双语链接与 Git index 读取 | [`scripts/translation-repository-context.ts`](dsh/scripts/translation-repository-context.ts)、`translation-links.ts`、`translation-pairing-git.ts`、`verify-translation-pairing.ts` | DSH 内容扫描根与实际 Git 根分离；跨目录链接按实际路径归一，既有 DSH 语义链接 ID 保持稳定；`--cached` 读取精确暂存内容；已存在的同目录 `-en.mp4`/`-zh.mp4` 视频按对应语言校验，保留原样 query/fragment 后缀；真实仓库外路径仍被拒绝 |
| Git hook 与已安装工具定位 | 根 [`lefthook.yml`](../lefthook.yml)、[`scripts/check-staged-translations.mjs`](../scripts/check-staged-translations.mjs)；DSH 的 `scripts/check-vendor-manifest.sh`、`verify-archived-agent-notes.ts`、`verify-concrete-terms.ts`、`doc-typecheck.ts`、`verify-node-next-types.ts`、`packages/llm/llm-pi-ai/scripts/gen-provider-data.ts`；[`apps/desktop/scripts/development-dependencies.ts`](dsh/apps/desktop/scripts/development-dependencies.ts) | 保留原门禁强度及冻结笔记封存检查；Git 路径使用当前 DSH 前缀，维护中且未忽略的迁移源码也参与术语检查；CLI 和类型依赖通过实际安装位置解析；Desktop 开发打包查找外层 workspace 的依赖 |
| 外部包的类型感知 lint | [`.oxlintrc.json`](dsh/.oxlintrc.json)、根 `dsh:lint`、根 `tsconfig.json` 与 [`tests/workspace.test.mjs`](../tests/workspace.test.mjs) | 根 lint 通过根配置继承完整规则并按外层目录匹配；DSH 在自身目录使用原配置与原 source/test 分组；外部包的 source/test globs 命中实际文件；根 TypeScript 入口只引用独立 Host/Client 程序；违规样例同时验证规则执行与所属程序，避免迁移后静默漏检 |
| 外部包的依赖与配置检查 | [`scripts/verify-package-dependencies.ts`](dsh/scripts/verify-package-dependencies.ts)、`verify-config-source-ownership.ts`、`workspace-package-globs.ts` | `all` 和 `policy` 包含显式声明的外部包，DSH `release` 集合维持原有分组范围；凭证来源检查包含外部包实际发布的 Cordis patch；DSH 文档中的包路径仍按 DSH 源码根目录解释 |

本地适配通过 DSH 的 Slot、Factory、提供方、预设及宿主能力接入。核心 Agent loop 没有加入 Convax 画布业务分支；Computer Use 的默认预设挂载和系统授权规则保持 DSH 自己的归属。Cordis 等第三方源码的固定版本和既有本地差异继续以 [`dsh/vendor/README.md`](dsh/vendor/README.md) 为准，DSH 升级不等同于重新同步这些依赖。

## 升级操作

1. 先保存当前 Convax 提交和锁文件，选择一个明确的 DSH 目标 commit；不要用会移动的分支名称替代依赖基线。
2. 在独立临时目录获取官方仓库，同时保留本文固定的旧基线和目标 commit。确认旧基线 tree 与上表一致后，再审阅旧基线到目标 commit 的差异。
3. 将差异应用到 `libs/dsh/`，按上表检查本地适配；路径调整属于本仓库集成，不应反向混入上游版本比较。不要直接覆盖 `libs/dsh/`，也不要覆盖根 `packages/` 中的 Convax 包。
4. 一起更新依赖声明、根 workspace、根锁文件、编译引用及实际生成目录。仅在上游提供替代能力并且消费者已迁移后删除本地适配。
5. 运行受影响 DSH 包和 Convax 的单元测试，再完成构建和构建后类型检查；对改变的用户行为运行浏览器 E2E。涉及 Session 格式、IPC、插件配置或用户数据迁移时，额外执行 DSH 对应的兼容性与升级检查。
6. 更新本文的上游 commit、版本、tree、适配清单和实际验证结果，使下一次升级仍有确定的起点。

上游比较可在独立克隆中执行；以下命令分别查看已审计的上游基线和迁移前 Convax 快照，根 tree 命令应返回上表的固定值：

```sh
git -C /path/to/deepseek-harness rev-parse '22ddee3792402c3e70ec5f86a63c3e3e895a2f60^{tree}'
git -C /path/to/deepseek-harness show --no-patch --format=fuller 22ddee3792402c3e70ec5f86a63c3e3e895a2f60
git show --no-patch --format=fuller f6dcd88e4a4060454892fab0117587f2682feac4
```

其中 `/path/to/deepseek-harness` 是已获取固定基线的官方仓库克隆。第三条命令在 Convax 仓库执行；前两条不依赖 Convax 是否保留旧导入提交。

## 验证范围

至少覆盖文件/文件夹/窗口/Chat 四类卡片、多 thread 切换、画布 tab 与视口恢复、连线引用、首次中文输入、正文文字选择、插件抽屉、右侧工具面板、窗口重连及发送时截图。窗口镜像的浏览器 fixture 只替换操作系统采集，原生 Desktop 仍需在目标平台验证权限、窗口关闭与资源释放；Computer Use 的可用性单独按 DSH preset 和授权验证。

安装与构建从仓库根目录使用根脚本。`.env`、`.convax/`、本地截图、运行日志和下载缓存不属于 DSH 上游源码，也不应进入升级补丁或公开提交。

## 本次目录迁移的验证记录

2026-11-03 在 Node.js 24 环境执行以下检查。根任务由 [`package.json`](../package.json)、[`turbo.json`](../turbo.json) 与 [`scripts/dsh.mjs`](../scripts/dsh.mjs) 编排；浏览器 E2E 的窗口 fixture 只替换系统窗口采集，不能替代原生窗口权限验证。

| 检查 | 已通过的结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 根 workspace 与唯一锁文件可重复安装 |
| `pnpm run build:artifacts`、`pnpm run build:check`、`pnpm run build` | 首轮 8 个产物步骤、362 个 Client 产物与 2 个聚合检查通过；目录生成器收尾后的完整构建 10 个步骤全部通过 |
| `pnpm run test -- --maxWorkers=2` | Turbo 编排的 79 个测试文件、851 项测试 |
| `pnpm run test:workspace` | 7 项 workspace、hook、完整 lint 规则及 Host/Client 程序归属测试 |
| `DSH_SNAPSHOT=replay pnpm run test:web:built`，指定七个 Convax E2E 文件 | 31 项浏览器测试，覆盖目录、画布管理、基础交互、Chat 设置、窗口镜像、活动和四类卡片尺寸 |
| `pnpm run doc-sync` | 43 项文档、目录和文档站点检查 |
| `pnpm run lint` | DSH 与外层 Convax 的完整类型感知规则；Chat 创建状态修复后另外执行该组件及回归测试的完整规则检查 |
| DSH 文档工具 focused tests | 双语链接、Git index、外部包分类、配置 schema、目录投影和依赖图的正反例；已执行的分组均通过 |
| `verify-node-next-types.ts` | 375 个包的 NodeNext 消费检查，包含外部 Convax 包 |
| 根 staged pairing hook 的临时 index 验证 | 根 README、根 packages README 和 DSH README 均通过；篡改暂存配对记录会被拒绝，真实 index 不受影响 |

真实 API 测试仍使用根 `.env` 中的 `DEEPSEEK_API_KEY`；本次浏览器 E2E 使用 `DSH_SNAPSHOT=replay`，不代表真实 API 调用验证。本次目录迁移没有把凭据写入文档或测试 fixture。
