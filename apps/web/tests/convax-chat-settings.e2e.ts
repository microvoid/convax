/** Thread-owned settings reuse native Session controls inside the real, zoomed Convax canvas. */
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-convax-plugin-host'
import type {
  CanvasCommand, CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId,
} from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

const BUNDLE = fileURLToPath(new URL('../../../packages/convax/plugin-renderer/', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/convax-chat-settings/', import.meta.url))
const ARTIFACTS = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))
const SETTINGS = '[role="dialog"][aria-label="Conversation settings"]'

async function execute(scaffold: WebScaffold, canvasId: CanvasId, command: CanvasCommand): Promise<void> {
  const revision = scaffold.ctx.convax.workspace().canvases.find(canvas => canvas.id === canvasId)?.revision ?? 0
  const result = await scaffold.ctx.convax.execute({
    canvasId, expectedRevision: revision, operationId: randomUUID() as CanvasOperationId, command,
  })
  if (!result.ok) throw new Error(`Settings fixture command ${command.kind} failed: ${result.code}: ${result.message}`)
}

async function seedChat(scaffold: WebScaffold) {
  const canvasId = randomUUID() as CanvasId
  const nodeId = randomUUID() as CanvasNodeId
  await execute(scaffold, canvasId, { kind: 'create', title: 'Chat settings' })
  await execute(scaffold, canvasId, { kind: 'add-node', node: {
    id: nodeId, typeId: 'convax.chat' as CanvasNodeTypeId, dataVersion: 1,
    data: { title: 'Settings fixture', cwd: scaffold.workspaceCwd }, position: { x: 80, y: 80 }, revision: 0,
  } })
  const threads: SessionId[] = []
  for (const agentPreset of ['standard', 'ptc']) {
    const document = scaffold.ctx.convax.workspace().canvases.find(canvas => canvas.id === canvasId)!
    const result = await scaffold.ctx.convax.createThread({
      canvasId, nodeId, expectedRevision: document.revision, operationId: randomUUID() as CanvasOperationId,
      kind: 'create', cwd: scaffold.workspaceCwd, agentPreset,
    })
    if (!result.ok) throw new Error(`Settings fixture thread failed: ${result.code}: ${result.message}`)
    threads.push(result.sessionId)
  }
  return { canvasId, nodeId, first: threads[0]!, second: threads[1]! }
}

async function setZoom(page: Page, target: number): Promise<void> {
  await page.locator('[data-convax-graph]').evaluate((root, target) => {
    const viewport = root.querySelector('.react-flow__viewport')
    if (viewport === null) throw new Error('Canvas viewport is missing')
    const zoom = new DOMMatrixReadOnly(getComputedStyle(viewport).transform).a
    const bounds = root.getBoundingClientRect()
    root.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, ctrlKey: true, deltaY: -Math.log2(target / zoom) / 0.02,
      clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2,
    }))
  }, target)
  await expect.poll(() => page.locator('.react-flow__viewport').evaluate(element =>
    new DOMMatrixReadOnly(getComputedStyle(element).transform).a)).toBeCloseTo(target, 4)
}

async function panArrowTo(page: Page, arrow: Locator, point: { x: number; y: number }): Promise<void> {
  const box = await arrow.boundingBox()
  if (box === null) throw new Error('Current thread dropdown arrow is missing')
  await page.locator('[data-convax-graph]').dispatchEvent('wheel', {
    deltaX: (box.x + box.width / 2 - point.x) * 2,
    deltaY: (box.y + box.height / 2 - point.y) * 2,
    clientX: 300, clientY: 200, bubbles: true, cancelable: true,
  })
  await expect.poll(async () => {
    const moved = await arrow.boundingBox()
    return moved !== null && Math.abs(moved.x + moved.width / 2 - point.x) < 1
      && Math.abs(moved.y + moved.height / 2 - point.y) < 1
  }).toBe(true)
}

function placement(page: Page, threadId: SessionId) {
  return page.evaluate(({ selector, threadId }) => {
    const panel = document.querySelector<HTMLElement>(selector)
    const arrow = document.querySelector<HTMLElement>(`[data-thread-tab="${threadId}"] button[aria-label="Current thread actions"]`)
    if (panel === null || arrow === null) throw new Error('Settings dialog or its thread arrow is missing')
    const box = panel.getBoundingClientRect()
    const anchor = arrow.getBoundingClientRect()
    const expectedLeft = Math.min(Math.max(anchor.left, 12), innerWidth - box.width - 12)
    const expectedTop = Math.min(Math.max(anchor.bottom + 4, 12), innerHeight - box.height - 12)
    return {
      bodyMounted: panel.parentElement === document.body,
      fixed: getComputedStyle(panel).position === 'fixed',
      anchored: Math.abs(box.left - expectedLeft) <= 1 && Math.abs(box.top - expectedTop) <= 1,
      viewportBounded: box.left >= 11 && box.top >= 11 && box.right <= innerWidth - 11 && box.bottom <= innerHeight - 11,
      hitTestable: [0.25, 0.5, 0.75].every(x => [0.25, 0.5, 0.75].every(y =>
        panel.contains(document.elementFromPoint(box.left + box.width * x, box.top + box.height * y)))),
    }
  }, { selector: SETTINGS, threadId })
}

async function openSettings(page: Page, arrow: Locator): Promise<Locator> {
  await arrow.click()
  const menu = page.getByRole('menu')
  await menu.waitFor()
  const settings = menu.getByRole('menuitem', { name: 'Conversation settings', exact: true })
  await settings.waitFor({ timeout: 10_000 })
  await settings.click()
  const dialog = page.getByRole('dialog', { name: 'Conversation settings', exact: true })
  await dialog.waitFor()
  await expect.poll(() => page.getByRole('menu').count()).toBe(0)
  return dialog
}

describe('web e2e: Convax Chat settings', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let fixture: Awaited<ReturnType<typeof seedChat>>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      extraOverlayPath: join(BUNDLE, 'cordis.patch.yml'), extraInstallAnchors: [join(BUNDLE, 'package.json')],
    })
    fixture = await seedChat(scaffold)
    browser = await chromium.launch()
  })
  afterAll(async () => { try { await browser?.close() } finally { await scaffold?.close() } })

  it('anchors settings to the active thread at canvas zoom and viewport edges while keeping native menus and focus usable', async () => {
    const page = await newEnglishPage(browser)
    const console = watchConsole(page)
    const consoleErrors: string[] = []
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    const producer = Promise.withResolvers<JobOutcome>()
    let jobId: JobId | undefined
    let detachController: (() => void) | undefined
    try {
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.goto(scaffold.authenticatedUrl)
      await page.locator('[data-convax-workspace]').waitFor({ timeout: 30_000 })
      await page.getByRole('button', { name: 'Workspace actions', exact: true }).click()
      await page.getByRole('menuitem', { name: 'All canvases', exact: true }).click()
      await page.locator('[data-canvas-manager-row="' + fixture.canvasId + '"] button').first().click()
      await page.locator('[data-canvas-gestures-ready]').waitFor()
      await page.getByRole('combobox', { name: 'Canvas input mode', exact: true }).selectOption('touchpad')
      const chat = page.locator(`[data-convax-chat="${fixture.nodeId}"]`)
      const tab = (id: SessionId) => chat.locator(`[data-thread-tab="${id}"]`)
      const arrow = (id: SessionId) => tab(id).getByRole('button', { name: 'Current thread actions', exact: true })
      const input = chat.locator('[data-composer-input][contenteditable="true"]').filter({ visible: true })
      await input.waitFor({ timeout: 15_000 })
      await expect.poll(() => scaffold.ctx.agents.get(fixture.first), { timeout: 15_000 }).toBeDefined()
      detachController = scaffold.ctx.jobs.attachController('convax-settings-fixture')
      jobId = scaffold.ctx.jobs.start({
        kind: 'bash', label: 'Convax settings job', owner: fixture.first,
        run: (job) => {
          job.append('Settings popup output\n')
          return { done: producer.promise, cancel: () => { producer.resolve({ status: 'killed' }) } }
        },
      })
      await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
      const expectedPlacement = { bodyMounted: true, fixed: true, anchored: true, viewportBounded: true, hitTestable: true }

      for (const zoom of [0.5, 1, 2]) {
        await setZoom(page, zoom)
        await panArrowTo(page, arrow(fixture.first), { x: 680, y: 180 })
        const dialog = await openSettings(page, arrow(fixture.first))
        await dialog.getByRole('heading', { name: 'Conversation', exact: true }).waitFor()
        await dialog.getByRole('heading', { name: 'Tools', exact: true }).waitFor()
        expect(await dialog.getByText('Standard mode', { exact: true }).count()).toBe(1)
        await expect.poll(() => placement(page, fixture.first)).toEqual(expectedPlacement)
        expect(await page.getByRole('toolbar').getByRole('button', { name: 'Conversation actions', exact: true }).count()).toBe(0)
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'detached' })
        expect(await arrow(fixture.first).evaluate(element => element === document.activeElement)).toBe(true)
      }

      const viewport = page.viewportSize()!
      await setZoom(page, 1)
      await panArrowTo(page, arrow(fixture.first), { x: viewport.width - 60, y: viewport.height - 60 })
      const edgeDialog = await openSettings(page, arrow(fixture.first))
      await expect.poll(() => placement(page, fixture.first)).toEqual(expectedPlacement)
      await edgeDialog.getByRole('button', { name: 'Close conversation settings', exact: true }).click()
      await edgeDialog.waitFor({ state: 'detached' })
      await panArrowTo(page, arrow(fixture.first), { x: 680, y: 180 })
      await writeComposerDraft(page, input, 'Keep the first thread draft')
      const firstEditor = await input.elementHandle()

      const nativeDialog = await openSettings(page, arrow(fixture.first))
      const more = nativeDialog.getByRole('button', { name: 'More actions', exact: true })
      await more.waitFor()
      await more.click()
      const copy = page.getByRole('menuitem', { name: 'Copy Session as Markdown', exact: true })
      await copy.waitFor()
      expect(await copy.evaluate((element) => {
        const box = element.getBoundingClientRect()
        return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))
      })).toBe(true)
      await copy.focus()
      await page.keyboard.press('Escape')
      await copy.waitFor({ state: 'detached' })
      expect(await nativeDialog.isVisible()).toBe(true)
      const jobs = nativeDialog.getByRole('button', { name: '1 background job running', exact: true })
      await jobs.waitFor({ timeout: 15_000 })
      await jobs.click()
      const list = page.getByRole('list', { name: 'Background jobs', exact: true })
      await list.waitFor()
      expect(await list.evaluate(element => element.closest('[data-menu-material]')?.parentElement === document.body)).toBe(true)
      await list.getByRole('button', { name: 'Show live output of Convax settings job', exact: true }).click()
      await list.getByText('Settings popup output', { exact: true }).waitFor()
      expect(await nativeDialog.isVisible()).toBe(true)
      await list.getByRole('button', { name: 'Hide live output of Convax settings job', exact: true }).focus()
      await page.keyboard.press('Escape')
      await list.waitFor({ state: 'detached' })
      expect(await nativeDialog.isVisible()).toBe(true)
      expect(await jobs.evaluate(element => element === document.activeElement)).toBe(true)
      await mkdir(ARTIFACTS, { recursive: true })
      await page.screenshot({ path: join(ARTIFACTS, 'convax-chat-settings.png') })
      await nativeDialog.getByRole('button', { name: 'Close conversation settings', exact: true }).click()
      await nativeDialog.waitFor({ state: 'detached' })

      await tab(fixture.second).getByRole('tab').click()
      const secondDialog = await openSettings(page, arrow(fixture.second))
      await secondDialog.getByText('PTC mode', { exact: true }).waitFor()
      expect(await secondDialog.getByRole('button', { name: '1 background job running', exact: true }).count()).toBe(0)
      await mkdir(EXPECTED, { recursive: true })
      await compareOrRefreshGolden(join(EXPECTED, 'settings.expected.md'),
        await captureStableAria(page, SETTINGS, scaffold.workspaceCwd), webSnapshotMode())
      await page.screenshot({ path: join(ARTIFACTS, 'convax-chat-settings-ptc.png') })
      await page.locator('[data-convax-graph]').click({ position: { x: 40, y: 40 } })
      await secondDialog.waitFor({ state: 'detached' })
      await tab(fixture.first).getByRole('tab').click()
      await expect.poll(() => input.textContent()).toBe('Keep the first thread draft')
      expect(await input.evaluate((element, original) => element === original, firstEditor)).toBe(true)
      expect(console.pageErrors).toEqual([])
    } catch (error) {
      globalThis.console.error('Convax settings browser diagnostics', { pageErrors: console.pageErrors, consoleErrors })
      await saveFailureShot(page, 'web-e2e-convax-chat-settings')
      throw error
    } finally {
      producer.resolve({ status: 'completed' })
      try {
        if (jobId !== undefined) {
          const settled = await scaffold.ctx.jobs.wait(jobId, 15_000, fixture.first)
          if (settled.status === 'running' || settled.status === 'stopping') throw new Error('Settings fixture job did not settle')
        }
      } finally { detachController?.(); await page.close() }
    }
  })
})
