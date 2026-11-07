import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import nimbus, { defineConfig as defineNimbusConfig } from "@cloudflare/nimbus-docs";
import { tableScroll } from "@cloudflare/nimbus-docs/markdown";

const docsUrl = new URL(process.env.DOCS_SITE_URL ?? "https://microvoid.io/convax/docs");
if (!["http:", "https:"].includes(docsUrl.protocol)
  || docsUrl.pathname.replace(/\/$/, "") !== "/convax/docs"
  || docsUrl.search || docsUrl.hash || docsUrl.username || docsUrl.password) {
  throw new Error("DOCS_SITE_URL must be an HTTP(S) address ending in /convax/docs, without credentials, query, or fragment.");
}

const nimbusConfig = defineNimbusConfig({
  site: docsUrl.origin,
  title: "Convax",
  description: "A canvas workspace for projects, resources, and AI conversations.",
  locale: "zh-CN",
  github: "https://github.com/microvoid/convax",
  socialImageAlt: "Convax documentation",
  agents: { discovery: false },
  sidebar: {
    scope: "section",
    items: [{ autogenerate: { collection: "docs" } }],
  },
});

export default defineConfig({
  base: "/convax/docs",
  output: "static",
  vite: { plugins: [tailwindcss()] },
  prefetch: { prefetchAll: true, defaultStrategy: "hover" },
  integrations: [nimbus(nimbusConfig, {
    rules: {
      "nimbus/frontmatter-shape": "error",
      "nimbus/internal-link": "error",
    },
    markdown: {
      hastPlugins: [tableScroll()],
      features: { headingAttributes: true },
    },
  })],
});
