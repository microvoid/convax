# `@convax/api`

[English](README.md) | 中文

基于 NestJS 与 Express 的 Convax 云端业务应用。`src/main.ts` 通过 `@convax/api/runtime` 导出 `startConvaxApi`，部署宿主负责监听和关闭。公开的 `GET /health` 返回 `{ "status": "ok", "service": "convax-api" }`。公开的 `GET /api/v1/client/policy` 和 `GET /api/v1/client/guidance` 提供客户端升级、维护和公告元数据。HTTP 错误使用共享错误契约。

通过 `startConvaxApi({ clientNotices: catalog })` 选择 `ClientNoticeCatalog`，该类型从同一运行时入口导出。无参数时，`src/client-notices/catalog.ts` 的 `DEFAULT_CLIENT_NOTICE_CATALOG` 明确选择无升级要求、无维护和无公告。修改该部署常量或宿主的启动选项后重新部署，即可发布新修订。启动时校验并冻结独立副本；内容非法时启动失败，不会静默返回空 catalog。

接口要求提供 `@convax/api-contracts` 定义的安装 UUID 请求头及客户端版本、平台、架构、渠道和语言查询字段。公告支持可选人群条件：包含下限、不含上限的 SemVer 版本范围，精确匹配的平台、架构、渠道，以及不区分大小写的语言匹配，并检查每条公告的有效期。原生升级公告要求匹配已配置且可用的 release，Web 不接收此类公告。强制升级还要求完整的最低版本规则和 HTTPS 回退页面。这些公开接口不认证账号、不访问 D1，也不持久化用户选择；已读与稍后提醒记录归 Host 本机管理。

Prisma schema 尚无业务模型。首个持久化功能需要先定义模型和迁移，再生成客户端。认证及业务接口遵循[后端方案](../../docs/api-backend.zh.md)。

在仓库根目录执行：

```sh
pnpm run dev:api
pnpm run check:api
pnpm --filter @convax/api db:validate
```

`dev:api` 先构建一次，再同时运行 API TypeScript watch 与 Wrangler；修改源码会自动重新编译并重载本地 Worker。
