/** Native terminal and browser cards keep their running resources across canvas navigation. */
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Locator, type Page } from 'playwright'
import { expect, it, vi } from 'vitest'
import type {} from '@deepseek-ai/dsh-convax-plugin-host'
import type {} from '@deepseek-ai/dsh-convax-plugin-inernal-nodes-host'
import type { CanvasCommand, CanvasDocument, CanvasId, CanvasOperationId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const BUNDLE = fileURLToPath(new URL('../../../../../packages/plugin-renderer/', import.meta.url))
const SHELL = fileURLToPath(new URL('./fixtures/convax-tool-cards.patch.yml', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/convax-tool-cards/', import.meta.url))
const ARTIFACTS = fileURLToPath(new URL('../../../../../.artifacts/convax-tool-cards/', import.meta.url))

async function execute(scaffold: WebScaffold, canvasId: CanvasId, command: CanvasCommand): Promise<void> {
  const canvas = scaffold.ctx.convax.workspace().canvases.find(item => item.id === canvasId)
  const result = await scaffold.ctx.convax.execute({ canvasId, expectedRevision: canvas?.revision ?? 0,
    operationId: randomUUID() as CanvasOperationId, command })
  if (!result.ok) throw new Error(`Tool-card fixture ${command.kind}: ${result.code}: ${result.message}`)
}

function currentDocument(scaffold: WebScaffold, canvasId: CanvasId): CanvasDocument {
  const canvas = scaffold.ctx.convax.workspace().canvases.find(item => item.id === canvasId)
  if (canvas === undefined) throw new Error('The tool-card canvas is missing')
  return canvas
}

function visibleGraph(page: Page): Locator {
  return page.locator('[data-convax-canvas]:not([hidden])')
}

async function terminalCommand(page: Page, terminal: Locator, text: string): Promise<void> {
  await terminal.locator('.xterm-helper-textarea').click()
  await page.keyboard.insertText(text)
  await page.keyboard.press('Enter')
}

async function openCanvas(page: Page, canvasId: CanvasId): Promise<void> {
  await page.getByRole('button', { name: 'Workspace actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'All canvases', exact: true }).click()
  await page.locator(`[data-canvas-manager-row="${canvasId}"] button`).first().click()
}

it.skipIf(process.platform === 'win32')('creates native tool cards and preserves their runtime through tab changes, then releases deleted resources', async () => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: [join(BUNDLE, 'cordis.patch.yml'), SHELL],
    extraInstallAnchors: [join(BUNDLE, 'package.json')],
  })
  try {
    const handles: SubprocessTerminalHandle[] = []
    const spawn = scaffold.ctx.subprocess.spawnTerminal.bind(scaffold.ctx.subprocess)
    const spawnSpy = vi.spyOn(scaffold.ctx.subprocess, 'spawnTerminal').mockImplementation(async (spec) => {
      const handle = await spawn(spec)
      handles.push(handle)
      return handle
    })
    try {
      const browser = await chromium.launch()
      try {
        const page = await newEnglishPage(browser)
        const console = watchConsole(page)
        const diagnostics: string[] = []
        page.on('console', (message) => { if (message.type() === 'error') diagnostics.push(message.text()) })
        try {
          await page.route('https://tool-cards.test/**', async route => route.fulfill({
            contentType: 'text/html',
            body: '<h1>Canvas browser page</h1><label>Page draft <input aria-label="Page draft"></label>',
          }))
          await page.emulateMedia({ reducedMotion: 'reduce' })
          await page.goto(scaffold.authenticatedUrl)
          await page.locator('[data-convax-workspace]').waitFor({ timeout: 30_000 })
          const initialAgents = scaffold.ctx.agents.list().length
          const before = new Set(scaffold.ctx.convax.workspace().canvases.map(canvas => canvas.id))
          await page.getByRole('button', { name: 'New canvas', exact: true }).first().click()
          await expect.poll(() => scaffold.ctx.convax.workspace().canvases.filter(canvas => !before.has(canvas.id)).length).toBe(1)
          const canvasId = scaffold.ctx.convax.workspace().canvases.find(canvas => !before.has(canvas.id))!.id
          await execute(scaffold, canvasId, { kind: 'rename', title: 'Tool cards' })
          await page.getByRole('tab', { name: 'Tool cards', exact: true }).waitFor()
          const directory = await scaffold.ctx.convax.ensureCanvasDirectory(canvasId)
          const document = () => currentDocument(scaffold, canvasId)

          await visibleGraph(page).locator('[data-convax-creation-dock]').getByRole('button', { name: 'Terminal', exact: true }).click()
          await expect.poll(() => document().nodes.filter(node => node.typeId === 'convax.terminal').length).toBe(1)
          const terminalId = document().nodes.find(node => node.typeId === 'convax.terminal')!.id
          const terminal = page.locator(`[data-convax-terminal="${terminalId}"]`)
          await terminal.locator('.xterm-rows').waitFor({ timeout: 30_000 })
          await expect.poll(() => scaffold.ctx.convaxTerminal.list(canvasId, terminalId).length).toBe(1)
          const runtime = scaffold.ctx.convaxTerminal.list(canvasId, terminalId)[0]!
          expect(runtime.cwd).toBe(directory)
          await terminalCommand(page, terminal, 'CARD_VALUE=kept; printf "CARD_STARTED\\n"')
          await expect.poll(() => terminal.locator('.xterm-rows').innerText(), { timeout: 15_000 }).toContain('CARD_STARTED')

          await visibleGraph(page).locator('[data-convax-creation-dock]').getByRole('button', { name: 'Browser', exact: true }).click()
          await expect.poll(() => document().nodes.filter(node => node.typeId === 'convax.browser').length).toBe(1)
          const browserId = document().nodes.find(node => node.typeId === 'convax.browser')!.id
          await execute(scaffold, canvasId, { kind: 'move-nodes', nodes: [
            { id: terminalId, position: { x: 0, y: 0 } }, { id: browserId, position: { x: 720, y: 0 } },
          ] })
          await visibleGraph(page).getByRole('button', { name: 'Fit canvas', exact: true }).click()
          const browserCard = page.locator(`[data-convax-browser="${browserId}"]`)
          const address = browserCard.getByRole('textbox', { name: 'Enter an HTTP(S) address', exact: true })
          await address.fill('https://tool-cards.test/preview')
          await address.press('Enter')
          const frame = browserCard.locator('[data-sidebar-browser-frame]')
          const pageDraft = frame.contentFrame().getByRole('textbox', { name: 'Page draft', exact: true })
          await pageDraft.fill('This page stays alive')
          const originalTerminal = await terminal.elementHandle()
          const originalFrame = await frame.elementHandle()
          expect(originalTerminal).not.toBeNull()
          expect(originalFrame).not.toBeNull()
          expect(scaffold.ctx.agents.list().length).toBe(initialAgents)
          expect(scaffold.ctx.convax.workspace().chats).toEqual([])
          await mkdir(EXPECTED, { recursive: true })
          await compareOrRefreshGolden(join(EXPECTED, 'browser.expected.md'),
            await captureStableAria(page, `[data-convax-browser="${browserId}"]`, scaffold.workspaceCwd), webSnapshotMode())
          await mkdir(ARTIFACTS, { recursive: true })
          await page.screenshot({ path: join(ARTIFACTS, 'tool-cards.png') })

          await page.getByRole('button', { name: 'New canvas', exact: true }).first().click()
          await terminal.waitFor({ state: 'hidden' })
          expect(await terminal.evaluate(element => element.closest('[data-convax-canvas]')?.hasAttribute('inert'))).toBe(true)
          expect(scaffold.ctx.convaxTerminal.list(canvasId, terminalId)[0]!.id).toBe(runtime.id)
          await page.getByRole('tab', { name: 'Tool cards', exact: true }).click()
          await terminal.waitFor({ state: 'visible' })
          expect(await terminal.evaluate((element, original) => element === original, originalTerminal)).toBe(true)
          expect(await frame.evaluate((element, original) => element === original, originalFrame)).toBe(true)
          expect(await pageDraft.inputValue()).toBe('This page stays alive')

          await page.getByRole('button', { name: 'Close Tool cards', exact: true }).click()
          await terminal.waitFor({ state: 'hidden' })
          expect(scaffold.ctx.convaxTerminal.list(canvasId, terminalId)[0]!.id).toBe(runtime.id)
          await openCanvas(page, canvasId)
          await terminal.waitFor({ state: 'visible' })
          expect(await terminal.evaluate((element, original) => element === original, originalTerminal)).toBe(true)
          expect(await frame.evaluate((element, original) => element === original, originalFrame)).toBe(true)
          expect(await pageDraft.inputValue()).toBe('This page stays alive')
          await terminalCommand(page, terminal, 'printf "CARD_VALUE=%s\\n" "$CARD_VALUE"')
          await expect.poll(() => terminal.locator('.xterm-rows').innerText(), { timeout: 15_000 }).toContain('CARD_VALUE=kept')
          expect(handles).toHaveLength(1)

          await terminal.locator('[data-convax-tool-drag]').click()
          await page.getByRole('toolbar', { name: 'Actions for Terminal', exact: true })
            .getByRole('button', { name: 'Remove reference', exact: true }).click()
          await expect.poll(() => document().nodes.some(node => node.id === terminalId)).toBe(false)
          await handles[0]!.done
          await terminal.waitFor({ state: 'detached' })
          await visibleGraph(page).getByRole('button', { name: 'Undo', exact: true }).click()
          await terminal.waitFor({ state: 'visible' })
          await terminal.getByRole('button', { name: 'New terminal', exact: true }).waitFor()
          expect(handles).toHaveLength(1)
          expect(scaffold.ctx.convaxTerminal.list(canvasId, terminalId)).toEqual([])
          await compareOrRefreshGolden(join(EXPECTED, 'restored-terminal.expected.md'),
            await captureStableAria(page, `[data-convax-terminal="${terminalId}"]`, scaffold.workspaceCwd), webSnapshotMode())

          await browserCard.locator('[data-convax-browser-header]').click()
          await page.getByRole('toolbar', { name: 'Actions for Browser', exact: true })
            .getByRole('button', { name: 'Remove reference', exact: true }).click()
          await browserCard.waitFor({ state: 'detached' })
          expect(await page.locator(`[data-convax-browser="${browserId}"] iframe`).count()).toBe(0)
          await visibleGraph(page).getByRole('button', { name: 'Undo', exact: true }).click()
          await browserCard.waitFor({ state: 'visible' })
          expect(document().nodes.map(node => node.typeId).sort()).toEqual(['convax.browser', 'convax.terminal'])
          expect(console.pageErrors).toEqual([])
        } catch (error) {
          globalThis.console.error('Tool-card browser diagnostics', { pageErrors: console.pageErrors, diagnostics })
          await saveFailureShot(page, 'web-e2e-convax-tool-cards')
          throw error
        } finally { await page.close() }
      } finally { await browser.close() }
    } finally { spawnSpy.mockRestore() }
  } finally { await scaffold.close() }
})
