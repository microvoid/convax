import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(appRoot, "../..");
const publicUrl = new URL(process.env.DOCS_SITE_URL ?? "https://microvoid.io/convax/docs");
const base = publicUrl.pathname.replace(/\/+$/, "");
const route = (path = "") => `${base}/${path.replace(/^\/+/, "")}`;
const canonical = (path = "") => new URL(route(path), publicUrl.origin).href;
const pages = ["", "getting-started/", "guides/canvases/", "guides/resources/", "guides/chats/", "guides/windows/", "development/architecture/", "development/plugins/"];
const timeout = 30_000;

/** Own a foreground Astro process and the atomically allocated port it reports. */
async function startPreview(t) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(name)));
  const child = spawn(process.execPath, [join(appRoot, "node_modules/astro/bin/astro.mjs"), "preview", "--host", "127.0.0.1", "--port", "0", "--ignore-lock"], {
    cwd: appRoot,
    env: { ...env, ASTRO_TELEMETRY_DISABLED: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const capture = (data) => { output = (output + data.toString()).slice(-16_000); };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    let forced = false;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const deadline = setTimeout(() => { forced = true; child.kill("SIGKILL"); }, 10_000);
    try {
      await closed;
      assert.equal(forced, false, "Astro preview did not exit after SIGTERM");
    } finally {
      clearTimeout(deadline);
      child.stdout.off("data", capture);
      child.stderr.off("data", capture);
    }
  });

  const origin = await new Promise((resolve, reject) => {
    let stdout = "";
    const ready = (chunk) => {
      stdout += chunk.toString();
      // Ignore the URL of a user's existing preview mentioned by --ignore-lock.
      // Astro's ready message (plain or JSON) identifies this child's Local URL.
      const match = stdout.match(/Local\s+(http:\/\/127\.0\.0\.1:[1-9]\d*)/);
      if (match) { cleanup(); resolve(match[1]); }
    };
    const failed = (error) => { cleanup(); reject(error); };
    const exited = (code, signal) => failed(new Error(`Astro exited before readiness (code ${code}, signal ${signal}):\n${output}`));
    const deadline = setTimeout(() => failed(new Error(`Astro preview readiness timed out:\n${output}`)), timeout);
    const cleanup = () => {
      clearTimeout(deadline);
      child.stdout.off("data", ready);
      child.off("error", failed);
      child.off("close", exited);
    };
    child.stdout.on("data", ready);
    child.once("error", failed);
    child.once("close", exited);
  });
  return origin;
}

async function openPage(t, browser, origin, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "light", ...options });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(timeout);
  page.setDefaultNavigationTimeout(timeout);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], "The shipped client must not raise uncaught errors"));
  const goto = async (path) => {
    const response = await page.goto(new URL(route(path), origin).href);
    assert.equal(response?.status(), 200, `GET ${route(path)}`);
    await page.locator("main h1").waitFor({ state: "visible" });
  };
  return { page, context, goto };
}

async function waitForTheme(page, expected) {
  await page.waitForFunction((mode) => (document.documentElement.dataset.mode ?? "light") === mode, expected);
  assert.equal(await page.locator("[data-nb-theme-toggle]").getAttribute("aria-pressed"), String(expected === "dark"));
}

async function screenshotPage(page, path) {
  for (const image of await page.locator("main img").all()) {
    await image.scrollIntoViewIfNeeded();
    await image.evaluate((element) => element.decode());
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
}

test("built Nimbus documentation works under its deployment base", { timeout: 180_000 }, async (t) => {
  const origin = await startPreview(t);
  t.diagnostic(`Owned Astro preview: ${origin}${base}/`);
  const browser = await chromium.launch({ headless: true, timeout: 45_000 });
  t.after(() => browser.close());
  const artifactRoot = join(repositoryRoot, ".artifacts/docs");
  await mkdir(artifactRoot, { recursive: true });
  const artifacts = await mkdtemp(join(artifactRoot, "smoke-"));
  t.diagnostic(`Browser screenshots: ${artifacts}`);

  await t.test("all 16 localized pages publish matching navigation and SEO", async (t) => {
    const { page, goto } = await openPage(t, browser, origin);
    const checkedLinks = new Set();
    await goto("");
    assert.equal(new URL(page.url()).pathname, route("zh/"), "The docs root redirects to Chinese");
    for (const locale of ["zh", "en"]) {
      for (const path of pages) {
        const localized = `${locale}/${path}`;
        await goto(localized);
        assert.equal(await page.locator("html").getAttribute("lang"), locale === "zh" ? "zh-CN" : "en");
        assert.equal(await page.locator('link[rel="canonical"]').getAttribute("href"), canonical(localized));
        assert.equal(await page.locator('link[rel="alternate"][hreflang="zh-CN"]').getAttribute("href"), canonical(`zh/${path}`));
        assert.equal(await page.locator('link[rel="alternate"][hreflang="en"]').getAttribute("href"), canonical(`en/${path}`));
        assert.equal(await page.locator('meta[property="og:locale"]').count(), 1);
        const sidebarLinks = await page.locator("[data-nb-sidebar] a[href]").evaluateAll((links) => links.map((link) => new URL(link.href).pathname));
        assert.ok(sidebarLinks.length >= pages.length, "All docs remain discoverable from the sidebar");
        assert.ok(sidebarLinks.every((href) => href.startsWith(route(`${locale}/`))), `The ${locale} sidebar must exclude the other locale`);
        const authoredLinks = await page.locator("main a[href]").evaluateAll((links) => links.map((link) => new URL(link.href)).filter((url) => url.origin === window.location.origin).map((url) => url.pathname));
        for (const href of authoredLinks) {
          assert.ok(href.startsWith(`${base}/`), `Authored link stays under the deployment base: ${href}`);
          assert.ok(!href.startsWith(`${base}${base}/`), `Authored link must not repeat the deployment base: ${href}`);
          if (checkedLinks.has(href)) continue;
          checkedLinks.add(href);
          const response = await page.request.head(new URL(href, origin).href);
          assert.equal(response.status(), 200, `Authored link resolves: ${href}`);
        }
      }
    }
    const missing = await page.goto(new URL(route("missing-page/"), origin).href);
    assert.equal(missing?.status(), 404);
    assert.equal(await page.locator('link[rel="alternate"][hreflang]').count(), 0, "A missing page must not advertise fabricated translations");
    assert.equal(await page.locator('meta[name="robots"]').getAttribute("content"), "noindex");
    assert.equal(await page.locator('header nav a[lang="en"]').getAttribute("href"), route("en/"));
    await goto("zh/");
    await screenshotPage(page, join(artifacts, "desktop-zh-light.png"));
  });

  await t.test("language switching retains the page and reloads locale-owned search", async (t) => {
    const { page, goto } = await openPage(t, browser, origin);
    await goto("zh/guides/windows/");
    await page.evaluate(() => { window.__docsSmokeDocument = "before-language-change"; });
    await page.locator('header nav a[lang="en"]').click();
    await page.waitForURL(new URL(route("en/guides/windows/"), origin).href);
    assert.equal(await page.locator("main h1").innerText(), "Window mirrors and Computer Use");
    assert.equal(await page.evaluate(() => window.__docsSmokeDocument), undefined, "Language switches must start a fresh document");
    await page.locator('header nav a[lang="zh-CN"]').click();
    await page.waitForURL(new URL(route("zh/guides/windows/"), origin).href);
    assert.equal(await page.locator("main h1").innerText(), "窗口镜像与 Computer Use");
  });

  await t.test("mobile readers can open, navigate, and dismiss the sidebar", async (t) => {
    const { page, goto } = await openPage(t, browser, origin, { viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
    await goto("zh/");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "The mobile layout must not overflow horizontally");
    const trigger = page.locator("[data-menu-btn]");
    const drawer = page.locator("[data-mobile-sidebar]");
    await trigger.click();
    await drawer.locator("[data-nb-sidebar]").waitFor({ state: "visible" });
    assert.equal(await trigger.getAttribute("aria-expanded"), "true");
    assert.equal(await drawer.getAttribute("aria-label"), "文档导航");
    assert.match(await drawer.innerText(), /使用指南/);
    assert.match(await drawer.innerText(), /开发文档/);
    assert.doesNotMatch(await drawer.innerText(), /Guides|Development/);
    await page.screenshot({ path: join(artifacts, "mobile-zh-navigation.png"), animations: "disabled" });
    await drawer.locator(`a[href="${route("zh/getting-started/")}"]`).click();
    await page.waitForURL(new URL(route("zh/getting-started/"), origin).href);
    assert.equal(await page.locator("main h1").innerText(), "快速开始");
    await page.locator("[data-menu-btn]").click();
    await page.locator("[data-mobile-sidebar][open]").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await page.locator("[data-mobile-sidebar][open]").waitFor({ state: "detached" });
    await page.locator('[data-menu-btn][aria-expanded="false"]').waitFor({ state: "visible" });
  });

  await t.test("theme selection persists across page loads", async (t) => {
    const { page, goto } = await openPage(t, browser, origin);
    await goto("en/guides/resources/");
    await waitForTheme(page, "light");
    await page.locator("[data-nb-theme-toggle]").click();
    await waitForTheme(page, "dark");
    await screenshotPage(page, join(artifacts, "desktop-en-dark.png"));
    await goto("en/guides/chats/");
    await waitForTheme(page, "dark");
    await page.locator("[data-nb-theme-toggle]").click();
    await waitForTheme(page, "light");
    assert.equal(await page.evaluate(() => localStorage.getItem("ui-mode")), "light");
  });

  await t.test("Pagefind returns real results in each document language", async (t) => {
    const { page, goto } = await openPage(t, browser, origin);
    for (const [locale, query] of [["zh", "Computer"], ["en", "mirrors"]]) {
      await goto(`${locale}/`);
      await page.locator("[data-search-trigger]").click();
      await page.locator("[data-search-input]").fill(query);
      await page.locator("[data-search-results] [role=option] a").first().waitFor({ state: "visible" });
      const links = await page.locator("[data-search-results] a").evaluateAll((anchors) => anchors.map((anchor) => new URL(anchor.href).pathname));
      assert.ok(links.some((href) => href === route(`${locale}/guides/windows/`)), "Search must find the authored window guide");
      assert.ok(links.every((href) => href.startsWith(route(`${locale}/`))), "Search must use the current locale's actual Pagefind index");
      await page.keyboard.press("Escape");
    }
  });

  await t.test("Markdown and agent indexes serve real localized source", async (t) => {
    const { context } = await openPage(t, browser, origin);
    const readText = async (path) => {
      const response = await context.request.get(new URL(route(path), origin).href);
      assert.equal(response.status(), 200, `GET ${route(path)}`);
      assert.match(response.headers()["content-type"], /text\/(?:markdown|plain)/);
      return response.text();
    };
    const collectSources = async (indexPath, locale) => {
      const visited = new Set();
      const sources = new Set();
      const visit = async (path) => {
        assert.ok(visited.size < 40, "The finite docs index must not grow or cycle indefinitely");
        if (visited.has(path)) return;
        visited.add(path);
        const index = await readText(path);
        for (const match of index.matchAll(/\]\((https?:\/\/[^\s)]+)\)/g)) {
          const target = new URL(match[1]);
          assert.equal(target.origin, publicUrl.origin);
          assert.ok(target.pathname.startsWith(`${base}/`), "Agent discovery URLs retain the deployment base");
          const logical = target.pathname.slice(base.length + 1);
          if (locale) assert.ok(logical.startsWith(`${locale}/`), "Section indexes stay within their locale");
          if (logical.endsWith("/llms.txt")) await visit(logical);
          else if (logical.endsWith("/index.md")) {
            assert.ok((await readText(logical)).length > 100, "Discovered Markdown contains the actual page source");
            sources.add(target.href);
          }
        }
      };
      await visit(indexPath);
      return [...sources].sort();
    };
    for (const locale of ["zh", "en"]) {
      const markdown = await readText(`${locale}/guides/windows/index.md`);
      assert.ok(markdown.includes(locale === "zh" ? "窗口镜像与 Computer Use" : "Window mirrors and Computer Use"));
      assert.deepEqual(await collectSources(`${locale}/llms.txt`, locale), pages.map((path) => canonical(`${locale}/${path}index.md`)).sort());
    }
    assert.deepEqual(await collectSources("llms.txt"), ["zh", "en"].flatMap((locale) => pages.map((path) => canonical(`${locale}/${path}index.md`))).sort());
    const full = await readText("llms-full.txt");
    assert.ok(full.includes("Window mirrors and Computer Use") && full.includes("窗口镜像与 Computer Use"));
  });

  await t.test("each overview links playable videos and decoded previews in its language", async (t) => {
    const { page, context, goto } = await openPage(t, browser, origin);
    for (const locale of ["zh", "en"]) {
      await goto(`${locale}/`);
      const links = page.locator('main a[href$=".mp4"]');
      assert.equal(await links.count(), 2, "Both product demos are available");
      for (const stem of ["projects", "apps"]) {
        const videoPath = route(`demos/${stem}-${locale}.mp4`);
        const preview = page.locator(`main a[href="${videoPath}"] img`);
        await preview.scrollIntoViewIfNeeded();
        await preview.evaluate((image) => image.decode());
        assert.ok(await preview.evaluate((image) => image.naturalWidth > 0));
        const response = await context.request.get(new URL(videoPath, origin).href, { headers: { Range: "bytes=0-63" } });
        assert.equal(response.status(), 206, "Video serving supports range requests");
        assert.match(response.headers()["content-type"], /video\/mp4/);
        assert.equal((await response.body()).subarray(4, 8).toString(), "ftyp", "The endpoint contains MP4 bytes");
        const duration = await page.evaluate((src) => new Promise((resolve, reject) => {
          const video = document.createElement("video");
          const timer = setTimeout(() => { video.removeAttribute("src"); video.load(); reject(new Error(`Video metadata timed out: ${src}`)); }, 30_000);
          video.preload = "metadata";
          video.onloadedmetadata = () => { clearTimeout(timer); const value = video.duration; video.removeAttribute("src"); video.load(); resolve(value); };
          video.onerror = () => { clearTimeout(timer); reject(new Error(`Browser cannot decode ${src}: ${video.error?.message}`)); };
          video.src = src;
        }), videoPath);
        assert.ok(duration > 30 && duration < 45, `Playable demo duration: ${duration}`);
      }
    }
  });
});
