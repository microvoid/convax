# Convax 文档站

[English](README.md) | 中文

Convax 双语文档站使用 [Cloudflare Nimbus](https://github.com/cloudflare/nimbus) 与 Astro。配置的正式地址为 [https://microvoid.io/convax/docs](https://microvoid.io/convax/docs)：Nimbus 接收 origin `https://microvoid.io`，Astro 使用固定 base `/convax/docs`。

## 开发

在仓库根目录执行 `pnpm install`；本应用共用根 workspace 与 lockfile。以下命令也在根目录运行：

```sh
pnpm run dev:docs
pnpm run build:docs
pnpm run check:docs
pnpm run preview:docs
```

开发和预览地址均为 `http://localhost:4321/convax/docs/`。查看搜索前，先构建再预览：Pagefind 在生产构建期间生成索引。构建后再执行文档检查，以覆盖构建后的内容。

## 部署

在仓库根目录运行 `pnpm run deploy:docs`，Wrangler 需要已登录 Cloudflare，并拥有 `microvoid.io` 区域的 Worker 与路由发布权限。命令会构建并发布 `convax-docs` Worker。两条路由覆盖 `/convax/docs` 和 `/convax/docs/*`。`scripts/prepare-cloudflare.mjs` 将 `dist/` 放入已忽略的 `.cloudflare/convax/docs/` 目录，并在根目录提供响应头规则和自定义 404 页面；当前账号不支持非根路径的 `assets.base_path`。Wrangler 固定为 **4.148.0**。官网继续独立部署。

演示视频使用按部署版本隔离的边缘缓存提供分段响应，并要求浏览器重新验证，确保固定文件名在更新后仍能获得最新内容。

## 维护内容与资源

十六篇源文档位于 `src/content/docs/{zh,en}/`。入口默认跳转中文；存在对应页面时，语言切换保留当前页面。两种语言应一起更新，路由保持对应，首页只使用各自语言的演示。

Markdown 链接写为 `/zh/...`、`/en/...` 或 `/demos/...`，由 Nimbus 添加 base。Markdown 图片和 JSX 图片的 `src` 保留 `/convax/docs/demos/...`，因为图片地址不会自动改写。

演示资源的唯一源位于仓库 `docs/assets/convax-demos/`。开发和构建前，`scripts/prepare-demos.mjs` 将其复制到已忽略的 `public/demos/`。请修改源资源，不要修改生成副本。

DSH Markdown 仍位于 `libs/dsh/docs`，对应的 VitePress 投影在 `libs/dsh/website` 独立维护。本应用不复制整套上游文档。

## 升级时保留本地改动

应用将 `@cloudflare/nimbus-docs` 固定为 **0.19.2**，由 **0.8.2** 脚手架及 `templates-v0.8.2` 生成。通过官方升级流程维护 `nimbus.json` 和审阅基线，不要手动修改字段跳过审阅。

Header、layout、语言导航和 Convax 品牌内容由本仓库维护。`src/components/LocalizedHead.astro` 基于 Nimbus 0.19.2 的 Head，增加页面语言支持；升级时要与包内当前 Head 对比，并为静态构建保留全站 Shiki CSS。分享卡片使用共享的英文 Convax 品牌构图及随应用提供的 Inter 字体，文字元数据与页面正文仍按语言呈现。遵循[维护者指南](AGENT.md)中的官方升级审阅流程，再构建并检查。

Nimbus 脚手架的署名与完整 MIT 条款保留在 [LICENSE.nimbus](LICENSE.nimbus)。
