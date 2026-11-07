/** Real desktop composition keeps transparent canvas chrome and icon-only creation controls usable. */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {} from '@deepseek-ai/dsh-convax-plugin-host'
import type { CanvasCommand, CanvasId, CanvasNode, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { initialShortcutConfig } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import { isDraggableAt, type RegionRect } from '@deepseek-ai/dsh-client-web/src/window-drag/regions.ts'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const BUNDLE = fileURLToPath(new URL('../../../../../packages/plugin-renderer/', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/convax-workspace-chrome/', import.meta.url))
const ARTIFACTS = fileURLToPath(new URL('../../../../../.artifacts/', import.meta.url))

async function dragRegions(page: Page): Promise<RegionRect[]> {
  return await page.evaluate(() => Array.from(document.querySelectorAll('*')).flatMap((element) => {
    const style = getComputedStyle(element)
    const region = style.getPropertyValue('-webkit-app-region')
    if ((region !== 'drag' && region !== 'no-drag') || style.visibility === 'hidden' || style.display === 'none') return []
    const box = element.getBoundingClientRect()
    return box.width === 0 || box.height === 0 ? [] : [{ x: box.x, y: box.y, width: box.width,
      height: box.height, draggable: region === 'drag' }]
  }))
}

async function toolbarPaint(toolbar: Locator) {
  return await toolbar.evaluate((element) => {
    const style = getComputedStyle(element)
    return { radius: style.borderRadius, background: style.backgroundColor, shadow: style.boxShadow }
  })
}

async function expectVerticalTooltip(page: Page, anchor: Locator, label: string, side: 'top' | 'bottom'): Promise<void> {
  await page.mouse.move(10, 200)
  await anchor.hover()
  const tooltip = page.getByRole('tooltip', { name: label, exact: true })
  await expect.poll(() => tooltip.evaluateAll(elements => elements[0]?.getAttribute('data-side') ?? null)).toBe(side)
  await expect.poll(async () => {
    const control = await anchor.boundingBox(), bubble = await tooltip.boundingBox()
    return control !== null && bubble !== null && (side === 'top'
      ? bubble.y + bubble.height <= control.y : bubble.y >= control.y + control.height)
  }).toBe(true)
  await page.mouse.move(10, 200)
  await tooltip.waitFor({ state: 'detached' })
}

async function cameraZoom(graph: Locator): Promise<number> {
  return await graph.locator('.react-flow__viewport').evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a)
}

async function expectNewCanvasAdjacency(titlebar: Locator, dragWidth: number): Promise<void> {
  await expect.poll(async () => {
    const create = await titlebar.getByRole('button', { name: 'New canvas', exact: true }).boundingBox()
    const list = titlebar.getByRole('button', { name: 'All canvases', exact: true })
    const previous = await (await list.count() > 0 ? list : titlebar.locator('[data-canvas-tab]').last()).boundingBox()
    const drag = await titlebar.locator('[data-canvas-window-drag]').boundingBox()
    if (create === null || previous === null || drag === null) return false
    const gap = create.x - previous.x - previous.width
    return gap >= 0 && gap <= 8 && Math.abs(create.y + create.height / 2 - previous.y - previous.height / 2) <= 1
      && drag.width >= dragWidth
  }, { message: 'New canvas stays beside the final visible tab or overflow control without consuming window dragging' }).toBe(true)
}

it('reserves window dragging beside overflowing tabs and centers icon creation controls at wide and narrow widths', async () => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: join(BUNDLE, 'cordis.patch.yml'), extraInstallAnchors: [join(BUNDLE, 'package.json')],
  })
  const owned: { browser?: Browser; page?: Page } = {}
  onTestFinished(async ({ task }) => {
    try {
      if (task.result?.state === 'fail' && owned.page !== undefined) await saveFailureShot(owned.page, 'convax-workspace-chrome')
    } finally { try { await owned.browser?.close() } finally { await scaffold.close() } }
  })
  const canvases: { id: CanvasId; title: string }[] = []
  for (let index = 1; index <= 12; index++) {
    const canvasId = randomUUID() as CanvasId
    const title = `Canvas ${String(index).padStart(2, '0')}`
    expect((await scaffold.ctx.convax.execute({ canvasId, expectedRevision: 0,
      operationId: randomUUID() as CanvasOperationId, command: { kind: 'create', title },
    })).ok).toBe(true)
    canvases.push({ id: canvasId, title })
  }
  const browser = await chromium.launch()
  owned.browser = browser
  const page = await newEnglishPage(browser)
  owned.page = page
  const console = watchConsole(page)
  const path = join(scaffold.workspaceCwd, 'canvas-tool-file.txt')
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript(({ snapshot, filePath }) => {
    // Only the operating-system enumeration and preload capabilities are replaced.
    Object.assign(window, { dshDesktop: { protocolVersion: 1,
      keyboard: { subscribe: () => () => {}, closeWindow: async () => {} },
      shortcuts: { get: async () => ({ ...snapshot, status: 'ready' }),
        subscribe: () => () => {}, recording: async () => {},
        edit: async () => ({ status: 'not-ready', snapshot }) },
      windowCapture: { list: async () => [], prepare: async () => { throw new Error('No fixture window is selected') },
        validate: async () => false, release: async () => {} },
    } })
    Object.defineProperty(globalThis, '__DSH_HOST_PATHS__', { value: {
      pathFor(file: File) { return file.name === 'canvas-tool-file.txt' ? filePath : '' },
    } })
    const mark = (): void => { document.documentElement.setAttribute('data-platform', 'darwin') }
    if (document.documentElement === null) document.addEventListener('DOMContentLoaded', mark, { once: true })
    else mark()
  }, { snapshot: initialShortcutConfig(), filePath: path })
  await page.goto(scaffold.authenticatedUrl)
  const workspace = page.locator('[data-convax-workspace]')
  await workspace.waitFor({ timeout: 30_000 })
  const titlebar = page.locator('[data-workspace-titlebar="integrated"]')
  const allCanvases = page.getByRole('button', { name: 'All canvases', exact: true })
  for (const [index, canvas] of canvases.entries()) {
    await page.getByRole('button', { name: 'Workspace actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'All canvases', exact: true }).click()
    const manager = page.getByRole('dialog', { name: 'All canvases', exact: true })
    await manager.locator(`[data-canvas-manager-row="${canvas.id}"]`).getByRole('button', { name: canvas.title, exact: true }).click()
    await manager.waitFor({ state: 'detached' })
    await expect.poll(() => page.getByRole('tab', { name: canvas.title, exact: true }).getAttribute('aria-selected')).toBe('true')
    if (index < 2) {
      expect(await titlebar.getByRole('tab').count()).toBe(index + 1)
      await expectNewCanvasAdjacency(titlebar, 120)
    }
    if (index === 1) {
      const source = await titlebar.getByRole('tab', { name: 'Canvas 01', exact: true }).boundingBox()
      const target = await titlebar.getByRole('tab', { name: 'Canvas 02', exact: true }).boundingBox()
      if (source === null || target === null) throw new Error('Canvas reorder targets are unavailable')
      await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
      await page.mouse.down()
      await page.mouse.move(target.x + target.width - 4, target.y + target.height / 2, { steps: 12 })
      await page.mouse.up()
      await expect.poll(() => titlebar.getByRole('tab').allTextContents()).toEqual(['Canvas 02', 'Canvas 01'])
      await expectNewCanvasAdjacency(titlebar, 120)
    }
  }
  const active = canvases.at(-1)!
  const graph = page.locator('[data-convax-graph]:visible')
  const dock = page.locator('[data-convax-creation-dock]:visible')
  const viewToolbar = graph.locator('[data-convax-view-toolbar]')
  const globalToolbar = page.locator('[data-convax-global-toolbar]')
  const add = dock.getByRole('button', { name: 'Add folder or files', exact: true })
  const application = dock.getByRole('button', { name: 'Application window', exact: true })
  const chat = dock.getByRole('button', { name: 'New chat', exact: true })
  await expect.poll(() => dock.getByRole('button').count()).toBe(5)
  expect(await add.locator('svg.lucide-plus').count()).toBe(1)
  expect(await application.locator('svg.lucide-app-window').count()).toBe(1)
  expect(await chat.locator('svg.lucide-bot-message-square').count()).toBe(1)
  expect(await dock.innerText()).toBe('')
  await expect.poll(() => viewToolbar.getByRole('button').count()).toBe(7)
  expect(await viewToolbar.innerText()).toBe('')
  const mode = viewToolbar.getByRole('button', { name: 'Canvas input mode', exact: true })
  const resetZoom = viewToolbar.getByRole('button', { name: 'Reset zoom to 100%', exact: true })
  await mode.click()
  const modeMenu = page.getByRole('menu')
  await modeMenu.waitFor()
  expect(await modeMenu.getByRole('menuitem').allTextContents()).toEqual(['Touchpad mode', 'Mouse mode'])
  await page.getByRole('menuitem', { name: 'Mouse mode', exact: true }).click()
  await expect.poll(() => graph.getAttribute('data-canvas-drag-select')).toBeNull()
  await expectVerticalTooltip(page, mode, 'Mouse mode', 'top')
  await mode.click()
  await page.getByRole('menuitem', { name: 'Touchpad mode', exact: true }).click()
  await expect.poll(() => graph.getAttribute('data-canvas-drag-select')).toBe('true')
  await mkdir(EXPECTED, { recursive: true })
  await compareOrRefreshGolden(join(EXPECTED, 'creation-dock.expected.md'),
    await captureStableAria(page, '[data-convax-creation-dock]:visible', scaffold.workspaceCwd), webSnapshotMode())
  await compareOrRefreshGolden(join(EXPECTED, 'view-toolbar.expected.md'),
    await captureStableAria(page, '[data-convax-view-toolbar]:visible', scaffold.workspaceCwd), webSnapshotMode())
  await compareOrRefreshGolden(join(EXPECTED, 'global-toolbar.expected.md'),
    await captureStableAria(page, '[data-convax-global-toolbar]', scaffold.workspaceCwd), webSnapshotMode())

  for (const width of [1280, 736, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await expectNewCanvasAdjacency(titlebar, width <= 900 ? 96 : 120)
    await expect.poll(async () => {
      const blank = await page.locator('[data-canvas-window-drag]').boundingBox()
      return blank !== null && blank.width >= (width <= 900 ? 96 : 120)
    }).toBe(true)
    await expect.poll(async () => {
      const headerBox = await titlebar.boundingBox(), graphBox = await graph.boundingBox(), dockBox = await dock.boundingBox()
      if (headerBox === null || graphBox === null || dockBox === null) return false
      return Math.abs(headerBox.y - graphBox.y) < 1
        && Math.abs(dockBox.x + dockBox.width / 2 - graphBox.x - graphBox.width / 2) < 1
        && dockBox.x >= 0 && dockBox.x + dockBox.width <= width
    }).toBe(true)
    expect(await titlebar.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
    expect(await page.getByRole('tab', { name: active.title, exact: true }).getAttribute('aria-selected')).toBe('true')
    expect(await titlebar.getByRole('tab').count()).toBeLessThan(canvases.length)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const dockPaint = await toolbarPaint(dock)
    expect(await toolbarPaint(viewToolbar)).toEqual(dockPaint)
    expect(await toolbarPaint(globalToolbar)).toEqual(dockPaint)
    expect(await globalToolbar.innerText()).toBe('')
    for (const bar of [dock, viewToolbar, globalToolbar]) {
      const box = await bar.boundingBox()
      if (box === null) throw new Error('A canvas toolbar is unavailable')
      expect(box.height).toBeLessThan(36)
      expect(await bar.locator('button:visible').evaluateAll(buttons => buttons.every((button) => {
        const control = button.getBoundingClientRect()
        return control.width === 28 && control.height === 28
      }))).toBe(true)
      expect(await bar.locator('button:visible svg').evaluateAll(icons => icons.every((icon) => {
        const iconBox = icon.getBoundingClientRect()
        return iconBox.width === 16 && iconBox.height === 16
      }))).toBe(true)
    }
    const headerBox = await titlebar.boundingBox(), globalBox = await globalToolbar.boundingBox()
    if (headerBox === null || globalBox === null) throw new Error('Titlebar controls are unavailable')
    expect(globalBox.height).toBeLessThan(36)
    expect(globalBox.x + globalBox.width).toBe(width - 12)
    if (width > 600) {
      expect(headerBox.height).toBe(48)
      for (const control of [titlebar.getByRole('tab', { name: active.title, exact: true }),
        titlebar.getByRole('button', { name: 'New canvas', exact: true }), globalToolbar]) {
        const box = await control.boundingBox()
        if (box === null) throw new Error('A titlebar control is unavailable')
        expect(Math.abs(box.y + box.height / 2 - headerBox.y - 24)).toBeLessThanOrEqual(1)
      }
    }
    const viewBox = await viewToolbar.boundingBox(), dockBox = await dock.boundingBox()
    if (viewBox === null || dockBox === null) throw new Error('A canvas toolbar is unavailable')
    expect(viewBox.height).toBe(dockBox.height)
    expect(globalBox.height).toBe(dockBox.height)
    expect(viewBox.x).toBe(12)
    expect(dockBox.y + dockBox.height).toBe(900 - 12)
    if (width > 1100) expect(viewBox.y + viewBox.height).toBe(dockBox.y + dockBox.height)
    expect(viewBox.x + viewBox.width <= dockBox.x || viewBox.y + viewBox.height <= dockBox.y
      || dockBox.x + dockBox.width <= viewBox.x || dockBox.y + dockBox.height <= viewBox.y).toBe(true)
    const regions = await dragRegions(page)
    const blank = await page.locator('[data-canvas-window-drag]').boundingBox()
    if (blank === null) throw new Error('Window drag region is unavailable')
    expect(isDraggableAt(regions, blank.x + blank.width / 2, blank.y + blank.height / 2)).toBe(true)
    for (const control of [allCanvases, titlebar.getByRole('button', { name: 'New canvas', exact: true }),
      page.getByRole('tab', { name: active.title, exact: true }), add, application, chat,
      ...await viewToolbar.getByRole('button').all(), ...await globalToolbar.getByRole('button').all()]) {
      const box = await control.boundingBox()
      if (box === null) throw new Error('A chrome control is unavailable')
      expect(isDraggableAt(regions, box.x + box.width / 2, box.y + box.height / 2)).toBe(false)
    }
    await add.click()
    const menu = page.getByRole('menu')
    await menu.waitFor()
    expect(await menu.getByRole('menuitem').allTextContents()).toEqual(['Add folder', 'Add files'])
    const menuBox = await menu.boundingBox()
    expect(menuBox).not.toBeNull()
    if (menuBox === null) throw new Error('Creation menu is unavailable')
    expect(menuBox.x).toBeGreaterThanOrEqual(0)
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width)
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(900)
    if (width === 1280) await compareOrRefreshGolden(join(EXPECTED, 'add-resources.expected.md'),
      await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd), webSnapshotMode())
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'detached' })
    await add.click()
    await page.locator('.react-flow__pane:visible').click({ position: { x: 12, y: 180 } })
    await menu.waitFor({ state: 'detached' })
    await application.click()
    const picker = page.getByRole('dialog', { name: 'Application window', exact: true })
    await picker.waitFor()
    await picker.getByText('No matching windows. Restore the window and refresh this list.', { exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await picker.waitFor({ state: 'detached' })
  }

  await page.setViewportSize({ width: 390, height: 900 })
  await page.getByRole('button', { name: 'Workspace actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Activity', exact: true }).click()
  const activity = page.getByRole('dialog', { name: 'Activity', exact: true })
  await activity.waitFor()
  await page.setViewportSize({ width: 1280, height: 900 })
  await activity.waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'Activity', exact: true }).click()
  await activity.waitFor()
  await activity.getByRole('button', { name: 'Close activity', exact: true }).click()
  await activity.waitFor({ state: 'detached' })
  await page.setViewportSize({ width: 390, height: 900 })
  await expect.poll(() => titlebar.getByRole('tab').count()).toBe(1)
  expect(await activity.count()).toBe(0)

  await page.setViewportSize({ width: 1280, height: 900 })
  for (let index = 0; index < 10; index++) {
    const tab = titlebar.locator('[data-canvas-tab]').filter({ hasNot: page.getByRole('tab', { name: active.title, exact: true }) }).first()
    const id = await tab.getAttribute('data-canvas-tab')
    if (id === null) throw new Error('An inactive canvas tab is unavailable')
    await tab.hover()
    await tab.getByRole('button', { name: /^Close Canvas / }).click()
    await titlebar.locator(`[data-canvas-tab="${id}"]`).waitFor({ state: 'detached' })
  }
  await expect.poll(() => titlebar.getByRole('tab').count()).toBe(2)
  await page.setViewportSize({ width: 390, height: 900 })
  await allCanvases.click()
  const manager = page.getByRole('dialog', { name: 'All canvases', exact: true })
  await manager.waitFor()
  await page.setViewportSize({ width: 1280, height: 900 })
  await expect.poll(() => titlebar.getByRole('tab').count()).toBe(2)
  expect(await allCanvases.isVisible()).toBe(true)
  await expectNewCanvasAdjacency(titlebar, 120)
  await page.keyboard.press('Escape')
  await manager.waitFor({ state: 'detached' })
  await expect.poll(() => allCanvases.count()).toBe(0)
  await expect.poll(() => page.getByRole('tab', { name: active.title, exact: true })
    .evaluate(element => document.activeElement === element)).toBe(true)

  await page.setViewportSize({ width: 1280, height: 900 })
  for (const [name, label] of [['Activity', 'Activity'], ['Automation', 'Automation tasks'], ['Workspace actions', 'Workspace actions']] as const) {
    await expectVerticalTooltip(page, globalToolbar.getByRole('button', { name, exact: true }), label, 'bottom')
  }
  await globalToolbar.getByRole('button', { name: 'Automation', exact: true }).click()
  const automation = page.getByRole('dialog', { name: 'Automation tasks', exact: true })
  await automation.waitFor()
  await page.keyboard.press('Escape')
  await automation.waitFor({ state: 'detached' })
  await expectVerticalTooltip(page, chat, 'New chat', 'top')
  await expectVerticalTooltip(page, add, 'Add folder or files', 'top')
  await expectVerticalTooltip(page, application, 'Application window', 'top')
  await writeFile(path, 'Added through the grouped creation menu.\n')
  await add.click()
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('menuitem', { name: 'Add files', exact: true }).click()
  await (await chooser).setFiles(path)
  const hasFile = () => scaffold.ctx.convax.workspace().canvases.find(canvas => canvas.id === active.id)?.nodes
    .some(node => node.typeId === 'convax.file' && node.data.path === path)
  await expect.poll(hasFile).toBe(true)
  await resetZoom.click()
  await expect.poll(() => cameraZoom(graph)).toBeCloseTo(1, 3)
  await expect.poll(() => resetZoom.getAttribute('aria-description')).toBe('100%')
  await expectVerticalTooltip(page, resetZoom, '100% · Reset zoom to 100%', 'top')
  await viewToolbar.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await expect.poll(() => cameraZoom(graph)).toBeGreaterThan(1)
  await viewToolbar.getByRole('button', { name: 'Zoom out', exact: true }).click()
  await expect.poll(() => cameraZoom(graph)).toBeCloseTo(1, 3)
  await viewToolbar.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  await expect.poll(async () => {
    const resource = await graph.locator('[data-convax-resource]').boundingBox(), header = await titlebar.boundingBox()
    return resource !== null && header !== null && resource.y >= header.y + header.height
  }).toBe(true)
  await graph.locator('[data-convax-resource-header]').click()
  const cardToolbar = page.getByRole('toolbar', { name: 'Actions for canvas-tool-file.txt', exact: true })
  await cardToolbar.waitFor()
  const cardAction = cardToolbar.getByRole('button').first()
  const cardActionLabel = await cardAction.getAttribute('aria-label')
  if (cardActionLabel === null) throw new Error('The selected card action has no accessible name')
  await expectVerticalTooltip(page, cardAction, cardActionLabel, 'top')
  await page.locator('.react-flow__pane:visible').click({ position: { x: 12, y: 180 } })
  await viewToolbar.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect.poll(hasFile).toBe(false)
  await viewToolbar.getByRole('button', { name: 'Redo', exact: true }).click()
  await expect.poll(hasFile).toBe(true)
  await viewToolbar.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  await page.mouse.move(10, 200)
  await mkdir(ARTIFACTS, { recursive: true })
  const artifacts = await mkdtemp(join(ARTIFACTS, 'convax-workspace-chrome-'))
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expect.poll(() => page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme'))).toBe(colorScheme === 'dark')
    expect(await toolbarPaint(viewToolbar)).toEqual(await toolbarPaint(dock))
    expect(await toolbarPaint(globalToolbar)).toEqual(await toolbarPaint(dock))
    await page.screenshot({ path: join(artifacts, `${colorScheme}.png`) })
  }
  await page.setViewportSize({ width: 390, height: 900 })
  await expect.poll(() => titlebar.getByRole('tab').count()).toBe(1)
  await viewToolbar.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  await page.mouse.move(10, 200)
  await expect.poll(async () => {
    const resource = await graph.locator('[data-convax-resource]').boundingBox()
    return resource !== null && resource.x >= 0 && resource.x + resource.width <= 390
  }).toBe(true)
  await page.screenshot({ path: join(artifacts, 'dark-390.png') })
  expect(console.pageErrors).toEqual([])
})


it('removes deleted nodes from selection without overlapping toolbars or reselecting restored cards', async () => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: join(BUNDLE, 'cordis.patch.yml'), extraInstallAnchors: [join(BUNDLE, 'package.json')],
  })
  const owned: { browser?: Browser; page?: Page } = {}
  onTestFinished(async ({ task }) => {
    try {
      if (task.result?.state === 'fail' && owned.page !== undefined) await saveFailureShot(owned.page, 'convax-selection-toolbar')
    } finally { try { await owned.browser?.close() } finally { await scaffold.close() } }
  })
  const canvasId = randomUUID() as CanvasId
  const execute = async (command: CanvasCommand): Promise<CanvasOperationId> => {
    const operationId = randomUUID() as CanvasOperationId
    const expectedRevision = scaffold.ctx.convax.workspace().canvases.find(canvas => canvas.id === canvasId)?.revision ?? 0
    expect((await scaffold.ctx.convax.execute({ canvasId, expectedRevision, operationId, confirmed: true, command })).ok).toBe(true)
    return operationId
  }
  await execute({ kind: 'create', title: 'Selection cleanup' })
  const path = join(scaffold.workspaceCwd, 'selection-reference.txt')
  await writeFile(path, 'A removable canvas reference.\n')
  const chat: CanvasNode = {
    id: randomUUID() as CanvasNodeId, typeId: 'convax.chat' as CanvasNodeTypeId,
    dataVersion: 1, data: { title: 'Selection chat', cwd: scaffold.workspaceCwd }, position: { x: 80, y: 80 }, revision: 0,
  }
  const file: CanvasNode = {
    id: randomUUID() as CanvasNodeId, typeId: 'convax.file' as CanvasNodeTypeId,
    dataVersion: 1, data: { path }, position: { x: 900, y: 80 }, revision: 0,
  }
  await execute({ kind: 'add-subgraph', nodes: [chat, file], connections: [] })
  const browser = await chromium.launch()
  owned.browser = browser
  const page = await newEnglishPage(browser)
  owned.page = page
  const console = watchConsole(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(scaffold.authenticatedUrl)
  await page.locator('[data-convax-workspace]').waitFor({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Workspace actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'All canvases', exact: true }).click()
  await page.locator(`[data-canvas-manager-row="${canvasId}"]`).getByRole('button', { name: 'Selection cleanup', exact: true }).click()
  const graph = page.locator('[data-convax-graph]:visible')
  await graph.locator(`[data-convax-chat="${chat.id}"]`).waitFor()
  await expect.poll(() => graph.locator('.react-flow__node').count()).toBe(2)
  await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  await graph.locator('.react-flow__pane').click({ position: { x: 10, y: 180 } })
  await page.keyboard.press('ControlOrMeta+A')
  await expect.poll(() => graph.locator('.react-flow__node.selected').count()).toBe(2)
  const bulk = graph.getByRole('button', { name: 'Remove selected references', exact: true })
  await bulk.waitFor()
  expect(await graph.locator('.react-flow__node-toolbar').count()).toBe(1)

  const removedFile = await execute({ kind: 'remove-nodes', nodeIds: [file.id] })
  await expect.poll(() => graph.locator('.react-flow__node').count()).toBe(1)
  await expect.poll(() => graph.locator('.react-flow__node.selected').getAttribute('data-id')).toBe(chat.id)
  await expect.poll(() => bulk.count()).toBe(0)
  expect(await graph.locator('.react-flow__node-toolbar').count()).toBe(1)
  await graph.getByRole('toolbar', { name: 'Actions for Selection chat', exact: true }).waitFor()

  const removedChat = await execute({ kind: 'remove-nodes', nodeIds: [chat.id] })
  await expect.poll(() => graph.locator('.react-flow__node').count()).toBe(0)
  expect(await graph.locator('.react-flow__node-toolbar').count()).toBe(0)
  await execute({ kind: 'history', targetOperationId: removedChat, direction: 'undo' })
  await expect.poll(() => graph.locator('.react-flow__node').count()).toBe(1)
  expect(await graph.locator('.react-flow__node.selected').count()).toBe(0)
  expect(await graph.locator('.react-flow__node-toolbar').count()).toBe(0)
  await execute({ kind: 'history', targetOperationId: removedFile, direction: 'undo' })
  await expect.poll(() => graph.locator('.react-flow__node').count()).toBe(2)
  expect(await graph.locator('.react-flow__node.selected').count()).toBe(0)
  expect(await graph.locator('.react-flow__node-toolbar').count()).toBe(0)
  expect(await bulk.count()).toBe(0)
  expect(console.pageErrors).toEqual([])
})
