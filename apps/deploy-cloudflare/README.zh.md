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

[Convax API Deploy](../../.github/workflows/convax-api-deploy.yml) 检查并发布推送到 `main` 的 API 相关改动，也支持从 `main` 手动触发。生产任务串行执行，Pull Request 不会获得部署凭据。在仓库配置 secret `CLOUDFLARE_API_TOKEN` 和 variable `CLOUDFLARE_ACCOUNT_ID`，指向生产账号。按 [Cloudflare GitHub Actions 配置](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)和 [Workers 权限说明](https://developers.cloudflare.com/workers/authorization/workers/)将 token 限定到该账号与 `microvoid.io` 区域：Workers Scripts 编辑、Workers Routes 编辑，以及路由查询使用的 Zone 读取权限。不需要 D1 权限。

每次部署在发布前执行 `pnpm run check:api`，发布后执行[线上 smoke](../../scripts/smoke-convax-api.mjs)。Smoke 检查策略和公告响应符合 schema、健康检查、非法请求处理，以及官网的 release 和 HTML 路由。Smoke 失败会使 workflow 失败，不会自动回滚已发布的 Worker。
