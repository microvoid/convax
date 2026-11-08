# Convax

[English](README.md) | 中文

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的无限画布工作台，连接文件、应用窗口镜像与多线程 AI 对话。

将项目和对话放在画布上，为任务连接所需资源，在同一工作区与 AI 协作。Convax 复用 DeepSeek Harness 的对话界面、输入框、智能体执行和插件系统。

<a id="demos"></a>
## 演示视频

在 [Convax 官网](https://microvoid.io/convax/) 观看多项目并行与应用操作的界面演示，或点击下方预览打开完整 MP4。

### 在画布上并行处理多个项目

[![在画布上并行处理多个项目 — 中文，34 秒](docs/assets/convax-demos/projects-zh.gif)](docs/assets/convax-demos/projects-zh.mp4)

### 在画布上，通过对话操作 Chrome 和 Excel

[![在画布上，通过对话操作 Chrome 和 Excel — 中文，36 秒](docs/assets/convax-demos/apps-zh.gif)](docs/assets/convax-demos/apps-zh.mp4)

<a id="features"></a>
## 主要功能

| 功能 | 使用方式 |
|---|---|
| 无限画布 | 平移、缩放、多选卡片、吸附对齐、节点连线，以及图编辑的撤销和重做。支持触控板与鼠标导航模式。 |
| 文件与文件夹 | 将本地资源拖入 Desktop，浏览文件夹卡片，展开预览文本、代码、Markdown、图片、PDF、表格、音频和视频。 |
| 终端与浏览器卡片 | 在画布中运行交互式 Shell 和浏览网页。切换画布或关闭画布标签保留运行，删除卡片关闭对应资源。 |
| AI 对话 | Chat 卡片支持多个 thread、对话分叉，以及 DSH 原有的输入框、模型选择、权限和工具。 |
| 显式引用 | 连接资源到 Chat，将可删除的 reference 加入输入框。发送以当前草稿中的引用为准，删除引用保留画布连线。 |
| 窗口镜像 | 在 macOS Desktop 中镜像一个具体应用窗口，连到 Chat 后，在发送时采集最新截图。 |
| 多画布 | 像浏览器一样切换和拖拽排序标签页，支持搜索、重命名、归档、恢复、复制和永久删除已保存画布。 |
| 默认工作目录 | 每张画布拥有独立工作目录，新建 Chat 和终端直接使用。终端从文件夹连线时使用该文件夹，从文件连线时使用其所在目录。 |

窗口镜像为只读预览。智能体 Computer Use 是独立的可选 DSH 能力，使用 PTC 模式及原有的应用授权和 macOS 系统权限。

<a id="repository-layout"></a>
## 仓库结构

根目录使用一个 pnpm workspace 和 lockfile，Turborepo 编排构建、类型检查、lint 和 Convax 测试，包含 `apps/docs/` 中的文档站。DSH 源码保留在 `libs/dsh/`，Convax Host 与 renderer 直接位于 `packages/`；包名和运行时入口保持不变。

```text
apps/
  api/
  deploy-cloudflare/
  docs/
packages/
  api-contracts/
  plugin-host/
  plugin-renderer/
libs/
  dsh/
  DSH_UPGRADE.md
scripts/
  dsh.mjs
pnpm-workspace.yaml
pnpm-lock.yaml
turbo.json
```

[DSH 升级记录](libs/DSH_UPGRADE.md)记录依赖的上游 commit、本地适配及升级验证步骤。`libs/dsh/` 由本仓库直接管理，不是嵌套安装目录或 Git submodule；只在根目录安装依赖。

<a id="run"></a>
## 快速开始

Convax 处于开发者预览阶段。从本仓库运行，需要 **Node.js 24.9.0 或更新版本**及 **pnpm 11.28.5**，版本要求见 [package.json](package.json)。

<a id="run-from-source"></a>
### 安装与构建

克隆本仓库后，在仓库根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm run build
```

<a id="development-commands"></a>
### 常用命令

以下命令均在仓库根目录执行。Turbo 任务复用 DSH 原有的构建顺序，包含 Convax 的源码、测试及产物；不跳过 Typert 或客户端生成步骤。

| 命令 | 用途 |
|---|---|
| `pnpm run build` | 构建运行时、客户端与文档产物，并检查 DSH 和文档类型。 |
| `pnpm run test` | 运行 Convax Host、renderer 和工作区回归测试。 |
| `pnpm run test:workspace` | 验证 workspace、Turbo 任务和启动器的数据目录。 |
| `pnpm run typecheck` | 检查 DSH、Convax 与文档站类型。 |
| `pnpm run lint` | 运行代码及文档内容 lint。 |
| `pnpm run start:desktop` | 使用已有产物启动 Desktop。 |
| `pnpm run dev:desktop` | 重新构建并启动 Desktop。 |
| `pnpm run dev:docs` | 启动 Nimbus 文档开发服务器。 |
| `pnpm run build:docs` | 将静态文档站构建到 `apps/docs/dist/`。 |
| `pnpm run check:docs` | 检查文档配置、内容与类型。 |
| `pnpm run preview:docs` | 构建并预览静态文档站。 |

<a id="desktop"></a>
### Desktop 桌面端

使用已构建产物启动开发版 Desktop：

```sh
pnpm run start:desktop
```

在 Desktop 欢迎页或设置中配置 API key。Desktop 也可以继承启动进程中的 `DEEPSEEK_API_KEY` 环境变量。

首次安装时，打开**插件 → 添加插件**，将 `link:/absolute/path/to/convax/packages/plugin-renderer` 替换为当前检出仓库的实际绝对路径，安装后选择**立即启用**。它会启用 Convax Host 和画布 renderer。后续启动会保留该 bundle 的启用状态；启动器本身只负责选择 Convax 数据目录。

修改源码后，重新构建并启动：

```sh
pnpm run dev:desktop
```

需要原生文件和文件夹拖放，或 macOS 窗口镜像时，使用 Desktop。平台准备步骤见 [Desktop 开发说明](libs/dsh/apps/desktop/README.zh.md#develop)。

<a id="web"></a>
### Web 网页端

在仓库根目录创建 `.env`，用于 Web 对话和真实 API 测试：

```dotenv
DEEPSEEK_API_KEY=your-deepseek-api-key
```

为 Web profile 加载 Convax 覆盖配置并启动：

```sh
pnpm dsh web --patch packages/plugin-renderer/cordis.patch.yml --no-open
```

打开终端打印的完整本地访问地址，服务默认使用 `http://127.0.0.1:3080`。覆盖配置会为本次启动启用两个 Convax 插件。Web 操作 Host 所在机器的文件系统；原生窗口镜像需要 macOS Desktop。

<a id="data-and-working-directories"></a>
## 数据与工作目录

- Convax Desktop 启动器将 profile、Session 和画布数据库保存在仓库的 `.convax/` 目录，Electron 偏好保存在 `.convax/electron-user-data/`。
- 新画布默认在 `~/Documents/convax/canvas-<canvas-id>/` 创建工作目录。同一画布中新建的 Chat 共用该目录，已有 Chat 保留原项目路径。重命名画布不移动目录。
- 移除资源卡片或删除画布会保留原始文件。删除画布会停止并归档其中的对话，同时保留 Session 历史。
- `.env` 和 `.convax/` 已加入 Git 忽略规则。真实 API 测试使用根目录 `.env` 中的 API key，凭据不写入源码或测试 fixture。

<a id="development-and-documentation"></a>
## 开发与文档

- [API 后端](docs/api-backend.zh.md)：云端服务架构、AuthX 接入边界与本地开发。
- [文档站](apps/docs/README.zh.md)：使用 Nimbus 编写中英文指南及静态构建。运行 `pnpm run dev:docs` 后，打开 `http://localhost:4321/convax/docs/` 进行本地预览。
- [Convax 包说明](packages/README.zh.md)：Host 持久化与可独立停用的 renderer。
- [画布界面](packages/plugin-renderer/README.zh.md)：交互、预览、Chat 卡片及当前限制。
- [插件开发](libs/dsh/docs/cookbook/convax-plugin-development.zh.md)：扩展自定义画布节点与工具。
- [开发指南](libs/dsh/docs/development.zh.md)、[架构说明](libs/dsh/docs/architecture.zh.md)和[贡献指南](libs/dsh/CONTRIBUTING.zh.md)。
- [Agent 约定](AGENTS.md)和[安全说明](libs/dsh/SAFETY.zh.md)。

Convax 构建于 DeepSeek Harness 和 Cordis 之上，上游运行时及插件文档保留在 `libs/dsh/`。

<a id="license"></a>
## 许可证

[MIT](LICENSE)。第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](libs/dsh/THIRD_PARTY_NOTICES.md)。
