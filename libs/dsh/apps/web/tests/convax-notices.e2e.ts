/** Shipped Loader composition consumes real notice HTTP responses and persists window-coordinated choices. */
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page, type Response as BrowserResponse } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const BUNDLE = fileURLToPath(new URL('../../../../../packages/plugin-renderer/', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/convax-notices/', import.meta.url))
const ARTIFACTS = fileURLToPath(new URL('../../../../../.artifacts/', import.meta.url))
const FEATURE_TITLE = 'Connect resources to a conversation'
const MAINTENANCE_TITLE = 'Cloud chat maintenance'
const BANNER_TITLE = 'Community update'

interface ServedNoticeRequest {
  readonly path: string
  readonly status: number
  readonly installationId: string | undefined
  readonly appVersion: string | null
}

interface NoticeFixture {
  readonly scaffold: WebScaffold
  readonly browser: Browser
  readonly served: ServedNoticeRequest[]
  readonly historyPath: string
  observe(page: Page): void
  outage(): void
}

async function fixture(required: boolean): Promise<NoticeFixture> {
  const scratch = await mkdtemp(join(tmpdir(), 'convax-notices-e2e-'))
  const owned: { server?: Server; scaffold?: WebScaffold; browser?: Browser; pages: Page[] } = { pages: [] }
  const consoleErrors: ReturnType<typeof watchConsole>[] = []
  onTestFinished(async ({ task }) => {
    try {
      if (task.result?.state === 'fail') {
        for (const page of owned.pages) if (!page.isClosed()) await saveFailureShot(page, 'convax-notices')
      }
      for (const errors of consoleErrors) expect(errors.pageErrors).toEqual([])
    } finally {
      try { await owned.browser?.close() } finally {
        try { await owned.scaffold?.close() } finally {
          try {
            if (owned.server?.listening) await new Promise<void>((resolve, reject) => {
              owned.server!.close((error) => { if (error) reject(error); else resolve() })
              owned.server!.closeAllConnections()
            })
          } finally { await rm(scratch, { recursive: true, force: true }) }
        }
      }
    }
  })
  const served: ServedNoticeRequest[] = []
  let unavailable = false
  const now = Date.now()
  const common = { schemaVersion: 1, revision: 'notice-fixture-1', serverTime: new Date(now).toISOString(), nextCheckAfterSeconds: 30 }
  const feature = {
    id: 'resource-link-intro', revision: '1', kind: 'feature', surface: 'modal',
    startsAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 86_400_000).toISOString(),
    requiresCapabilities: ['convax.canvas'],
    frequency: { scope: 'installation', maxImpressions: 1, cooldownSeconds: 86_400 },
    content: { title: FEATURE_TITLE, body: 'Connect a resource card to give the conversation the context it needs.' },
    actions: [{ id: 'dismiss', label: 'Got it', type: 'dismiss' }],
  }
  const banner = { ...feature, id: 'community-update', kind: 'announcement', surface: 'banner',
    content: { title: BANNER_TITLE, body: 'Release notes remain available while you work.' },
    actions: [{ id: 'dismiss', label: 'Dismiss announcement', type: 'dismiss' }] }
  const policy = {
    ...common,
    update: required ? { required: true, minSupportedVersion: '0.2.0', targetVersion: '0.2.1',
      releaseId: 'convax-mac-arm64-latest-0.2.1', reasonCode: 'support_ended', fallbackPage: 'https://example.test/download' }
      : { required: false },
    maintenance: required ? [] : [{ id: 'cloud-chat', revision: '1', status: 'active',
      startsAt: new Date(now - 60_000).toISOString(), estimatedEndsAt: null,
      affectedCapabilities: ['convax.canvas'], title: MAINTENANCE_TITLE, body: 'Cloud chat is temporarily unavailable. Local work can continue.' }],
  }
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const known = url.pathname === '/api/v1/client/policy' || url.pathname === '/api/v1/client/guidance'
    // A guidance failure keeps the supported retry interval short while the independent policy read succeeds.
    const status = request.method !== 'GET' || !known ? 404
      : unavailable || (required && url.pathname.endsWith('/guidance')) ? 503 : 200
    const header = request.headers['x-installation-id']
    response.once('finish', () => { served.push({ path: url.pathname, status,
      installationId: typeof header === 'string' ? header : undefined, appVersion: url.searchParams.get('appVersion') }) })
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify(status !== 200 ? { error: { code: status === 404 ? 'not_found' : 'service_unavailable', message: 'Fixture unavailable' } }
      : url.pathname.endsWith('/policy') ? policy : { ...common, items: [feature, banner] }))
  })
  owned.server = server
  const listening = once(server, 'listening')
  server.listen(0, '127.0.0.1')
  await listening
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Notice fixture has no TCP listener')
  const overlay = join(scratch, 'cordis.patch.yml')
  await writeFile(overlay, [
    '- id: convax-host', '  config:', "    databasePath: !!js dshHomePath('storages', 'convax-canvas.sqlite')", '    notices:',
    `      origin: "http://127.0.0.1:${address.port}"`, '      appVersion: "0.1.0"', '      platform: darwin', '      arch: arm64',
    '      channel: latest', '      locale: en', `      allowedPageOrigins: ${required ? '["https://example.test"]' : '[]'}`,
    '      timeoutMs: 1000', '      idleMs: 0', '      pollIntervalMs: 1000', '      leaseMs: 6000',
    '      failureRetryMs: 1000', '      messageHoldMs: 3000', '      modalCooldownMs: 86400000', '      maxModalPerLaunch: 1', '',
  ].join('\n'))
  const scaffold = await launchWebScaffold({ extraOverlayPath: overlay,
    profile: { hmr: false, packages: [
      { dir: join(BUNDLE, '../plugin-host') }, { dir: join(BUNDLE, '../plugin-inernal-nodes-host') },
      { dir: join(BUNDLE, '../plugin-inernal-nodes-renderer') }, { dir: BUNDLE, enabled: true },
    ] } })
  owned.scaffold = scaffold
  const browser = await chromium.launch()
  owned.browser = browser
  return { scaffold, browser, served, historyPath: join(scaffold.harnessHome, 'storages', 'convax-notices.json'),
    observe: (page) => { owned.pages.push(page); consoleErrors.push(watchConsole(page)) },
    outage: () => { unavailable = true } }
}

function nextNoticePoll(page: Page): Promise<BrowserResponse> {
  return page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/convaxNotices/poll'), { timeout: 15_000 })
}

async function openPage(value: NoticeFixture): Promise<{ page: Page; poll: BrowserResponse }> {
  const page = await newEnglishPage(value.browser)
  value.observe(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const polling = nextNoticePoll(page)
  await page.goto(value.scaffold.authenticatedUrl)
  await page.locator('[data-convax-workspace]').waitFor({ timeout: 30_000 })
  return { page, poll: await polling }
}

async function history(value: NoticeFixture) {
  return JSON.parse(await readFile(value.historyPath, 'utf8')) as {
    installationId: string
    records: Record<string, { impressions: number; dismissed: boolean }>
  }
}

it('shows maintenance as a transient message, then persists ordinary choices across windows and workspace navigation', async () => {
  const value = await fixture(false)
  const { page } = await openPage(value)
  const maintenance = page.getByRole('alert').filter({ hasText: MAINTENANCE_TITLE })
  await maintenance.waitFor()
  expect(await page.getByRole('status', { name: MAINTENANCE_TITLE, exact: true }).count()).toBe(0)
  await mkdir(EXPECTED, { recursive: true })
  await compareOrRefreshGolden(join(EXPECTED, 'maintenance-message.expected.md'),
    await captureStableAria(page, '[role="alert"]', value.scaffold.workspaceCwd), webSnapshotMode())
  await maintenance.waitFor({ state: 'detached', timeout: 10_000 })
  const feature = page.getByRole('dialog', { name: FEATURE_TITLE, exact: true })
  await feature.waitFor({ timeout: 10_000 })
  await page.setViewportSize({ width: 390, height: 844 })
  const bounds = await feature.boundingBox()
  if (bounds === null) throw new Error('Feature notice has no visible bounds')
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(844)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(() => page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme'))).toBe(true)
  expect(await feature.isVisible()).toBe(true)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.emulateMedia({ colorScheme: 'light' })
  await expect.poll(() => page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme'))).toBe(false)
  await compareOrRefreshGolden(join(EXPECTED, 'feature-modal.expected.md'),
    await captureStableAria(page, `[role="dialog"][aria-label="${FEATURE_TITLE}"]`, value.scaffold.workspaceCwd), webSnapshotMode())
  await page.setViewportSize({ width: 1280, height: 900 })
  await mkdir(ARTIFACTS, { recursive: true })
  await page.screenshot({ path: join(ARTIFACTS, 'convax-notices.png') })

  const other = await openPage(value)
  const denied = await other.poll.json() as { result: { ok: boolean; value: unknown } }
  expect(denied.result).toEqual({ ok: true, value: null })
  expect(await other.page.locator('[data-convax-notice]').count()).toBe(0)
  await page.bringToFront()
  await feature.getByRole('button', { name: 'Got it', exact: true }).click()
  await expect.poll(async () => (await history(value)).records['guidance:resource-link-intro'])
    .toMatchObject({ impressions: 1, dismissed: true })
  const banner = page.getByRole('status', { name: BANNER_TITLE, exact: true })
  await banner.waitFor({ timeout: 10_000 })
  await banner.getByRole('button', { name: 'Dismiss announcement', exact: true }).click()
  await expect.poll(async () => (await history(value)).records['guidance:community-update'])
    .toMatchObject({ impressions: 1, dismissed: true })
  await page.getByRole('button', { name: 'Workspace actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'All canvases', exact: true }).click()
  await page.getByRole('dialog', { name: 'All canvases', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Close canvas manager', exact: true }).click()
  const reloadedPoll = nextNoticePoll(page)
  await page.reload()
  await page.locator('[data-convax-workspace]').waitFor({ timeout: 30_000 })
  expect((await (await reloadedPoll).json() as { result: { value: unknown } }).result.value).toBeNull()
  const otherPoll = nextNoticePoll(other.page)
  await other.page.bringToFront()
  expect((await (await otherPoll).json() as { result: { value: unknown } }).result.value).toBeNull()
  expect(await other.page.locator('[data-convax-notice]').count()).toBe(0)
  const persisted = await history(value)
  expect(persisted.records['maintenance:cloud-chat:active']).toMatchObject({ impressions: 1, dismissed: true })
  expect(value.served.filter(request => request.status === 200).every(request => request.installationId === persisted.installationId
    && request.appVersion === '0.1.0')).toBe(true)
})

it('retains a required update after real HTTP failures and rejects ordinary dismissal', async () => {
  const value = await fixture(true)
  const { page } = await openPage(value)
  const required = page.getByRole('dialog', { name: 'Update required', exact: true })
  await required.waitFor({ timeout: 10_000 })
  await mkdir(EXPECTED, { recursive: true })
  await compareOrRefreshGolden(join(EXPECTED, 'mandatory-update.expected.md'),
    await captureStableAria(page, '[role="dialog"][aria-label="Update required"]', value.scaffold.workspaceCwd), webSnapshotMode())
  expect(await required.getByRole('button', { name: 'Close', exact: true }).count()).toBe(0)
  await page.keyboard.press('Escape')
  await page.mouse.click(5, 100)
  expect(await required.isVisible()).toBe(true)
  value.outage()
  await expect.poll(() => value.served.filter(request => request.path.endsWith('/policy') && request.status === 503).length,
    { timeout: 10_000 }).toBeGreaterThan(0)
  expect(await required.isVisible()).toBe(true)
  await required.getByRole('button', { name: 'Open updater', exact: true }).click()
  await required.getByRole('alert').filter({ hasText: 'Updates are unavailable in this build. Use the official download page.' }).waitFor()
  expect(await required.getByRole('button', { name: 'Open download page', exact: true }).isEnabled()).toBe(true)
  expect(await required.isVisible()).toBe(true)
})
