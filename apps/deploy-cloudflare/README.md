# `@convax/deploy-cloudflare`

English | [中文](README.zh.md)

Cloudflare Workers carrier for `@convax/api/runtime`. `src/api.ts` bridges the Nest server through `cloudflare:node`'s `httpServerHandler`. `wrangler.jsonc` keeps a local `CONVAX_DB` placeholder; the public health, policy and guidance routes require no database, so production has no D1 binding.

Run from the repository root:

```sh
pnpm run dev:api
pnpm run build:api
pnpm run check:api
```

Development serves `http://127.0.0.1:8104/health`. The build checks types and performs a strict deployment dry-run; it does not publish. See the [backend plan](../../docs/api-backend.md) for platform ownership and deployment prerequisites.

Production runs as the `convax-api` Worker at [microvoid.io/convax/api](https://microvoid.io/convax/api), with [convax-api.whistleyz.workers.dev](https://convax-api.whistleyz.workers.dev) as its Workers URL. From the repository root, validate or publish the production configuration with an authenticated Cloudflare account:

```sh
pnpm --filter @convax/deploy-cloudflare dry-run:production
pnpm --filter @convax/deploy-cloudflare deploy
```

The public endpoints are `GET /convax/api/health`, `GET /convax/api/v1/client/policy` and `GET /convax/api/v1/client/guidance`. The Worker maps these paths to the application's `/health` and `/api/v1/client/*` routes, which remain available directly in local development and on the Workers URL. The more specific `/convax/api/release*` route stays with `convax-homepage` for public download discovery.

The checked-in catalog publishes no update requirement, maintenance or announcements. Add production bindings and secrets when a route first requires them. Keep local Worker state, generated outputs and credentials out of Git.
