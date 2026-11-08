# Convax API 后端

[English](api-backend.md) | 中文

## 目标与当前范围

Convax API 是独立部署的云端服务，负责 Convax 自有业务数据。技术基线参考 AuthX：NestJS 与 Express、Prisma 与 Cloudflare D1，以及 Cloudflare Workers 部署适配。依赖和检查由现有根 pnpm workspace、锁文件、TypeScript 工具链及 Turborepo 任务统一管理。

服务提供公开的 `GET /health`，返回 `{ "status": "ok", "service": "convax-api" }`，以及客户端策略和公告查询。HTTP 错误使用统一的 `{ "error": { "code": "...", "message": "..." } }` 结构。这些公开元数据接口不检查数据库、不认证账号，也不授予 Convax 资源访问权限。持久业务数据、AuthX 接入和同步需要分别实现。

## 归属与服务边界

| 归属 | 职责 |
|---|---|
| Convax API | Convax 云端业务规则、资源授权及自有持久数据。分享、同步和云资源元数据是候选功能，具体范围需要明确的消费者。 |
| Convax Desktop Host | 本地画布 SQLite 数据、DSH Session、文件、终端、浏览器资源及本地执行。 |
| AuthX | 账户、认证、OAuth/OIDC 及已有计费能力。Convax 保存自身领域需要的稳定身份引用。 |
| 产品官网 | `apps/web/` 中的静态内容、演示及公开 Release 查询。 |

云端 API 与 Desktop Host 分别拥有各自的数据。未来同步协议需要先定义资源身份、版本、冲突、删除和重试语义，再将本地图数据复制到 D1。本地文件路径和操作系统资源继续由 Host 管理。

## 技术基线

| 层面 | 选择 |
|---|---|
| 语言与模块 | TypeScript 和 ESM，使用 Convax 根 workspace 配置的版本。 |
| HTTP 应用 | NestJS 11 与 Express 5。Controller 适配 HTTP 输入输出，可注入的 Service 类拥有业务用例。 |
| 数据库 | Prisma 7、`@prisma/adapter-d1` 与 Cloudflare D1，数据库引擎为 SQLite。 |
| 公共契约 | 独立的 `@convax/api-contracts` 包，保存 OpenAPI 3.1 与 JSON Schema 产物。持久模型与 Nest 框架类型保留在内部。 |
| 输入校验 | 通过 Nest 校验管线使用 `class-validator` 与 `class-transformer`。公开 DTO 和运行时校验必须与契约包一致。 |
| 部署 | Wrangler 与启用 Node.js 兼容的 Cloudflare Workers。通过 `cloudflare:node` 的 `httpServerHandler` 桥接 Nest HTTP server。 |
| 验证 | TypeScript、Node.js 原生 HTTP 及真实 Worker 测试、契约校验、Prisma schema 校验及 Worker 打包 dry-run。后续测试集可沿用 workspace 已有的 Vitest。 |
| 后台工作 | 具有持久重试或定时执行需求的工作可采用 Cloudflare Queues 和 Cron，在具体功能需要时加入。 |

Nest Service 类通过构造器注入依赖。每个有状态资源都有明确的应用级或请求级 owner，并提供对应的关闭或释放路径。React 组件和 Hook 消费 API，不拥有后端业务工作流。

## 仓库结构

```text
apps/
  api/                  # Nest 模块、Controller、Service 与 Prisma schema
  deploy-cloudflare/    # Worker 入口、平台适配与 Wrangler 配置
packages/
  api-contracts/        # 公共 HTTP 契约
docs/
  api-backend.md
  api-backend.zh.md
```

[`@convax/api`](../apps/api/package.json) 拥有应用，并通过范围明确的运行时入口启动和关闭 HTTP server。[`@convax/deploy-cloudflare`](../apps/deploy-cloudflare/package.json) 消费该入口，负责平台相关组合。业务规则、公开错误、授权和重试保留在 `apps/api/` 对应的业务服务中。

[`@convax/api-contracts`](../packages/api-contracts/package.json) 拥有稳定的公开路径、请求响应形状和错误码。新客户端消费这些契约，不导入 Controller、Prisma 模型或部署类型。客户端需要可执行的请求辅助方法时，再增加 SDK。

## 客户端策略与公告

`GET /api/v1/client/policy` 返回完整的升级与维护快照，`GET /api/v1/client/guidance` 返回按有效期和部署条件筛选的普通公告。两者都校验 `@convax/api-contracts` 定义的客户端版本、平台、架构、渠道、语言查询字段及安装 UUID 请求头，并返回 `Cache-Control: no-store`。安装标识不是认证凭据，这些接口也不将 bearer token 解释为账号身份。

`startConvaxApi({ clientNotices: catalog })` 接受不可变的 `ClientNoticeCatalog` 部署配置。未提供选项时，仓库中的默认配置明确声明无升级要求、无维护和无公告。修改部署 catalog 后重新部署即可发布对应修订。启动时校验并冻结独立副本，复用的 Worker isolate 不保留请求 binding、账号身份或调用方的可变配置。公告支持明确的 SemVer 版本上下限、平台、架构、渠道和语言条件，不提供账号定向或百分比灰度。

原生强制升级要求显式可用、与安装平台、架构和渠道匹配的 release，以及最低支持版本、原因和 HTTPS 回退页面。Web 不接收原生升级要求或升级公告。API 提供元数据，不下载安装包，也不执行本地任务限制。维护展示、空闲时机、窗口互斥、已读记录和稍后提醒结果归 Desktop Host 与 Renderer 管理。API 没有反馈接口、管理端发布接口或公告相关 D1 模型。[API 包](../apps/api/README.zh.md)拥有配置细节，[契约包](../packages/api-contracts/README.zh.md)拥有传输结构。

## 数据库与请求生命周期

初始 Prisma schema 预留数据库位置，不引入没有业务依据的表。通过 `pnpm --filter @convax/api db:validate` 校验该 schema。首个持久化功能需要同时定义首个模型与迁移，再运行 `pnpm --filter @convax/api db:generate` 生成对应客户端。schema 没有 model 时暂不生成。D1 存储归 API 所有；Desktop 的 `node:sqlite` 数据库和 AuthX 数据库分别管理。

D1 对事务和并发写入存在约束。具体功能需要基于 D1 支持的操作，定义原子写入边界、唯一约束、幂等键与重试行为。不能假定 Prisma 交互式事务具备长期运行的 PostgreSQL 连接的行为；AuthX 的部分一致性边界使用显式 D1 原子 SQL。

Cloudflare bindings 归属于一次 invocation。引入数据库访问时，通过显式 invocation context 传入当前 binding，为该上下文创建 Prisma D1 adapter，并在请求拥有的工作结束后断开连接。复用的 Nest 应用不能在单例 provider 中保留某次请求的 bindings 或授权状态。流式响应与延后执行的工作需要先明确生命周期，再清理数据库资源。

## AuthX 接入

Convax Desktop 遵循 AuthX 的标准 OAuth/OIDC public client 契约：Authorization Code 与 PKCE `S256`、`state` 和 `nonce`、值为 `none` 的 public client token 认证方式、轮换 refresh credential，以及精确注册的 loopback redirect。AuthX 的 Convax 本地 profile 使用回调端口 `65051`；生产客户端需要单独审核和注册。

API 在提供受保护接口前，必须先明确接受的 access token audience。校验已配置的 issuer、audience、project 和 environment、签名算法、已知 JWKS key、有效期及非空 subject。身份验证通过后，基于 Convax 自有归属数据判断资源授权。Desktop profile 使用 OAuth client ID 作为 audience；Hosted Application Session SDK 采用另一套契约，没有明确协议决策时不能替代。

身份提供方凭据、签名密钥、Token 签发和计费权威保留在 AuthX。公开的健康检查与通知元数据接口没有实现这些集成，不能据此判断 Desktop 登录或云端授权已经接通。

## 开发与验证

在仓库根目录执行安装与 API 命令：

```sh
pnpm install --frozen-lockfile
pnpm run dev:api
```

开发任务通过 Turbo 构建 API 与契约，再同时运行 API TypeScript 编译器的 watch 模式与本地 Worker，在 `http://127.0.0.1:8104` 提供服务。修改 API TypeScript 后自动重新编译并触发 Wrangler 重载。访问 `http://127.0.0.1:8104/health` 检查启动情况。本地开发和验证不需要生产 Cloudflare 部署或模型 API key。

```sh
pnpm run build:api
pnpm run typecheck:api
pnpm run test:api
pnpm run check:api
```

`check:api` 执行类型检查、lint、Prisma 校验、契约检查、Node HTTP 测试、真实本地 Worker 测试及 Cloudflare strict deployment dry-run。具体检查由根 [package scripts](../package.json) 定义。增加业务接口前，更新公开契约，实现输入校验与资源授权，并测试可观察的响应和持久化行为。数据库变更还需要迁移，并针对全新本地 D1 数据库检查。涉及 Desktop 行为变更时，继续遵循 Convax 与 DSH 现有测试要求。

[Cloudflare 部署包](../apps/deploy-cloudflare/README.zh.md)拥有生产地址及发布命令。公开基础地址为 `https://microvoid.io/convax/api`：健康检查为 `/convax/api/health`，客户端元数据为 `/convax/api/v1/client/policy` 或 `/convax/api/v1/client/guidance`。Worker 将部署前缀映射到应用路由；本地开发与 Workers 地址保留 `/health` 和 `/api/v1/client/*`。`/convax/api/release` 的公开 Release 查询通过更具体的路由，继续归官网 Worker 管理。

生产配置不绑定 D1，提供公开元数据接口。打包 dry-run 成功不代表已经发布远端服务；需要持久化或外部凭据的接口必须在发布前增加对应环境的 bindings 和 secrets。

## AuthX 参考入口

以下路径位于 AuthX 仓库，核对日期为 2026-11-08。扩展初始化工程时可据此查看对应机制；Convax 拥有自身实现和依赖版本。

| AuthX 路径 | 参考内容 |
|---|---|
| `apps/api/src/runtime/bootstrap-http.ts` | Nest 与 Express 初始化。 |
| `apps/api/src/main.ts` | 范围明确的 HTTP runtime 边界与显式关闭操作。 |
| `apps/deploy-cloudflare/src/api.ts` | Cloudflare HTTP 桥接与响应生命周期。 |
| `apps/api/src/database/invocation-database.ts` | invocation 拥有的 Prisma D1 资源。 |
| `packages/contracts/README.md` | 公共契约归属及兼容规则。 |
| `README.md` 的 “Convax Desktop public client” 章节 | Desktop OAuth/OIDC 接入契约。 |
| `packages/contracts/fixtures/convax-local-public-client.json` | 本地 Desktop client 与 resource server 校验 profile。 |
