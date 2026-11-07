# Convax documentation

English | [中文](README.zh.md)

The bilingual Convax documentation site uses [Cloudflare Nimbus](https://github.com/cloudflare/nimbus) and Astro. Its configured production address is [https://microvoid.io/convax/docs](https://microvoid.io/convax/docs): Nimbus receives the origin `https://microvoid.io`, while Astro serves the fixed base `/convax/docs`.

## Develop

Use `pnpm install` at the repository root; this app shares its workspace and lockfile. Run these root commands:

```sh
pnpm run dev:docs
pnpm run build:docs
pnpm run check:docs
pnpm run preview:docs
```

Development and preview use `http://localhost:4321/convax/docs/`. Build before previewing search: Pagefind creates its index during the production build. Run the documentation check after building for post-build coverage.

## Deploy

Run `pnpm run deploy:docs` from the repository root with Wrangler authenticated to a Cloudflare account that can publish Workers and routes in the `microvoid.io` zone. The command builds and publishes the `convax-docs` Worker. Its two routes cover `/convax/docs` and `/convax/docs/*`. `scripts/prepare-cloudflare.mjs` stages `dist/` under the ignored `.cloudflare/convax/docs/` directory, with root header rules and a custom 404 page; this account does not support non-root `assets.base_path`. Wrangler is pinned to **4.148.0**. The homepage remains a separate deployment.

Demo videos use a deployment-scoped edge cache for byte ranges and require browser revalidation, keeping stable filenames fresh across releases.

## Maintain content and assets

The sixteen authored pages live under `src/content/docs/{zh,en}/`. The entry redirects to Chinese; the language switch preserves the current page when a counterpart exists. Update both languages together, keep their routes aligned, and use each homepage's own-language demo.

Author Markdown links as `/zh/...`, `/en/...`, or `/demos/...`; Nimbus adds the base. Markdown images and JSX image `src` values retain `/convax/docs/demos/...` because images are not rewritten.

Demo assets have one source in the repository's `docs/assets/convax-demos/`. `scripts/prepare-demos.mjs` copies them to the ignored `public/demos/` before development or build. Edit the source assets, rather than the generated copies.

DSH Markdown remains in `libs/dsh/docs`, with its separate VitePress projection in `libs/dsh/website`. This app does not copy that entire documentation corpus.

## Upgrade with local changes

The app pins `@cloudflare/nimbus-docs` to **0.19.2**. It was scaffolded with **0.8.2**, using `templates-v0.8.2`. Keep `nimbus.json` and its review baseline under the official upgrade workflow; do not change its fields by hand to skip a review.

Header, layout, locale navigation, and Convax branding are locally owned. `src/components/LocalizedHead.astro` derives from Nimbus 0.19.2's Head and adds page-language support; compare it with the package's current Head during upgrades, retaining full-site Shiki CSS for static builds. Social-card artwork uses a shared English Convax composition and bundled Inter fonts; textual metadata and page content stay localized. Follow the official upgrade review in the [maintainer guide](AGENT.md), then rebuild and check.

Nimbus starter attribution and its complete MIT terms are retained in [LICENSE.nimbus](LICENSE.nimbus).
