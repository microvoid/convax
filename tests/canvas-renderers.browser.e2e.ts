import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import type {} from '@deepseek-ai/dsh-convax-plugin-host'
import type { CanvasId, CanvasNodeId, CanvasOperationId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { acknowledgeReloadConnectionLoss, launchWebScaffold, watchConsole, type WebScaffold } from '../libs/dsh/apps/web/tests/scaffold.ts'
import { newEnglishPage, writeComposerDraft } from '../libs/dsh/apps/web/tests/support.ts'
import { canvasDocument, seedComplexCanvas } from './fixtures/complex-canvas.ts'
import { exportComplexCanvas } from './fixtures/export-complex-canvas.ts'
import { measurePan } from './fixtures/canvas-renderer-measurement.ts'

const RENDERER = fileURLToPath(new URL('../packages/plugin-renderer/', import.meta.url))
const COUNTER = join(RENDERER, 'examples', 'counter')
const ARTIFACTS = fileURLToPath(new URL('../.artifacts/', import.meta.url))
const MODES = ['react-flow', 'convax'] as const
type Mode = typeof MODES[number]

function graph(page: Page) {
  return page.locator('[data-convax-graph]:visible')
}

function node(page: Page, id: CanvasNodeId) {
  return graph(page).locator(`.react-flow__node[data-id="${id}"]`)
}

function resourceHeader(page: Page, id: CanvasNodeId) {
  return node(page, id).locator('[data-convax-resource-header]')
}

async function openCanvas(page: Page, scaffold: WebScaffold, id: CanvasId): Promise<void> {
  const url = new URL(scaffold.baseUrl)
  url.searchParams.set('convax-renderer', 'compare')
  // The token exchange redirects to the root and drops query parameters.
  await page.goto(scaffold.authenticatedUrl)
  await page.goto(url.toString())
  await page.getByRole('button', { name: 'Workspace actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'All canvases', exact: true }).click()
  await page.locator(`[data-canvas-manager-row="${id}"] button`).first().click()
  await graph(page).waitFor()
}

async function modeReady(page: Page, mode: Mode): Promise<void> {
  await expect.poll(() => graph(page).getAttribute('data-convax-renderer')).toBe(mode)
  await expect.poll(() => graph(page).getAttribute('data-canvas-gestures-ready')).toBe('')
  expect(await graph(page).locator('[data-convax-edge-raster]').count()).toBe(mode === 'convax' ? 1 : 0)
}

async function switchMode(page: Page, mode: Mode): Promise<void> {
  await graph(page).locator('[data-convax-renderer-switch]').click()
  await modeReady(page, mode)
}

async function viewport(page: Page) {
  return graph(page).locator('.react-flow__viewport').evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform)
    return { x: matrix.e, y: matrix.f, zoom: matrix.a }
  })
}

async function center(locator: Locator) {
  await locator.waitFor()
  const box = await locator.boundingBox()
  if (box === null) throw new Error('Canvas control has no screen bounds')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

async function drag(page: Page, origin: Locator, dx: number, dy: number, beforeRelease: () => void): Promise<void> {
  const start = await center(origin)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  try {
    await page.mouse.move(start.x + dx, start.y + dy, { steps: 12 })
    beforeRelease()
  } finally { await page.mouse.up() }
}

async function connect(page: Page, source: CanvasNodeId, target: CanvasNodeId): Promise<void> {
  const start = await center(node(page, source).locator('.react-flow__handle.source'))
  const end = await center(node(page, target).locator('.react-flow__handle.target'))
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 16 })
  await page.mouse.up()
}

async function hoverEdge(page: Page, id: string): Promise<void> {
  const point = await graph(page).locator(`[data-convax-edge="${id}"] path[d]`).first().evaluate((element) => {
    if (!(element instanceof SVGPathElement)) throw new Error('Connection has no SVG path')
    const matrix = element.getScreenCTM()
    if (matrix === null) throw new Error('Connection has no transform into the viewport')
    const { x, y } = element.getPointAtLength(element.getTotalLength() / 2).matrixTransform(matrix)
    return { x, y }
  })
  await page.mouse.move(point.x, point.y)
}

async function waitForHistory(page: Page): Promise<void> {
  await expect.poll(() => graph(page).getAttribute('data-convax-history-pending')).not.toBe('true')
}

async function idle(page: Page): Promise<void> {
  await expect.poll(() => page.getByRole('button', { name: 'New chat', exact: true }).isEnabled()).toBe(true)
}

async function fitCanvas(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  await expect.poll(async () => (await viewport(page)).zoom).toBeLessThan(0.5)
}

async function zoomTo(page: Page, zoom: number): Promise<void> {
  const current = await viewport(page)
  const point = await center(graph(page))
  await graph(page).dispatchEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true,
    deltaY: -Math.log2(zoom / current.zoom) / 0.02, clientX: point.x, clientY: point.y })
  await expect.poll(async () => (await viewport(page)).zoom).toBeCloseTo(zoom, 3)
  await expect.poll(() => graph(page).getAttribute('data-canvas-wheel-owner')).toBeNull()
}

describe('Convax renderer comparison in Chromium', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let artifacts: string

  beforeAll(async () => {
    await mkdir(ARTIFACTS, { recursive: true })
    artifacts = await mkdtemp(join(ARTIFACTS, 'convax-renderer-comparison-'))
    scaffold = await launchWebScaffold({
      profile: { hmr: false },
      extraOverlayPath: [join(RENDERER, 'cordis.patch.yml'), join(COUNTER, 'cordis.patch.yml')],
      extraInstallAnchors: [join(RENDERER, 'package.json'), join(COUNTER, 'package.json')],
    })
    if (process.env.CONVAX_EXPORT_RENDERER_DEMO === '1') {
      const instructions = await exportComplexCanvas(scaffold, join(artifacts, 'demo'), COUNTER)
      console.info(`Convax renderer demo: ${instructions}`)
    }
    browser = await chromium.launch()
  })

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  async function openFixture(hasTouch = false) {
    const host = scaffold.ctx.convax
    const fixture = await seedComplexCanvas(host, scaffold.workspaceCwd)
    const document = () => canvasDocument(host, fixture.id)
    const thread = await host.createThread({ canvasId: fixture.id, nodeId: fixture.chat.id, expectedRevision: document().revision,
      operationId: randomUUID() as CanvasOperationId, kind: 'create', agentPreset: 'standard' })
    if (!thread.ok) throw new Error(`Comparison fixture thread: ${thread.code}: ${thread.message}`)
    const page = hasTouch
      ? await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'en-US', timezoneId: 'Asia/Shanghai', hasTouch })
      : await newEnglishPage(browser)
    const console = watchConsole(page)
    const stacks: string[] = []
    page.on('pageerror', (error) => { stacks.push(error.stack ?? error.message) })
    onTestFinished(async ({ task }) => {
      try {
        if (task.result?.state === 'fail') {
          const name = task.name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')
          await page.screenshot({ path: join(artifacts, `failure-${name}.png`), timeout: 5_000 }).catch(() => undefined)
          if (stacks.length > 0) await writeFile(join(artifacts, `failure-${name}.log`), stacks.join('\n\n'))
        }
        expect(console.pageErrors).toEqual([])
      } finally { await page.close() }
    })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openCanvas(page, scaffold, fixture.id)
    await modeReady(page, 'react-flow')
    return { fixture, page, console, document, sessionId: thread.sessionId }
  }

  it('keeps the same project usable across renderers and retains edits across a switch and reload', async () => {
    const { fixture, page, console, document, sessionId } = await openFixture()
    const { script, folder, chat, counter, research, review, reviewInput, reviewDelivery } = fixture
    const original = document()
    expect(original.nodes).toHaveLength(69)
    expect(original.connections).toHaveLength(90)
    expect(original.groups).toHaveLength(6)
    await fitCanvas(page)
    const scriptCard = node(page, script.id).locator('[data-convax-resource]')
    const counterCard = node(page, counter.id).locator('[data-convax-counter]')
    const chatCard = node(page, chat.id).locator('[data-convax-chat]')
    const chatTab = chatCard.locator(`[data-thread-tab="${sessionId}"]`)
    const draftInput = chatCard.locator('[data-composer-input][contenteditable="true"]')
    const draft = 'Check continuity in the deck bell scene.'
    const groupHeader = graph(page).locator(`[data-convax-group-header="${research.id}"]`)
    const nodePosition = (id: CanvasNodeId) => document().nodes.find(item => item.id === id)?.position
    const edgeIds = () => document().connections.map(edge => edge.id).sort()

    for (const mode of MODES) {
      if (mode === 'convax') {
        const prior = document()
        const view = await viewport(page)
        await switchMode(page, mode)
        await expect.poll(() => viewport(page)).toEqual(view)
        expect(document()).toEqual(prior)
        await scriptCard.getByRole('button', { name: 'Collapse night-ferry-outline.md', exact: true }).waitFor()
        await counterCard.getByText('13', { exact: true }).waitFor()
        await expect.poll(() => draftInput.textContent()).toBe(draft)
        await scriptCard.getByRole('button', { name: 'Collapse night-ferry-outline.md', exact: true }).click()
      }

      await groupHeader.getByText(research.title, { exact: true }).waitFor()
      await graph(page).locator(`[data-convax-group="${review.id}"][data-color="purple"]`).waitFor()
      await chatTab.waitFor()
      await graph(page).locator(`[data-convax-edge="${reviewInput.id}"] path[d]`).first().waitFor({ state: 'attached' })
      await graph(page).locator(`[data-convax-edge="${reviewDelivery.id}"] path[d]`).first().waitFor({ state: 'attached' })

      await resourceHeader(page, script.id).click()
      const cardToolbar = graph(page).getByRole('toolbar', { name: /night-ferry-outline\.md/ })
      await cardToolbar.waitFor()
      const toolbarButton = cardToolbar.getByRole('button').first()
      const toolbarSize = await toolbarButton.boundingBox()
      expect(toolbarSize?.width).toBeGreaterThanOrEqual(24)
      await resourceHeader(page, folder.id).click({ modifiers: ['ControlOrMeta'] })
      await cardToolbar.waitFor({ state: 'hidden' })
      await expect.poll(() => graph(page).locator('.react-flow__node.selected').count()).toBe(2)
      await page.keyboard.press('ControlOrMeta+d')
      await expect.poll(() => document().nodes.length).toBe(original.nodes.length + 2)
      await expect.poll(() => graph(page).locator('[data-convax-view-toolbar]').getByRole('button', { name: 'Undo', exact: true }).isEnabled()).toBe(true)
      await page.keyboard.press('ControlOrMeta+z')
      await expect.poll(() => document().nodes.length).toBe(original.nodes.length)
      await waitForHistory(page)
      await fitCanvas(page)

      const groupStart = nodePosition(script.id)!
      const folderStart = nodePosition(folder.id)!
      const beforeNodeDrag = document()
      await drag(page, resourceHeader(page, script.id), 45, 20, () => { expect(document()).toEqual(beforeNodeDrag) })
      await expect.poll(() => document().revision).toBe(beforeNodeDrag.revision + 1)
      expect(nodePosition(script.id)!.x).toBeGreaterThan(groupStart.x + 20)
      expect(nodePosition(folder.id)).toEqual(folderStart)
      await idle(page)
      await page.keyboard.press('ControlOrMeta+z')
      await expect.poll(() => nodePosition(script.id)).toEqual(groupStart)
      await waitForHistory(page)

      const beforeDrag = document()
      await drag(page, groupHeader, 50, 24, () => { expect(document()).toEqual(beforeDrag) })
      await expect.poll(() => document().revision).toBe(beforeDrag.revision + 1)
      const afterGroup = nodePosition(script.id)!
      const afterFolder = nodePosition(folder.id)!
      expect(afterGroup.x).toBeGreaterThan(groupStart.x + 20)
      expect(afterGroup.y).toBeGreaterThan(groupStart.y + 10)
      expect(afterFolder.x - folderStart.x).toBeCloseTo(afterGroup.x - groupStart.x)
      expect(afterFolder.y - folderStart.y).toBeCloseTo(afterGroup.y - groupStart.y)
      expect(nodePosition(chat.id)).toEqual(chat.position)
      await idle(page)
      await page.keyboard.press('ControlOrMeta+z')
      await expect.poll(() => nodePosition(script.id)).toEqual(groupStart)
      await waitForHistory(page)

      await connect(page, script.id, chat.id)
      await expect.poll(() => document().connections.length).toBe(original.connections.length + 1)
      const added = document().connections.find(edge => edge.source === script.id && edge.target === chat.id)!
      expect(added).toMatchObject({ sourcePort: 'output', targetPort: 'input', purpose: 'input' })
      await idle(page)
      await hoverEdge(page, added.id)
      const cut = graph(page).locator(`[data-convax-edge-cut="${added.id}"]`)
      await cut.focus()
      const cutWidth = (await cut.boundingBox())!.width
      const beforeZoom = (await viewport(page)).zoom
      await zoomTo(page, beforeZoom * 1.1)
      await expect.poll(async () => (await cut.boundingBox())?.width).toBeCloseTo(cutWidth, 1)
      await zoomTo(page, beforeZoom)
      await cut.click()
      await expect.poll(edgeIds).toEqual(original.connections.map(edge => edge.id).sort())
      await idle(page)

      const desiredValue = mode === 'react-flow' ? 13 : 14
      await counterCard.getByRole('button', { name: 'Increase', exact: true }).click()
      await expect.poll(() => document().nodes.find(item => item.id === counter.id)?.data).toEqual({ value: desiredValue })
      await scriptCard.getByRole('button', { name: 'Expand night-ferry-outline.md', exact: true }).click()
      await scriptCard.getByText(fixture.scriptText, { exact: true }).waitFor()
      if (mode === 'react-flow') {
        await writeComposerDraft(page, draftInput, draft)
        await expect.poll(() => draftInput.textContent()).toBe(draft)
      }
    }

    const final = document()
    const finalView = await viewport(page)
    const warnings = console.warnings.length
    expect(console.pageErrors).toEqual([])
    await page.reload()
    acknowledgeReloadConnectionLoss(console, warnings)
    await scriptCard.getByText(fixture.scriptText, { exact: true }).waitFor({ timeout: 30_000 })
    await counterCard.getByText('14', { exact: true }).waitFor()
    await chatTab.waitFor()
    await expect.poll(() => viewport(page)).toEqual(finalView)
    expect(document()).toEqual(final)
    expect(final.nodes.map(item => [item.id, item.position])).toEqual(original.nodes.map(item => [item.id, item.position]))
    expect(final.groups).toEqual(original.groups)
    expect(final.connections).toEqual(original.connections)
  })

  it('records both renderers on the same pan trace', async () => {
    const { page, document } = await openFixture()
    await page.getByRole('button', { name: 'Canvas input mode', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Touchpad mode', exact: true }).click()
    await fitCanvas(page)
    const fit = await viewport(page)
    const { nodes, connections } = document()
    for (const mode of MODES) {
      if (mode === 'convax') await switchMode(page, mode)
      await expect.poll(() => viewport(page)).toEqual(fit)
      await expect.poll(() => graph(page).locator('[data-convax-edge]').count()).toBe(connections.length)
      await page.mouse.move(5, 60)
      await graph(page).screenshot({ path: join(artifacts, `${mode}.png`) })
    }

    await switchMode(page, 'react-flow')
    await zoomTo(page, 0.8)
    const start = await viewport(page)
    const measurements = []
    for (const mode of MODES) {
      if (mode === 'convax') await switchMode(page, mode)
      await expect.poll(() => viewport(page)).toEqual(start)
      const measured = await measurePan(graph(page))
      expect(measured.midway.x).toBeCloseTo(start.x - 495, 2)
      expect(measured.midway.y).toBeCloseTo(start.y - 270, 2)
      measurements.push({ mode, ...measured })
      await expect.poll(() => graph(page).getAttribute('data-canvas-wheel-owner')).toBeNull()
      await expect.poll(() => viewport(page)).toEqual(start)
    }
    const report = { documentNodes: nodes.length, documentEdges: connections.length, viewport: start, measurements }
    await writeFile(join(artifacts, 'pan-comparison.json'), `${JSON.stringify(report, null, 2)}\n`)
    console.info('Convax renderer pan comparison', report)
  })

  it('preserves marquee, connected creation and real touch zoom in both renderers', async () => {
    const { fixture, page, document } = await openFixture(true)
    const panePoint = async (near: { x: number; y: number } | null, span = 0) => await graph(page).evaluate((root, options) => {
      const { left, right, top, bottom } = root.getBoundingClientRect()
      const preferred = options.near ?? { x: right - 150, y: top + 220 }
      const points: Array<{ x: number; y: number }> = []
      for (let y = top + 70; y < bottom - 70; y += 12) {
        for (let x = left + 70 + options.span; x < right - 70 - options.span; x += 12) {
          points.push({ x, y })
        }
      }
      points.sort((a, b) => Math.hypot(a.x - preferred.x, a.y - preferred.y) - Math.hypot(b.x - preferred.x, b.y - preferred.y))
      const pane = (x: number, y: number) => root.ownerDocument.elementFromPoint(x, y)?.matches('.react-flow__pane') === true
      const found = points.find(({ x, y }) => pane(x, y) && pane(x - options.span, y) && pane(x + options.span, y))
      if (found === undefined) throw new Error('Canvas viewport has no blank space for the requested gesture')
      return found
    }, { near, span })
    await page.getByRole('button', { name: 'Canvas input mode', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Touchpad mode', exact: true }).click()

    for (const mode of MODES) {
      if (mode === 'convax') await switchMode(page, mode)
      await fitCanvas(page)
      const script = await node(page, fixture.script.id).boundingBox()
      const folder = await node(page, fixture.folder.id).boundingBox()
      if (script === null || folder === null) throw new Error('Reference cards have no screen bounds')
      const selectionStart = { x: Math.min(script.x, folder.x) - 12, y: Math.max(script.y + script.height, folder.y + folder.height) + 12 }
      const selectionEnd = { x: Math.max(script.x + script.width, folder.x + folder.width) + 12, y: Math.min(script.y, folder.y) - 12 }
      await page.mouse.move(selectionStart.x, selectionStart.y)
      await page.mouse.down()
      await page.mouse.move(selectionEnd.x, selectionEnd.y, { steps: 10 })
      await page.mouse.up()
      const selected = graph(page).locator('.react-flow__node.selected')
      await expect.poll(() => selected.evaluateAll(elements => elements.map(element => element.getAttribute('data-id')).sort()))
        .toEqual([fixture.script.id, fixture.folder.id].sort())
      const referenceIds = [fixture.script.id, fixture.folder.id]
      const incidentEdges = document().connections.filter(edge => referenceIds.includes(edge.source) || referenceIds.includes(edge.target))
        .map(edge => edge.id).sort()
      const selectedEdges = graph(page).locator('[data-convax-edge][data-selected="true"]')
      await expect.poll(() => selectedEdges.evaluateAll(elements => elements.map(element => element.getAttribute('data-convax-edge')).sort()))
        .toEqual(incidentEdges)
      const selectionRect = graph(page).locator('[data-native-canvas-selection], .react-flow__nodesselection-rect')
      await selectionRect.waitFor()
      const gap = { x: script.x + script.width / 2, y: (script.y + script.height + folder.y) / 2 }
      await page.mouse.click(gap.x, gap.y)
      await expect.poll(() => selected.count()).toBe(2)
      const beforeSelectionDrag = document()
      await page.mouse.move(gap.x, gap.y)
      await page.mouse.down()
      try {
        await page.mouse.move(gap.x + 35, gap.y + 18, { steps: 10 })
        expect(document()).toEqual(beforeSelectionDrag)
      } finally { await page.mouse.up() }
      await expect.poll(() => document().revision).toBe(beforeSelectionDrag.revision + 1)
      for (const item of [fixture.script, fixture.folder]) {
        expect(document().nodes.find(value => value.id === item.id)?.position.x).toBeGreaterThan(item.position.x)
      }
      await idle(page)
      await page.keyboard.press('ControlOrMeta+z')
      await expect.poll(() => document().nodes.map(({ id, position }) => [id, position]))
        .toEqual(beforeSelectionDrag.nodes.map(({ id, position }) => [id, position]))
      expect(document().connections).toEqual(beforeSelectionDrag.connections)
      await waitForHistory(page)

      const source = await center(node(page, fixture.script.id).locator('.react-flow__handle.source'))
      const blank = await panePoint({ x: source.x + 56, y: source.y + 38 })
      await page.mouse.click(blank.x, blank.y)
      await expect.poll(() => selected.count()).toBe(0)
      const before = document()
      const dragConnection = async (cancel: boolean): Promise<void> => {
        await page.mouse.move(source.x, source.y)
        await page.mouse.down()
        try {
          await page.mouse.move(blank.x, blank.y, { steps: 12 })
          if (cancel) await page.keyboard.press('Escape')
        } finally { await page.mouse.up() }
      }
      const terminal = page.getByRole('menuitem', { name: 'Terminal', exact: true })
      const preview = graph(page).locator('[data-convax-connection-preview]')
      await dragConnection(true)
      await expect.poll(() => terminal.count()).toBe(0)
      expect(document()).toEqual(before)
      await dragConnection(false)
      await terminal.waitFor()
      expect(await preview.getAttribute('data-origin-node')).toBe(fixture.script.id)
      expect(await preview.getAttribute('data-origin-direction')).toBe('output')
      expect(document()).toEqual(before)
      await page.keyboard.press('Escape')
      await terminal.waitFor({ state: 'hidden' })
      await preview.waitFor({ state: 'detached' })
      expect(document()).toEqual(before)

      await dragConnection(false)
      await terminal.click()
      await expect.poll(() => document().nodes.length).toBe(before.nodes.length + 1)
      const added = document().nodes.find(item => item.typeId === 'convax.terminal')
      expect(added).toBeDefined()
      expect(document().connections).toContainEqual(expect.objectContaining({
        source: fixture.script.id, target: added?.id, sourcePort: 'output', targetPort: 'input', purpose: 'input',
      }))
      await idle(page)
      await page.mouse.click(blank.x - 30, blank.y)
      await page.keyboard.press('ControlOrMeta+z')
      await expect.poll(() => document().nodes).toEqual(before.nodes)
      expect(document().connections).toEqual(before.connections)
      await waitForHistory(page)

      const focus = await panePoint(null, 84)
      const cdp = await page.context().newCDPSession(page)
      const graphBounds = await graph(page).boundingBox()
      if (graphBounds === null) throw new Error('Canvas viewport has no screen bounds')
      const start = await viewport(page)
      const touchPoints = (radius: number) => [{ x: focus.x - radius, y: focus.y, id: 1 }, { x: focus.x + radius, y: focus.y, id: 2 }]
      const beforeTouch = document()
      try {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touchPoints(56) })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touchPoints(70) })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touchPoints(84) })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await expect.poll(async () => (await viewport(page)).zoom).toBeCloseTo(start.zoom * 1.5, 3)
        const after = await viewport(page)
        expect(after.x).toBeCloseTo(start.x * 1.5 - (focus.x - graphBounds.x) * 0.5, 0)
        expect(after.y).toBeCloseTo(start.y * 1.5 - (focus.y - graphBounds.y) * 0.5, 0)
        expect(document()).toEqual(beforeTouch)
      } finally { await cdp.detach() }
    }
  })
})
