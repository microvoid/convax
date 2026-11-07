/** Real theme changes verify readable canvas surfaces and third-party graph chrome together. */
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-convax-plugin-host'
import type { CanvasConnectionId, CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const BUNDLE = fileURLToPath(new URL('../../../../../packages/plugin-renderer/', import.meta.url))
const ARTIFACTS = fileURLToPath(new URL('../../../../../.artifacts/convax-theme/', import.meta.url))

async function paint(element: Locator, pseudo: '::placeholder' | null = null) {
  return element.evaluate((element, pseudo) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('Color inspection needs a 2D context')
    const rgba = (color: string): [number, number, number, number] => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      const data = context.getImageData(0, 0, 1, 1).data
      const r = data.at(0), g = data.at(1), b = data.at(2), a = data.at(3)
      if (r === undefined || g === undefined || b === undefined || a === undefined) throw new Error('Color pixel is missing')
      return [r, g, b, a / 255]
    }
    const over = ([r, g, b, a]: [number, number, number, number], background: [number, number, number]): [number, number, number] =>
      [r * a + background[0] * (1 - a), g * a + background[1] * (1 - a), b * a + background[2] * (1 - a)]
    const ancestors: Element[] = []
    for (let current: Element | null = element; current !== null; current = current.parentElement) ancestors.unshift(current)
    let background: [number, number, number] = [255, 255, 255]
    for (const ancestor of ancestors) background = over(rgba(getComputedStyle(ancestor).backgroundColor), background)
    const style = getComputedStyle(element, pseudo)
    const foreground = rgba(style.color)
    foreground[3] *= Number(style.opacity)
    const ink = over(foreground, background)
    const linear = (channel: number) => {
      const value = channel / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    }
    const luminance = (color: [number, number, number]) =>
      linear(color[0]) * 0.2126 + linear(color[1]) * 0.7152 + linear(color[2]) * 0.0722
    const inkValue = luminance(ink), backgroundValue = luminance(background)
    const contrast = (Math.max(inkValue, backgroundValue) + 0.05) / (Math.min(inkValue, backgroundValue) + 0.05)
    return { color: style.color, background: background.map(Math.round), contrast,
      width: style.width, fill: rgba(style.backgroundColor), border: rgba(style.borderColor), outline: style.outlineStyle,
      focused: document.activeElement === element, focusVisible: element.matches(':focus-visible'), outlineColor: rgba(style.outlineColor),
      primary: rgba(style.getPropertyValue('--dsw-alias-state-business-primary').trim()),
      surface: rgba(style.getPropertyValue('--dsw-alias-bg-base').trim()) }
  }, pseudo)
}

it('keeps canvas cards, tools, menus, focus and resource ports readable in both palettes', async () => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: join(BUNDLE, 'cordis.patch.yml'), extraInstallAnchors: [join(BUNDLE, 'package.json')],
  })
  const owned: { browser?: Browser; page?: Page } = {}
  onTestFinished(async ({ task }) => {
    try {
      if (task.result?.state === 'fail' && owned.page !== undefined) await saveFailureShot(owned.page, 'convax-theme')
    } finally { try { await owned.browser?.close() } finally { await scaffold.close() } }
  })
  const browser = await chromium.launch()
  owned.browser = browser
  const page = await newEnglishPage(browser)
  owned.page = page
  const console = watchConsole(page)
  await page.setViewportSize({ width: 1800, height: 1100 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const folderPath = join(scaffold.workspaceCwd, 'Project')
  await mkdir(folderPath)
  for (const name of ['notes.txt', 'report.pdf', 'budget.xlsx', 'slides.pptx']) await writeFile(join(folderPath, name), 'Theme fixture\n')
  const canvasId = randomUUID() as CanvasId, folder = randomUUID() as CanvasNodeId
  const file = randomUUID() as CanvasNodeId, chatId = randomUUID() as CanvasNodeId
  const edgeId = randomUUID() as CanvasConnectionId
  const seeded = await scaffold.ctx.convax.commit({ canvasId, expectedRevision: 0, operationId: randomUUID() as CanvasOperationId, ops: [
    { op: 'canvas.add', title: 'Theme acceptance' },
    { op: 'node.add', id: folder, typeId: 'convax.folder' as CanvasNodeTypeId, dataVersion: 1,
      data: { path: folderPath }, position: { x: 0, y: 80 } },
    { op: 'node.add', id: file, typeId: 'convax.file' as CanvasNodeTypeId, dataVersion: 1,
      data: { path: join(folderPath, 'notes.txt') }, position: { x: 0, y: 380 } },
    { op: 'node.add', id: chatId, typeId: 'convax.chat' as CanvasNodeTypeId, dataVersion: 1,
      data: { title: 'Theme review', cwd: folderPath }, position: { x: 450, y: 80 } },
    { op: 'edge.add', id: edgeId, source: folder, sourcePort: 'output', target: chatId, targetPort: 'input', purpose: 'input' },
  ] })
  expect(seeded.ok).toBe(true)
  await page.goto(scaffold.authenticatedUrl)
  await page.locator('[data-convax-workspace]').waitFor({ timeout: 30_000 })
  const brandMark = page.locator('[data-workspace-titlebar] img[alt="Convax"]')
  await expect.poll(() => brandMark.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
  await page.getByRole('button', { name: 'Workspace actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'All canvases', exact: true }).click()
  await page.locator(`[data-canvas-manager-row="${canvasId}"] button`).first().click()
  const chat = page.locator(`[data-convax-chat="${chatId}"]`)
  const resource = page.locator(`[data-convax-resource="${folder}"]`)
  const header = resource.locator('[data-convax-resource-header]')
  const tree = resource.locator('[data-convax-directory-tree]')
  await resource.getByRole('button', { name: 'Expand Project', exact: true }).click()
  await page.locator(`[data-convax-resource="${file}"]`).getByRole('button', { name: 'Expand notes.txt', exact: true }).click()
  await tree.getByRole('button', { name: 'report.pdf', exact: true }).waitFor()
  await expect.poll(() => scaffold.ctx.convax.workspace().chats.find(chat => chat.nodeId === chatId)?.threads.length,
    { timeout: 15_000 }).toBe(1)
  const sessionId = scaffold.ctx.convax.workspace().chats.find(chat => chat.nodeId === chatId)?.threads[0]?.sessionId
  if (sessionId === undefined) throw new Error('Theme fixture has no bound thread')
  await expect.poll(() => scaffold.ctx.agents.get(sessionId), { timeout: 15_000 }).toBeDefined()
  const agent = scaffold.ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error('Theme fixture Agent is unavailable')
  agent.session.append('turn/start', { turn: 1 })
  agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Review project colors.' }], source: { kind: 'user' } }),
    { surfaceOp: 'append' })
  agent.session.append('step/start', { turn: 1, step: 1 })
  agent.session.append('assistant/message', { stream: [], turn: 1, step: 1,
    message: createAssistantMessage({ content: [{ type: 'text', text: 'Readable project summary with `inline code` and [a link](https://example.com).' }],
      source: { provider: 'fixture', model: 'fixture' } }) }, { surfaceOp: 'append' })
  agent.session.append('step/end', { turn: 1, step: 1 })
  agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await scaffold.ctx.sessions.flush(agent.session)
  await chat.getByText('Readable project summary with', { exact: false }).waitFor()
  await chat.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
  const tools = chat.locator('[data-sidebar-right-panel="embedded"]')
  await tools.waitFor()
  await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  await mkdir(ARTIFACTS, { recursive: true })
  const report: string[] = ['# Convax theme acceptance', '', '| Palette | Region | Contrast |', '|---|---|---|']
  const failures: string[] = []
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expect.poll(() => page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme'))).toBe(colorScheme === 'dark')
    const checks: [string, Locator, number][] = [
      ['folder title', header.locator('span').filter({ hasText: 'Project' }).last(), 4.5],
      ['folder metadata', header.locator('span').filter({ hasText: 'Folder' }).last(), 4.5],
      ['tree filename', tree.getByRole('button', { name: 'notes.txt', exact: true }), 4.5],
      ['folder icon', header.locator('svg.lucide-folder-closed'), 3],
      ['PDF icon', tree.getByRole('button', { name: 'report.pdf', exact: true }).locator('svg'), 3],
      ['spreadsheet icon', tree.getByRole('button', { name: 'budget.xlsx', exact: true }).locator('svg'), 3],
      ['presentation icon', tree.getByRole('button', { name: 'slides.pptx', exact: true }).locator('svg'), 3],
      ['Chat paragraph', chat.getByText('Readable project summary with', { exact: false }), 4.5],
      ['creation button', page.getByRole('button', { name: 'Add folder or files', exact: true }), 4.5],
    ]
    for (const [name, locator, minimum] of checks) {
      const value = await paint(locator)
      report.push(`| ${colorScheme} | ${name} | ${value.contrast.toFixed(2)} |`)
      if (value.contrast < minimum) failures.push(`${colorScheme}: ${name} contrast ${value.contrast.toFixed(2)} < ${minimum}`)
    }
    for (const [name, locator] of [['resource', resource], ['Chat', chat]] as const) {
      const handle = await paint(locator.locator('.react-flow__handle.source'))
      if (handle.width !== '10px' || JSON.stringify(handle.fill) !== JSON.stringify(handle.primary)
        || JSON.stringify(handle.border) !== JSON.stringify(handle.surface)) {
        failures.push(`${colorScheme}: ${name} port ${JSON.stringify(handle)}`)
      }
    }
    const edge = page.locator(`[data-convax-edge="${edgeId}"]`)
    await edge.locator('.react-flow__edge-interaction').click()
    const cut = page.locator(`[data-convax-edge-cut="${edgeId}"]`)
    await expect.poll(() => cut.isVisible()).toBe(true)
    const cutColor = await paint(cut)
    report.push(`| ${colorScheme} | connection action | ${cutColor.contrast.toFixed(2)} |`)
    if (cutColor.contrast < 3) failures.push(`${colorScheme}: connection action contrast ${cutColor.contrast.toFixed(2)}`)
    await header.click()
    const toolbar = page.getByRole('toolbar', { name: 'Actions for Project', exact: true })
    await toolbar.waitFor()
    const control = toolbar.getByRole('button', { name: 'Show in file manager', exact: true })
    await page.keyboard.press('Tab')
    await control.focus()
    const focused = await paint(control)
    if (focused.outline !== 'solid' || !focused.focused || !focused.focusVisible || focused.outlineColor[3] === 0) {
      failures.push(`${colorScheme}: card toolbar keyboard focus ${JSON.stringify(focused)}`)
    }
    await page.screenshot({ path: join(ARTIFACTS, `${colorScheme}-canvas.png`) })
    await page.getByRole('button', { name: 'Workspace actions', exact: true }).click()
    const menu = page.getByRole('menu')
    await menu.waitFor()
    const settings = menu.getByRole('menuitem', { name: 'Settings', exact: true })
    const menuColor = await paint(settings)
    report.push(`| ${colorScheme} | menu text | ${menuColor.contrast.toFixed(2)} |`)
    if (menuColor.contrast < 4.5) failures.push(`${colorScheme}: menu text contrast ${menuColor.contrast.toFixed(2)}`)
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: 'Workspace actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'All canvases', exact: true }).click()
    const manager = page.getByRole('dialog', { name: 'All canvases', exact: true })
    const search = manager.getByRole('searchbox', { name: 'Search canvases', exact: true })
    const placeholder = await paint(search, '::placeholder')
    report.push(`| ${colorScheme} | search placeholder | ${placeholder.contrast.toFixed(2)} |`)
    if (placeholder.contrast < 4.5) failures.push(`${colorScheme}: search placeholder contrast ${placeholder.contrast.toFixed(2)}`)
    await search.fill('No matching canvas')
    const empty = manager.getByRole('status')
    await empty.waitFor()
    const emptyColor = await paint(empty)
    report.push(`| ${colorScheme} | empty search | ${emptyColor.contrast.toFixed(2)} |`)
    if (emptyColor.contrast < 4.5) failures.push(`${colorScheme}: empty search contrast ${emptyColor.contrast.toFixed(2)}`)
    await page.screenshot({ path: join(ARTIFACTS, `${colorScheme}-manager.png`) })
    await page.keyboard.press('Escape')
    await manager.waitFor({ state: 'detached' })
    await tree.getByRole('button', { name: 'notes.txt', exact: true }).hover()
    const hover = await paint(tree.getByRole('button', { name: 'notes.txt', exact: true }))
    if (hover.contrast < 4.5) failures.push(`${colorScheme}: tree hover contrast ${hover.contrast.toFixed(2)}`)
  }
  await page.setViewportSize({ width: 390, height: 844 })
  for (const name of ['Add folder or files', 'New chat']) {
    const button = page.locator('.react-flow__panel.bottom.center').getByRole('button', { name, exact: true })
    const box = await button.boundingBox()
    expect(box).not.toBeNull()
    if (box === null) throw new Error('Creation action is unavailable')
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: join(ARTIFACTS, 'dark-narrow.png') })
  await writeFile(join(ARTIFACTS, 'acceptance.md'), [...report, '', ...failures.map(value => `- ${value}`), ''].join('\n'))
  expect(console.pageErrors).toEqual([])
  expect(failures, 'theme acceptance findings').toEqual([])
})
