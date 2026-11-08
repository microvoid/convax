# `@convax/api-contracts`

[English](README.md) | 中文

Convax API 的公共 HTTP 契约。`openapi/convax.openapi.json` 定义 OpenAPI 3.1 操作；`schemas/` 以 JSON Schema 定义健康状态、错误、客户端策略和公告响应。消费者通过 `./openapi` 和 `./schemas/*` 导出使用契约，不导入 Nest 或 Prisma 类型。

`./notices` 导出仅供 TypeScript 使用的客户端策略和公告类型。`apps/api/` 通过经过校验的不可变部署 catalog 实现公开的 `GET /api/v1/client/policy` 和 `GET /api/v1/client/guidance`。策略描述升级与维护限制，普通公告选择 `modal`、`banner` 或 `message` 展示方式。维护使用消息提示。已读和稍后提醒记录保存在本机，没有反馈接口或引导气泡协议。

客户端拒绝未知的类别、展示方式和动作。页面跳转必须通过安装配置中的精确 HTTPS origin 白名单，升级动作引用已配置 Desktop 更新器的 release 标识。策略请求失败不解除已接受的限制。这些契约不认证用户，也不授予本地操作权限。

在仓库根目录执行：

```sh
pnpm run check:api
pnpm --filter @convax/api-contracts test
```

包内检查验证操作标识与引用的 schema。`apps/api/` 的可观察 HTTP 测试使用这些 schema 校验响应。契约归属及扩展规则见[后端方案](../../docs/api-backend.zh.md)。
