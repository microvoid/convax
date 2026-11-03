/** Real Convax Host persistence and browser gestures, grouped by independently runnable interaction. */
import { randomUUID } from 'node:crypto'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {} from '@deepseek-ai/dsh-convax-plugin-host'
import type {
  CanvasCommand, CanvasConnectionId, CanvasDocument, CanvasId, CanvasNode, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId,
} from '@deepseek-ai/dsh-convax-plugin-host/types'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

const BUNDLE = fileURLToPath(new URL('../../../../../packages/plugin-renderer/', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/convax-canvas-interactions/', import.meta.url))
const ARTIFACTS = fileURLToPath(new URL('../../../../../.artifacts/', import.meta.url))

function canvas(scaffold: WebScaffold, id: CanvasId): CanvasDocument {
  const document = scaffold.ctx.convax.workspace().canvases.find(item => item.id === id)
  if (document === undefined) throw new Error(`Canvas ${id} is missing from the real Host`)
  return document
}

async function execute(scaffold: WebScaffold, id: CanvasId, command: CanvasCommand): Promise<CanvasDocument> {
  const existing = scaffold.ctx.convax.workspace().canvases.find(item => item.id === id)
  const result = await scaffold.ctx.convax.execute({
    canvasId: id, expectedRevision: existing?.revision ?? 0,
    operationId: randomUUID() as CanvasOperationId, command,
  })
  if (!result.ok) throw new Error(`Canvas fixture command ${command.kind} failed: ${result.code}: ${result.message}`)
  return canvas(scaffold, id)
}

async function seedCanvas(scaffold: WebScaffold, title: string, withChat = false) {
  const id = randomUUID() as CanvasId
  await execute(scaffold, id, { kind: 'create', title })
  const directory = join(scaffold.workspaceCwd, title.toLowerCase().replaceAll(' ', '-'))
  await mkdir(directory, { recursive: true })
  const resources: CanvasNode[] = []
  for (const [index, name] of ['notes.txt', 'outline.md'].entries()) {
    const path = join(directory, name)
    await writeFile(path, `Canvas interaction fixture ${index + 1}\n`)
    const node: CanvasNode = {
      id: randomUUID() as CanvasNodeId, typeId: 'convax.file' as CanvasNodeTypeId,
      dataVersion: 1, data: { path }, position: { x: 80 + index * 400, y: 80 }, revision: 0,
    }
    await execute(scaffold, id, { kind: 'add-node', node })
    resources.push(node)
  }
  if (withChat) {
    await execute(scaffold, id, {
      kind: 'add-node', node: {
        id: randomUUID() as CanvasNodeId, typeId: 'convax.chat' as CanvasNodeTypeId,
        dataVersion: 1, data: { title: 'Keyboard isolation', cwd: scaffold.workspaceCwd },
        position: { x: 80, y: 240 }, revision: 0,
      },
    })
  }
  return { id, resources }
}

async function openCanvas(browser: Browser, scaffold: WebScaffold, id: CanvasId): Promise<Page> {
  const page = await newEnglishPage(browser)
  const startup = watchConsole(page)
  const consoleErrors: string[] = []
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  onTestFinished(async ({ task }) => {
    try {
      if (task.result?.state === 'fail') {
        globalThis.console.error('Convax browser failure diagnostics', { pageErrors: startup.pageErrors, consoleErrors })
        await saveFailureShot(page, 'web-e2e-convax-canvas-interactions')
      }
    } finally { await page.close() }
  })
  await page.goto(scaffold.authenticatedUrl)
  await page.locator('[data-convax-workspace]').waitFor({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Workspace actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'All canvases', exact: true }).click()
  await page.locator('[data-canvas-manager-row="' + id + '"] button').first().click()
  await page.locator('[data-convax-graph]').waitFor()
  await expect.poll(() => page.locator('.react-flow__node').count()).toBe(canvas(scaffold, id).nodes.length)
  await page.getByRole('combobox', { name: 'Canvas input mode', exact: true }).selectOption('touchpad')
  expect(startup.pageErrors).toEqual([])
  return page
}

function node(page: Page, id: CanvasNodeId) {
  return page.locator(`.react-flow__node[data-id="${id}"]`)
}

function positions(scaffold: WebScaffold, id: CanvasId) {
  return canvas(scaffold, id).nodes.map(item => ({ id: item.id, position: item.position }))
}

async function zoom(page: Page): Promise<number> {
  return page.locator('.react-flow__viewport').evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).a)
}

async function beginDrag(page: Page, item: CanvasNode, target: { x: number; y: number }): Promise<void> {
  const header = await node(page, item.id).locator('[data-convax-resource-header]').boundingBox()
  if (header === null) throw new Error('Resource header is not visible for dragging')
  const scale = await zoom(page)
  const point = { x: header.x + header.width / 2, y: header.y + header.height / 2 }
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  // React Flow starts its drag offset after the pointer crosses its movement threshold.
  await page.mouse.move(point.x + 4, point.y)
  await page.mouse.move(point.x + 4 + (target.x - item.position.x) * scale,
    point.y + (target.y - item.position.y) * scale, { steps: 12 })
}

async function resetZoom(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Reset zoom to 100%', exact: true }).click()
  await expect.poll(() => zoom(page)).toBe(1)
}

async function worldPoint(page: Page, point: { x: number; y: number }) {
  return page.locator('[data-convax-graph]').evaluate((element, screen) => {
    const bounds = element.getBoundingClientRect()
    const viewport = element.querySelector('.react-flow__viewport')
    if (viewport === null) throw new Error('The real graph has no rendered viewport')
    const matrix = new DOMMatrixReadOnly(getComputedStyle(viewport).transform)
    return { x: (screen.x - bounds.left - matrix.e) / matrix.a, y: (screen.y - bounds.top - matrix.f) / matrix.a }
  }, point)
}

async function selectedIds(page: Page): Promise<string[]> {
  return page.locator('.react-flow__node.selected').evaluateAll(elements => elements.map(element => element.getAttribute('data-id')!).sort())
}

async function addFolder(scaffold: WebScaffold, id: CanvasId, name: string, position = { x: 80, y: 350 }): Promise<CanvasNode> {
  const path = join(scaffold.workspaceCwd, name)
  await mkdir(path)
  await writeFile(join(path, 'README.md'), `# ${name}\n`)
  const folder: CanvasNode = {
    id: randomUUID() as CanvasNodeId, typeId: 'convax.folder' as CanvasNodeTypeId,
    dataVersion: 1, data: { path }, position, revision: 0,
  }
  await execute(scaffold, id, { kind: 'add-node', node: folder })
  return folder
}

async function connectToPoint(page: Page, id: CanvasNodeId, direction: 'source' | 'target', point: { x: number; y: number }): Promise<void> {
  const handle = await node(page, id).locator(`.react-flow__handle.${direction}`).boundingBox()
  if (handle === null) throw new Error(`Node ${id} has no visible ${direction} port`)
  const start = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }
  const hit = await page.evaluate((point) => {
    const element = document.elementFromPoint(point.x, point.y)
    return { nodeId: element?.closest('.react-flow__handle')?.getAttribute('data-nodeid'), element: element?.outerHTML.slice(0, 700) }
  }, start)
  expect(hit.nodeId, JSON.stringify({ start, hit })).toBe(id)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(point.x, point.y, { steps: 12 })
  await page.mouse.up()
}

function observeCanvas(scaffold: WebScaffold, id: CanvasId): CanvasDocument[] {
  const observations: CanvasDocument[] = []
  const stop = scaffold.ctx.convax.repository.subscribe(() => { observations.push(canvas(scaffold, id)) })
  onTestFinished(stop)
  return observations
}

async function observeChatCreation(page: Page) {
  const recording = await page.evaluateHandle(() => {
    const frames: {
      height: number
      cardHeight: number
      transcriptHeight: number
      handleY: number
      composerHeight: number
      phase: string
      notice: string | null
    }[] = []
    let previous: HTMLElement | null = null
    let remounts = 0
    let disappearances = 0
    let visible = false
    let stopped = false
    let frame = 0
    const sample = (): void => {
      const chat = document.querySelector<HTMLElement>('[data-convax-chat]')
      const node = chat?.closest<HTMLElement>('.react-flow__node')
      const rect = chat?.getBoundingClientRect()
      const showing = chat !== null && node !== null && node !== undefined && rect !== undefined
        && rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility === 'visible'
      if (!showing || chat === null || rect === undefined) {
        if (visible) disappearances += 1
        visible = false
        return
      }
      if (previous !== null && previous !== chat) remounts += 1
      previous = chat
      visible = true
      const scale = rect.width / chat.offsetWidth
      const scroll = chat.querySelector<HTMLElement>('[data-conversation-scroll]')
      const header = chat.querySelector<HTMLElement>('[data-convax-chat-header]')
      const pending = chat.querySelector('[data-convax-thread]')?.firstElementChild ?? header?.nextElementSibling
      const transcript = scroll ?? (pending instanceof HTMLElement ? pending : null)
      const composer = chat.querySelector<HTMLElement>('[data-composer-seat]')
      const handle = chat.querySelector<HTMLElement>('.react-flow__handle.target')
      if (handle === null) throw new Error('The Chat has no input handle')
      const handleRect = handle.getBoundingClientRect()
      const next = {
        height: chat.offsetHeight,
        cardHeight: scroll === null ? chat.offsetHeight : (scroll.getBoundingClientRect().bottom - rect.top) / scale,
        transcriptHeight: transcript?.offsetHeight ?? 0,
        handleY: (handleRect.top + handleRect.height / 2 - rect.top) / scale,
        composerHeight: composer?.offsetHeight ?? 0,
        phase: chat.querySelector('[data-convax-chat-phase]')?.getAttribute('data-convax-chat-phase') ?? 'pending',
        notice: chat.querySelector('[role="alert"], [role="status"]')?.textContent ?? null,
      }
      if (JSON.stringify(next) !== JSON.stringify(frames.at(-1))) frames.push(next)
    }
    const tick = (): void => {
      if (stopped) return
      sample()
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return {
      read: () => ({ frames, remounts, disappearances }),
      stop: () => { stopped = true; cancelAnimationFrame(frame) },
    }
  })
  onTestFinished(async () => {
    if (!page.isClosed()) await recording.evaluate((value) => { value.stop() })
    await recording.dispose()
  })
  return recording
}

async function paintFrame(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve() }) }))
}

async function allowClipboard(page: Page, scaffold: WebScaffold): Promise<void> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: scaffold.baseUrl })
}

async function clipboardSettled(page: Page): Promise<void> {
  await expect.poll(() => page.locator('[data-convax-graph]').getAttribute('data-convax-clipboard-pending')).not.toBe('true')
}

async function historySettled(page: Page): Promise<void> {
  await expect.poll(() => page.locator('[data-convax-graph]').getAttribute('data-convax-history-pending')).not.toBe('true')
}

async function resourcePresentation(page: Page, id: CanvasNodeId) {
  return node(page, id).locator('[data-convax-resource]').evaluate((element) => {
    if (!(element instanceof HTMLElement)) throw new Error('Resource is not an HTML element')
    const preview = element.querySelector('[data-convax-file-preview]')
    return { expanded: element.getAttribute('data-expanded'), width: element.offsetWidth,
      height: preview instanceof HTMLElement ? preview.offsetHeight : 0 }
  })
}

async function resizeResourceTo(page: Page, id: CanvasNodeId, name: string, width: number, height: number): Promise<void> {
  const card = node(page, id)
  if (await card.locator('[data-convax-resource]').getAttribute('data-expanded') !== 'true') {
    await card.getByRole('button', { name: `Expand ${name}`, exact: true }).click()
  }
  const current = await resourcePresentation(page, id)
  const grip = await card.getByRole('button', { name: 'Resize preview', exact: true }).boundingBox()
  if (grip === null) throw new Error('Expanded resource has no resize grip')
  const scale = await zoom(page)
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(grip.x + grip.width / 2 + (width - current.width) * scale,
    grip.y + grip.height / 2 + (height - current.height) * scale, { steps: 12 })
  await page.mouse.up()
  await expect.poll(() => resourcePresentation(page, id)).toEqual({ expanded: 'true', width, height })
}

describe('web e2e: Convax canvas interactions', () => {
  let scaffold: WebScaffold
  let browser: Browser

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      extraOverlayPath: join(BUNDLE, 'cordis.patch.yml'),
      extraInstallAnchors: [join(BUNDLE, 'package.json')],
    })
    browser = await chromium.launch()
  })
  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('transcript: selects native Chat text without moving its card or camera', async () => {
    const fixture = await seedCanvas(scaffold, 'Transcript selection', true)
    const page = await openCanvas(browser, scaffold, fixture.id)
    const chat = canvas(scaffold, fixture.id).nodes.find(item => item.typeId === 'convax.chat')!
    await expect.poll(() => scaffold.ctx.convax.workspace().chats.find(item => item.nodeId === chat.id)?.threads.length,
      { timeout: 15_000 }).toBe(1)
    const sessionId = scaffold.ctx.convax.workspace().chats.find(item => item.nodeId === chat.id)!.threads[0]!.sessionId
    await expect.poll(() => scaffold.ctx.agents.get(sessionId), { timeout: 15_000 }).toBeDefined()
    const agent = scaffold.ctx.agents.get(sessionId)!
    const text = 'Native Chat text can be selected without moving its card.'
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Show a paragraph for selection.' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('step/start', { turn: 1, step: 1 })
    agent.session.append('assistant/message', {
      stream: [], turn: 1, step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'fixture', model: 'fixture' } }),
    }, { surfaceOp: 'append' })
    agent.session.append('step/end', { turn: 1, step: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await scaffold.ctx.sessions.flush(agent.session)
    const paragraph = node(page, chat.id).getByText(text, { exact: true })
    await paragraph.waitFor()
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await paragraph.scrollIntoViewIfNeeded()
    expect(await paragraph.evaluate(element => getComputedStyle(element).cursor)).toBe('text')
    expect(await node(page, chat.id).locator('[data-convax-chat-drag]').evaluate(element => getComputedStyle(element).cursor)).toBe('grab')
    const bounds = await paragraph.evaluate((element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      const rect = range.getClientRects()[0]
      if (rect === undefined) throw new Error('Transcript paragraph has no text rectangle')
      return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 }
    })
    const before = positions(scaffold, fixture.id)
    const viewport = () => page.locator('.react-flow__viewport').getAttribute('style')
    const camera = await viewport()
    await page.mouse.move(bounds.left + 1, bounds.y)
    await page.mouse.down()
    await page.mouse.move(bounds.right - 1, bounds.y, { steps: 12 })
    await page.mouse.up()
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain('Chat text can be selected')
    expect(positions(scaffold, fixture.id)).toEqual(before)
    expect(await viewport()).toBe(camera)
  })

  it('keyboard: selects, nudges, persists across reload, clears selection, and deletes resource nodes', async () => {
    const fixture = await seedCanvas(scaffold, 'Keyboard persistence')
    const first = fixture.resources[0]!
    const second = fixture.resources[1]!
    const page = await openCanvas(browser, scaffold, fixture.id)
    const console = watchConsole(page)
    await node(page, first.id).locator('[data-convax-resource-header]').click()
    await page.keyboard.press('ControlOrMeta+A')
    await expect.poll(() => page.locator('.react-flow__node.selected').count()).toBe(2)

    await page.keyboard.press('ArrowRight')
    await expect.poll(() => positions(scaffold, fixture.id)).toEqual(fixture.resources.map(item => ({
      id: item.id, position: { x: item.position.x + 5, y: item.position.y },
    })))
    await expect.poll(() => page.getByRole('button', { name: 'New chat', exact: true }).isEnabled()).toBe(true)
    await page.keyboard.press('ArrowDown')
    const moved = fixture.resources.map(item => ({
      id: item.id, position: { x: item.position.x + 5, y: item.position.y + 5 },
    }))
    await expect.poll(() => positions(scaffold, fixture.id)).toEqual(moved)

    await page.reload()
    await node(page, first.id).waitFor({ timeout: 30_000 })
    await expect.poll(() => node(page, first.id).getAttribute('style')).toContain('translate(85px, 85px)')
    await expect.poll(() => node(page, second.id).getAttribute('style')).toContain('translate(485px, 85px)')
    expect(positions(scaffold, fixture.id)).toEqual(moved)

    await node(page, first.id).locator('[data-convax-resource-header]').click()
    await page.keyboard.press('Escape')
    await expect.poll(() => page.locator('.react-flow__node.selected').count()).toBe(0)
    const revision = canvas(scaffold, fixture.id).revision
    await page.keyboard.press('Delete')
    expect(canvas(scaffold, fixture.id).revision).toBe(revision)

    await node(page, first.id).locator('[data-convax-resource-header]').click()
    await page.keyboard.press('Delete')
    await expect.poll(() => canvas(scaffold, fixture.id).nodes.map(item => item.id)).toEqual([second.id])
    await expect.poll(() => node(page, first.id).count()).toBe(0)
    expect(positions(scaffold, fixture.id)).toEqual([moved[1]])
    await page.keyboard.press('Escape')
    await mkdir(EXPECTED, { recursive: true })
    await compareOrRefreshGolden(join(EXPECTED, 'keyboard.expected.md'),
      await captureStableAria(page, '[data-convax-graph]', scaffold.workspaceCwd), webSnapshotMode())
    expect(console.pageErrors).toEqual([])
  })

  it('keyboard: leaves composition, Chat editing, and dialog text shortcuts with their native controls', async () => {
    const fixture = await seedCanvas(scaffold, 'Keyboard isolation', true)
    const page = await openCanvas(browser, scaffold, fixture.id)
    const console = watchConsole(page)
    await expect.poll(() => scaffold.ctx.convax.workspace().chats.find(chat => chat.canvasId === fixture.id)?.threads.length,
      { timeout: 15_000 }).toBe(1)
    const input = page.locator('[data-composer-input][contenteditable="true"]')
    await input.waitFor()
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    const before = positions(scaffold, fixture.id)
    await writeComposerDraft(page, input, 'Native editing')
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.press('Backspace')
    await page.keyboard.type('hello')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowRight')
    expect(await input.innerText()).toBe('hello')
    expect(positions(scaffold, fixture.id)).toEqual(before)
    expect(canvas(scaffold, fixture.id).nodes).toHaveLength(3)

    await node(page, fixture.resources[0]!.id).locator('[data-convax-resource-header]').click()
    const compositionWasNotClaimed = await page.locator('[data-convax-graph]').evaluate(element => element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Delete', isComposing: true, bubbles: true, cancelable: true }),
    ))
    expect(compositionWasNotClaimed).toBe(true)
    expect(canvas(scaffold, fixture.id).nodes).toHaveLength(3)

    await page.getByRole('button', { name: 'Workspace actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'All canvases', exact: true }).click()
    await page.locator(`[data-canvas-manager-row="${fixture.id}"]`).getByRole('button', { name: /Actions for /i }).click()
    await page.getByRole('menuitem', { name: 'Rename canvas', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Rename canvas', exact: true })
    const title = dialog.getByRole('textbox', { name: 'Canvas name', exact: true })
    await title.click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.press('Backspace')
    expect(await title.inputValue()).toBe('')
    expect(canvas(scaffold, fixture.id).nodes).toHaveLength(3)
    expect(positions(scaffold, fixture.id)).toEqual(before)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    expect(console.pageErrors).toEqual([])
  })

  it('snapping: shows edge and center guides, commits exact alignment, and retains it after reload', async () => {
    const fixture = await seedCanvas(scaffold, 'Snapping alignment')
    const first = fixture.resources[0]!
    const second = fixture.resources[1]!
    const page = await openCanvas(browser, scaffold, fixture.id)
    const console = watchConsole(page)
    await resetZoom(page)
    const guides = page.locator('[data-convax-snap-guide]')

    const before = canvas(scaffold, fixture.id).revision
    await beginDrag(page, second, { x: first.position.x + 3, y: 210 })
    await expect.poll(() => page.locator('[data-convax-snap-guide="x"]').count()).toBeGreaterThan(0)
    expect(canvas(scaffold, fixture.id).revision).toBe(before)
    await mkdir(ARTIFACTS, { recursive: true })
    await page.screenshot({ path: join(ARTIFACTS, 'convax-interactions-snapping.png') })
    await page.mouse.up()
    await expect.poll(() => canvas(scaffold, fixture.id).nodes.find(item => item.id === second.id)?.position.x).toBe(first.position.x)
    await expect.poll(() => guides.count()).toBe(0)
    await expect.poll(() => page.getByRole('button', { name: 'New chat', exact: true }).isEnabled()).toBe(true)

    const aligned = canvas(scaffold, fixture.id).nodes.find(item => item.id === second.id)!
    await beginDrag(page, aligned, { x: 600, y: first.position.y + 3 })
    await expect.poll(() => page.locator('[data-convax-snap-guide="y"]').count()).toBeGreaterThan(0)
    await page.mouse.up()
    await expect.poll(() => canvas(scaffold, fixture.id).nodes.find(item => item.id === second.id)?.position.y).toBe(first.position.y)
    await expect.poll(() => guides.count()).toBe(0)
    await expect.poll(() => page.getByRole('button', { name: 'New chat', exact: true }).isEnabled()).toBe(true)

    await node(page, first.id).getByRole('button', { name: 'Expand notes.txt', exact: true }).click()
    const handle = node(page, first.id).getByRole('button', { name: 'Resize preview', exact: true })
    const resize = await handle.boundingBox()
    if (resize === null) throw new Error('Expanded resource has no resize handle')
    await page.mouse.move(resize.x + resize.width / 2, resize.y + resize.height / 2)
    await page.mouse.down()
    await page.mouse.move(resize.x + resize.width / 2 + 160, resize.y + resize.height / 2, { steps: 8 })
    await page.mouse.up()
    await node(page, first.id).getByRole('button', { name: 'Collapse notes.txt', exact: true }).click()
    await expect.poll(() => node(page, first.id).evaluate((element) => {
      if (!(element instanceof HTMLElement)) throw new Error('Resource node is not an HTML element')
      return element.offsetWidth
    })).toBe(480)
    const other = canvas(scaffold, fixture.id).nodes.find(item => item.id === second.id)!
    const center = first.position.x + 240
    await beginDrag(page, other, { x: center - 160 + 3, y: 210 })
    await expect.poll(() => page.locator('[data-convax-snap-guide="x"]').getAttribute('data-coordinate')).toBe(String(center))
    await page.mouse.up()
    await expect.poll(() => canvas(scaffold, fixture.id).nodes.find(item => item.id === second.id)?.position.x).toBe(center - 160)
    await expect.poll(() => guides.count()).toBe(0)

    const committed = positions(scaffold, fixture.id)
    await page.reload()
    await node(page, second.id).waitFor({ timeout: 30_000 })
    await expect.poll(() => node(page, second.id).evaluate((element) => {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform)
      return matrix.e
    })).toBe(center - 160)
    expect(positions(scaffold, fixture.id)).toEqual(committed)
    await mkdir(EXPECTED, { recursive: true })
    await compareOrRefreshGolden(join(EXPECTED, 'snapping.expected.md'),
      await captureStableAria(page, '[data-convax-graph]', scaffold.workspaceCwd), webSnapshotMode())
    expect(console.pageErrors).toEqual([])
  })

  it('snapping: moves a selection together and cancels its preview without committing on Escape', async () => {
    const fixture = await seedCanvas(scaffold, 'Snapping selection')
    const first = fixture.resources[0]!
    const second = fixture.resources[1]!
    const anchor: CanvasNode = { ...first, id: randomUUID() as CanvasNodeId, position: { x: 80, y: 420 } }
    await execute(scaffold, fixture.id, { kind: 'add-node', node: anchor })
    const page = await openCanvas(browser, scaffold, fixture.id)
    const console = watchConsole(page)
    await resetZoom(page)
    await node(page, first.id).locator('[data-convax-resource-header]').click()
    await page.keyboard.down('ControlOrMeta')
    await node(page, second.id).locator('[data-convax-resource-header]').click()
    await page.keyboard.up('ControlOrMeta')
    await expect.poll(() => page.locator('.react-flow__node.selected').count()).toBe(2)

    await beginDrag(page, first, { x: 83, y: 230 })
    await expect.poll(() => page.locator('[data-convax-snap-guide="x"]').count()).toBeGreaterThan(0)
    await page.mouse.up()
    await expect.poll(() => canvas(scaffold, fixture.id).nodes.find(item => item.id === first.id)?.position.x).toBe(80)
    await expect.poll(() => canvas(scaffold, fixture.id).nodes.find(item => item.id === first.id)?.position.y).toBe(230)
    const moved = canvas(scaffold, fixture.id)
    const a = moved.nodes.find(item => item.id === first.id)!
    const b = moved.nodes.find(item => item.id === second.id)!
    expect(b.position.x - a.position.x).toBe(second.position.x - first.position.x)
    expect(b.position.y - a.position.y).toBe(second.position.y - first.position.y)
    expect(moved.nodes.find(item => item.id === anchor.id)?.position).toEqual(anchor.position)
    await expect.poll(() => page.getByRole('button', { name: 'New chat', exact: true }).isEnabled()).toBe(true)

    const committed = positions(scaffold, fixture.id)
    const revision = moved.revision
    await beginDrag(page, a, { x: 83, y: 330 })
    await expect.poll(() => page.locator('[data-convax-snap-guide]').count()).toBeGreaterThan(0)
    expect(positions(scaffold, fixture.id)).toEqual(committed)
    await page.keyboard.press('Escape')
    await expect.poll(() => page.locator('[data-convax-snap-guide]').count()).toBe(0)
    await page.mouse.up()
    await page.reload()
    await node(page, first.id).waitFor({ timeout: 30_000 })
    expect(canvas(scaffold, fixture.id).revision).toBe(revision)
    expect(positions(scaffold, fixture.id)).toEqual(committed)
    expect(console.pageErrors).toEqual([])
  })

  it('context: creates a project through the real directory picker at the clicked canvas position and fits menus inside the viewport', async () => {
    const fixture = await seedCanvas(scaffold, 'Context creation')
    const directory = join(scaffold.workspaceCwd, 'context-picked-project')
    await mkdir(directory)
    const page = await openCanvas(browser, scaffold, fixture.id)
    const console = watchConsole(page)
    await resetZoom(page)
    const point = { x: 150, y: 150 }
    const expected = await worldPoint(page, point)
    await page.mouse.click(point.x, point.y, { button: 'right' })
    const menu = page.getByRole('menu')
    await menu.waitFor()
    for (const label of ['Add project', 'Add files', 'New chat', 'Select all', 'Fit canvas']) {
      expect(await menu.getByRole('menuitem', { name: label, exact: true }).count()).toBe(1)
    }
    await mkdir(EXPECTED, { recursive: true })
    await compareOrRefreshGolden(join(EXPECTED, 'context.expected.md'),
      await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd), webSnapshotMode())
    await menu.getByRole('menuitem', { name: 'Add project', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Select Workspace Directory', exact: true })
    await picker.waitFor()
    await picker.getByRole('button', { name: 'Edit path', exact: true }).click()
    const path = picker.getByRole('textbox', { name: 'Edit path', exact: true })
    await path.fill(directory)
    await path.press('Enter')
    await picker.getByRole('button', { name: 'Open', exact: true }).click()
    await picker.waitFor({ state: 'hidden' })
    await expect.poll(() => canvas(scaffold, fixture.id).nodes.length).toBe(3)
    const added = canvas(scaffold, fixture.id).nodes.find(item => item.typeId === 'convax.folder')!
    expect(added.data.path).toBe(directory)
    expect(added.position.x).toBeCloseTo(expected.x, 3)
    expect(added.position.y).toBeCloseTo(expected.y, 3)
    await node(page, added.id).waitFor()

    await page.mouse.click(1670, 990, { button: 'right' })
    await menu.waitFor()
    const bounds = await menu.boundingBox()
    if (bounds === null) throw new Error('The open context menu has no visible bounds')
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.y).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(1680)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(1000)
    await mkdir(ARTIFACTS, { recursive: true })
    await page.screenshot({ path: join(ARTIFACTS, 'convax-interactions-context.png') })
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'hidden' })
    await page.mouse.click(1670, 990, { button: 'right' })
    await menu.waitFor()
    await page.mouse.click(30, 24)
    await menu.waitFor({ state: 'hidden' })
    expect(console.pageErrors).toEqual([])
  })

  it('context: targets an unselected node individually and a selected node as the whole selection without changing selection on open', async () => {
    const fixture = await seedCanvas(scaffold, 'Context targets')
    const first = fixture.resources[0]!
    const second = fixture.resources[1]!
    const third: CanvasNode = { ...first, id: randomUUID() as CanvasNodeId, position: { x: 80, y: 350 } }
    await execute(scaffold, fixture.id, { kind: 'add-node', node: third })
    const page = await openCanvas(browser, scaffold, fixture.id)
    const console = watchConsole(page)
    await resetZoom(page)
    await node(page, first.id).locator('[data-convax-resource-header]').click()
    await page.keyboard.down('ControlOrMeta')
    await node(page, second.id).locator('[data-convax-resource-header]').click()
    await page.keyboard.up('ControlOrMeta')
    const selection = [first.id, second.id].sort()
    await expect.poll(() => selectedIds(page)).toEqual(selection)
    const firstBounds = await node(page, first.id).boundingBox()
    const secondBounds = await node(page, second.id).boundingBox()
    if (firstBounds === null || secondBounds === null) throw new Error('Selected nodes have no rendered bounds')
    await page.mouse.click((firstBounds.x + firstBounds.width + secondBounds.x) / 2,
      firstBounds.y + firstBounds.height / 2, { button: 'right' })
    const menu = page.getByRole('menu')
    await menu.waitFor()
    expect(await page.locator('[data-convax-context-menu]').getAttribute('data-target-count')).toBe('2')
    expect(await selectedIds(page)).toEqual(selection)
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'hidden' })

    await node(page, third.id).locator('[data-convax-resource-header]').click({ button: 'right' })
    await menu.waitFor()
    expect(await page.locator('[data-convax-context-menu]').getAttribute('data-target-count')).toBe('1')
    expect(await selectedIds(page)).toEqual(selection)
    await menu.getByRole('menuitem', { name: 'Remove selected references', exact: true }).click()
    await expect.poll(() => canvas(scaffold, fixture.id).nodes.map(item => item.id).sort()).toEqual(selection)
    await expect.poll(() => node(page, third.id).count()).toBe(0)
    await expect.poll(() => page.getByRole('button', { name: 'New chat', exact: true }).isEnabled()).toBe(true)

    await node(page, first.id).locator('[data-convax-resource-header]').click({ button: 'right' })
    await menu.waitFor()
    expect(await page.locator('[data-convax-context-menu]').getAttribute('data-target-count')).toBe('2')
    expect(await selectedIds(page)).toEqual(selection)
    await menu.getByRole('menuitem', { name: 'Remove selected references', exact: true }).click()
    await expect.poll(() => canvas(scaffold, fixture.id).nodes).toHaveLength(0)
    await expect.poll(() => page.locator('.react-flow__node').count()).toBe(0)
    expect(console.pageErrors).toEqual([])
  })

  it('context: preserves the native Chat editor context menu', async () => {
    const fixture = await seedCanvas(scaffold, 'Context editor', true)
    const page = await openCanvas(browser, scaffold, fixture.id)
    const console = watchConsole(page)
    const input = page.locator('[data-composer-input][contenteditable="true"]')
    await input.waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await writeComposerDraft(page, input, 'Native context')
    await input.click({ button: 'right', position: { x: 40, y: 12 } })
    expect(await page.locator('[data-convax-context-menu]').count()).toBe(0)
    const nativeDefault = await input.evaluate(element => element.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2,
    })))
    expect(nativeDefault).toBe(true)
    expect(await input.innerText()).toBe('Native context')
    expect(console.pageErrors).toEqual([])
  })

  it('connection-create: creates a Chat and its edge atomically from a folder and adds one native reference', async () => {
    const fixture = await seedCanvas(scaffold, 'Connected Chat')
    const folder = await addFolder(scaffold, fixture.id, 'connected-project')
    const page = await openCanvas(browser, scaffold, fixture.id)
    const console = watchConsole(page)
    await resetZoom(page)
    const before = canvas(scaffold, fixture.id)
    const observations = observeCanvas(scaffold, fixture.id)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const published = Promise.withResolvers<undefined>()
    const acknowledge = Promise.withResolvers<undefined>()
    const originalCreateThread = scaffold.ctx.convax.createThread.bind(scaffold.ctx.convax)
    const initialRequests: Promise<Awaited<ReturnType<typeof originalCreateThread>>>[] = []
    const creation = vi.spyOn(scaffold.ctx.convax, 'createThread').mockImplementation((request) => {
      if (request.canvasId !== fixture.id) return originalCreateThread(request)
      entered.resolve(undefined)
      const result = release.promise.then(async () => {
        const result = await originalCreateThread(request)
        // Workspace subscribers can receive the durable binding before the creation response arrives.
        published.resolve(undefined)
        await acknowledge.promise
        return result
      })
      initialRequests.push(result)
      return result
    })
    onTestFinished(async () => {
      creation.mockRestore()
      release.resolve(undefined)
      acknowledge.resolve(undefined)
      await Promise.allSettled(initialRequests)
    })
    const recording = await observeChatCreation(page)
    await connectToPoint(page, folder.id, 'source', { x: 1250, y: 650 })
    const preview = page.locator('[data-convax-connection-preview]')
    await preview.waitFor()
    const menu = page.getByRole('menu')
    await menu.getByRole('menuitem', { name: 'New chat', exact: true }).click()
    await entered.promise
    await expect.poll(() => canvas(scaffold, fixture.id).nodes.filter(item => item.typeId === 'convax.chat').length).toBe(1)
    expect(await page.getByRole('dialog', { name: 'Select Workspace Directory', exact: true }).count()).toBe(0)
    const created = canvas(scaffold, fixture.id).nodes.find(item => item.typeId === 'convax.chat')!
    expect(created.data.cwd).toBe(folder.data.path)
    const atomic = observations.find(document => document.revision === before.revision + 1)
    expect(atomic?.nodes).toHaveLength(before.nodes.length + 1)
    expect(atomic?.connections).toHaveLength(1)
    expect(atomic?.connections[0]).toMatchObject({
      source: folder.id, sourcePort: 'output', target: created.id, targetPort: 'input', purpose: 'input',
    })
    const chat = page.locator(`[data-convax-chat="${created.id}"]`)
    await chat.waitFor({ state: 'visible' })
    await paintFrame(page)
    const pending = await recording.evaluate(value => value.read())
    expect(pending.frames.length).toBeGreaterThan(0)
    release.resolve(undefined)
    await published.promise
    await expect.poll(() => scaffold.ctx.convax.workspace().chats.find(chat => chat.nodeId === created.id)?.threads.length,
      { timeout: 15_000 }).toBe(1)
    await chat.locator('[data-composer-input][contenteditable="true"]').waitFor()
    await paintFrame(page)
    acknowledge.resolve(undefined)
    const removeReference = chat.getByRole('button', { name: 'Remove reference connected-project/', exact: true })
    await expect.poll(() => removeReference.count(), { timeout: 15_000 }).toBe(1)
    await chat.locator('[data-composer-input][contenteditable="true"]').waitFor()
    await paintFrame(page)
    const painted = await recording.evaluate(value => value.read())
    const diagnostics = JSON.stringify(painted)
    expect(painted.remounts, diagnostics).toBe(0)
    expect(painted.disappearances, diagnostics).toBe(0)
    expect(painted.frames.every(frame => frame.transcriptHeight === 240), diagnostics).toBe(true)
    const cardHeights = painted.frames.map(frame => frame.cardHeight)
    const handlePositions = painted.frames.map(frame => frame.handleY)
    expect(Math.max(...cardHeights) - Math.min(...cardHeights), diagnostics).toBeLessThan(2)
    expect(Math.max(...handlePositions) - Math.min(...handlePositions), diagnostics).toBeLessThan(2)
    expect(await chat.locator('[data-composer-chip]').count()).toBe(0)
    await expect.poll(() => preview.count()).toBe(0)
    expect(canvas(scaffold, fixture.id).connections).toHaveLength(1)
    expect(scaffold.ctx.convax.workspace().chats.find(item => item.nodeId === created.id)?.threads).toHaveLength(1)
    expect(console.pageErrors).toEqual([])
  })

  it('connection-create: creates a folder from an existing Chat input and keeps reference removal independent of its edge', async () => {
    const fixture = await seedCanvas(scaffold, 'Reverse connection', true)
    const page = await openCanvas(browser, scaffold, fixture.id)
    const console = watchConsole(page)
    const chatNode = canvas(scaffold, fixture.id).nodes.find(item => item.typeId === 'convax.chat')!
    await expect.poll(() => scaffold.ctx.convax.workspace().chats.find(chat => chat.nodeId === chatNode.id)?.threads.length,
      { timeout: 15_000 }).toBe(1)
    const originalThread = scaffold.ctx.convax.workspace().chats.find(chat => chat.nodeId === chatNode.id)!.threads[0]!.sessionId
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await resetZoom(page)
    const directory = join(scaffold.workspaceCwd, 'reverse-reference')
    await mkdir(directory)
    const before = canvas(scaffold, fixture.id)
    const observations = observeCanvas(scaffold, fixture.id)
    await connectToPoint(page, chatNode.id, 'target', { x: 1450, y: 200 })
    await page.locator('[data-convax-connection-preview]').waitFor()
    await page.getByRole('menu').getByRole('menuitem', { name: 'Add project', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Select Workspace Directory', exact: true })
    await picker.waitFor()
    await picker.getByRole('button', { name: 'Edit path', exact: true }).click()
    const path = picker.getByRole('textbox', { name: 'Edit path', exact: true })
    await path.fill(directory)
    await path.press('Enter')
    await picker.getByRole('button', { name: 'Open', exact: true }).click()
    await picker.waitFor({ state: 'hidden' })
    await expect.poll(() => canvas(scaffold, fixture.id).nodes.filter(item => item.typeId === 'convax.folder').length).toBe(1)
    const folder = canvas(scaffold, fixture.id).nodes.find(item => item.typeId === 'convax.folder')!
    expect(folder.data.path).toBe(directory)
    const atomic = observations.find(document => document.revision === before.revision + 1)
    expect(atomic?.nodes).toHaveLength(before.nodes.length + 1)
    expect(atomic?.connections).toHaveLength(1)
    expect(atomic?.connections[0]).toMatchObject({ source: folder.id, target: chatNode.id, purpose: 'input' })
    const edge = canvas(scaffold, fixture.id).connections[0]!
    const chat = page.locator(`[data-convax-chat="${chatNode.id}"]`)
    const removeReference = chat.getByRole('button', { name: 'Remove reference reverse-reference/', exact: true })
    await expect.poll(() => removeReference.count(), { timeout: 15_000 }).toBe(1)
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await chat.getByRole('group', { name: 'Pending attachments', exact: true }).hover()
    await removeReference.click()
    await expect.poll(() => removeReference.count()).toBe(0)
    expect(canvas(scaffold, fixture.id).connections).toEqual([edge])
    expect(canvas(scaffold, fixture.id).nodes.find(item => item.id === chatNode.id)?.data.cwd).toBe(scaffold.workspaceCwd)

    await page.reload()
    await chat.locator('[data-composer-input][contenteditable="true"]').waitFor({ timeout: 30_000 })
    expect(await removeReference.count()).toBe(0)
    expect(canvas(scaffold, fixture.id).connections).toEqual([edge])
    await chat.getByRole('button', { name: 'New thread', exact: true }).click()
    await expect.poll(() => scaffold.ctx.convax.workspace().chats.find(item => item.nodeId === chatNode.id)?.threads.length,
      { timeout: 15_000 }).toBe(2)
    await expect.poll(() => chat.locator('[data-thread-tab][data-active="true"]').getAttribute('data-thread-tab')).not.toBe(originalThread)
    expect(await removeReference.count()).toBe(0)
    await chat.locator(`[data-thread-tab="${originalThread}"]`).getByRole('tab').click()
    await expect.poll(() => chat.locator('[data-thread-tab][data-active="true"]').getAttribute('data-thread-tab')).toBe(originalThread)
    expect(await removeReference.count()).toBe(0)
    expect(canvas(scaffold, fixture.id).connections).toEqual([edge])
    expect(console.pageErrors).toEqual([])
  })

  it('connection-create: cancels pending creation with Escape or an outside click and still connects existing nodes', async () => {
    const fixture = await seedCanvas(scaffold, 'Connection cancellation', true)
    const folder = await addFolder(scaffold, fixture.id, 'cancelled-project', { x: 820, y: 80 })
    const page = await openCanvas(browser, scaffold, fixture.id)
    const console = watchConsole(page)
    const chatNode = canvas(scaffold, fixture.id).nodes.find(item => item.typeId === 'convax.chat')!
    await expect.poll(() => scaffold.ctx.convax.workspace().chats.find(chat => chat.nodeId === chatNode.id)?.threads.length,
      { timeout: 15_000 }).toBe(1)
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await resetZoom(page)
    const before = canvas(scaffold, fixture.id)
    const preview = page.locator('[data-convax-connection-preview]')
    await connectToPoint(page, folder.id, 'source', { x: 1450, y: 800 })
    await preview.waitFor()
    await page.keyboard.press('Escape')
    await preview.waitFor({ state: 'hidden' })
    await page.getByRole('menu').waitFor({ state: 'hidden' })
    expect(canvas(scaffold, fixture.id)).toEqual(before)
    await connectToPoint(page, folder.id, 'source', { x: 1450, y: 800 })
    await preview.waitFor()
    await page.mouse.click(30, 24)
    await preview.waitFor({ state: 'hidden' })
    await page.getByRole('menu').waitFor({ state: 'hidden' })
    expect(canvas(scaffold, fixture.id)).toEqual(before)

    const target = await node(page, chatNode.id).locator('.react-flow__handle.target').boundingBox()
    if (target === null) throw new Error('The existing Chat has no input port')
    await connectToPoint(page, fixture.resources[0]!.id, 'source', {
      x: target.x + target.width / 2, y: target.y + target.height / 2,
    })
    await expect.poll(() => canvas(scaffold, fixture.id).connections.length).toBe(1)
    expect(canvas(scaffold, fixture.id).connections[0]).toMatchObject({ source: fixture.resources[0]!.id, target: chatNode.id })
    expect(await preview.count()).toBe(0)
    expect(await page.getByRole('menu').count()).toBe(0)
    const chat = page.locator(`[data-convax-chat="${chatNode.id}"]`)
    await expect.poll(() => chat.getByRole('button', { name: 'Remove reference notes.txt', exact: true }).count(),
      { timeout: 15_000 }).toBe(1)
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await mkdir(ARTIFACTS, { recursive: true })
    await page.screenshot({ path: join(ARTIFACTS, 'convax-interactions-connection-create.png') })
    await mkdir(EXPECTED, { recursive: true })
    await compareOrRefreshGolden(join(EXPECTED, 'connection-create.expected.md'),
      await captureStableAria(page, '[data-convax-graph]', scaffold.workspaceCwd), webSnapshotMode())
    expect(console.pageErrors).toEqual([])
  })

  it('clipboard: copies a connected resource selection across canvases and duplicates it without overlapping existing cards', async () => {
    const fixture = await seedCanvas(scaffold, 'Clipboard source')
    const first = fixture.resources[0]!
    const second = fixture.resources[1]!
    second.position = { x: 680, y: 80 }
    await execute(scaffold, fixture.id, { kind: 'move-nodes', nodes: [{ id: second.id, position: second.position }] })
    await execute(scaffold, fixture.id, {
      kind: 'add-connection', connection: {
        id: randomUUID() as CanvasConnectionId, source: first.id, sourcePort: 'output',
        target: second.id, targetPort: 'input', purpose: 'input',
      },
    })
    const targetId = randomUUID() as CanvasId
    await execute(scaffold, targetId, { kind: 'create', title: 'Clipboard destination' })
    const original = canvas(scaffold, fixture.id)
    const page = await openCanvas(browser, scaffold, fixture.id)
    const console = watchConsole(page)
    await allowClipboard(page, scaffold)
    await page.evaluate(() => navigator.clipboard.writeText(''))
    await resetZoom(page)
    await node(page, first.id).getByRole('button', { name: 'Expand notes.txt', exact: true }).click()
    const resize = await node(page, first.id).getByRole('button', { name: 'Resize preview', exact: true }).boundingBox()
    if (resize === null) throw new Error('Expanded source resource has no resize grip')
    await page.mouse.move(resize.x + resize.width / 2, resize.y + resize.height / 2)
    await page.mouse.down()
    await page.mouse.move(resize.x + resize.width / 2 + 160, resize.y + resize.height / 2 - 40, { steps: 12 })
    await page.mouse.up()
    const presentation = (id: CanvasNodeId) => node(page, id).locator('[data-convax-resource]').evaluate((element) => {
      if (!(element instanceof HTMLElement)) throw new Error('Resource is not an HTML element')
      const preview = element.querySelector('[data-convax-file-preview]')
      return { expanded: element.getAttribute('data-expanded'), width: element.offsetWidth,
        height: preview instanceof HTMLElement ? preview.offsetHeight : 0 }
    })
    await expect.poll(() => presentation(first.id)).toEqual({ expanded: 'true', width: 480, height: 200 })
    await node(page, first.id).locator('[data-convax-resource-header]').click()
    await page.keyboard.press('ControlOrMeta+A')
    await expect.poll(() => selectedIds(page)).toEqual([first.id, second.id].sort())
    await page.keyboard.press('ControlOrMeta+C')
    await expect.poll(async () => (await page.evaluate(() => navigator.clipboard.readText())).includes(first.id)).toBe(true)
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(JSON.parse(copied)).toMatchObject({ kind: 'convax.canvas.nodes', version: 1 })
    await clipboardSettled(page)
    expect(canvas(scaffold, fixture.id)).toEqual(original)

    await page.getByRole('button', { name: 'Workspace actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'All canvases', exact: true }).click()
    await page.locator('[data-canvas-manager-row="' + targetId + '"] button').first().click()
    await expect.poll(() => page.locator('.react-flow__node').count()).toBe(0)
    await page.mouse.click(840, 420)
    await page.keyboard.press('ControlOrMeta+V')
    await expect.poll(() => canvas(scaffold, targetId).nodes.length).toBe(2)
    const pasted = canvas(scaffold, targetId)
    const pastedFirst = pasted.nodes.find(item => item.data.path === first.data.path)!
    const pastedSecond = pasted.nodes.find(item => item.data.path === second.data.path)!
    expect(pasted.nodes.every(item => !original.nodes.some(source => source.id === item.id))).toBe(true)
    expect(pasted.connections).toHaveLength(1)
    expect(pasted.connections[0]).toMatchObject({ source: pastedFirst.id, target: pastedSecond.id, purpose: 'input' })
    expect(pasted.connections[0]!.id).not.toBe(original.connections[0]!.id)
    expect(pastedSecond.position.x - pastedFirst.position.x).toBe(second.position.x - first.position.x)
    expect(pastedSecond.position.y - pastedFirst.position.y).toBe(second.position.y - first.position.y)
    await expect.poll(() => selectedIds(page)).toEqual(pasted.nodes.map(item => item.id).sort())
    await expect.poll(() => presentation(pastedFirst.id)).toEqual({ expanded: 'true', width: 480, height: 200 })
    await clipboardSettled(page)
    await expect.poll(() => page.getByRole('button', { name: 'New chat', exact: true }).isEnabled()).toBe(true)

    await page.keyboard.press('ControlOrMeta+D')
    await expect.poll(() => canvas(scaffold, targetId).nodes.length).toBe(4)
    const duplicated = canvas(scaffold, targetId).nodes.filter(item => !pasted.nodes.some(old => old.id === item.id))
    await expect.poll(() => selectedIds(page)).toEqual(duplicated.map(item => item.id).sort())
    await expect.poll(() => presentation(duplicated.find(item => item.data.path === first.data.path)!.id))
      .toEqual({ expanded: 'true', width: 480, height: 200 })
    await clipboardSettled(page)
    expect(canvas(scaffold, targetId).connections).toHaveLength(2)
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(copied)
    const rectangles = new Map(await page.locator('.react-flow__node').evaluateAll(elements => elements.map((element) => {
      const bounds = element.getBoundingClientRect()
      return [element.getAttribute('data-id')!, { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }] as const
    })))
    for (const item of duplicated) {
      const bounds = rectangles.get(item.id)
      if (bounds === undefined) throw new Error('A duplicated resource is not rendered')
      for (const old of pasted.nodes) {
        const previous = rectangles.get(old.id)
        if (previous === undefined) throw new Error('A pasted resource is not rendered')
        expect(bounds.x < previous.x + previous.width && bounds.x + bounds.width > previous.x
          && bounds.y < previous.y + previous.height && bounds.y + bounds.height > previous.y).toBe(false)
      }
    }
    expect(canvas(scaffold, fixture.id)).toEqual(original)
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await mkdir(ARTIFACTS, { recursive: true })
    await page.screenshot({ path: join(ARTIFACTS, 'convax-interactions-clipboard.png') })
    await mkdir(EXPECTED, { recursive: true })
    await compareOrRefreshGolden(join(EXPECTED, 'clipboard.expected.md'),
      await captureStableAria(page, '[data-convax-graph]', scaffold.workspaceCwd), webSnapshotMode())
    expect(console.pageErrors).toEqual([])
  })

  it('clipboard: duplicates a linked Chat with its own Session and blank draft without restoring removed references', async () => {
    const fixture = await seedCanvas(scaffold, 'Clipboard Chat', true)
    const folder = await addFolder(scaffold, fixture.id, 'duplicated-project', { x: 820, y: 80 })
    const page = await openCanvas(browser, scaffold, fixture.id)
    const console = watchConsole(page)
    await allowClipboard(page, scaffold)
    const originalChat = canvas(scaffold, fixture.id).nodes.find(item => item.typeId === 'convax.chat')!
    await expect.poll(() => scaffold.ctx.convax.workspace().chats.find(chat => chat.nodeId === originalChat.id)?.threads.length,
      { timeout: 15_000 }).toBe(1)
    const originalSession = scaffold.ctx.convax.workspace().chats.find(chat => chat.nodeId === originalChat.id)!.threads[0]!.sessionId
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await resetZoom(page)
    const target = await node(page, originalChat.id).locator('.react-flow__handle.target').boundingBox()
    if (target === null) throw new Error('The source Chat has no input port')
    await connectToPoint(page, folder.id, 'source', { x: target.x + target.width / 2, y: target.y + target.height / 2 })
    const sourceChat = page.locator(`[data-convax-chat="${originalChat.id}"]`)
    const remove = sourceChat.getByRole('button', { name: 'Remove reference duplicated-project/', exact: true })
    await expect.poll(() => remove.count(), { timeout: 15_000 }).toBe(1)
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await sourceChat.getByRole('group', { name: 'Pending attachments', exact: true }).hover()
    await remove.click()
    await expect.poll(() => remove.count()).toBe(0)
    const sourceInput = sourceChat.locator('[data-composer-input][contenteditable="true"]')
    await writeComposerDraft(page, sourceInput, 'Source draft remains here')
    const before = canvas(scaffold, fixture.id)
    await node(page, folder.id).locator('[data-convax-resource-header]').click()
    await page.keyboard.press('ControlOrMeta+A')
    await expect.poll(() => selectedIds(page)).toEqual(before.nodes.map(item => item.id).sort())
    await page.keyboard.press('ControlOrMeta+D')
    await expect.poll(() => canvas(scaffold, fixture.id).nodes.length).toBe(before.nodes.length * 2)
    const after = canvas(scaffold, fixture.id)
    const newNodes = after.nodes.filter(item => !before.nodes.some(old => old.id === item.id))
    const newChat = newNodes.find(item => item.typeId === 'convax.chat')!
    const newFolder = newNodes.find(item => item.typeId === 'convax.folder')!
    expect(newChat.data).toEqual(originalChat.data)
    expect(newFolder.data.path).toBe(folder.data.path)
    expect(after.connections).toHaveLength(2)
    expect(after.connections.find(item => item.source === newFolder.id && item.target === newChat.id)).toBeDefined()
    for (const old of before.nodes) expect(after.nodes.find(item => item.id === old.id)).toEqual(old)
    expect(after.connections.find(item => item.id === before.connections[0]!.id)).toEqual(before.connections[0])
    await expect.poll(() => scaffold.ctx.convax.workspace().chats.find(chat => chat.nodeId === newChat.id)?.threads.length,
      { timeout: 15_000 }).toBe(1)
    const copiedSession = scaffold.ctx.convax.workspace().chats.find(chat => chat.nodeId === newChat.id)!.threads[0]!.sessionId
    expect(copiedSession).not.toBe(originalSession)
    const copiedChat = page.locator(`[data-convax-chat="${newChat.id}"]`)
    await copiedChat.locator('[data-composer-input][contenteditable="true"]').waitFor()
    expect(await copiedChat.locator('[data-composer-input][contenteditable="true"]').textContent()).toBe('')
    expect(await copiedChat.getByRole('group', { name: 'Pending attachments', exact: true }).count()).toBe(0)
    expect(await sourceInput.textContent()).toBe('Source draft remains here')
    expect(await sourceChat.getByRole('button', { name: 'Remove reference duplicated-project/', exact: true }).count()).toBe(0)
    expect(console.pageErrors).toEqual([])
  })

  it('clipboard: preserves native editor shortcuts and rejects ordinary or malformed clipboard payloads without graph writes', async () => {
    const fixture = await seedCanvas(scaffold, 'Clipboard isolation', true)
    const page = await openCanvas(browser, scaffold, fixture.id)
    const console = watchConsole(page)
    await allowClipboard(page, scaffold)
    const input = page.locator('[data-composer-input][contenteditable="true"]')
    await input.waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    const before = canvas(scaffold, fixture.id)
    await writeComposerDraft(page, input, 'Native clipboard text')
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.press('ControlOrMeta+C')
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Native clipboard text')
    await page.keyboard.press('ControlOrMeta+V')
    await expect.poll(() => input.textContent()).toBe('Native clipboard text')
    await page.keyboard.press('ControlOrMeta+D')
    expect(canvas(scaffold, fixture.id)).toEqual(before)

    await page.mouse.click(1550, 200)
    await page.evaluate(() => navigator.clipboard.writeText('Ordinary unrelated clipboard text'))
    await page.keyboard.press('ControlOrMeta+V')
    const invalid = page.getByText('Clipboard does not contain canvas nodes', { exact: true })
    await invalid.waitFor()
    await clipboardSettled(page)
    expect(canvas(scaffold, fixture.id)).toEqual(before)
    await invalid.waitFor({ state: 'hidden' })
    await page.evaluate(text => navigator.clipboard.writeText(text), JSON.stringify({
      kind: 'convax.canvas.nodes', version: 1, nodes: [{ id: 'malformed-node' }], connections: [], dimensions: {},
    }))
    await page.keyboard.press('ControlOrMeta+V')
    await invalid.waitFor()
    await clipboardSettled(page)
    expect(canvas(scaffold, fixture.id)).toEqual(before)
    expect(await input.textContent()).toBe('Native clipboard text')
    expect(console.pageErrors).toEqual([])
  })

  it('clipboard: preserves the measured size and collapse state of two closely spaced narrow Chats when duplicating', async () => {
    const id = randomUUID() as CanvasId
    await execute(scaffold, id, { kind: 'create', title: 'Clipboard compact Chats' })
    const originals: CanvasNode[] = []
    for (const [index, title] of ['Compact A', 'Compact B'].entries()) {
      const item: CanvasNode = {
        id: randomUUID() as CanvasNodeId, typeId: 'convax.chat' as CanvasNodeTypeId,
        dataVersion: 1, data: { title, cwd: scaffold.workspaceCwd },
        position: { x: 80 + index * 740, y: 80 }, revision: 0,
      }
      await execute(scaffold, id, { kind: 'add-node', node: item })
      originals.push(item)
    }
    const page = await openCanvas(browser, scaffold, id)
    const console = watchConsole(page)
    await allowClipboard(page, scaffold)
    await expect.poll(() => scaffold.ctx.convax.workspace().chats.filter(chat => chat.canvasId === id
      && chat.threads.length === 1).length, { timeout: 15_000 }).toBe(2)
    await expect.poll(() => page.locator('[data-composer-input][contenteditable="true"]').count()).toBe(2)
    const sessions = scaffold.ctx.convax.workspace().chats.filter(chat => chat.canvasId === id)
      .flatMap(chat => chat.threads.map(thread => thread.sessionId))
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await resetZoom(page)
    for (const original of originals) {
      const chat = page.locator(`[data-convax-chat="${original.id}"]`)
      const grip = await chat.getByRole('button', { name: 'Resize chat', exact: true }).boundingBox()
      if (grip === null) throw new Error('Expanded source Chat has no resize grip')
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
      await page.mouse.down()
      await page.mouse.move(grip.x + grip.width / 2 - 220, grip.y + grip.height / 2, { steps: 12 })
      await page.mouse.up()
      await expect.poll(() => chat.evaluate((element) => {
        if (!(element instanceof HTMLElement)) throw new Error('Chat is not an HTML element')
        return element.offsetWidth
      })).toBe(400)
      await chat.getByRole('button', { name: 'Collapse chat', exact: true }).click()
      await expect.poll(() => chat.getAttribute('data-collapsed')).toBe('true')
    }
    const first = originals[0]!
    const second = originals[1]!
    const header = await node(page, second.id).locator('[data-convax-chat-drag]').boundingBox()
    if (header === null) throw new Error('Collapsed Chat has no drag header')
    const start = { x: header.x + header.width / 2, y: header.y + 2 }
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x + 4, start.y)
    await page.mouse.move(start.x + 4 - 300, start.y, { steps: 12 })
    await page.mouse.up()
    await expect.poll(() => canvas(scaffold, id).nodes.find(item => item.id === second.id)?.position.x).toBe(520)
    expect(canvas(scaffold, id).nodes.find(item => item.id === first.id)?.position.x).toBe(80)
    const sourceSizes = new Map(await page.locator('[data-convax-chat]').evaluateAll(elements => elements.map((element) => {
      if (!(element instanceof HTMLElement)) throw new Error('Chat is not an HTML element')
      return [element.getAttribute('data-convax-chat')!, { width: element.offsetWidth, height: element.offsetHeight }] as const
    })))
    for (const size of sourceSizes.values()) { expect(size.width).toBe(400); expect(size.height).toBeLessThan(100) }
    const before = canvas(scaffold, id)
    await page.mouse.click(1500, 180)
    await page.keyboard.press('ControlOrMeta+A')
    await expect.poll(() => selectedIds(page)).toEqual(originals.map(item => item.id).sort())
    await page.keyboard.press('ControlOrMeta+D')
    await expect.poll(() => canvas(scaffold, id).nodes.length).toBe(4)
    await clipboardSettled(page)
    const copied = canvas(scaffold, id).nodes.filter(item => !originals.some(original => original.id === item.id))
    const copiedA = copied.find(item => item.data.title === first.data.title)!
    const copiedB = copied.find(item => item.data.title === second.data.title)!
    expect(copiedB.position.x - copiedA.position.x).toBe(440)
    expect(copiedB.position.y - copiedA.position.y).toBe(0)
    for (const item of copied) {
      const chat = page.locator(`[data-convax-chat="${item.id}"]`)
      await expect.poll(() => chat.getAttribute('data-collapsed')).toBe('true')
      const original = originals.find(original => original.data.title === item.data.title)!
      expect(await chat.evaluate((element) => {
        if (!(element instanceof HTMLElement)) throw new Error('Copied Chat is not an HTML element')
        return { width: element.offsetWidth, height: element.offsetHeight }
      })).toEqual(sourceSizes.get(original.id))
    }
    await expect.poll(() => scaffold.ctx.convax.workspace().chats.filter(chat => copied.some(item => item.id === chat.nodeId)
      && chat.threads.length === 1).length, { timeout: 15_000 }).toBe(2)
    const copiedSessions = scaffold.ctx.convax.workspace().chats.filter(chat => copied.some(item => item.id === chat.nodeId))
      .flatMap(chat => chat.threads.map(thread => thread.sessionId))
    expect(new Set([...sessions, ...copiedSessions]).size).toBe(4)
    for (const original of before.nodes) expect(canvas(scaffold, id).nodes.find(item => item.id === original.id)).toEqual(original)
    const rectangles = new Map(await page.locator('.react-flow__node').evaluateAll(elements => elements.map((element) => {
      const bounds = element.getBoundingClientRect()
      return [element.getAttribute('data-id')!, { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }] as const
    })))
    for (const copy of copied) {
      const bounds = rectangles.get(copy.id)!
      for (const original of originals) {
        const previous = rectangles.get(original.id)!
        expect(bounds.x < previous.x + previous.width && bounds.x + bounds.width > previous.x
          && bounds.y < previous.y + previous.height && bounds.y + bounds.height > previous.y).toBe(false)
      }
    }
    const a = rectangles.get(copiedA.id)!
    const b = rectangles.get(copiedB.id)!
    expect(a.x + a.width).toBeLessThan(b.x)
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await mkdir(ARTIFACTS, { recursive: true })
    await page.screenshot({ path: join(ARTIFACTS, 'convax-interactions-clipboard-collapsed.png') })
    expect(console.pageErrors).toEqual([])
  })

  it('history: undoes and redoes a move without discarding an Agent data edit and persists the result across reload', async () => {
    const fixture = await seedCanvas(scaffold, 'History field isolation')
    const first = fixture.resources[0]!
    const second = fixture.resources[1]!
    const page = await openCanvas(browser, scaffold, fixture.id)
    const console = watchConsole(page)
    const other = canvas(scaffold, fixture.id).nodes.find(item => item.id === second.id)!
    await node(page, first.id).locator('[data-convax-resource-header]').click()
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => canvas(scaffold, fixture.id).nodes.find(item => item.id === first.id)?.position.x).toBe(85)
    await expect.poll(() => page.getByRole('button', { name: 'New chat', exact: true }).isEnabled()).toBe(true)
    const path = join(scaffold.workspaceCwd, 'history-agent-notes.txt')
    await writeFile(path, 'A separately committed Agent edit\n')
    await execute(scaffold, fixture.id, {
      kind: 'update-node', nodeId: first.id, dataVersion: 1, data: { path, agentNote: 'keep-me' },
    })
    await node(page, first.id).getByText('history-agent-notes.txt', { exact: true }).waitFor()
    await node(page, first.id).locator('[data-convax-resource-header]').click()
    await page.keyboard.press('ControlOrMeta+Z')
    await expect.poll(() => canvas(scaffold, fixture.id).nodes.find(item => item.id === first.id)?.position).toEqual(first.position)
    await historySettled(page)
    expect(canvas(scaffold, fixture.id).nodes.find(item => item.id === first.id)?.data).toEqual({ path, agentNote: 'keep-me' })
    expect(canvas(scaffold, fixture.id).nodes.find(item => item.id === second.id)).toEqual(other)
    await page.keyboard.press('ControlOrMeta+Shift+Z')
    await expect.poll(() => canvas(scaffold, fixture.id).nodes.find(item => item.id === first.id)?.position.x).toBe(85)
    await historySettled(page)
    expect(canvas(scaffold, fixture.id).nodes.find(item => item.id === first.id)?.data).toEqual({ path, agentNote: 'keep-me' })
    await page.reload()
    await node(page, first.id).getByText('history-agent-notes.txt', { exact: true }).waitFor({ timeout: 30_000 })
    await expect.poll(() => node(page, first.id).getAttribute('style')).toContain('translate(85px, 80px)')
    expect(canvas(scaffold, fixture.id).nodes.find(item => item.id === first.id)?.data).toEqual({ path, agentNote: 'keep-me' })
    expect(console.pageErrors).toEqual([])
  })

  it('history: treats a duplicated connected selection as one operation and restores its presentation on redo', async () => {
    const fixture = await seedCanvas(scaffold, 'History duplicate')
    const first = fixture.resources[0]!
    const second = fixture.resources[1]!
    second.position = { x: 680, y: 80 }
    await execute(scaffold, fixture.id, { kind: 'move-nodes', nodes: [{ id: second.id, position: second.position }] })
    await execute(scaffold, fixture.id, {
      kind: 'add-connection', connection: {
        id: randomUUID() as CanvasConnectionId, source: first.id, sourcePort: 'output',
        target: second.id, targetPort: 'input', purpose: 'input',
      },
    })
    const original = canvas(scaffold, fixture.id)
    const page = await openCanvas(browser, scaffold, fixture.id)
    const console = watchConsole(page)
    await resetZoom(page)
    await resizeResourceTo(page, first.id, 'notes.txt', 480, 200)
    await node(page, first.id).locator('[data-convax-resource-header]').click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.press('ControlOrMeta+D')
    await expect.poll(() => canvas(scaffold, fixture.id).nodes.length).toBe(4)
    await clipboardSettled(page)
    const duplicated = canvas(scaffold, fixture.id)
    const copies = duplicated.nodes.filter(item => !original.nodes.some(old => old.id === item.id))
    const copiedFile = copies.find(item => item.data.path === first.data.path)!
    await expect.poll(() => resourcePresentation(page, copiedFile.id)).toEqual({ expanded: 'true', width: 480, height: 200 })
    await page.keyboard.press('ControlOrMeta+Z')
    await expect.poll(() => canvas(scaffold, fixture.id).nodes.map(item => item.id).sort())
      .toEqual(original.nodes.map(item => item.id).sort())
    await historySettled(page)
    expect(canvas(scaffold, fixture.id).connections).toEqual(original.connections)
    for (const old of original.nodes) expect(canvas(scaffold, fixture.id).nodes.find(item => item.id === old.id)).toEqual(old)
    await page.keyboard.press('ControlOrMeta+Shift+Z')
    await expect.poll(() => canvas(scaffold, fixture.id).nodes.length).toBe(4)
    await historySettled(page)
    expect(canvas(scaffold, fixture.id).nodes.map(item => item.id).sort()).toEqual(duplicated.nodes.map(item => item.id).sort())
    expect(canvas(scaffold, fixture.id).connections).toEqual(duplicated.connections)
    await expect.poll(() => resourcePresentation(page, copiedFile.id)).toEqual({ expanded: 'true', width: 480, height: 200 })
    await page.reload()
    await node(page, copiedFile.id).waitFor({ timeout: 30_000 })
    await expect.poll(() => resourcePresentation(page, copiedFile.id)).toEqual({ expanded: 'true', width: 480, height: 200 })
    expect(canvas(scaffold, fixture.id).connections).toEqual(duplicated.connections)
    expect(console.pageErrors).toEqual([])
  })

  it('history: restores a deleted resource with its saved expanded dimensions and monotonic node revisions', async () => {
    const fixture = await seedCanvas(scaffold, 'History resource view')
    const first = fixture.resources[0]!
    const second = fixture.resources[1]!
    const page = await openCanvas(browser, scaffold, fixture.id)
    const console = watchConsole(page)
    await resetZoom(page)
    await resizeResourceTo(page, first.id, 'notes.txt', 480, 200)
    const revision = canvas(scaffold, fixture.id).nodes.find(item => item.id === first.id)!.revision
    await node(page, first.id).locator('[data-convax-resource-header]').click()
    await page.keyboard.press('Delete')
    await expect.poll(() => canvas(scaffold, fixture.id).nodes.map(item => item.id)).toEqual([second.id])
    await node(page, second.id).locator('[data-convax-resource-header]').click()
    await page.keyboard.press('ControlOrMeta+Z')
    await expect.poll(() => canvas(scaffold, fixture.id).nodes.some(item => item.id === first.id)).toBe(true)
    await historySettled(page)
    await expect.poll(() => resourcePresentation(page, first.id)).toEqual({ expanded: 'true', width: 480, height: 200 })
    const restoredRevision = canvas(scaffold, fixture.id).nodes.find(item => item.id === first.id)!.revision
    expect(restoredRevision).toBeGreaterThan(revision)
    await page.keyboard.press('ControlOrMeta+Shift+Z')
    await expect.poll(() => canvas(scaffold, fixture.id).nodes.map(item => item.id)).toEqual([second.id])
    await historySettled(page)
    await page.keyboard.press('ControlOrMeta+Z')
    await expect.poll(() => canvas(scaffold, fixture.id).nodes.some(item => item.id === first.id)).toBe(true)
    await historySettled(page)
    expect(canvas(scaffold, fixture.id).nodes.find(item => item.id === first.id)!.revision).toBeGreaterThan(restoredRevision)
    await expect.poll(() => resourcePresentation(page, first.id)).toEqual({ expanded: 'true', width: 480, height: 200 })
    await page.reload()
    await node(page, first.id).waitFor({ timeout: 30_000 })
    await expect.poll(() => resourcePresentation(page, first.id)).toEqual({ expanded: 'true', width: 480, height: 200 })
    expect(console.pageErrors).toEqual([])
  })

  it('history: restores a deleted Chat to the same Session and draft while preserving native editor undo and removed references', async () => {
    const fixture = await seedCanvas(scaffold, 'History Chat restore', true)
    const folder = await addFolder(scaffold, fixture.id, 'history-reference', { x: 820, y: 80 })
    const page = await openCanvas(browser, scaffold, fixture.id)
    const console = watchConsole(page)
    const chatNode = canvas(scaffold, fixture.id).nodes.find(item => item.typeId === 'convax.chat')!
    await expect.poll(() => scaffold.ctx.convax.workspace().chats.find(chat => chat.nodeId === chatNode.id)?.threads.length,
      { timeout: 15_000 }).toBe(1)
    const sessionId = scaffold.ctx.convax.workspace().chats.find(chat => chat.nodeId === chatNode.id)!.threads[0]!.sessionId
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await resetZoom(page)
    const target = await node(page, chatNode.id).locator('.react-flow__handle.target').boundingBox()
    if (target === null) throw new Error('The source Chat has no input port')
    await connectToPoint(page, folder.id, 'source', { x: target.x + target.width / 2, y: target.y + target.height / 2 })
    const chat = page.locator(`[data-convax-chat="${chatNode.id}"]`)
    const remove = chat.getByRole('button', { name: 'Remove reference history-reference/', exact: true })
    await expect.poll(() => remove.count(), { timeout: 15_000 }).toBe(1)
    const connection = canvas(scaffold, fixture.id).connections[0]!
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await chat.getByRole('group', { name: 'Pending attachments', exact: true }).hover()
    await remove.click()
    await expect.poll(() => remove.count()).toBe(0)
    const input = chat.locator('[data-composer-input][contenteditable="true"]')
    await writeComposerDraft(page, input, 'Keep native draft')
    const beforeNativeUndo = canvas(scaffold, fixture.id)
    await page.keyboard.press('ControlOrMeta+Z')
    await expect.poll(() => input.textContent()).not.toBe('Keep native draft')
    expect(canvas(scaffold, fixture.id)).toEqual(beforeNativeUndo)
    await page.keyboard.press('ControlOrMeta+Shift+Z')
    await expect.poll(() => input.textContent()).toBe('Keep native draft')
    expect(canvas(scaffold, fixture.id)).toEqual(beforeNativeUndo)

    await chat.locator('[data-convax-chat-drag]').click({ button: 'right', position: { x: 300, y: 2 } })
    await page.getByRole('menu').getByRole('menuitem', { name: 'Remove selected references', exact: true }).click()
    const confirmation = page.getByRole('dialog', { name: 'Stop and archive running threads?', exact: true })
    await confirmation.waitFor()
    await confirmation.getByRole('button', { name: 'Stop and delete', exact: true }).click()
    await expect.poll(() => canvas(scaffold, fixture.id).nodes.some(item => item.id === chatNode.id)).toBe(false)
    expect(scaffold.ctx.workspaceRegistry.archivedSessionIds).toContain(sessionId)
    await node(page, fixture.resources[0]!.id).locator('[data-convax-resource-header]').click()
    await page.keyboard.press('ControlOrMeta+Z')
    await expect.poll(() => canvas(scaffold, fixture.id).nodes.some(item => item.id === chatNode.id)).toBe(true)
    await historySettled(page)
    await expect.poll(() => scaffold.ctx.workspaceRegistry.archivedSessionIds.includes(sessionId)).toBe(false)
    const restoredChat = scaffold.ctx.convax.workspace().chats.find(item => item.nodeId === chatNode.id)!
    expect(restoredChat.threads.map(thread => thread.sessionId)).toEqual([sessionId])
    await input.waitFor({ timeout: 30_000 })
    await expect.poll(() => input.textContent()).toBe('Keep native draft')
    expect(await remove.count()).toBe(0)
    expect(canvas(scaffold, fixture.id).connections).toEqual([connection])
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await mkdir(ARTIFACTS, { recursive: true })
    await page.screenshot({ path: join(ARTIFACTS, 'convax-interactions-history.png') })
    await mkdir(EXPECTED, { recursive: true })
    await compareOrRefreshGolden(join(EXPECTED, 'history.expected.md'),
      await captureStableAria(page, '[data-convax-graph]', scaffold.workspaceCwd), webSnapshotMode())
    expect(console.pageErrors).toEqual([])
  })
})
