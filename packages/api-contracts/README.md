# `@convax/api-contracts`

English | [中文](README.zh.md)

Public HTTP contracts for the Convax API. `openapi/convax.openapi.json` defines the OpenAPI 3.1 operations; `schemas/` owns health, error, client policy and announcement responses as JSON Schema. Consumers use the `./openapi` and `./schemas/*` exports without importing Nest or Prisma types.

`./notices` exports TypeScript-only client policy and announcement types. `apps/api/` implements public `GET /api/v1/client/policy` and `GET /api/v1/client/guidance` using a validated immutable deployment catalog. Policy describes update and maintenance restrictions, while optional announcements select `modal`, `banner` or `message` presentation. Maintenance uses messages. Read and snooze state remains local to the installation; there is no feedback endpoint or guide-bubble protocol.

Client consumers reject unknown kinds, surfaces and actions. Page navigation requires an installed exact HTTPS-origin allowlist, and update actions reference the configured Desktop updater's release identity. A policy read failure does not clear a previously accepted restriction. These contracts do not authenticate users or authorize local operations.

Run from the repository root:

```sh
pnpm run check:api
pnpm --filter @convax/api-contracts test
```

The package check validates operation identities and referenced schemas. Observable HTTP tests in `apps/api/` validate responses against these schemas. Contract ownership and extension rules are in the [backend plan](../../docs/api-backend.md).
