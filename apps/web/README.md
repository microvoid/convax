# @convax/web

English | [中文](README.zh.md)

The bilingual Convax public homepage is a standalone React and Vite app. It presents product features and demos, offers the macOS Apple Silicon client download, and guides users through installation and their first conversation. Source setup lives in the documentation. The homepage does not connect to a DSH Host or model API and needs no `.env` file.

## Develop

Run commands from the repository root using its configured Node.js and pnpm versions. Dependencies belong to the root workspace and lockfile.

```sh
pnpm install --frozen-lockfile
pnpm --filter @convax/web dev
```

Open the `/convax/` URL printed by Vite. Both the development server and the built-site preview use that prefix. Chinese is the default; `/convax/?lang=en` opens English. The language button updates the URL, document metadata, and demo media.

## Build and validate

```sh
pnpm --filter @convax/web build
pnpm --filter @convax/web test
pnpm --filter @convax/web preview
```

The browser tests serve the existing build under `/convax/` on an OS-assigned local port, check desktop and 390px layouts, exercise language and keyboard controls, and decode the actual demo videos. They verify download availability and recovery states, and check that JavaScript, CSS, the favicon, posters, and video sources resolve under the deployment prefix. They use `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` when set, otherwise Google Chrome on macOS if installed, then Playwright's Chromium. Screenshots are written to `.artifacts/public-site/`. Build before running tests.

## Deploy

The production homepage is [microvoid.io/convax](https://microvoid.io/convax/). Vite builds the site into `apps/web/dist/convax/` with `base` fixed to `/convax/`. Publish the `apps/web/dist/` directory as the static root: its physical `convax/` directory provides `/convax/` and `/convax/assets/`. The bundled assets do not belong at the origin's `/assets/` path. No server process, Host credentials, or API configuration is required. Vite bundles the shared demo MP4 files from `docs/assets/convax-demos/` and local posters into the build output. Videos load on user action, with native controls and localized retry feedback.

Cloudflare deployment uses `wrangler.jsonc` and requires an authenticated Wrangler account with access to the `microvoid.io` zone. It uploads `dist/` and publishes the `convax-homepage` static Worker on `/convax` and `/convax/*`, using the generated `convax/` directory for the URL prefix. The origin's other paths keep their existing routing. The deploy command builds before publishing; local preview serves the nested site at the `/convax/` URL printed by Vite.

Requests to `/convax/api/release` run `worker.mjs` to read the latest public stable GitHub Release and find its macOS Apple Silicon installer. The homepage shows download preparation or retry feedback when an installer is unavailable; it does not treat an Actions build artifact as a public download. This read-only endpoint requires no Host credentials or model API key.

Demo MP4 requests also run the Worker, which caches complete files and uses Cloudflare's Cache API to serve byte ranges for native video seeking. Other assets are served directly. The browser suite checks the page; `tests/worker.test.mjs` checks the deployed configuration in the local Workers runtime, including release responses and cold and warm range responses.

```sh
pnpm --filter @convax/web exec wrangler login
pnpm --filter @convax/web run deploy
```

The navigation, footer, and browser favicon share the canvas mark in `../../packages/plugin-renderer/src/client/assets/convax-mark.svg`.
