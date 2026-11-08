# `@convax/api`

English | [中文](README.zh.md)

NestJS and Express application for Convax cloud business services. `src/main.ts` exports `startConvaxApi` through `@convax/api/runtime`; the deployment carrier owns listening and closing. Public `GET /health` returns `{ "status": "ok", "service": "convax-api" }`. Public `GET /api/v1/client/policy` and `GET /api/v1/client/guidance` deliver client update, maintenance and announcement metadata. HTTP errors use the shared error contract.

Pass `startConvaxApi({ clientNotices: catalog })` to select a `ClientNoticeCatalog`, exported as a type from the same runtime entry. Without options, `DEFAULT_CLIENT_NOTICE_CATALOG` in `src/client-notices/catalog.ts` explicitly selects no update requirement, maintenance or announcements. Change that deployment constant or the carrier's startup options and redeploy to publish a revision. Startup validates and freezes a detached copy; malformed content fails startup rather than silently serving an empty catalog.

The routes require the installation UUID header and client version, platform, architecture, channel and locale query fields defined in `@convax/api-contracts`. Guidance supports optional audience constraints with inclusive minimum and exclusive maximum SemVer versions, exact platform/architecture/channel and case-insensitive locale matching, plus each notice's effective dates. Native upgrade guidance requires the matching configured available release; Web receives none. Required updates additionally need a complete minimum-version rule and HTTPS fallback page. These public routes do not authenticate accounts, inspect D1 or persist user choices; the Host owns local read and reminder records.

The Prisma schema has no business models. Define a model and migration with the first persisted feature before generating a client. Authentication and business routes follow the [backend plan](../../docs/api-backend.md).

Run from the repository root:

```sh
pnpm run dev:api
pnpm run check:api
pnpm --filter @convax/api db:validate
```

`dev:api` builds once, then watches API TypeScript alongside Wrangler so source edits recompile and reload the local Worker.
