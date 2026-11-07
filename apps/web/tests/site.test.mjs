/** Built public-site behavior and real local demo playback, without a DSH Host. */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright'
import { preview, resolveConfig } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const artifacts = fileURLToPath(new URL('../../../.artifacts/public-site/', import.meta.url))
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ?? (existsSync(chrome) ? chrome : undefined)
const readyRelease = {
  status: 'ready', version: '0.1.0', size: 123_731_968,
  downloadUrl: 'https://github.com/microvoid/convax/releases/download/v0.1.0/convax-0.1.0-mac-arm64.dmg',
  releaseUrl: 'https://github.com/microvoid/convax/releases/tag/v0.1.0',
}
const releasesUrl = 'https://github.com/microvoid/convax/releases'
let server
let browser
let origin
let base

before(async () => {
  const config = await resolveConfig({ root }, 'build')
  await access(resolve(config.root, config.build.outDir, 'index.html')).catch((error) => {
    throw new Error('Build the homepage before testing: pnpm --filter @convax/web build', { cause: error })
  })
  server = await preview({ root, preview: { host: '127.0.0.1', port: 0, strictPort: true } })
  const address = server.httpServer.address()
  assert.ok(address && typeof address !== 'string', 'Vite preview must bind an OS-assigned TCP port')
  origin = `http://127.0.0.1:${address.port}`
  base = server.config.base
  assert.equal(base, '/convax/', 'The public homepage must build for its production subpath')
  browser = await chromium.launch({ executablePath })
  await mkdir(artifacts, { recursive: true })
}, { timeout: 60_000 })

after(async () => {
  try { await browser?.close() } finally { await server?.close() }
})

async function openPage(t, { language = 'zh', width = 1440, release = 'ready', releaseResponse, onRequest } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' })
  const errors = []
  const external = []
  const api = []
  const outsideBase = []
  t.after(async () => {
    try {
      assert.deepEqual(errors, [], 'The public homepage must not throw browser errors')
      assert.deepEqual(external, [], 'The homepage and its demo assets must work without external requests')
      assert.deepEqual(api, [], 'The public homepage must only query its public release endpoint, never a Host or model API')
      assert.deepEqual(outsideBase, [], 'Homepage assets must stay under the configured deployment prefix')
    } finally { await context.close() }
  })
  const page = await context.newPage()
  await page.route(`${origin}${base}api/release`, route => route.fulfill({
    status: releaseResponse?.status ?? (release === 'unavailable' ? 503 : 200),
    contentType: 'application/json',
    body: JSON.stringify(releaseResponse?.body ?? (release === 'ready' ? readyRelease : { status: release, releaseUrl: releasesUrl })),
  }))
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', (request) => {
    onRequest?.(request)
    const url = new URL(request.url())
    if (url.origin !== origin) external.push(request.url())
    else if (!url.pathname.startsWith(base)) outsideBase.push(url.pathname)
    if (['fetch', 'xhr', 'websocket'].includes(request.resourceType())
      && !(url.origin === origin && url.pathname === `${base}api/release` && request.method() === 'GET')) api.push(request.url())
  })
  const response = await page.goto(`${origin}${base}${language === 'en' ? '?lang=en' : ''}`)
  assert.equal(response?.status(), 200)
  await page.getByRole('heading', { level: 1 }).waitFor()
  await page.locator(`[data-release-status="${release}"]`).waitFor()
  return page
}

async function assertLocale(page, language) {
  const english = language === 'en'
  await page.waitForFunction(lang => document.documentElement.lang === lang, english ? 'en' : 'zh-CN')
  assert.equal(new URL(page.url()).pathname, base)
  assert.equal(new URL(page.url()).searchParams.get('lang'), english ? 'en' : null)
  assert.equal(await page.title(), english
    ? 'Convax — Your projects. One canvas. In parallel.'
    : 'Convax — 一张画布，多个项目，并行推进')
  assert.match(await page.locator('h1').innerText(), english
    ? /Your projects\. One canvas\.\s*In parallel\./u
    : /把多个项目，\s*放在一张画布上。/u)
  for (const kind of ['projects', 'apps']) {
    const player = page.locator(`video[data-demo="${kind}"]`)
    const source = new URL(await player.getAttribute('src'), page.url())
    const poster = new URL(await player.getAttribute('poster'), page.url())
    assert.ok(source.pathname.startsWith(`${base}assets/`))
    assert.ok(poster.pathname.startsWith(`${base}assets/`))
    assert.match(source.pathname, new RegExp(`/${kind}-${language}-[^/]+\\.mp4$`, 'u'))
    assert.match(poster.pathname, new RegExp(`/${kind}-${language}-[^/]+\\.jpg$`, 'u'))
  }
}

async function assertNoPageOverflow(page) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.scrollingElement.scrollWidth,
  }))
  assert.ok(dimensions.content <= dimensions.viewport,
    `Content must fit the ${page.viewportSize().width}px viewport: ${JSON.stringify(dimensions)}`)
}

async function scrollToTop(page) {
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForFunction(() => window.scrollY === 0)
}

async function playDemo(page, kind, language) {
  const player = page.locator(`video[data-demo="${kind}"]`)
  const figure = page.locator('figure').filter({ has: player })
  await figure.getByRole('button', { name: language === 'en' ? /^Play demo:/u : /^播放演示:/u }).click()
  await page.waitForFunction(kind => {
    const video = document.querySelector(`video[data-demo="${kind}"]`)
    return video && Number.isFinite(video.duration) && video.readyState >= 2 && !video.paused && video.currentTime > 0
  }, kind)
  const playback = await player.evaluate(video => ({ duration: video.duration, error: video.error?.code ?? null }))
  assert.ok(Math.abs(playback.duration - (kind === 'projects' ? 34 : 36)) < 0.25,
    `${kind} must decode its actual published MP4 duration, received ${playback.duration}`)
  assert.equal(playback.error, null)
  await player.evaluate(video => video.pause())
}

test('Chinese homepage presents five sections and local poster players without automatic downloads or playback', { timeout: 60_000 }, async (t) => {
  const mediaRequests = []
  const page = await openPage(t, { onRequest: (request) => {
    if (new URL(request.url()).pathname.endsWith('.mp4')) mediaRequests.push(request.url())
  } })
  await assertLocale(page, 'zh')
  for (const id of ['projects', 'apps', 'features', 'download', 'faq']) assert.equal(await page.locator(`section#${id}`).count(), 1)
  for (const [selector, attribute, contentType] of [
    ['script[type="module"][src]', 'src', /javascript/u],
    ['link[rel="stylesheet"]', 'href', /text\/css/u],
    ['link[rel="icon"]', 'href', /image\/svg\+xml/u],
  ]) {
    const source = new URL(await page.locator(selector).getAttribute(attribute), page.url())
    assert.equal(source.origin, origin)
    assert.ok(source.pathname.startsWith(`${base}assets/`), `${selector} must resolve under the deployment prefix`)
    const response = await page.request.get(source.href)
    assert.equal(response.status(), 200)
    assert.match(response.headers()['content-type'], contentType)
  }
  assert.equal(await page.locator('video').count(), 2)
  for (const player of await page.locator('video').all()) {
    assert.equal(await player.getAttribute('preload'), 'none')
    assert.equal(await player.getAttribute('autoplay'), null)
    assert.deepEqual(await player.evaluate(video => ({ controls: video.controls, paused: video.paused, time: video.currentTime })),
      { controls: true, paused: true, time: 0 })
  }
  assert.deepEqual(mediaRequests, [], 'preload=none must avoid downloading demo MP4s before a play action')
  await scrollToTop(page)
  await page.screenshot({ path: join(artifacts, 'desktop-zh.png'), fullPage: true })
  await scrollToTop(page)
  await page.locator('.hero').screenshot({ path: join(artifacts, 'hero-zh.png') })
  await page.getByRole('link', { name: '观看演示', exact: true }).click()
  assert.equal(new URL(page.url()).pathname, base)
  assert.equal(new URL(page.url()).hash, '#projects')
})

test('language navigation updates URL, metadata and both localized video sources and also supports direct English entry', { timeout: 60_000 }, async (t) => {
  const page = await openPage(t)
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await assertLocale(page, 'en')
  const description = await page.locator('meta[name="description"]').getAttribute('content')
  assert.match(description, /^Connect files, projects, application windows/u)
  assert.equal(await page.locator('meta[property="og:title"]').getAttribute('content'), await page.title())
  await scrollToTop(page)
  await page.screenshot({ path: join(artifacts, 'desktop-en.png'), fullPage: true })
  await scrollToTop(page)
  await page.locator('.hero').screenshot({ path: join(artifacts, 'hero-en.png') })
  await page.reload()
  await assertLocale(page, 'en')
  await page.getByRole('button', { name: '中文', exact: true }).click()
  await assertLocale(page, 'zh')
  const direct = await openPage(t, { language: 'en' })
  await assertLocale(direct, 'en')
})

test('all four published demo MP4s decode and play only after an explicit play action', { timeout: 60_000 }, async (t) => {
  for (const language of ['zh', 'en']) {
    const page = await openPage(t, { language })
    for (const kind of ['projects', 'apps']) await playDemo(page, kind, language)
  }
})

test('failed local media reports a localized error and retry recovers the real video', { timeout: 60_000 }, async (t) => {
  for (const language of ['zh', 'en']) {
    const page = await openPage(t, { language })
    const player = page.locator('video[data-demo="projects"]')
    const source = await player.evaluate(video => video.src)
    await page.route(source, route => route.fulfill({ status: 404, contentType: 'video/mp4', body: '' }))
    const figure = page.locator('figure').filter({ has: player })
    await figure.getByRole('button', { name: language === 'en' ? /^Play demo:/u : /^播放演示:/u }).click()
    const error = figure.getByRole('alert')
    await error.waitFor()
    assert.match(await error.innerText(), language === 'en' ? /This video could not play/u : /视频暂时无法播放/u)
    await page.unroute(source)
    await error.getByRole('button', { name: language === 'en' ? 'Try again' : '重试', exact: true }).click()
    await error.waitFor({ state: 'detached' })
    await playDemo(page, 'projects', language)
  }
})

test('published installers replace source setup with direct downloads and a keyboard-accessible getting-started path', { timeout: 60_000 }, async (t) => {
  for (const language of ['zh', 'en']) {
    const page = await openPage(t, { language })
    const hero = page.locator('[data-download="hero"]')
    const installer = page.locator('[data-download="installer"]')
    assert.equal(await hero.getAttribute('href'), readyRelease.downloadUrl)
    assert.equal(await installer.getAttribute('href'), readyRelease.downloadUrl)
    assert.equal(await hero.innerText(), language === 'en' ? 'Download for macOS' : '下载 macOS 客户端')
    assert.match((await page.locator('.hero-platform').innerText()).replace(/\s+/gu, ' '), /Apple Silicon.*v0\.1\.0/u)
    const card = page.locator('.download-card')
    assert.match(await card.innerText(), /Apple Silicon/u)
    assert.match(await card.innerText(), /118 MB/u)
    assert.equal(await card.getByRole('link', { name: language === 'en' ? 'Releases & updates' : '版本与更新说明' }).getAttribute('href'), readyRelease.releaseUrl)
    assert.equal(await page.locator('.onboarding-steps > li').count(), 3)
    assert.equal(await page.locator('.download-intro .text-link').getAttribute('href'), `/convax/docs/${language}/getting-started/`)
    assert.equal(await page.locator('pre, [role="tab"]').count(), 0)
    assert.doesNotMatch(await page.locator('main').innerText(), /从源码开始|Start from source|pnpm|git clone/u)
    await installer.focus()
    assert.equal(await installer.evaluate(element => document.activeElement === element), true)
    const summary = page.locator('#faq summary').first()
    await summary.focus()
    await page.keyboard.press('Enter')
    assert.equal(await summary.evaluate(element => element.parentElement.open), true)
    await page.keyboard.press('Enter')
    assert.equal(await summary.evaluate(element => element.parentElement.open), false)
  }
})

test('unpublished installers show the preparation state and never offer a fabricated file link', { timeout: 60_000 }, async (t) => {
  for (const language of ['zh', 'en']) {
    const page = await openPage(t, { language, release: 'pending' })
    const hero = page.locator('[data-download="hero"]')
    assert.equal(await hero.getAttribute('href'), '#download')
    assert.equal(await page.locator('[data-download="installer"]').count(), 0)
    const card = page.locator('.download-card')
    assert.equal(await card.locator(':scope > button').isDisabled(), true)
    assert.equal(await card.locator(':scope > button').innerText(), language === 'en' ? 'Installer coming soon' : '安装包准备中')
    assert.equal(await card.getByRole('link', { name: language === 'en' ? 'Releases & updates' : '版本与更新说明' }).getAttribute('href'), releasesUrl)
    assert.equal(await page.locator('a[href*="/releases/download/"]').count(), 0)
    await hero.click()
    assert.equal(new URL(page.url()).hash, '#download')
    await card.screenshot({ path: join(artifacts, `download-pending-${language}.png`) })
  }
})

test('release lookup failures keep the homepage available and retry recovers the public installer', { timeout: 60_000 }, async (t) => {
  for (const language of ['zh', 'en']) {
    const releaseRequests = []
    const page = await openPage(t, { language, release: 'unavailable', onRequest: (request) => {
      if (new URL(request.url()).pathname === `${base}api/release`) releaseRequests.push(request.url())
    } })
    const card = page.locator('.download-card')
    assert.match(await card.locator('.download-status').innerText(), language === 'en' ? /Download information is unavailable/u : /暂时无法获取下载版本/u)
    assert.equal(await card.locator(':scope > button').isDisabled(), true)
    assert.equal(await page.locator('[data-download="hero"]').getAttribute('href'), '#download')
    assert.equal(await page.locator('[data-download="installer"]').count(), 0)
    await page.route(`${origin}${base}api/release`, route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(readyRelease) }))
    await card.getByRole('button', { name: language === 'en' ? 'Check again' : '重新检查', exact: true }).click()
    await page.locator('[data-release-status="ready"]').waitFor()
    assert.equal(await page.locator('[data-download="installer"]').getAttribute('href'), readyRelease.downloadUrl)
    assert.equal(await page.locator('[data-download="hero"]').getAttribute('href'), readyRelease.downloadUrl)
    assert.equal(releaseRequests.length, 2, 'A manual retry must issue one fresh release lookup')
    await assertLocale(page, language)
  }
})

test('invalid public download metadata never turns the primary action into an unrelated file link', { timeout: 60_000 }, async (t) => {
  const page = await openPage(t, {
    release: 'unavailable',
    releaseResponse: { status: 200, body: { ...readyRelease, downloadUrl: 'https://example.com/unrelated-installer.dmg' } },
  })
  assert.equal(await page.locator('[data-download="installer"]').count(), 0)
  assert.equal(await page.locator('[data-download="hero"]').getAttribute('href'), '#download')
  assert.equal(await page.locator('a[href="https://example.com/unrelated-installer.dmg"]').count(), 0)
  const card = page.locator('.download-card')
  assert.equal(await card.locator(':scope > button').isDisabled(), true)
  await page.route(`${origin}${base}api/release`, route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(readyRelease) }))
  await card.getByRole('button', { name: '重新检查', exact: true }).click()
  await page.locator('[data-release-status="ready"]').waitFor()
  assert.equal(await page.locator('[data-download="installer"]').getAttribute('href'), readyRelease.downloadUrl)
})

test('390px mobile layout, menu and localized download controls remain within the viewport', { timeout: 60_000 }, async (t) => {
  const page = await openPage(t, { width: 390 })
  await assertNoPageOverflow(page)
  await scrollToTop(page)
  await page.screenshot({ path: join(artifacts, 'mobile-zh.png'), fullPage: true })
  const toggle = page.getByRole('button', { name: '导航菜单', exact: true })
  await toggle.click()
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
  const navigation = page.getByRole('navigation', { name: '导航菜单', exact: true })
  await navigation.waitFor()
  const firstLink = navigation.getByRole('link', { name: '演示', exact: true })
  await page.waitForFunction(() => document.activeElement === document.querySelector('#primary-nav a'))
  assert.equal(await firstLink.evaluate(element => document.activeElement === element), true)
  await assertNoPageOverflow(page)
  await firstLink.press('Escape')
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
  assert.equal(await toggle.evaluate(element => document.activeElement === element), true)
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await assertLocale(page, 'en')
  const hero = page.locator('[data-download="hero"]')
  assert.equal(await hero.getAttribute('href'), readyRelease.downloadUrl)
  const heroSize = await hero.boundingBox()
  assert.ok(heroSize && heroSize.height >= 44, 'The primary mobile download action must retain a touch-sized target')
  await assertNoPageOverflow(page)
  await scrollToTop(page)
  await page.screenshot({ path: join(artifacts, 'mobile-en.png'), fullPage: true })
})

test('English download actions remain complete and reachable across phone, tablet and desktop widths', { timeout: 60_000 }, async (t) => {
  for (const width of [390, 768, 1024, 1440]) {
    const page = await openPage(t, { language: 'en', width })
    await assertNoPageOverflow(page)
    for (const selector of ['[data-download="hero"]', '[data-download="installer"]']) {
      const action = page.locator(selector)
      await action.scrollIntoViewIfNeeded()
      const geometry = await action.evaluate(element => ({
        x: element.getBoundingClientRect().x, width: element.getBoundingClientRect().width,
        height: element.getBoundingClientRect().height, content: element.scrollWidth, inner: element.clientWidth,
      }))
      assert.ok(geometry.x >= 0 && geometry.x + geometry.width <= width,
        `${selector} must fit the ${width}px viewport: ${JSON.stringify(geometry)}`)
      assert.ok(geometry.height >= 44, `${selector} must remain a touch-sized action at ${width}px`)
      assert.ok(geometry.content <= geometry.inner, `${selector} must show its full label at ${width}px`)
      assert.equal(await action.getAttribute('href'), readyRelease.downloadUrl)
    }
  }
})
