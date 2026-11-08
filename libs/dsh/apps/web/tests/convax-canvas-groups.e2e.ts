/** Group gestures exercise the shipped renderer against durable Host transactions. */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import type {} from '@deepseek-ai/dsh-convax-plugin-host'
import type {
  CanvasCommand, CanvasDocument, CanvasGroupId, CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId,
} from '@deepseek-ai/dsh-convax-plugin-host/types'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const BUNDLE = fileURLToPath(new URL('../../../../../packages/plugin-renderer/', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/convax-canvas-groups/group-menu.expected.md', import.meta.url))
const ARTIFACTS = fileURLToPath(new URL('../../../../../.artifacts/', import.meta.url))

function document(scaffold: WebScaffold, id: CanvasId): CanvasDocument {
  const canvas = scaffold.ctx.convax.workspace().canvases.find(value => value.id === id)
  if (canvas === undefined) throw new Error('Grouping fixture canvas is missing')
  return canvas
}

async function execute(scaffold: WebScaffold, canvasId: CanvasId, command: CanvasCommand): Promise<void> {
  const revision = scaffold.ctx.convax.workspace().canvases.find(value => value.id === canvasId)?.revision ?? 0
  const result = await scaffold.ctx.convax.execute({ canvasId, expectedRevision: revision,
    operationId: randomUUID() as CanvasOperationId, command })
  if (!result.ok) throw new Error(`Grouping fixture ${command.kind}: ${result.code}: ${result.message}`)
}

async function seed(scaffold: WebScaffold, title: string) {
  const id = randomUUID() as CanvasId
  const directory = await mkdtemp(join(scaffold.workspaceCwd, 'groups-'))
  await execute(scaffold, id, { kind: 'create', title })
  const nodeIds: CanvasNodeId[] = []
  for (const [index, name] of ['notes.txt', 'outline.md'].entries()) {
    const path = join(directory, name)
    await writeFile(path, `Group fixture ${index + 1}\n`)
    const nodeId = randomUUID() as CanvasNodeId
    await execute(scaffold, id, { kind: 'add-node', node: { id: nodeId,
      typeId: 'convax.file' as CanvasNodeTypeId, dataVersion: 1, data: { path },
      position: { x: 120 + index * 400, y: 180 }, revision: 0 } })
    nodeIds.push(nodeId)
  }
  return { id, nodeIds }
}

async function openCanvas(browser: Browser, scaffold: WebScaffold, id: CanvasId): Promise<Page> {
  const page = await newEnglishPage(browser)
  const errors = watchConsole(page)
  onTestFinished(async ({ task }) => {
    try {
      if (task.result?.state === 'fail') await saveFailureShot(page, 'web-e2e-convax-canvas-groups')
      expect(errors.pageErrors).toEqual([])
    } finally { await page.close() }
  })
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: scaffold.baseUrl })
  await page.goto(scaffold.authenticatedUrl)
  await page.locator('[data-convax-workspace]').waitFor({ timeout: 30_000 })
  await showCanvas(page, id)
  return page
}

async function showCanvas(page: Page, id: CanvasId): Promise<void> {
  await page.getByRole('button', { name: 'Workspace actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'All canvases', exact: true }).click()
  await page.locator(`[data-canvas-manager-row="${id}"] button`).first().click()
  await page.locator('[data-convax-graph]:visible').waitFor()
}

function card(page: Page, id: CanvasNodeId) {
  return page.locator(`.react-flow__node[data-id="${id}"]:visible`)
}

function header(page: Page, id: CanvasGroupId) {
  return page.locator(`[data-convax-group-header="${id}"]:visible`)
}

function colorPicker(page: Page) {
  return page.getByRole('dialog', { name: 'Group color', exact: true })
}

function groupFill(page: Page, id: CanvasGroupId): Promise<string> {
  return page.locator(`[data-convax-group="${id}"]:visible`).evaluate(element => getComputedStyle(element, '::before').backgroundColor)
}

async function openColors(page: Page, id: CanvasGroupId): Promise<void> {
  await header(page, id).click()
  await page.locator(`[data-convax-group-color-trigger="${id}"]:visible`).click()
  await colorPicker(page).waitFor()
  await expect.poll(() => colorPicker(page).evaluate(element => element.contains(globalThis.document.activeElement))).toBe(true)
}

async function idle(page: Page): Promise<void> {
  await expect.poll(() => page.getByRole('button', { name: 'New chat', exact: true }).isEnabled()).toBe(true)
}

async function selectCards(page: Page, ids: readonly CanvasNodeId[]): Promise<void> {
  for (const [index, id] of ids.entries()) {
    await card(page, id).locator('[data-convax-resource-header]').click({ modifiers: index === 0 ? [] : ['ControlOrMeta'] })
  }
  await expect.poll(() => page.locator('.react-flow__node.selected:visible').count()).toBe(ids.length)
}

async function createGroup(page: Page, scaffold: WebScaffold, id: CanvasId, nodeIds: readonly CanvasNodeId[]): Promise<CanvasGroupId> {
  await selectCards(page, nodeIds)
  await page.keyboard.press('ControlOrMeta+g')
  await expect.poll(() => document(scaffold, id).groups?.length ?? 0).toBe(1)
  const groupId = document(scaffold, id).groups![0]!.id
  await header(page, groupId).waitFor()
  await idle(page)
  return groupId
}

async function setZoom(page: Page, target: number): Promise<void> {
  await page.locator('[data-convax-graph]:visible').evaluate((root, target) => {
    const viewport = root.querySelector('.react-flow__viewport')
    if (viewport === null) throw new Error('Grouping canvas viewport is missing')
    const current = new DOMMatrixReadOnly(getComputedStyle(viewport).transform).a
    const bounds = root.getBoundingClientRect()
    root.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true,
      deltaY: -Math.log2(target / current) / 0.02, clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2 }))
  }, target)
  await expect.poll(() => page.locator('.react-flow__viewport:visible').evaluate(element =>
    new DOMMatrixReadOnly(getComputedStyle(element).transform).a)).toBeCloseTo(target, 4)
}

describe('web e2e: Convax canvas groups', () => {
  let scaffold: WebScaffold
  let browser: Browser

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: join(BUNDLE, 'cordis.patch.yml'),
      extraInstallAnchors: [join(BUNDLE, 'package.json')] })
    browser = await chromium.launch()
  })
  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('creates, renames, moves once at zoom, ungroups, and restores the group through undo and redo', async () => {
    const fixture = await seed(scaffold, 'Group history')
    const page = await openCanvas(browser, scaffold, fixture.id)
    const initial = document(scaffold, fixture.id).nodes.map(value => ({ id: value.id, position: value.position }))
    const groupId = await createGroup(page, scaffold, fixture.id, fixture.nodeIds)
    expect(document(scaffold, fixture.id).nodes.every(value => value.groupId === groupId)).toBe(true)
    expect(document(scaffold, fixture.id).nodes.map(value => ({ id: value.id, position: value.position }))).toEqual(initial)

    await header(page, groupId).dblclick()
    const dialog = page.getByRole('dialog', { name: 'Rename group', exact: true })
    await dialog.getByRole('textbox', { name: 'Group name', exact: true }).fill('Research')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => document(scaffold, fixture.id).groups?.[0]?.title).toBe('Research')
    await idle(page)
    await header(page, groupId).click({ button: 'right' })
    await page.getByRole('menu').waitFor()
    await mkdir(dirname(EXPECTED), { recursive: true })
    await compareOrRefreshGolden(EXPECTED, await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd), webSnapshotMode())
    await page.keyboard.press('Escape')

    await setZoom(page, 0.5)
    await header(page, groupId).scrollIntoViewIfNeeded()
    const bounds = await header(page, groupId).boundingBox()
    if (bounds === null) throw new Error('Group title has no draggable bounds')
    const revision = document(scaffold, fixture.id).revision
    const start = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x + 60, start.y + 40, { steps: 12 })
    expect(document(scaffold, fixture.id).revision).toBe(revision)
    await page.mouse.up()
    await expect.poll(() => document(scaffold, fixture.id).revision).toBe(revision + 1)
    const moved = document(scaffold, fixture.id).nodes.map(value => ({ id: value.id, position: value.position }))
    moved.forEach((value, index) => {
      expect(value.position.x).toBeCloseTo(initial[index]!.position.x + 120, 3)
      expect(value.position.y).toBeCloseTo(initial[index]!.position.y + 80, 3)
    })
    await idle(page)
    await header(page, groupId).click()
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(() => document(scaffold, fixture.id).nodes.map(value => ({ id: value.id, position: value.position })))
      .toEqual(initial)
    await idle(page)
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect.poll(() => document(scaffold, fixture.id).nodes.map(value => ({ id: value.id, position: value.position }))).toEqual(moved)
    await idle(page)

    await header(page, groupId).click()
    await page.keyboard.press('ControlOrMeta+Shift+g')
    await expect.poll(() => document(scaffold, fixture.id).groups?.length ?? 0).toBe(0)
    expect(document(scaffold, fixture.id).nodes.every(value => value.groupId === undefined)).toBe(true)
    expect(document(scaffold, fixture.id).nodes.map(value => ({ id: value.id, position: value.position }))).toEqual(moved)
    await idle(page)
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(() => document(scaffold, fixture.id).groups?.[0]).toEqual({ id: groupId, title: 'Research' })
    await idle(page)
    await page.reload()
    await header(page, groupId).waitFor({ timeout: 30_000 })
    expect(document(scaffold, fixture.id).nodes.every(value => value.groupId === groupId)).toBe(true)
    expect(await page.getByRole('button', { name: 'Retry', exact: true }).count()).toBe(0)
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await mkdir(ARTIFACTS, { recursive: true })
    await page.screenshot({ path: join(ARTIFACTS, 'convax-groups.png') })
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme'))).toBe(true)
    await page.screenshot({ path: join(ARTIFACTS, 'convax-groups-dark.png') })
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme'))).toBe(false)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await header(page, groupId).click({ button: 'right' })
    const menu = await page.getByRole('menu').boundingBox()
    if (menu === null) throw new Error('Group menu is missing at the minimum viewport')
    expect(menu.x).toBeGreaterThanOrEqual(0)
    expect(menu.x + menu.width).toBeLessThanOrEqual(390)
    expect(menu.y + menu.height).toBeLessThanOrEqual(844)
    await page.screenshot({ path: join(ARTIFACTS, 'convax-groups-mobile.png') })
  })

  it('copies a complete group across canvases and detaches partial member copies, with atomic undo and redo', async () => {
    const fixture = await seed(scaffold, 'Copy grouped cards')
    const destination = randomUUID() as CanvasId
    await execute(scaffold, destination, { kind: 'create', title: 'Pasted groups' })
    const page = await openCanvas(browser, scaffold, fixture.id)
    const groupId = await createGroup(page, scaffold, fixture.id, fixture.nodeIds)
    await header(page, groupId).click()
    await page.keyboard.press('ControlOrMeta+c')
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('convax.canvas.nodes')
    await showCanvas(page, destination)
    await page.locator('[data-convax-graph]:visible .react-flow__pane').click()
    await page.keyboard.press('ControlOrMeta+v')
    await expect.poll(() => document(scaffold, destination).nodes.length).toBe(2)
    const pasted = document(scaffold, destination)
    const pastedGroup = pasted.groups![0]!
    expect(pastedGroup.id).not.toBe(groupId)
    expect(pasted.nodes.every(value => value.groupId === pastedGroup.id && !fixture.nodeIds.includes(value.id))).toBe(true)
    await idle(page)
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(() => document(scaffold, destination).nodes.length).toBe(0)
    expect(document(scaffold, destination).groups?.length ?? 0).toBe(0)
    await idle(page)
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect.poll(() => document(scaffold, destination).nodes.length).toBe(2)
    expect(document(scaffold, destination).groups?.[0]?.id).toBe(pastedGroup.id)
    await idle(page)
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await card(page, pasted.nodes[0]!.id).locator('[data-convax-resource-header]').click()
    await page.keyboard.press('ControlOrMeta+d')
    await expect.poll(() => document(scaffold, destination).nodes.length).toBe(3)
    const partial = document(scaffold, destination).nodes.find(value => !pasted.nodes.some(old => old.id === value.id))!
    expect(partial.groupId).toBeUndefined()
    expect(document(scaffold, destination).groups).toHaveLength(1)
    expect(document(scaffold, fixture.id).groups?.[0]?.id).toBe(groupId)
  })

  it('changes membership explicitly, fits expanded previews, and cancels a group drag without committing', async () => {
    const fixture = await seed(scaffold, 'Group membership')
    const firstId = fixture.nodeIds[0]!
    const secondId = fixture.nodeIds[1]!
    const page = await openCanvas(browser, scaffold, fixture.id)
    const groupId = await createGroup(page, scaffold, fixture.id, fixture.nodeIds)
    const frame = page.locator(`[data-convax-group="${groupId}"]:visible`)
    const height = await frame.evaluate(element => (element as HTMLElement).offsetHeight)
    await card(page, firstId).getByRole('button', { name: 'Expand notes.txt', exact: true }).click()
    await expect.poll(() => frame.evaluate(element => (element as HTMLElement).offsetHeight)).toBeGreaterThan(height)

    await card(page, firstId).locator('[data-convax-resource-header]').click()
    await card(page, firstId).locator('[data-convax-resource-header]').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Remove from group', exact: true }).click()
    await expect.poll(() => document(scaffold, fixture.id).nodes.find(value => value.id === firstId)?.groupId).toBeUndefined()
    expect(document(scaffold, fixture.id).nodes.find(value => value.id === secondId)?.groupId).toBe(groupId)
    expect(document(scaffold, fixture.id).groups).toHaveLength(1)
    await idle(page)
    await card(page, firstId).locator('[data-convax-resource-header]').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Add to group', exact: true }).hover()
    await page.getByRole('menuitem', { name: 'Group', exact: true }).click()
    await expect.poll(() => document(scaffold, fixture.id).nodes.find(value => value.id === firstId)?.groupId).toBe(groupId)
    await idle(page)

    await header(page, groupId).click()
    await card(page, firstId).locator('[data-convax-resource-header]').click({ modifiers: ['ControlOrMeta'] })
    const beforeMove = document(scaffold, fixture.id).nodes.map(value => ({ ...value.position }))
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => document(scaffold, fixture.id).nodes.map(value => value.position))
      .toEqual(beforeMove.map(point => ({ x: point.x + 5, y: point.y })))
    await idle(page)
    await header(page, groupId).click()
    const before = document(scaffold, fixture.id)
    const bounds = await header(page, groupId).boundingBox()
    if (bounds === null) throw new Error('Group title is not visible for cancellation')
    const start = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x + 50, start.y + 50, { steps: 8 })
    await page.keyboard.press('Escape')
    await page.mouse.up()
    expect(document(scaffold, fixture.id)).toEqual(before)
    await header(page, groupId).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Delete group and contents', exact: true }).click()
    await expect.poll(() => document(scaffold, fixture.id).nodes.length).toBe(0)
    expect(document(scaffold, fixture.id).groups?.length ?? 0).toBe(0)
    await idle(page)
    await page.locator('[data-convax-graph]:visible .react-flow__pane').click()
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(() => document(scaffold, fixture.id).nodes.length).toBe(2)
    expect(document(scaffold, fixture.id).nodes.every(value => value.groupId === groupId)).toBe(true)
  })

  it('previews colors locally, applies once, restores history, and retains colors after reload', async () => {
    const fixture = await seed(scaffold, 'Group colors')
    const page = await openCanvas(browser, scaffold, fixture.id)
    const groupId = await createGroup(page, scaffold, fixture.id, fixture.nodeIds)
    const initial = document(scaffold, fixture.id)
    const originalFill = await groupFill(page, groupId)
    await openColors(page, groupId)
    await colorPicker(page).getByRole('radio', { name: 'Blue', exact: true }).hover()
    await expect.poll(() => groupFill(page, groupId)).not.toBe(originalFill)
    expect(document(scaffold, fixture.id)).toEqual(initial)
    await page.keyboard.press('Escape')
    await colorPicker(page).waitFor({ state: 'hidden' })
    await expect.poll(() => groupFill(page, groupId)).toBe(originalFill)
    expect(document(scaffold, fixture.id)).toEqual(initial)

    await openColors(page, groupId)
    await colorPicker(page).getByRole('radio', { name: 'Green', exact: true }).hover()
    await header(page, groupId).locator('[data-convax-group-title]').click()
    await colorPicker(page).waitFor({ state: 'hidden' })
    await expect.poll(() => groupFill(page, groupId)).toBe(originalFill)
    expect(document(scaffold, fixture.id)).toEqual(initial)

    await header(page, groupId).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Group color', exact: true }).click()
    await colorPicker(page).waitFor()
    await colorPicker(page).getByRole('radio', { name: 'Blue', exact: true }).click()
    await expect.poll(() => document(scaffold, fixture.id).groups?.[0]?.color).toBe('blue')
    expect(document(scaffold, fixture.id).revision).toBe(initial.revision + 1)
    await colorPicker(page).waitFor({ state: 'hidden' })
    await idle(page)
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(() => document(scaffold, fixture.id).groups?.[0]?.color).toBeUndefined()
    await idle(page)
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect.poll(() => document(scaffold, fixture.id).groups?.[0]?.color).toBe('blue')
    await idle(page)
    await page.reload()
    await header(page, groupId).waitFor({ timeout: 30_000 })
    expect(document(scaffold, fixture.id).groups?.[0]?.color).toBe('blue')

    await openColors(page, groupId)
    const saved = document(scaffold, fixture.id)
    await mkdir(ARTIFACTS, { recursive: true })
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await expect.poll(() => page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme'))).toBe(scheme === 'dark')
      const fills: string[] = []
      for (const name of ['Blue', 'Green', 'Yellow', 'Orange', 'Purple', 'Pink']) {
        await colorPicker(page).getByRole('radio', { name, exact: true }).hover()
        await expect.poll(() => page.locator(`[data-convax-group="${groupId}"]:visible`).getAttribute('data-color'))
          .toBe(name.toLowerCase())
        fills.push(await groupFill(page, groupId))
      }
      expect(new Set(fills).size).toBe(6)
      expect(document(scaffold, fixture.id)).toEqual(saved)
      await page.screenshot({ path: join(ARTIFACTS, `convax-group-colors-${scheme}.png`) })
    }
    await page.keyboard.press('Escape')
    await openColors(page, groupId)
    await colorPicker(page).getByRole('radio', { name: 'Default', exact: true }).click()
    await expect.poll(() => document(scaffold, fixture.id).groups?.[0]?.color).toBeUndefined()
    expect(document(scaffold, fixture.id).nodes.map(value => value.position)).toEqual(initial.nodes.map(value => value.position))
  })

  it('applies mixed groups atomically, copies their colors, and offers a mobile color sheet', async () => {
    const fixture = await seed(scaffold, 'Mixed group colors')
    const originalNodes = document(scaffold, fixture.id).nodes
    const extra = originalNodes.map(node => ({ ...node, id: randomUUID() as CanvasNodeId,
      position: { x: node.position.x, y: 480 }, revision: 0 }))
    await execute(scaffold, fixture.id, { kind: 'add-subgraph', nodes: extra, connections: [] })
    const firstGroup = randomUUID() as CanvasGroupId
    const secondGroup = randomUUID() as CanvasGroupId
    await execute(scaffold, fixture.id, { kind: 'group-nodes',
      group: { id: firstGroup, title: 'Sources', color: 'blue' }, nodeIds: fixture.nodeIds })
    await execute(scaffold, fixture.id, { kind: 'group-nodes',
      group: { id: secondGroup, title: 'Ideas', color: 'purple' }, nodeIds: extra.map(node => node.id) })
    const destination = randomUUID() as CanvasId
    await execute(scaffold, destination, { kind: 'create', title: 'Colored copies' })
    const page = await openCanvas(browser, scaffold, fixture.id)
    await openColors(page, firstGroup)
    await colorPicker(page).getByRole('radio', { name: 'Orange', exact: true }).hover()
    await header(page, secondGroup).locator('[data-convax-group-title]').click()
    await colorPicker(page).waitFor({ state: 'hidden' })
    expect(await header(page, secondGroup).evaluate(element => globalThis.document.activeElement === element)).toBe(true)
    await header(page, firstGroup).click()
    await header(page, secondGroup).click({ modifiers: ['ControlOrMeta'] })
    await page.locator(`[data-convax-group-color-trigger="${firstGroup}"]:visible`).click()
    await colorPicker(page).getByText('Mixed colors', { exact: false }).waitFor()
    const revision = document(scaffold, fixture.id).revision
    await colorPicker(page).getByRole('radio', { name: 'Green', exact: true }).click()
    await expect.poll(() => document(scaffold, fixture.id).groups?.map(group => group.color)).toEqual(['green', 'green'])
    expect(document(scaffold, fixture.id).revision).toBe(revision + 1)
    await idle(page)
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(() => document(scaffold, fixture.id).groups?.map(group => group.color)).toEqual(['blue', 'purple'])
    await idle(page)
    await header(page, firstGroup).click()
    await page.keyboard.press('ControlOrMeta+c')
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(firstGroup)
    await showCanvas(page, destination)
    await page.locator('[data-convax-graph]:visible .react-flow__pane').click()
    await page.keyboard.press('ControlOrMeta+v')
    await expect.poll(() => document(scaffold, destination).groups?.[0]?.color).toBe('blue')
    expect(document(scaffold, destination).groups?.[0]?.id).not.toBe(firstGroup)
    await idle(page)
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(() => document(scaffold, destination).nodes).toHaveLength(0)
    await idle(page)
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect.poll(() => document(scaffold, destination).groups?.[0]?.color).toBe('blue')
    await idle(page)
    const copiedGroup = document(scaffold, destination).groups![0]!.id
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await openColors(page, copiedGroup)
    expect(await colorPicker(page).getAttribute('data-mode')).toBe('sheet')
    const bounds = await colorPicker(page).boundingBox()
    if (bounds === null) throw new Error('The mobile color sheet is not visible')
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(844)
    await page.screenshot({ path: join(ARTIFACTS, 'convax-group-colors-mobile.png') })
    await colorPicker(page).getByRole('radio', { name: 'Pink', exact: true }).click()
    await expect.poll(() => document(scaffold, destination).groups?.[0]?.color).toBe('pink')
  })
})
