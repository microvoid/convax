# `@convax/deploy-cloudflare`

[English](README.md) | 中文

`@convax/api/runtime` 的 Cloudflare Workers 宿主。`src/api.ts` 通过 `cloudflare:node` 的 `httpServerHandler` 桥接 Nest server。`wrangler.jsonc` 保留本地 `CONVAX_DB` 占位配置；公开的健康检查、策略与公告接口不需要数据库，因此生产环境没有 D1 binding。

在仓库根目录执行：

```sh
pnpm run dev:api
pnpm run build:api
pnpm run check:api
```

开发入口为 `http://127.0.0.1:8104/health`。构建检查类型并执行 strict deployment dry-run，不发布服务。平台归属及部署准备见[后端方案](../../docs/api-backend.zh.md)。

生产环境使用 `convax-api` Worker，公开地址为 [microvoid.io/convax/api](https://microvoid.io/convax/api)，Workers 地址为 [convax-api.whistleyz.workers.dev](https://convax-api.whistleyz.workers.dev)。使用已登录的 Cloudflare 账号，在仓库根目录校验或发布生产配置：

```sh
pnpm --filter @convax/deploy-cloudflare dry-run:production
pnpm --filter @convax/deploy-cloudflare deploy
```

公开接口为 `GET /convax/api/health`、`GET /convax/api/v1/client/policy` 和 `GET /convax/api/v1/client/guidance`。Worker 将这些路径映射到应用的 `/health` 与 `/api/v1/client/*` 路由；本地开发与 Workers 地址仍可直接访问应用路由。更具体的 `/convax/api/release*` 路由继续归 `convax-homepage` 管理，用于公开下载查询。

仓库中的 catalog 不投放升级要求、维护或公告。接口首次需要生产 bindings 和 secrets 时再添加。本地 Worker 状态、生成产物和凭据应排除在 Git 之外。
