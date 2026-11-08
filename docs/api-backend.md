# Convax API backend

English | [中文](api-backend.zh.md)

## Purpose and current scope

The Convax API is an independently deployed cloud service for Convax-owned business data. Its technical baseline follows AuthX: NestJS with Express, Prisma with Cloudflare D1, and a Cloudflare Workers deployment adapter. The existing root pnpm workspace, lockfile, TypeScript toolchain, and Turborepo tasks own its dependencies and checks.

The service exposes public `GET /health`, returning `{ "status": "ok", "service": "convax-api" }`, plus client policy and announcement queries. HTTP failures use the shared `{ "error": { "code": "...", "message": "..." } }` envelope. These public metadata routes do not inspect a database, authenticate an account, or grant access to Convax resources. Persisted business data, AuthX integration, and synchronization require their own implementation.

## Ownership and service boundaries

| Owner | Responsibility |
|---|---|
| Convax API | Convax cloud business rules, resource authorization, and its own persisted data. Sharing, synchronization, and cloud resource metadata are candidate features whose scope needs a concrete consumer. |
| Convax Desktop Host | Local canvas SQLite data, DSH Sessions, files, terminals, browser resources, and local execution. |
| AuthX | Accounts, authentication, OAuth/OIDC, and its existing billing capabilities. Convax stores the stable identity references needed by its own domain. |
| Product website | Static content, demos, and public release lookup in `apps/web/`. |

The cloud API and Desktop Host have separate data ownership. A future synchronization protocol must define resource identity, revisions, conflicts, deletion, and retry behavior before copying local graph data to D1. Local file paths and operating-system resources retain their Host ownership.

## Technical baseline

| Layer | Choice |
|---|---|
| Language and modules | TypeScript and ESM, using the versions configured by the Convax root workspace. |
| HTTP application | NestJS 11 with Express 5. Controllers adapt HTTP input and output; injectable service classes own use cases. |
| Database | Prisma 7 with `@prisma/adapter-d1` and Cloudflare D1, whose database engine is SQLite. |
| Public contracts | A dedicated `@convax/api-contracts` package containing OpenAPI 3.1 and JSON Schema artifacts. Persistence models and Nest framework types remain internal. |
| Input validation | `class-validator` and `class-transformer` through Nest's validation pipeline. Public DTOs and runtime validation must agree with the contracts package. |
| Deployment | Wrangler and Cloudflare Workers with Node.js compatibility. `cloudflare:node`'s `httpServerHandler` bridges the Nest HTTP server. |
| Verification | TypeScript, Node.js native HTTP and real Worker tests, contract validation, Prisma schema validation, and a Worker bundle dry-run. The existing workspace's Vitest is available for later test suites. |
| Background work | Cloudflare Queues and Cron are candidates for work with durable retry or scheduled execution requirements. Add them when a feature needs them. |

Nest service classes use constructor injection. Each stateful resource has an explicit application or request owner and a matching close/dispose path. React components and Hooks consume the API; they do not own its business workflows.

## Repository structure

```text
apps/
  api/                  # Nest modules, controllers, services, and Prisma schema
  deploy-cloudflare/    # Worker entry, platform adapters, and Wrangler configuration
packages/
  api-contracts/        # Public HTTP contracts
docs/
  api-backend.md
  api-backend.zh.md
```

[`@convax/api`](../apps/api/package.json) owns the application and exposes a narrow runtime entry for starting and closing its HTTP server. [`@convax/deploy-cloudflare`](../apps/deploy-cloudflare/package.json) consumes that entry and owns platform-specific composition. Business rules, public errors, authorization, and retries stay with their business service in `apps/api/`.

[`@convax/api-contracts`](../packages/api-contracts/package.json) owns stable public paths, request and response shapes, and error codes. New clients consume those contracts rather than importing controllers, Prisma models, or deployment types. Add an SDK when a client needs executable request helpers.

## Client policy and announcements

`GET /api/v1/client/policy` returns a complete update and maintenance snapshot. `GET /api/v1/client/guidance` returns optional announcements selected by effective dates and deployment targeting. Both validate the client version, platform, architecture, channel and locale query fields and the installation UUID header defined in `@convax/api-contracts`; both return `Cache-Control: no-store`. The installation identifier is not an authentication credential, and these routes do not consume bearer tokens as account identity.

`startConvaxApi({ clientNotices: catalog })` accepts the immutable `ClientNoticeCatalog` deployment configuration. With no option, the checked-in default explicitly declares no update requirement, maintenance or announcements. Changing the deployment catalog and redeploying publishes its revision. Startup validates and freezes an independent copy, so a reused Worker isolate retains no request bindings, account identity or mutable caller configuration. Guidance supports explicit SemVer version bounds, platform, architecture, channel and locale constraints; there is no account targeting or percentage rollout.

Native update requirements need an explicitly available release matching the installed platform, architecture and channel, a minimum supported version, a reason and an HTTPS fallback page. Web receives no native update requirement or upgrade announcement. The API supplies metadata rather than downloading installers or enforcing local task restrictions. Maintenance presentation, idle timing, window arbitration, read records and reminder outcomes belong to the Desktop Host and Renderer. The API has no feedback endpoint, admin publication route or notice-related D1 model. [The API package](../apps/api/README.md) owns the configuration details; [the contracts package](../packages/api-contracts/README.md) owns wire shapes.

## Database and request lifecycle

The initial Prisma schema reserves the database location without inventing a business table. `pnpm --filter @convax/api db:validate` validates this schema. Define the first model and migration together with the first persisted feature, then run `pnpm --filter @convax/api db:generate` to generate its client. Generation is deferred while the schema has no model. D1 storage belongs to the API; Desktop's `node:sqlite` database and AuthX's database remain separately owned.

D1 imposes constraints on transactions and concurrent writes. A feature must define its atomic write boundary, unique constraints, idempotency keys, and retry behavior against D1's supported operations. Prisma interactive transactions must not be assumed to provide the same behavior as a long-lived PostgreSQL connection; AuthX uses explicit D1 atomic SQL for some consistency boundaries.

Cloudflare bindings belong to an invocation. When database access is introduced, pass the current binding through an explicit invocation context, construct the Prisma D1 adapter for that context, and disconnect after request-owned work settles. A reused Nest application must not retain one request's bindings or authorization state in singleton providers. Streaming responses and deferred work require an explicit lifetime before database cleanup.

## AuthX integration

Convax Desktop follows AuthX's standard OAuth/OIDC public-client contract: Authorization Code with PKCE `S256`, `state` and `nonce`, public-client token authentication method `none`, rotating refresh credentials, and exact registered loopback redirects. AuthX's local Convax profile uses callback port `65051`; a production client needs its own reviewed registration.

The API must define which access-token audience it accepts before exposing a protected route. Verify the configured issuer, audience, project and environment, signature algorithm, known JWKS key, expiry, and non-empty subject. Resolve resource authorization from Convax's own ownership data after verifying identity. The Desktop profile uses the OAuth client ID as its audience; the Hosted Application Session SDK uses a different contract and must not be substituted without an explicit protocol decision.

Keep identity-provider credentials, signing keys, token issuance, and billing authority in AuthX. The public health and notice metadata routes do not implement this integration, and they must not be used as evidence that Desktop login or cloud authorization is connected.

## Development and verification

Run installation and API commands from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm run dev:api
```

The development task builds the API and contracts through Turbo, then runs the API TypeScript compiler in watch mode alongside the local Worker at `http://127.0.0.1:8104`. Editing API TypeScript recompiles it and triggers Wrangler's reload. Read `http://127.0.0.1:8104/health` to check startup. Local development and verification do not require a production Cloudflare deployment or a model API key.

```sh
pnpm run build:api
pnpm run typecheck:api
pnpm run test:api
pnpm run check:api
```

`check:api` runs type checks, lint, Prisma validation, contract checks, Node HTTP tests, real local Worker tests, and the strict Cloudflare deployment dry-run. The root [package scripts](../package.json) define the exact checks. Before adding a business route, update its public contract, implement input validation and resource authorization, and test the observable response and persistence behavior. A database change also needs a migration and a check against a fresh local D1 database. Desktop behavior changes retain the existing Convax and DSH test requirements.

The [Cloudflare deployment package](../apps/deploy-cloudflare/README.md) owns the production endpoints and publication commands. The public base URL is `https://microvoid.io/convax/api`: health is `/convax/api/health`, and client metadata is `/convax/api/v1/client/policy` or `/convax/api/v1/client/guidance`. The Worker maps this deployment prefix to the application's routes; local development and the Workers URL keep `/health` and `/api/v1/client/*`. Public release discovery at `/convax/api/release` remains owned by the website Worker through a more specific route.

The production configuration serves the public metadata routes without a D1 binding. A successful bundle dry-run does not publish a remote service; routes that require persistence or external credentials must add their environment-specific bindings and secrets before publication.

## AuthX reference points

These paths refer to the AuthX repository, reviewed on 2026-11-08. They identify the mechanisms to consult when extending this scaffold; Convax owns its implementation and dependency versions.

| AuthX path | Reference |
|---|---|
| `apps/api/src/runtime/bootstrap-http.ts` | Nest and Express initialization. |
| `apps/api/src/main.ts` | Narrow HTTP runtime boundary and explicit close operation. |
| `apps/deploy-cloudflare/src/api.ts` | Cloudflare HTTP bridge and response lifetime. |
| `apps/api/src/database/invocation-database.ts` | Invocation-owned Prisma D1 resources. |
| `packages/contracts/README.md` | Public contract ownership and compatibility rules. |
| `README.md`, section “Convax Desktop public client” | Desktop OAuth/OIDC integration contract. |
| `packages/contracts/fixtures/convax-local-public-client.json` | Local Desktop client and resource-server validation profile. |
