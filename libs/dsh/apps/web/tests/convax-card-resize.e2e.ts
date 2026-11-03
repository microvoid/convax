/** Card sizing uses real canvas gestures, native Chat composition and persisted view preferences. */
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import type {} from '@deepseek-ai/dsh-convax-plugin-host'
import type {
  CanvasCommand, CanvasConnectionId, CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId,
} from '@deepseek-ai/dsh-convax-plugin-host/types'
import { compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

const BUNDLE = fileURLToPath(new URL('../../../../../packages/plugin-renderer/', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/convax-card-resize/geometry.expected.json', import.meta.url))
const ARTIFACTS = fileURLToPath(new URL('../../../../../.artifacts/', import.meta.url))

async function execute(scaffold: WebScaffold, canvasId: CanvasId, command: CanvasCommand): Promise<void> {
  const revision = scaffold.ctx.convax.workspace().canvases.find(canvas => canvas.id === canvasId)?.revision ?? 0
  const result = await scaffold.ctx.convax.execute({
    canvasId, expectedRevision: revision, operationId: randomUUID() as CanvasOperationId, command,
  })
  if (!result.ok) throw new Error(`Card resize fixture ${command.kind}: ${result.code}: ${result.message}`)
}

async function captureFixture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 64; canvas.height = 48
    const context = canvas.getContext('2d')!
    context.fillStyle = 'red'; context.fillRect(0, 0, canvas.width, canvas.height)
    const source = { id: 'resize-source-window', name: 'Resize window fixture' }
    const leases = new Set<string>()
    let selected: string | undefined
    let counter = 0
    Object.defineProperty(globalThis, 'dshDesktop', { configurable: true, value: {
      protocolVersion: 1,
      windowCapture: {
        list: async () => [source],
        prepare: async (id: string) => {
          if (id !== source.id) throw new Error('Unknown resize fixture window')
          selected = `resize-lease-${++counter}`
          leases.add(selected)
          return { id: selected, source }
        },
        validate: async (id: string) => leases.has(id),
        release: async (id: string) => { leases.delete(id); if (selected === id) selected = undefined },
      },
    } })
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async () => {
      if (selected === undefined) throw new DOMException('Select the resize fixture window first', 'NotAllowedError')
      selected = undefined
      const stream = canvas.captureStream(5)
      context.fillRect(0, 0, canvas.width, canvas.height)
      return stream
    } })
  })
}

async function seed(scaffold: WebScaffold) {
  const canvasId = randomUUID() as CanvasId
  const fileId = randomUUID() as CanvasNodeId
  const folderId = randomUUID() as CanvasNodeId
  const chatId = randomUUID() as CanvasNodeId
  const folder = join(scaffold.workspaceCwd, 'resize-project')
  const path = join(folder, 'notes.txt')
  await mkdir(folder)
  await writeFile(path, 'Card resize preview stays mounted.\n')
  await execute(scaffold, canvasId, { kind: 'create', title: 'Card resizing' })
  for (const [id, type, data, position] of [
    [fileId, 'convax.file', { path }, { x: 80, y: 80 }],
    [folderId, 'convax.folder', { path: folder }, { x: 540, y: 80 }],
    [chatId, 'convax.chat', { title: 'Resize conversation', cwd: folder }, { x: 1050, y: 80 }],
  ] as const) {
    await execute(scaffold, canvasId, { kind: 'add-node', node: {
      id, typeId: type as CanvasNodeTypeId, dataVersion: 1, data, position, revision: 0,
    } })
  }
  const revision = scaffold.ctx.convax.workspace().canvases.find(canvas => canvas.id === canvasId)!.revision
  const thread = await scaffold.ctx.convax.createThread({
    canvasId, nodeId: chatId, expectedRevision: revision, operationId: randomUUID() as CanvasOperationId,
    kind: 'create', cwd: folder, agentPreset: 'standard',
  })
  if (!thread.ok) throw new Error(`Card resize fixture thread: ${thread.code}: ${thread.message}`)
  for (const source of [fileId, folderId]) await execute(scaffold, canvasId, { kind: 'add-connection', connection: {
    id: randomUUID() as CanvasConnectionId, source, sourcePort: 'output', target: chatId, targetPort: 'input', purpose: 'input',
  } })
  return { canvasId, fileId, folderId, chatId }
}

async function viewport(page: Page): Promise<readonly number[]> {
  return page.locator('.react-flow__viewport').evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform)
    return [matrix.a, matrix.e, matrix.f]
  })
}

async function setZoom(page: Page, target: number): Promise<void> {
  await page.locator('[data-convax-graph]').evaluate((root, target) => {
    const viewport = root.querySelector('.react-flow__viewport')
    if (viewport === null) throw new Error('Card resize canvas viewport is missing')
    const zoom = new DOMMatrixReadOnly(getComputedStyle(viewport).transform).a
    const bounds = root.getBoundingClientRect()
    root.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, ctrlKey: true, deltaY: -Math.log2(target / zoom) / 0.02,
      clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2,
    }))
  }, target)
  await expect.poll(async () => (await viewport(page))[0]).toBeCloseTo(target, 4)
}

async function positionCard(page: Page, card: Locator): Promise<void> {
  const rect = await card.boundingBox()
  if (rect === null) throw new Error('Resize card is not mounted')
  const deltaX = (rect.x - 160) * 2
  const deltaY = (rect.y - 140) * 2
  await page.locator('[data-convax-graph]').dispatchEvent('wheel', { deltaX, deltaY, clientX: 300, clientY: 200 })
  await expect.poll(async () => {
    const moved = await card.boundingBox()
    return moved !== null && Math.abs(moved.x - 160) < 1 && Math.abs(moved.y - 140) < 1
  }).toBe(true)
}

async function dimensions(card: Locator, body: Locator): Promise<{ width: number; height: number }> {
  return {
    width: await card.evaluate(element => (element as HTMLElement).offsetWidth),
    height: await body.evaluate(element => (element as HTMLElement).offsetHeight),
  }
}

async function dragResize(page: Page, card: Locator, grip: Locator, dx: number, dy: number): Promise<void> {
  await positionCard(page, card)
  await card.hover({ position: { x: 30, y: 20 } })
  await grip.waitFor({ state: 'visible' })
  const box = await grip.boundingBox()
  if (box === null) throw new Error('Card resize handle is not visible')
  const before = await viewport(page)
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  expect(await grip.evaluate((element, point) => element.contains(document.elementFromPoint(point.x, point.y)), point)).toBe(true)
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.mouse.move(point.x + dx, point.y + dy, { steps: 8 })
  await page.mouse.up()
  expect(await viewport(page)).toEqual(before)
}

it('resizes every card at canvas zoom, retains previews and bindings, and restores dimensions after reload', async () => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: [join(BUNDLE, 'cordis.patch.yml'), fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url))],
    extraInstallAnchors: [join(BUNDLE, 'package.json')],
  })
  const owned: { browser?: Browser; page?: Page } = {}
  onTestFinished(async ({ task }) => {
    try {
      if (task.result?.state === 'fail' && owned.page !== undefined) await saveFailureShot(owned.page, 'convax-card-resize')
    } finally { try { await owned.browser?.close() } finally { await scaffold.close() } }
  })
  const fixture = await seed(scaffold)
  const browser = await chromium.launch()
  owned.browser = browser
  const page = await newEnglishPage(browser, 1100)
  owned.page = page
  const console = watchConsole(page)
  await captureFixture(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(scaffold.authenticatedUrl)
  await page.locator('[data-convax-workspace]').waitFor({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Workspace actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'All canvases', exact: true }).click()
  await page.locator(`[data-canvas-manager-row="${fixture.canvasId}"] button`).first().click()
  await page.locator('[data-canvas-gestures-ready]').waitFor()
  await page.getByRole('combobox', { name: 'Canvas input mode', exact: true }).selectOption('touchpad')
  const document = () => scaffold.ctx.convax.workspace().canvases.find(canvas => canvas.id === fixture.canvasId)!
  const file = page.locator(`[data-convax-resource="${fixture.fileId}"]`)
  const folder = page.locator(`[data-convax-resource="${fixture.folderId}"]`)
  const chat = page.locator(`[data-convax-chat="${fixture.chatId}"]`)
  await chat.locator('[data-composer-input][contenteditable="true"]').filter({ visible: true }).waitFor({ timeout: 15_000 })
  await file.getByRole('button', { name: 'Expand notes.txt', exact: true }).click()
  await folder.getByRole('button', { name: 'Expand resize-project', exact: true }).click()
  await file.getByText('Card resize preview stays mounted.', { exact: false }).waitFor()
  await folder.locator('[data-convax-directory-tree]').getByText('notes.txt', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Application window', exact: true }).click()
  await page.getByRole('dialog', { name: 'Application window', exact: true })
    .getByRole('button', { name: 'Resize window fixture', exact: true }).click()
  await expect.poll(() => document().nodes.filter(node => node.typeId === 'convax.window').length).toBe(1)
  const windowNode = document().nodes.find(node => node.typeId === 'convax.window')!
  await execute(scaffold, fixture.canvasId, { kind: 'move-nodes', nodes: [{ id: windowNode.id, position: { x: 80, y: 580 } }] })
  const windowCard = page.locator(`[data-convax-window="${windowNode.id}"]`)
  await windowCard.locator('video').waitFor()
  const state = structuredClone(document())
  await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  await setZoom(page, 0.75)

  const composer = chat.locator('[data-composer-input][contenteditable="true"]').filter({ visible: true })
  await writeComposerDraft(page, composer, 'Keep this draft while resizing.')
  const editor = await composer.elementHandle()
  const video = await windowCard.locator('video').elementHandle()
  const cases = [
    { name: 'file', card: file, body: file.locator('[data-convax-file-preview]'), grip: file.locator('[data-convax-resource-resize]'), title: 'notes.txt' },
    { name: 'folder', card: folder, body: folder.locator('[data-convax-directory-preview]'), grip: folder.locator('[data-convax-resource-resize]'), title: 'resize-project' },
    { name: 'window', card: windowCard, body: windowCard.locator('[data-convax-window-preview]'), grip: windowCard.locator('[data-convax-resource-resize]'), title: 'Resize window fixture' },
    { name: 'chat', card: chat, body: chat.locator('[data-conversation-scroll]').filter({ visible: true }), grip: chat.locator('[data-convax-chat-resize]').filter({ visible: true }), title: undefined },
  ]
  const expected: Record<string, { width: number; height: number }> = {}
  for (const entry of cases) {
    const before = await dimensions(entry.card, entry.body)
    await dragResize(page, entry.card, entry.grip, 60, 45)
    const next = { width: before.width + 80, height: before.height + 60 }
    await expect.poll(() => dimensions(entry.card, entry.body)).toEqual(next)
    expected[entry.name] = next
    expect(document()).toEqual(state)
  }
  expect(await composer.textContent()).toBe('Keep this draft while resizing.')
  expect(await composer.evaluate((element, original) => element === original, editor)).toBe(true)
  expect(await windowCard.locator('video').evaluate((element, original) => element === original, video)).toBe(true)
  await expect.poll(() => windowCard.locator('video').evaluate(element => element instanceof HTMLVideoElement && element.readyState >= 2)).toBe(true)

  for (const entry of cases) {
    await positionCard(page, entry.card)
    await entry.card.getByRole('button', { name: entry.title === undefined ? 'Collapse chat' : `Collapse ${entry.title}`, exact: true }).click()
    expect(await entry.body.count()).toBe(0)
    const beforeWidth = expected[entry.name]!.width
    await dragResize(page, entry.card, entry.grip, 30, 45)
    await expect.poll(() => entry.card.evaluate(element => (element as HTMLElement).offsetWidth)).toBe(beforeWidth + 40)
    await entry.card.getByRole('button', { name: entry.title === undefined ? 'Expand chat' : `Expand ${entry.title}`, exact: true }).click()
    expected[entry.name] = { width: beforeWidth + 40, height: expected[entry.name]!.height }
    await expect.poll(() => dimensions(entry.card, entry.body)).toEqual(expected[entry.name])
  }
  await mkdir(ARTIFACTS, { recursive: true })
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await expect.poll(() => page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme'))).toBe(scheme === 'dark')
    await positionCard(page, windowCard)
    await windowCard.hover({ position: { x: 30, y: 20 } })
    await page.screenshot({ path: join(ARTIFACTS, `convax-card-resize-${scheme}.png`) })
  }
  await page.reload()
  await page.locator('[data-convax-workspace]').waitFor({ timeout: 30_000 })
  await composer.waitFor({ timeout: 15_000 })
  for (const entry of cases) await expect.poll(() => dimensions(entry.card, entry.body)).toEqual(expected[entry.name])
  expect(document()).toEqual(state)
  expect(await composer.textContent()).toBe('Keep this draft while resizing.')
  await mkdir(fileURLToPath(new URL('./expected/convax-card-resize/', import.meta.url)), { recursive: true })
  const restored = []
  for (const entry of cases) restored.push({ kind: entry.name, ...await dimensions(entry.card, entry.body) })
  await compareOrRefreshGolden(EXPECTED, JSON.stringify({ zoom: Number((await viewport(page))[0]!.toFixed(4)),
    cards: restored, connections: document().connections.length, draft: await composer.textContent() }, null, 2), webSnapshotMode())
  expect(console.pageErrors).toEqual([])
})
