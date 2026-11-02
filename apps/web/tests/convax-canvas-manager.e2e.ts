/** Canvas organization through the real Host, isolated persistence, and shipped browser controls. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-convax-plugin-host'
import type {
  CanvasCommand, CanvasConnectionId, CanvasDocument, CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId,
} from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, readPersistedEvents, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

const BUNDLE = fileURLToPath(new URL('../../../packages/convax/plugin-renderer/', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/convax-canvas-manager/', import.meta.url))
const ARTIFACTS = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))
const MANAGER = '[role="dialog"][aria-label="All canvases"]'

function canvas(scaffold: WebScaffold, id: CanvasId): CanvasDocument {
  const document = scaffold.ctx.convax.workspace().canvases.find(item => item.id === id)
  if (document === undefined) throw new Error(`Manager fixture canvas ${id} is missing`)
  return document
}

async function execute(scaffold: WebScaffold, canvasId: CanvasId, command: CanvasCommand): Promise<void> {
  const revision = scaffold.ctx.convax.workspace().canvases.find(item => item.id === canvasId)?.revision ?? 0
  const result = await scaffold.ctx.convax.execute({
    canvasId, expectedRevision: revision, operationId: randomUUID() as CanvasOperationId, command,
  })
  if (!result.ok) throw new Error(`Manager fixture command ${command.kind} failed: ${result.code}: ${result.message}`)
}

async function seedCanvas(scaffold: WebScaffold, title: string) {
  const canvasId = randomUUID() as CanvasId
  await execute(scaffold, canvasId, { kind: 'create', title })
  return canvasId
}

async function seedConversation(scaffold: WebScaffold) {
  const canvasId = await seedCanvas(scaffold, 'Independent copy')
  const directory = join(scaffold.workspaceCwd, 'manager-project')
  await mkdir(directory)
  const path = join(directory, 'notes.txt')
  await writeFile(path, 'The source file stays on disk.\n')
  const fileId = randomUUID() as CanvasNodeId
  const folderId = randomUUID() as CanvasNodeId
  const chatId = randomUUID() as CanvasNodeId
  await execute(scaffold, canvasId, { kind: 'add-subgraph', nodes: [
    { id: folderId, typeId: 'convax.folder' as CanvasNodeTypeId, dataVersion: 1,
      data: { path: directory }, position: { x: 60, y: 80 }, revision: 0 },
    { id: fileId, typeId: 'convax.file' as CanvasNodeTypeId, dataVersion: 1,
      data: { path }, position: { x: 60, y: 300 }, revision: 0 },
    { id: chatId, typeId: 'convax.chat' as CanvasNodeTypeId, dataVersion: 1,
      data: { title: 'Source conversation', cwd: directory }, position: { x: 520, y: 80 }, revision: 0 },
  ], connections: [
    { id: randomUUID() as CanvasConnectionId, source: folderId, sourcePort: 'output',
      target: chatId, targetPort: 'input', purpose: 'input' },
    { id: randomUUID() as CanvasConnectionId, source: fileId, sourcePort: 'output',
      target: chatId, targetPort: 'input', purpose: 'input' },
  ] })
  const thread = await scaffold.ctx.convax.createThread({
    canvasId, nodeId: chatId, expectedRevision: canvas(scaffold, canvasId).revision,
    operationId: randomUUID() as CanvasOperationId, kind: 'create', cwd: directory, agentPreset: 'standard',
  })
  if (!thread.ok) throw new Error(`Manager fixture thread failed: ${thread.code}: ${thread.message}`)
  return { canvasId, chatId, path, sessionId: thread.sessionId }
}

async function appendTranscript(scaffold: WebScaffold, sessionId: SessionId, text: string): Promise<void> {
  await expect.poll(() => scaffold.ctx.agents.get(sessionId), { timeout: 15_000 }).toBeDefined()
  const agent = scaffold.ctx.agents.get(sessionId)!
  agent.session.append('turn/start', { turn: 1 })
  agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Show the saved fixture.' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  agent.session.append('step/start', { turn: 1, step: 1 })
  agent.session.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'fixture', model: 'fixture' } }),
  }, { surfaceOp: 'append' })
  agent.session.append('step/end', { turn: 1, step: 1 })
  agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await scaffold.ctx.sessions.flush(agent.session)
}

async function newPage(browser: Browser, scaffold: WebScaffold): Promise<Page> {
  const page = await newEnglishPage(browser)
  const tripwire = watchConsole(page)
  onTestFinished(async ({ task }) => {
    try {
      if (task.result?.state === 'fail') await saveFailureShot(page, 'web-e2e-convax-canvas-manager')
      expect(tripwire.pageErrors).toEqual([])
    } finally { await page.close() }
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(scaffold.authenticatedUrl)
  await page.locator('[data-convax-workspace]').waitFor({ timeout: 30_000 })
  return page
}

async function openManager(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Workspace actions', exact: true }).click({ timeout: 10_000 })
  await page.getByRole('menuitem', { name: 'All canvases', exact: true }).click({ timeout: 10_000 })
  const manager = page.getByRole('dialog', { name: 'All canvases', exact: true })
  await manager.waitFor()
  return manager
}

function row(manager: Locator, id: CanvasId): Locator {
  return manager.locator(`[data-canvas-manager-row="${id}"]`)
}

async function rowAction(page: Page, manager: Locator, id: CanvasId, name: string): Promise<void> {
  await row(manager, id).getByRole('button', { name: /Actions for /i }).click()
  await page.getByRole('menuitem', { name, exact: true }).click()
}

async function openCanvas(page: Page, id: CanvasId, title: string): Promise<void> {
  const manager = await openManager(page)
  await row(manager, id).getByRole('button', { name: title, exact: true }).click()
  await manager.waitFor({ state: 'detached' })
  await page.locator('[data-convax-graph]').waitFor()
}

async function expectViewportPlacement(manager: Locator): Promise<void> {
  await expect.poll(() => manager.evaluate((element) => {
    const box = element.getBoundingClientRect()
    return {
      bodyMounted: element.parentElement === document.body,
      fixed: getComputedStyle(element).position === 'fixed',
      bounded: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
      usable: element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)),
    }
  })).toEqual({ bodyMounted: true, fixed: true, bounded: true, usable: true })
}

describe('web e2e: Convax canvas manager', () => {
  let scaffold: WebScaffold
  let browser: Browser

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      extraOverlayPath: join(BUNDLE, 'cordis.patch.yml'), extraInstallAnchors: [join(BUNDLE, 'package.json')],
    })
    browser = await chromium.launch()
  })
  afterAll(async () => { try { await browser?.close() } finally { await scaffold?.close() } })

  it('searches, archives and restores a canvas across reload while keeping the manager usable at viewport edges', async () => {
    const canvasId = await seedCanvas(scaffold, 'Lifecycle canvas')
    await seedCanvas(scaffold, 'Search destination')
    const page = await newPage(browser, scaffold)
    await page.setViewportSize({ width: 1024, height: 720 })
    const workspaceActions = page.getByRole('button', { name: 'Workspace actions', exact: true })
    expect(await page.getByRole('button', { name: 'Open canvas', exact: true }).count()).toBe(0)
    await workspaceActions.click()
    const menu = page.getByRole('menu')
    await menu.waitFor()
    expect(await menu.getByRole('menuitem').allTextContents()).toEqual(['All canvases', 'Settings', 'Plugins'])
    expect(await menu.getByRole('separator').count()).toBe(1)
    await mkdir(ARTIFACTS, { recursive: true })
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await expect.poll(() => page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme')))
        .toBe(colorScheme === 'dark')
      await page.screenshot({ path: join(ARTIFACTS, `convax-workspace-actions-${colorScheme}.png`) })
    }
    await page.emulateMedia({ colorScheme: 'light' })
    await mkdir(EXPECTED, { recursive: true })
    await compareOrRefreshGolden(join(EXPECTED, 'workspace-actions.expected.md'),
      await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd), webSnapshotMode())
    await menu.getByRole('menuitem', { name: 'All canvases', exact: true }).click()
    let manager = page.getByRole('dialog', { name: 'All canvases', exact: true })
    await manager.waitFor()
    expect(await menu.count()).toBe(0)
    const search = manager.getByRole('searchbox', { name: 'Search canvases', exact: true })
    await expect.poll(() => search.evaluate(element => document.activeElement === element)).toBe(true)
    await expectViewportPlacement(manager)
    await mkdir(ARTIFACTS, { recursive: true })
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await expect.poll(() => page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme')))
        .toBe(colorScheme === 'dark')
      await page.screenshot({ path: join(ARTIFACTS, `convax-canvas-manager-${colorScheme}.png`) })
    }
    await page.emulateMedia({ colorScheme: 'light' })
    await mkdir(EXPECTED, { recursive: true })
    await compareOrRefreshGolden(join(EXPECTED, 'manager.expected.md'),
      await captureStableAria(page, MANAGER, scaffold.workspaceCwd), webSnapshotMode())
    await search.fill('LiFeCyClE')
    await expect.poll(() => manager.locator('[data-canvas-manager-row]').count()).toBe(1)
    await row(manager, canvasId).waitFor()
    await search.fill('no canvas matches this query')
    await expect.poll(() => manager.locator('[data-canvas-manager-row]').count()).toBe(0)
    await compareOrRefreshGolden(join(EXPECTED, 'empty-search.expected.md'),
      await captureStableAria(page, MANAGER, scaffold.workspaceCwd), webSnapshotMode())
    await page.keyboard.press('Escape')
    await manager.waitFor({ state: 'detached' })
    await expect.poll(() => workspaceActions.evaluate(element => ({
      restored: document.activeElement === element,
      tag: document.activeElement?.tagName,
      label: document.activeElement?.getAttribute('aria-label'),
    }))).toEqual({ restored: true, tag: 'BUTTON', label: 'Workspace actions' })
    expect(await menu.count()).toBe(0)
    await page.keyboard.press('Enter')
    await menu.waitFor()
    expect(await menu.getByRole('menuitem').allTextContents()).toEqual(['All canvases', 'Settings', 'Plugins'])
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => menu.getByRole('menuitem', { name: 'All canvases', exact: true })
      .evaluate(element => document.activeElement === element)).toBe(true)
    await page.keyboard.press('Enter')
    await manager.waitFor()
    await expect.poll(() => search.evaluate(element => document.activeElement === element)).toBe(true)
    await search.fill('Keyboard search')
    await page.keyboard.press('Escape')
    await manager.waitFor({ state: 'detached' })
    await expect.poll(() => workspaceActions.evaluate(element => document.activeElement === element)).toBe(true)
    expect(await menu.count()).toBe(0)
    await openCanvas(page, canvasId, 'Lifecycle canvas')
    manager = await openManager(page)
    expect(await row(manager, canvasId).getByRole('button', { name: 'Lifecycle canvas', exact: true }).getAttribute('aria-current')).toBe('page')
    await rowAction(page, manager, canvasId, 'Archive')
    await expect.poll(() => canvas(scaffold, canvasId).archived).toBe(true)
    await expect.poll(() => page.getByRole('tab', { name: 'Lifecycle canvas', exact: true }).count()).toBe(0)
    await page.getByRole('alert').filter({ hasText: 'Canvas archived' }).getByRole('button', { name: 'Undo', exact: true }).click()
    await expect.poll(() => canvas(scaffold, canvasId).archived === true).toBe(false)
    if (await manager.count() === 0) manager = await openManager(page)
    await row(manager, canvasId).waitFor()
    await rowAction(page, manager, canvasId, 'Archive')
    await expect.poll(() => canvas(scaffold, canvasId).archived).toBe(true)
    if (await manager.count() === 0) manager = await openManager(page)
    await manager.getByRole('tab', { name: /^Archived/ }).click()
    await row(manager, canvasId).waitFor()
    await page.reload()
    await page.locator('[data-convax-workspace]').waitFor({ timeout: 30_000 })
    manager = await openManager(page)
    await manager.getByRole('tab', { name: /^Archived/ }).click()
    await row(manager, canvasId).waitFor()
    expect(canvas(scaffold, canvasId).archived).toBe(true)
    await rowAction(page, manager, canvasId, 'Unarchive')
    await expect.poll(() => canvas(scaffold, canvasId).archived === true).toBe(false)
    await manager.getByRole('tab', { name: /^Canvases/ }).click()
    await row(manager, canvasId).waitFor()
    await page.keyboard.press('Escape')
    await manager.waitFor({ state: 'detached' })
    await page.setViewportSize({ width: 390, height: 700 })
    manager = await openManager(page)
    await expectViewportPlacement(manager)
    await page.screenshot({ path: join(ARTIFACTS, 'convax-canvas-manager-narrow.png') })
    await page.mouse.click(4, 690)
    await manager.waitFor({ state: 'detached' })
    const before = scaffold.ctx.convax.workspace().canvases.length
    manager = await openManager(page)
    await manager.getByRole('button', { name: 'New canvas', exact: true }).click()
    await expect.poll(() => scaffold.ctx.convax.workspace().canvases.length).toBe(before + 1)
    await manager.waitFor({ state: 'detached' })
  })

  it('duplicates graph layout into an independent blank Chat and permanently deletes only the disposable copy', async () => {
    const fixture = await seedConversation(scaffold)
    const original = canvas(scaffold, fixture.canvasId)
    const page = await newPage(browser, scaffold)
    await openCanvas(page, fixture.canvasId, 'Independent copy')
    await appendTranscript(scaffold, fixture.sessionId, 'Original conversation stays independent.')
    const sourceEvents = await readPersistedEvents(scaffold, fixture.sessionId)
    const originalChat = page.locator(`[data-convax-chat="${fixture.chatId}"]`)
    await originalChat.getByText('Original conversation stays independent.', { exact: true }).waitFor({ timeout: 15_000 })
    const originalInput = originalChat.locator('[data-composer-input][contenteditable="true"]')
    await writeComposerDraft(page, originalInput, 'Keep this draft in the source.')
    const existing = new Set(scaffold.ctx.convax.workspace().canvases.map(item => item.id))
    let manager = await openManager(page)
    await rowAction(page, manager, fixture.canvasId, 'Duplicate canvas')
    await expect.poll(() => scaffold.ctx.convax.workspace().canvases.filter(item => !existing.has(item.id)).length).toBe(1)
    const copy = scaffold.ctx.convax.workspace().canvases.find(item => !existing.has(item.id))!
    await manager.waitFor({ state: 'detached' })
    expect(copy.id).not.toBe(original.id)
    expect(copy.nodes).toHaveLength(original.nodes.length)
    expect(copy.connections).toHaveLength(original.connections.length)
    expect(copy.archived === true).toBe(false)
    for (const source of original.nodes) {
      const cloned = copy.nodes.find(item => item.typeId === source.typeId)!
      expect(original.nodes.some(item => item.id === cloned.id)).toBe(false)
      expect(cloned.data).toEqual(source.data)
      expect(cloned.position).toEqual(source.position)
    }
    const copyChat = copy.nodes.find(item => item.typeId === 'convax.chat')!
    for (const connection of copy.connections) {
      expect(original.connections.some(item => item.id === connection.id)).toBe(false)
      expect(copy.nodes.some(item => item.id === connection.source)).toBe(true)
      expect(connection.target).toBe(copyChat.id)
    }
    await expect.poll(() => scaffold.ctx.convax.workspace().chats.find(item => item.nodeId === copyChat.id)?.threads.length,
      { timeout: 15_000 }).toBe(1)
    const copiedSession = scaffold.ctx.convax.workspace().chats.find(item => item.nodeId === copyChat.id)!.threads[0]!.sessionId
    expect(copiedSession).not.toBe(fixture.sessionId)
    const copiedChat = page.locator(`[data-convax-chat="${copyChat.id}"]`)
    const copiedInput = copiedChat.locator('[data-composer-input][contenteditable="true"]')
    await copiedInput.waitFor({ timeout: 15_000 })
    expect(await copiedInput.textContent()).toBe('')
    expect((await readPersistedEvents(scaffold, copiedSession)).some(event => event.type === 'user/message')).toBe(false)
    expect(await copiedChat.getByText('Original conversation stays independent.', { exact: true }).count()).toBe(0)
    await appendTranscript(scaffold, copiedSession, 'The deleted copy retains its Session log.')
    const copiedEvents = await readPersistedEvents(scaffold, copiedSession)
    manager = await openManager(page)
    await row(manager, copy.id).getByRole('button', { name: /Actions for /i }).click()
    const remove = page.getByRole('menuitem', { name: 'Permanently delete…', exact: true })
    await remove.waitFor()
    await mkdir(ARTIFACTS, { recursive: true })
    await page.screenshot({ path: join(ARTIFACTS, 'convax-canvas-manager-row-actions.png') })
    await remove.click()
    const confirmation = page.getByRole('dialog', { name: `Permanently delete ${copy.title}?`, exact: true })
    await confirmation.waitFor()
    await page.screenshot({ path: join(ARTIFACTS, 'convax-canvas-manager-purge.png') })
    await mkdir(EXPECTED, { recursive: true })
    await compareOrRefreshGolden(join(EXPECTED, 'purge.expected.md'),
      await captureStableAria(page, '[role="dialog"][aria-label^="Permanently delete "]', scaffold.workspaceCwd), webSnapshotMode())
    await page.keyboard.press('Escape')
    await confirmation.waitFor({ state: 'detached' })
    expect(canvas(scaffold, copy.id).nodes).toHaveLength(original.nodes.length)
    if (await manager.count() === 0) manager = await openManager(page)
    await rowAction(page, manager, copy.id, 'Permanently delete…')
    await confirmation.getByRole('button', { name: 'Permanently delete', exact: true }).click()
    await expect.poll(() => scaffold.ctx.convax.workspace().canvases.some(item => item.id === copy.id)).toBe(false)
    await confirmation.waitFor({ state: 'detached' })
    expect(scaffold.ctx.convax.workspace().chats.some(item => item.canvasId === copy.id)).toBe(false)
    expect(await readPersistedEvents(scaffold, copiedSession)).toEqual(copiedEvents)
    expect(await readPersistedEvents(scaffold, fixture.sessionId)).toEqual(sourceEvents)
    expect(await readFile(fixture.path, 'utf8')).toBe('The source file stays on disk.\n')
    expect(canvas(scaffold, fixture.canvasId)).toEqual(original)
    if (await manager.count() > 0) await page.keyboard.press('Escape')
    await openCanvas(page, fixture.canvasId, 'Independent copy')
    await originalInput.waitFor({ timeout: 15_000 })
    expect(await originalInput.textContent()).toBe('Keep this draft in the source.')
  })

  it('renames active, inactive and archived canvases without changing selection and persists trimmed titles across reload', async () => {
    const activeId = await seedCanvas(scaffold, 'Rename active')
    const inactiveId = await seedCanvas(scaffold, 'Rename inactive')
    const archivedId = await seedCanvas(scaffold, 'Rename archived')
    await execute(scaffold, archivedId, { kind: 'set-archived', archived: true })
    const page = await newPage(browser, scaffold)
    await openCanvas(page, activeId, 'Rename active')
    const activeBefore = canvas(scaffold, activeId)
    const inactiveBefore = canvas(scaffold, inactiveId)

    const openRename = async (id: CanvasId, archived = false): Promise<Locator> => {
      const manager = await openManager(page)
      if (archived) await manager.getByRole('tab', { name: /^Archived/ }).click()
      await rowAction(page, manager, id, 'Rename canvas')
      await manager.waitFor({ state: 'detached' })
      const dialog = page.getByRole('dialog', { name: 'Rename canvas', exact: true })
      await dialog.waitFor()
      return dialog
    }

    let dialog = await openRename(activeId)
    let name = dialog.getByRole('textbox', { name: 'Canvas name', exact: true })
    expect(await name.inputValue()).toBe('Rename active')
    await mkdir(ARTIFACTS, { recursive: true })
    await page.screenshot({ path: join(ARTIFACTS, 'convax-canvas-manager-rename.png') })
    await mkdir(EXPECTED, { recursive: true })
    await compareOrRefreshGolden(join(EXPECTED, 'rename.expected.md'),
      await captureStableAria(page, '[role="dialog"][aria-label="Rename canvas"]', scaffold.workspaceCwd), webSnapshotMode())
    for (const empty of ['', '   ']) {
      await name.fill(empty)
      expect(await dialog.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)
    }
    await name.fill('Discarded active title')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    expect(canvas(scaffold, activeId)).toEqual(activeBefore)
    expect(await page.getByRole('tab', { name: 'Rename active', exact: true }).getAttribute('aria-selected')).toBe('true')

    dialog = await openRename(inactiveId)
    name = dialog.getByRole('textbox', { name: 'Canvas name', exact: true })
    expect(await name.inputValue()).toBe('Rename inactive')
    await name.fill('Discarded inactive title')
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    expect(canvas(scaffold, inactiveId)).toEqual(inactiveBefore)

    for (const target of [
      { id: inactiveId, title: 'Inactive renamed', archived: false },
      { id: archivedId, title: 'Archived renamed', archived: true },
      { id: activeId, title: 'Active renamed', archived: false },
    ]) {
      const before = canvas(scaffold, target.id)
      dialog = await openRename(target.id, target.archived)
      name = dialog.getByRole('textbox', { name: 'Canvas name', exact: true })
      expect(await name.inputValue()).toBe(before.title)
      await name.fill(`  ${target.title}  `)
      await dialog.getByRole('button', { name: 'Save', exact: true }).click()
      await expect.poll(() => canvas(scaffold, target.id).title).toBe(target.title)
      await dialog.waitFor({ state: 'hidden' })
      expect(canvas(scaffold, target.id).archived === true).toBe(target.archived)
      const activeTitle = target.id === activeId ? target.title : 'Rename active'
      await expect.poll(() => page.getByRole('tab', { name: activeTitle, exact: true }).getAttribute('aria-selected')).toBe('true')
      if (target.id === activeId) expect(await page.getByRole('tab', { name: 'Rename active', exact: true }).count()).toBe(0)
      for (const unopened of ['Rename inactive', 'Inactive renamed', 'Rename archived', 'Archived renamed']) {
        expect(await page.getByRole('tab', { name: unopened, exact: true }).count()).toBe(0)
      }
    }

    await page.reload()
    await page.locator('[data-convax-workspace]').waitFor({ timeout: 30_000 })
    await expect.poll(() => page.getByRole('tab', { name: 'Active renamed', exact: true }).getAttribute('aria-selected')).toBe('true')
    const manager = await openManager(page)
    await row(manager, activeId).getByRole('button', { name: 'Active renamed', exact: true }).waitFor()
    expect(await row(manager, activeId).getByRole('button', { name: 'Active renamed', exact: true }).getAttribute('aria-current')).toBe('page')
    await row(manager, inactiveId).getByRole('button', { name: 'Inactive renamed', exact: true }).waitFor()
    expect(await row(manager, archivedId).count()).toBe(0)
    await manager.getByRole('tab', { name: /^Archived/ }).click()
    await row(manager, archivedId).getByText('Archived renamed', { exact: true }).waitFor()
    expect(canvas(scaffold, archivedId).archived).toBe(true)
    expect(await page.getByRole('tab', { name: 'Archived renamed', exact: true }).count()).toBe(0)
  })
})
