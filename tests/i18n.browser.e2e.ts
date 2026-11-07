/** Real Web settings and Convax cards share one reactive, Host-persisted language preference. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-convax-plugin-host'
import type { CanvasCommand, CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { acknowledgeReloadConnectionLoss, launchWebScaffold, watchConsole, type WebScaffold } from '../libs/dsh/apps/web/tests/scaffold.ts'
import { newEnglishPage } from '../libs/dsh/apps/web/tests/support.ts'
import { dictionaries, en, zh } from '../packages/plugin-renderer/src/client/locales.ts'

const RENDERER = fileURLToPath(new URL('../packages/plugin-renderer/', import.meta.url))
const COUNTER = join(RENDERER, 'examples', 'counter')
const PICKER = fileURLToPath(new URL('../libs/dsh/apps/web/tests/pin-browse-picker.overlay.yml', import.meta.url))
const LANGUAGE_NAMES = { en: 'English', zh: '中文', ja: '日本語', es: 'Español', fr: 'Français', de: 'Deutsch', ru: 'Русский', pt: 'Português' }
const USER_TITLE = 'User named board / 用户命名'
type Language = keyof typeof LANGUAGE_NAMES
type Copy = Pick<typeof en, 'workspace.actions' | 'workspace.settings' | 'workspace.addResources' | 'workspace.addProject' | 'workspace.addFile'>

async function resourceActions(page: Page, copy: Copy): Promise<void> {
  await page.locator('[data-convax-creation-dock]:visible')
    .getByRole('button', { name: copy['workspace.addResources'], exact: true }).click()
  const menu = page.getByRole('menu')
  await menu.getByRole('menuitem', { name: copy['workspace.addProject'], exact: true }).waitFor()
  await menu.getByRole('menuitem', { name: copy['workspace.addFile'], exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'detached' })
}

async function settingsLanguage(page: Page, current: Language, next: Language, copy: Copy): Promise<void> {
  await page.getByRole('button', { name: copy['workspace.actions'], exact: true }).click()
  await page.getByRole('menuitem', { name: copy['workspace.settings'], exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: LANGUAGE_NAMES[current], exact: true }).click()
  await page.getByRole('menuitem', { name: LANGUAGE_NAMES[next], exact: true }).click()
  await expect.poll(() => page.locator('html').getAttribute('lang'), { timeout: 10_000 }).toBe(next === 'zh' ? 'zh-CN' : next)
  await page.keyboard.press('Escape')
}

async function execute(scaffold: WebScaffold, canvasId: CanvasId, command: CanvasCommand): Promise<void> {
  const canvas = scaffold.ctx.convax.workspace().canvases.find(item => item.id === canvasId)
  const result = await scaffold.ctx.convax.execute({ canvasId, expectedRevision: canvas?.revision ?? 0,
    operationId: randomUUID() as CanvasOperationId, command })
  if (!result.ok) throw new Error(`Internationalization fixture ${command.kind}: ${result.code}: ${result.message}`)
}

async function openCanvas(page: Page, canvasId: CanvasId): Promise<void> {
  await page.getByRole('button', { name: en['workspace.actions'], exact: true }).click()
  await page.getByRole('menuitem', { name: en['canvas.all'], exact: true }).click()
  await page.locator(`[data-canvas-manager-row="${canvasId}"] button`).first().click()
}

describe('Convax internationalization in the shipped Web composition', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const canvasId = randomUUID() as CanvasId
  const nodeId = randomUUID() as CanvasNodeId

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      extraOverlayPath: [join(RENDERER, 'cordis.patch.yml'), join(COUNTER, 'cordis.patch.yml'), PICKER],
      extraInstallAnchors: [join(RENDERER, 'package.json'), join(COUNTER, 'package.json')],
    })
    expect((await scaffold.ctx.convax.execute({ canvasId, expectedRevision: 0,
      operationId: randomUUID() as CanvasOperationId, command: { kind: 'create', title: USER_TITLE },
    })).ok).toBe(true)
    expect((await scaffold.ctx.convax.execute({ canvasId, expectedRevision: 1,
      operationId: randomUUID() as CanvasOperationId, command: { kind: 'add-node', node: {
        id: nodeId, typeId: 'example.convax.counter' as CanvasNodeTypeId, dataVersion: 1,
        data: { value: 12 }, position: { x: 300, y: 200 }, revision: 0,
      } },
    })).ok).toBe(true)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto(scaffold.authenticatedUrl)
    await page.locator('[data-convax-workspace]').waitFor({ timeout: 30_000 })
    await page.getByRole('button', { name: en['workspace.actions'], exact: true }).click()
    await page.getByRole('menuitem', { name: 'All canvases', exact: true }).click()
    await page.locator(`[data-canvas-manager-row="${canvasId}"] button`).first().click()
    await page.locator(`[data-convax-counter="${nodeId}"]`).waitFor({ timeout: 30_000 })
  })

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('updates the canvas and an installed third-party card without remounting or changing saved content', async () => {
    const card = page.locator(`[data-convax-counter="${nodeId}"]`)
    await card.getByRole('button', { name: 'Increase', exact: true }).waitFor()
    await card.evaluate((element) => { element.setAttribute('data-i18n-mount', 'retained') })
    const before = scaffold.ctx.convax.workspace().canvases.find(canvas => canvas.id === canvasId)
    await settingsLanguage(page, 'en', 'zh', en)
    await resourceActions(page, zh)
    await card.getByRole('button', { name: '增加', exact: true }).waitFor()
    expect(await card.getAttribute('data-i18n-mount')).toBe('retained')
    expect(scaffold.ctx.convax.workspace().canvases.find(canvas => canvas.id === canvasId)).toEqual(before)
    await expect.poll(() => readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8'))
      .toContain('preference: zh')
    const warnings = tripwire.warnings.length
    await page.reload()
    acknowledgeReloadConnectionLoss(tripwire, warnings)
    await page.locator('[data-convax-creation-dock]:visible')
      .getByRole('button', { name: zh['workspace.addResources'], exact: true }).waitFor({ timeout: 30_000 })
    await resourceActions(page, zh)
    await card.getByRole('button', { name: '增加', exact: true }).waitFor()
    expect(await page.locator('html').getAttribute('lang')).toBe('zh-CN')
    expect(await page.evaluate(() => localStorage.getItem('dsh.locale'))).toBeNull()
    await settingsLanguage(page, 'zh', 'en', zh)
    await card.getByRole('button', { name: 'Increase', exact: true }).waitFor()
    expect(tripwire.pageErrors).toEqual([])
  })

  it('renders every shipped Convax language through the shared DSH language selector', async () => {
    let current: Language = 'en'
    for (const next of ['ja', 'es', 'fr', 'de', 'ru', 'pt', 'zh', 'en'] as const) {
      await settingsLanguage(page, current, next, dictionaries[current])
      const copy = dictionaries[next]
      await resourceActions(page, copy)
      await page.getByRole('button', { name: copy['workspace.actions'], exact: true }).waitFor()
      expect(scaffold.ctx.convax.workspace().canvases.find(canvas => canvas.id === canvasId)?.title).toBe(USER_TITLE)
      await expect.poll(() => readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8'))
        .toContain(`preference: ${next}`)
      current = next
    }
    expect(tripwire.pageErrors).toEqual([])
  })
  it('localizes newly generated canvas names while preserving an identical user-authored title', async () => {
    const existing = new Set(scaffold.ctx.convax.workspace().canvases.map(canvas => canvas.id))
    await page.getByRole('button', { name: en['canvas.new'], exact: true }).click()
    await expect.poll(() => scaffold.ctx.convax.workspace().canvases.filter(canvas => !existing.has(canvas.id)).length).toBe(1)
    const created = scaffold.ctx.convax.workspace().canvases.find(canvas => !existing.has(canvas.id))!
    const tab = page.locator(`[data-canvas-tab="${created.id}"]`).getByRole('tab')
    await expect.poll(() => tab.textContent()).toBe(en['canvas.untitled'])
    expect(created.titleFormat).toEqual({ kind: 'default' })
    await settingsLanguage(page, 'en', 'zh', en)
    await expect.poll(() => tab.textContent()).toBe(zh['canvas.untitled'])
    await tab.dblclick()
    const dialog = page.getByRole('dialog', { name: zh['canvas.rename'], exact: true })
    await dialog.getByRole('textbox', { name: zh['canvas.name'], exact: true }).fill('Untitled canvas')
    await dialog.getByRole('button', { name: zh['canvas.save'], exact: true }).click()
    await expect.poll(() => tab.textContent()).toBe('Untitled canvas')
    await settingsLanguage(page, 'zh', 'en', zh)
    await settingsLanguage(page, 'en', 'zh', en)
    await expect.poll(() => tab.textContent()).toBe('Untitled canvas')
    expect(scaffold.ctx.convax.workspace().canvases.find(canvas => canvas.id === created.id)?.title).toBe('Untitled canvas')
    await settingsLanguage(page, 'zh', 'en', zh)
    await openCanvas(page, canvasId)
    expect(tripwire.pageErrors).toEqual([])
  })

  it('localizes a Host migration failure while retaining the original diagnostic in collapsed details', async () => {
    const host = scaffold.ctx.convax
    const typeId = 'fixture.i18n-diagnostic' as CanvasNodeTypeId
    const diagnosticNode = randomUUID() as CanvasNodeId
    const remove = host.registerNodeType({ id: typeId, dataVersion: 1, ports: [], parse: data => data })
    onTestFinished(remove)
    await execute(scaffold, canvasId, { kind: 'add-node', node: { id: diagnosticNode, typeId,
      dataVersion: 1, data: { label: 'Literal provider content' }, position: { x: 650, y: 200 }, revision: 0,
    } })
    await remove()
    const original = 'Fixture migration failure: literal provider diagnostic'
    const removeReplacement = host.registerNodeType({ id: typeId, dataVersion: 2, ports: [], parse: data => data,
      migrations: [{ fromVersion: 1, migrate() { throw new Error(original) } }],
    })
    onTestFinished(removeReplacement)
    await host.retryMigrations()
    await expect.poll(() => host.workspace().nodeIssues.find(issue => issue.nodeId === diagnosticNode)?.kind).toBe('incompatible')
    const diagnostic = host.workspace().nodeIssues.find(issue => issue.nodeId === diagnosticNode)!.message
    expect(diagnostic).toContain(original)
    const placeholder = page.locator('[data-convax-placeholder="incompatible"]').filter({ hasText: typeId })
    await placeholder.getByRole('status').getByText(en['node.incompatible'], { exact: true }).waitFor()
    const details = placeholder.locator('[data-convax-diagnostic]')
    expect(await details.getAttribute('open')).toBeNull()
    await details.getByText(en['diagnostic.details'], { exact: true }).click()
    await expect.poll(() => details.locator('pre').textContent()).toBe(diagnostic)
    await settingsLanguage(page, 'en', 'zh', en)
    await placeholder.getByRole('status').getByText(zh['node.incompatible'], { exact: true }).waitFor()
    await details.getByText(zh['diagnostic.details'], { exact: true }).waitFor()
    expect(await details.locator('pre').textContent()).toBe(diagnostic)
    expect(host.workspace().canvases.find(canvas => canvas.id === canvasId)?.nodes
      .find(node => node.id === diagnosticNode)?.data).toEqual({ label: 'Literal provider content' })
    await settingsLanguage(page, 'zh', 'en', zh)
    expect(tripwire.pageErrors).toEqual([])
  })

  it('formats real pending-activity timestamps with the current language without calling a model', async () => {
    const chatNode = randomUUID() as CanvasNodeId
    await execute(scaffold, canvasId, { kind: 'add-node', node: {
      id: chatNode, typeId: 'convax.chat' as CanvasNodeTypeId, dataVersion: 1,
      data: { title: 'Literal question thread', cwd: scaffold.workspaceCwd }, position: { x: 1200, y: 200 }, revision: 0,
    } })
    const revision = scaffold.ctx.convax.workspace().canvases.find(canvas => canvas.id === canvasId)!.revision
    const thread = await scaffold.ctx.convax.createThread({ canvasId, nodeId: chatNode, expectedRevision: revision,
      operationId: randomUUID() as CanvasOperationId, kind: 'create', cwd: scaffold.workspaceCwd, agentPreset: 'standard' })
    if (!thread.ok) throw new Error(`Activity thread fixture: ${thread.code}: ${thread.message}`)
    const handle = await scaffold.ctx.agents.resume({ resumeSessionId: thread.sessionId,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      setup: ctx => scaffold.ctx.agentPresets.mount(ctx, 'standard').then(() => undefined),
    })
    const controller = new AbortController()
    const outcome = scaffold.ctx.userQuestions.ask({ agent: handle.agent, signal: controller.signal, questions: [{
      id: 'internationalization-question', question: 'Literal question for timestamp verification?',
      options: [{ label: 'Continue' }, { label: 'Stop' }],
    }] }).then(value => ({ value }), (error: unknown) => ({ error }))
    onTestFinished(async () => {
      controller.abort()
      await outcome
      handle.agent.cancel({ kind: 'user' })
      await handle.dispose()
    })
    const timestamp = async (language: Language): Promise<{ title: string; iso: string }> => {
      const copy = dictionaries[language]
      const unreadLabel = copy['activity.unreadLabel'].replace('{count}', '1')
      await page.getByRole('button', { name: unreadLabel, exact: true }).click()
      const time = page.getByRole('dialog', { name: copy['activity.title'], exact: true })
        .locator(`[data-convax-activity-session="${thread.sessionId}"] [data-convax-activity-time]`)
      await time.waitFor()
      const iso = await time.getAttribute('datetime')
      const title = await time.getAttribute('title')
      expect(iso).not.toBeNull()
      expect(title).not.toBeNull()
      const expected = await page.evaluate(value => new Intl.DateTimeFormat(document.documentElement.lang,
        { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)), iso!)
      expect(title).toBe(expected)
      await page.keyboard.press('Escape')
      return { title: title!, iso: iso! }
    }
    const english = await timestamp('en')
    await settingsLanguage(page, 'en', 'zh', en)
    const chinese = await timestamp('zh')
    expect(chinese.iso).toBe(english.iso)
    expect(chinese.title).not.toBe(english.title)
    await settingsLanguage(page, 'zh', 'en', zh)
    expect(tripwire.pageErrors).toEqual([])
  })

})
