import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CanvasId, CanvasNodeId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { ElectronApplication, Locator, Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { writeComposerDraft } from '../libs/dsh/apps/web/tests/support.ts'
import { measurePan } from './fixtures/canvas-renderer-measurement.ts'
import { stageDesktopRendererFixture } from './fixtures/desktop-renderer.ts'

const MODES = ['react-flow', 'convax'] as const
type Mode = typeof MODES[number]
const DESKTOP_E2E = process.env.CONVAX_DESKTOP_RENDERER_E2E === '1'

function graph(page: Page) { return page.locator('[data-convax-graph]:visible') }

function node(page: Page, id: CanvasNodeId) {
  return graph(page).locator(`.react-flow__node[data-id="${id}"]`)
}

async function desktopPage(app: ElectronApplication, canvasId: CanvasId, errors: string[]): Promise<Page> {
  await app.firstWindow({ timeout: 40_000 })
  const welcomeWindow = () => app.windows().find(page => page.url().includes('/welcome.html'))
  await expect.poll(() => welcomeWindow(), { timeout: 30_000 }).toBeDefined()
  await welcomeWindow()!.evaluate(async () => {
    const welcome = (window as Window & { dshWelcome?: { skip(): Promise<void> } }).dshWelcome
    if (welcome === undefined) throw new Error('Desktop welcome preload did not load')
    await welcome.skip()
  })
  const page = app.windows().find(candidate => candidate.url().startsWith('dsh-app://app/'))
  if (page === undefined) throw new Error('Desktop workspace window did not open')
  page.on('pageerror', (error) => { errors.push(error.stack ?? error.message) })
  await page.goto('dsh-app://app/?convax-renderer=compare')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.locator('[data-convax-workspace]').waitFor({ timeout: 30_000 })
  await app.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().startsWith('dsh-app://app/'))
    if (window === undefined) throw new Error('Desktop workspace has no BrowserWindow')
    window.setSize(1680, 1000)
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    if (process.platform === 'darwin') app.focus({ steal: true })
  })
  const notice = page.getByRole('button', { name: 'Continue', exact: true })
  const workspace = page.getByRole('button', { name: 'Workspace actions', exact: true })
  await workspace.waitFor()
  if (await notice.isVisible()) await notice.click()
  if (await graph(page).count() === 0) {
    await workspace.click()
    await page.getByRole('menuitem', { name: 'All canvases', exact: true }).click()
    await page.locator(`[data-canvas-manager-row="${canvasId}"] button`).first().click()
  }
  await modeReady(page, 'react-flow')
  return page
}

async function modeReady(page: Page, mode: Mode): Promise<void> {
  await expect.poll(() => graph(page).getAttribute('data-convax-renderer')).toBe(mode)
  await expect.poll(() => graph(page).getAttribute('data-canvas-gestures-ready')).toBe('')
  expect(await graph(page).locator('[data-convax-edge-raster]').count()).toBe(mode === 'convax' ? 1 : 0)
}

async function viewport(page: Page) {
  return graph(page).locator('.react-flow__viewport').evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform)
    return { x: matrix.e, y: matrix.f, zoom: matrix.a }
  })
}

async function center(locator: Locator) {
  const bounds = await locator.boundingBox()
  if (bounds === null) throw new Error('Desktop canvas control has no screen bounds')
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
}

async function drag(page: Page, start: Locator, delta: { x: number; y: number }, during?: () => void): Promise<void> {
  const from = await center(start)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  try {
    await page.mouse.move(from.x + delta.x, from.y + delta.y, { steps: 12 })
    during?.()
  } finally { await page.mouse.up() }
}

async function settleHistory(page: Page): Promise<void> {
  await expect.poll(() => graph(page).getAttribute('data-convax-history-pending')).not.toBe('true')
}

function undoButton(page: Page) {
  return graph(page).locator('[data-convax-view-toolbar]').getByRole('button', { name: 'Undo', exact: true })
}

async function fit(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  await expect.poll(async () => (await viewport(page)).zoom).toBeLessThan(0.5)
}

async function moveCamera(page: Page): Promise<void> {
  const camera = await viewport(page)
  const point = await center(graph(page))
  await page.mouse.move(point.x, point.y)
  await page.keyboard.down('Control')
  try { await page.mouse.wheel(0, -20) } finally { await page.keyboard.up('Control') }
  await expect.poll(async () => (await viewport(page)).zoom).toBeGreaterThan(camera.zoom)
  await expect.poll(() => graph(page).getAttribute('data-canvas-wheel-owner')).toBeNull()
}

it.skipIf(!DESKTOP_E2E)('retains the Night Ferry canvas across both Electron renderers and a desktop restart', async () => {
  await mkdir('.artifacts', { recursive: true })
  const output = await mkdtemp(join(process.cwd(), '.artifacts', 'convax-desktop-renderers-'))
  const { fixture, readCanvas, launch } = await stageDesktopRendererFixture(output)
  const errors: string[] = []
  let app: ElectronApplication | undefined
  let page: Page | undefined
  onTestFinished(async ({ task }) => {
    try {
      if (task.result?.state === 'fail') {
        await page?.screenshot({ path: join(output, 'failure.png'), timeout: 5_000 }).catch(() => undefined)
        await writeFile(join(output, 'page-errors.log'), errors.join('\n\n'))
      }
    } finally { await app?.close() }
  })

  app = await launch()
  page = await desktopPage(app, fixture.id, errors)
  const active = page
  const script = node(active, fixture.script.id).locator('[data-convax-resource]')
  const scriptHeader = script.locator('[data-convax-resource-header]')
  const folderHeader = node(active, fixture.folder.id).locator('[data-convax-resource-header]')
  const chat = node(active, fixture.chat.id)
  const counter = node(active, fixture.counter.id).locator('[data-convax-counter]')
  const original = readCanvas()
  const position = (id: CanvasNodeId) => readCanvas().nodes.find(value => value.id === id)!.position
  const draft = 'Check continuity in the Night Ferry desktop scene.'
  const draftInput = chat.locator('[data-composer-input][contenteditable="true"]')
  const baselinePositions = original.nodes.map(value => [value.id, value.position])
  expect(original.nodes).toHaveLength(69)
  expect(original.connections).toHaveLength(90)
  expect(original.groups).toHaveLength(6)
  await fit(active)
  const thread = chat.locator('[data-thread-tab]').first()
  await thread.waitFor()
  const threadId = await thread.getAttribute('data-thread-tab')

  for (const mode of MODES) {
    if (mode === 'convax') {
      const prior = readCanvas()
      const camera = await viewport(active)
      await graph(active).locator('[data-convax-renderer-switch]').click()
      await modeReady(active, mode)
      await expect.poll(() => viewport(active)).toEqual(camera)
      expect(readCanvas()).toEqual(prior)
      await expect.poll(() => draftInput.textContent()).toBe(draft)
    }
    await fit(active)
    if (mode === 'convax') await script.getByRole('button', { name: 'Collapse night-ferry-outline.md', exact: true }).click()
    await expect.poll(() => graph(active).locator('.react-flow__node').count()).toBe(69)
    await expect.poll(() => graph(active).locator('[data-convax-edge]').count()).toBe(90)
    expect(await graph(active).locator('[data-convax-group-header]').count()).toBe(6)
    await graph(active).screenshot({ path: join(output, `${mode}.png`) })

    await scriptHeader.click()
    await folderHeader.click({ modifiers: ['ControlOrMeta'] })
    await expect.poll(() => graph(active).locator('.react-flow__node.selected').count()).toBe(2)
    await active.keyboard.press('ControlOrMeta+d')
    await expect.poll(() => readCanvas().nodes.length).toBe(71)
    await settleHistory(active)
    await expect.poll(() => undoButton(active).isEnabled()).toBe(true)
    await active.keyboard.press('ControlOrMeta+z')
    await expect.poll(() => readCanvas().nodes.length).toBe(69)
    await settleHistory(active)
    const redo = graph(active).locator('[data-convax-view-toolbar]').getByRole('button', { name: 'Redo', exact: true })
    await redo.click()
    await expect.poll(() => readCanvas().nodes.length).toBe(71)
    await settleHistory(active)
    await undoButton(active).click()
    await expect.poll(() => readCanvas().nodes.length).toBe(69)
    await settleHistory(active)
    await fit(active)

    const beforeNode = readCanvas()
    await drag(active, scriptHeader, { x: 42, y: 20 }, () => { expect(readCanvas()).toEqual(beforeNode) })
    await expect.poll(() => readCanvas().revision).toBe(beforeNode.revision + 1)
    expect(position(fixture.script.id).x).toBeGreaterThan(fixture.script.position.x + 20)
    expect(position(fixture.folder.id)).toEqual(fixture.folder.position)
    await undoButton(active).click()
    await expect.poll(() => position(fixture.script.id)).toEqual(fixture.script.position)
    await settleHistory(active)

    const beforeGroup = readCanvas()
    const group = graph(active).locator(`[data-convax-group-header="${fixture.research.id}"]`)
    await drag(active, group, { x: 48, y: 24 }, () => { expect(readCanvas()).toEqual(beforeGroup) })
    await expect.poll(() => readCanvas().revision).toBe(beforeGroup.revision + 1)
    const nodeMove = position(fixture.script.id).x - fixture.script.position.x
    expect(nodeMove).toBeGreaterThan(20)
    expect(position(fixture.folder.id).x - fixture.folder.position.x).toBeCloseTo(nodeMove)
    await undoButton(active).click()
    await expect.poll(() => position(fixture.folder.id)).toEqual(fixture.folder.position)
    await settleHistory(active)

    const source = node(active, fixture.script.id).locator('.react-flow__handle.source')
    const target = await center(chat.locator('.react-flow__handle.target'))
    const from = await center(source)
    await drag(active, source, { x: target.x - from.x, y: target.y - from.y })
    await expect.poll(() => readCanvas().connections.length).toBe(91)
    const connection = readCanvas().connections.find(edge => edge.source === fixture.script.id && edge.target === fixture.chat.id)
    expect(connection).toMatchObject({ sourcePort: 'output', targetPort: 'input', purpose: 'input' })
    const point = await graph(active).locator(`[data-convax-edge="${connection!.id}"] path[d]`).first().evaluate((element) => {
      const path = element as SVGPathElement
      const matrix = path.getScreenCTM()
      if (matrix === null) throw new Error('Desktop canvas connection has no screen transform')
      const { x, y } = path.getPointAtLength(path.getTotalLength() / 2).matrixTransform(matrix)
      return { x, y }
    })
    await active.mouse.move(point.x, point.y)
    await graph(active).locator(`[data-convax-edge-cut="${connection!.id}"]`).click()
    await expect.poll(() => readCanvas().connections).toEqual(original.connections)

    const value = mode === 'react-flow' ? 13 : 14
    await counter.getByRole('button', { name: 'Increase', exact: true }).click()
    await expect.poll(() => readCanvas().nodes.find(item => item.id === fixture.counter.id)?.data).toEqual({ value })
    await script.getByRole('button', { name: 'Expand night-ferry-outline.md', exact: true }).click()
    await script.getByText(fixture.scriptText, { exact: true }).waitFor()
    if (mode === 'react-flow') {
      await writeComposerDraft(active, draftInput, draft)
      await expect.poll(() => draftInput.textContent()).toBe(draft)
    }
    await moveCamera(active)
  }

  const saved = readCanvas()
  const savedCamera = await viewport(active)
  expect(saved.nodes.map(value => [value.id, value.position])).toEqual(baselinePositions)
  expect(saved.groups).toEqual(original.groups)
  expect(saved.connections).toEqual(original.connections)
  await app.close()
  app = undefined
  app = await launch()
  page = await desktopPage(app, fixture.id, errors)
  await node(page, fixture.script.id).getByText(fixture.scriptText, { exact: true }).waitFor({ timeout: 30_000 })
  await node(page, fixture.counter.id).getByText('14', { exact: true }).waitFor()
  await node(page, fixture.chat.id).locator(`[data-thread-tab="${threadId}"]`).waitFor()
  await expect.poll(() => viewport(page)).toEqual(savedCamera)
  expect(readCanvas()).toEqual(saved)
  expect(errors).toEqual([])
  await page.screenshot({ path: join(output, 'desktop-restarted.png') })
  console.info(`Desktop renderer comparison: ${output}`)
})

it.skipIf(!DESKTOP_E2E)('measures the same pan trace in both Electron renderers', async () => {
  await mkdir('.artifacts', { recursive: true })
  const output = await mkdtemp(join(process.cwd(), '.artifacts', 'convax-desktop-pan-'))
  const { fixture, launch } = await stageDesktopRendererFixture(output)
  const app = await launch()
  onTestFinished(() => app.close())
  const errors: string[] = []
  const page = await desktopPage(app, fixture.id, errors)
  await page.getByRole('button', { name: 'Canvas input mode', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Touchpad mode', exact: true }).click()
  await fit(page)
  const start = await viewport(page)
  const measurements = []
  let current: Mode = 'react-flow'
  const order = [...MODES, ...MODES.toReversed()]
  for (const mode of order) {
    if (current !== mode) {
      await graph(page).locator('[data-convax-renderer-switch]').click()
      await modeReady(page, mode)
      current = mode
    }
    await expect.poll(() => viewport(page)).toEqual(start)
    await expect.poll(() => graph(page).locator('[data-convax-edge]').count()).toBe(90)
    const measured = await measurePan(graph(page))
    expect(measured.midway.x).toBeCloseTo(start.x - 495, 2)
    expect(measured.midway.y).toBeCloseTo(start.y - 270, 2)
    measurements.push({ mode, ...measured })
    await expect.poll(() => graph(page).getAttribute('data-canvas-wheel-owner')).toBeNull()
    await expect.poll(() => viewport(page)).toEqual(start)
  }
  expect(errors).toEqual([])
  const runtime = await app.evaluate(() => ({ electron: process.versions.electron, chromium: process.versions.chrome }))
  await writeFile(join(output, 'pan-comparison.json'), `${JSON.stringify({ runtime, viewport: start, measurements }, null, 2)}\n`)
  console.info(`Desktop renderer pan comparison: ${output}`)
})

it.skipIf(!DESKTOP_E2E)('keeps each retained React Flow background tied to its own zoom in Electron', async () => {
  await mkdir('.artifacts', { recursive: true })
  const output = await mkdtemp(join(process.cwd(), '.artifacts', 'convax-desktop-background-'))
  const { fixture, launch } = await stageDesktopRendererFixture(output)
  const app = await launch()
  onTestFinished(() => app.close())
  const errors: string[] = []
  const page = await desktopPage(app, fixture.id, errors)
  const background = (canvasId: string) => page.locator(`[data-convax-canvas="${canvasId}"] .react-flow__background`).evaluate((svg) => {
    const pattern = svg.querySelector('pattern')
    const rect = svg.querySelector('rect')
    if (pattern === null || rect === null) throw new Error('React Flow grid is missing its SVG paint server')
    const fill = rect.getAttribute('fill')
    const id = /^url\(#(.+)\)$/.exec(fill ?? '')?.[1]
    const referenced = id === undefined ? null : svg.ownerDocument.getElementById(id)
    return { id: pattern.id, fill, spacing: Number(pattern.getAttribute('width')), ownsPaint: referenced === pattern }
  })

  await fit(page)
  const firstZoom = (await viewport(page)).zoom
  await page.getByRole('button', { name: 'New canvas', exact: true }).first().click()
  const secondCanvas = page.locator(`[data-convax-canvas]:visible:not([data-convax-canvas="${fixture.id}"])`)
  await secondCanvas.waitFor()
  const secondId = await secondCanvas.getAttribute('data-convax-canvas')
  if (secondId === null) throw new Error('New canvas has no identity')
  await modeReady(page, 'react-flow')
  const initialSecondZoom = (await viewport(page)).zoom
  const initial = await background(secondId)
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await expect.poll(async () => (await viewport(page)).zoom).toBeGreaterThan(initialSecondZoom)
  const secondZoom = (await viewport(page)).zoom
  await expect.poll(async () => (await background(secondId)).spacing).toBeCloseTo(24 * secondZoom, 3)
  const second = await background(secondId)
  await page.screenshot({ path: join(output, 'second-canvas.png') })
  await page.locator(`[data-canvas-tab="${fixture.id}"]`).getByRole('tab').click()
  await expect.poll(async () => (await viewport(page)).zoom).toBe(firstZoom)
  const first = await background(fixture.id)
  const retainedSecond = await background(secondId)
  await writeFile(join(output, 'backgrounds.json'), `${JSON.stringify({ initial, first, second, retainedSecond, firstZoom, secondZoom }, null, 2)}\n`)

  expect(first.spacing).toBeCloseTo(24 * firstZoom, 3)
  expect(first.id).not.toBe(second.id)
  expect([first.ownsPaint, initial.ownsPaint, second.ownsPaint, retainedSecond.ownsPaint]).toEqual([true, true, true, true])
  expect(retainedSecond).toEqual(second)
  expect(errors).toEqual([])
})
