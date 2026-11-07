# @convax/web

[English](README.md) | 中文

Convax 中英文公共官网是独立的 React 与 Vite 应用，介绍产品能力及演示，提供 macOS Apple Silicon 客户端下载，并引导用户安装和创建首个对话。源码启动说明位于文档中。官网不连接 DSH Host 或模型 API，也不需要 `.env` 文件。

## 开发

在仓库根目录使用项目配置的 Node.js 和 pnpm 版本执行命令。依赖由根工作区及锁文件统一管理。

```sh
pnpm install --frozen-lockfile
pnpm --filter @convax/web dev
```

打开 Vite 打印的 `/convax/` 地址。开发服务器和构建产物预览均使用此前缀。默认显示中文，访问 `/convax/?lang=en` 可直接进入英文版。语言按钮会同步更新地址、页面元数据及演示媒体。

## 构建与验证

```sh
pnpm --filter @convax/web build
pnpm --filter @convax/web test
pnpm --filter @convax/web preview
```

浏览器测试使用系统分配的本地端口，在 `/convax/` 下启动已有构建，检查桌面与 390px 布局，验证语言和键盘交互，并实际解码演示视频。测试还会验证下载可用性及恢复状态，并确认 JavaScript、CSS、favicon、封面和视频地址均位于部署前缀下。测试优先使用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定的浏览器，否则在 macOS 上检测已安装的 Google Chrome，最后使用 Playwright 的 Chromium。截图输出至 `.artifacts/public-site/`。运行测试前先构建。

## 部署

生产官网位于 [microvoid.io/convax](https://microvoid.io/convax/)。Vite 将站点构建到 `apps/web/dist/convax/`，`base` 固定为 `/convax/`。将 `apps/web/dist/` 目录作为静态根目录发布，由其物理 `convax/` 目录提供 `/convax/` 和 `/convax/assets/`。构建资源不应发布到站点根部的 `/assets/`。无需服务端进程、Host 凭据或 API 配置。Vite 会将 `docs/assets/convax-demos/` 中复用的演示 MP4 及本地封面打包到构建产物。视频由用户主动播放，提供原生控件和本地化的失败重试提示。

Cloudflare 部署使用 `wrangler.jsonc`，需要已登录 Wrangler 且拥有 `microvoid.io` 区域的访问权限。部署上传 `dist/`，将 `convax-homepage` 静态 Worker 发布到 `/convax` 和 `/convax/*`，由生成的 `convax/` 目录承载 URL 前缀，站点其他路径沿用现有路由。部署命令会先构建再发布；本地预览通过 Vite 打印的 `/convax/` 地址提供嵌套站点。

请求 `/convax/api/release` 时，`worker.mjs` 读取 GitHub 上最新的公开稳定 Release，查找对应的 macOS Apple Silicon 安装包。安装包不可用时，官网显示下载准备状态或重试提示；Actions 构建产物不会被当作公开下载。该接口只读，不需要 Host 凭据或模型 API key。

演示 MP4 请求也会执行 Worker，缓存完整文件后由 Cloudflare Cache API 提供字节范围响应，支持原生视频跳转。其他资源由静态服务直接返回。浏览器测试检查页面，`tests/worker.test.mjs` 则在本地 Workers 运行时中检查部署配置，包括 Release 响应及冷、热缓存的范围响应。

```sh
pnpm --filter @convax/web exec wrangler login
pnpm --filter @convax/web run deploy
```

导航、页脚与浏览器 favicon 共用 `../../packages/plugin-renderer/src/client/assets/convax-mark.svg` 中的画布标识。
