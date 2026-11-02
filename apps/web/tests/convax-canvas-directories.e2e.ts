/** Canvas-owned directories through the real Host, browser creation controls, and durable Sessions. */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {} from '@deepseek-ai/dsh-convax-plugin-host'
import type { CanvasCommand, CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const BUNDLE = fileURLToPath(new URL('../../../packages/convax/plugin-renderer/', import.meta.url))
const PICKER = fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/convax-canvas-directories/', import.meta.url))

async function execute(scaffold: WebScaffold, canvasId: CanvasId, command: CanvasCommand): Promise<void> {
  const canvas = scaffold.ctx.convax.workspace().canvases.find(item => item.id === canvasId)
  const result = await scaffold.ctx.convax.execute({ canvasId, expectedRevision: canvas?.revision ?? 0,
    operationId: randomUUID() as CanvasOperationId, command })
  if (!result.ok) throw new Error(`Canvas directory fixture ${command.kind}: ${result.code}: ${result.message}`)
}

function creationDock(page: Page) {
  return page.locator('.react-flow__panel').filter({ has: page.getByRole('button', { name: 'Add project', exact: true }) })
}

async function sessionDirectory(scaffold: WebScaffold, sessionId: SessionId): Promise<string | undefined> {
  return (await scaffold.ctx.sessionPersistence.stat(sessionId))?.header.cwd
}

it('creates canvas directories automatically and uses them for new Chats while folder Chats retain their selected project', async () => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'convax-canvas-directories-')))
  try {
    const root = join(scratch, 'canvas-workspaces')
    const patch = join(scratch, 'directories.overlay.json')
    await writeFile(patch, JSON.stringify([{ id: 'convax-host', config: {
      databasePath: join(scratch, 'canvas.sqlite'), canvasDirectoryRoot: root,
    } }]))
    const scaffold = await launchWebScaffold({
      extraOverlayPath: [join(BUNDLE, 'cordis.patch.yml'), PICKER, patch], extraInstallAnchors: [join(BUNDLE, 'package.json')],
    })
    try {
      const browser = await chromium.launch()
      try {
        const page = await newEnglishPage(browser)
        const console = watchConsole(page)
        try {
          await page.emulateMedia({ reducedMotion: 'reduce' })
          await page.goto(scaffold.authenticatedUrl)
          await page.locator('[data-convax-workspace]').waitFor({ timeout: 30_000 })
          const before = new Set(scaffold.ctx.convax.workspace().canvases.map(item => item.id))
          await page.getByRole('button', { name: 'New canvas', exact: true }).first().click()
          await expect.poll(() => scaffold.ctx.convax.workspace().canvases.filter(item => !before.has(item.id)).length).toBe(1)
          const canvasId = scaffold.ctx.convax.workspace().canvases.find(item => !before.has(item.id))!.id
          const document = () => scaffold.ctx.convax.workspace().canvases.find(item => item.id === canvasId)!
          const directory = join(root, `canvas-${encodeURIComponent(canvasId)}`)
          await expect.poll(() => stat(directory).then(value => value.isDirectory(), () => false)).toBe(true)

          await creationDock(page).getByRole('button', { name: 'New chat', exact: true }).click()
          await expect.poll(async () => ({
            picker: await page.getByRole('dialog', { name: 'Select Workspace Directory', exact: true }).count(),
            chats: document().nodes.filter(item => item.typeId === 'convax.chat').length,
          }), { timeout: 15_000 }).toEqual({ picker: 0, chats: 1 })
          expect(await page.getByRole('dialog', { name: 'Select Workspace Directory', exact: true }).count()).toBe(0)
          const firstChat = document().nodes.find(item => item.typeId === 'convax.chat')!
          expect(firstChat.data.cwd).toBe(directory)
          const chat = page.locator(`[data-convax-chat="${firstChat.id}"]`)
          await chat.locator('[data-composer-input][contenteditable="true"]:visible').waitFor({ timeout: 15_000 })
          const threads = () => scaffold.ctx.convax.workspace().chats.find(item => item.nodeId === firstChat.id)!.threads
          await expect.poll(() => threads().length).toBe(1)
          await expect.poll(() => sessionDirectory(scaffold, threads()[0]!.sessionId)).toBe(directory)
          await mkdir(EXPECTED, { recursive: true })
          await compareOrRefreshGolden(join(EXPECTED, 'new-chat.expected.md'),
            await captureStableAria(page, `[data-convax-chat="${firstChat.id}"] [data-composer-card]:visible`, scaffold.workspaceCwd),
            webSnapshotMode())
          await chat.getByRole('button', { name: 'New thread', exact: true }).click()
          await expect.poll(() => threads().length).toBe(2)
          for (const thread of threads()) expect(await sessionDirectory(scaffold, thread.sessionId)).toBe(directory)

          await page.getByRole('tab', { name: document().title, exact: true }).dblclick()
          const rename = page.getByRole('dialog', { name: 'Rename canvas', exact: true })
          await rename.getByRole('textbox', { name: 'Canvas name', exact: true }).fill('Canvas directory survives rename')
          await rename.getByRole('button', { name: 'Save', exact: true }).click()
          await rename.waitFor({ state: 'hidden' })
          await page.reload()
          await chat.locator('[data-composer-input][contenteditable="true"]:visible').waitFor({ timeout: 30_000 })
          await creationDock(page).getByRole('button', { name: 'New chat', exact: true }).click()
          await expect.poll(() => document().nodes.filter(item => item.typeId === 'convax.chat').length).toBe(2)
          expect(document().nodes.filter(item => item.typeId === 'convax.chat').map(item => item.data.cwd)).toEqual([directory, directory])
          expect((await stat(directory)).isDirectory()).toBe(true)

          const folder = join(scratch, 'explicit-project')
          await mkdir(folder)
          const folderId = randomUUID() as CanvasNodeId
          await execute(scaffold, canvasId, { kind: 'add-node', node: {
            id: folderId, typeId: 'convax.folder' as CanvasNodeTypeId, dataVersion: 1,
            data: { path: folder }, position: { x: 80, y: 800 }, revision: 0,
          } })
          await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
          const folderCard = page.locator(`[data-convax-resource="${folderId}"]`)
          await folderCard.locator('[data-convax-resource-header]').click()
          await page.getByRole('toolbar', { name: 'Actions for explicit-project', exact: true })
            .getByRole('button', { name: 'New chat', exact: true }).click()
          await expect.poll(() => document().nodes.filter(item => item.typeId === 'convax.chat').length).toBe(3)
          const projectChat = document().nodes.find(item => item.typeId === 'convax.chat' && item.data.cwd === folder)!
          expect(projectChat).toBeDefined()
          await expect.poll(() => scaffold.ctx.convax.workspace().chats.find(item => item.nodeId === projectChat.id)
            ?.threads.length).toBe(1)
          const projectSession = scaffold.ctx.convax.workspace().chats.find(item => item.nodeId === projectChat.id)!.threads[0]!.sessionId
          expect(await sessionDirectory(scaffold, projectSession)).toBe(folder)
          expect(document().connections.some(item => item.source === folderId && item.target === projectChat.id)).toBe(true)
          expect(await page.getByRole('dialog', { name: 'Select Workspace Directory', exact: true }).count()).toBe(0)
          expect(await scaffold.ctx.convax.ensureCanvasDirectory(canvasId)).toBe(directory)

          const canvasIds = new Set(scaffold.ctx.convax.workspace().canvases.map(item => item.id))
          await page.getByRole('button', { name: 'Workspace actions', exact: true }).click()
          await page.getByRole('menuitem', { name: 'All canvases', exact: true }).click()
          const manager = page.getByRole('dialog', { name: 'All canvases', exact: true })
          await manager.locator(`[data-canvas-manager-row="${canvasId}"]`).getByRole('button', { name: /^Actions for / }).click()
          await page.getByRole('menuitem', { name: 'Duplicate canvas', exact: true }).click()
          await manager.waitFor({ state: 'hidden' })
          await expect.poll(() => scaffold.ctx.convax.workspace().canvases.filter(item => !canvasIds.has(item.id)).length).toBe(1)
          const copyId = scaffold.ctx.convax.workspace().canvases.find(item => !canvasIds.has(item.id))!.id
          const copy = () => scaffold.ctx.convax.workspace().canvases.find(item => item.id === copyId)!
          const copyDirectory = join(root, `canvas-${encodeURIComponent(copyId)}`)
          expect(copyDirectory).not.toBe(directory)
          expect((await stat(copyDirectory)).isDirectory()).toBe(true)
          const copiedNodes = new Set(copy().nodes.map(item => item.id))
          await expect.poll(() => scaffold.ctx.convax.workspace().chats.filter(item => item.canvasId === copyId)
            .map(item => item.threads.length), { timeout: 15_000 }).toEqual([1, 1, 1])
          await creationDock(page).getByRole('button', { name: 'New chat', exact: true }).click()
          await expect.poll(() => copy().nodes.filter(item => !copiedNodes.has(item.id)).length).toBe(1)
          const newCopyChat = copy().nodes.find(item => !copiedNodes.has(item.id))!
          expect(newCopyChat.data.cwd).toBe(copyDirectory)
          await expect.poll(() => scaffold.ctx.convax.workspace().chats.find(item => item.nodeId === newCopyChat.id)
            ?.threads.length).toBe(1)
          const copySession = scaffold.ctx.convax.workspace().chats.find(item => item.nodeId === newCopyChat.id)!.threads[0]!.sessionId
          expect(await sessionDirectory(scaffold, copySession)).toBe(copyDirectory)
          expect(await scaffold.ctx.convax.ensureCanvasDirectory(canvasId)).toBe(directory)
          expect(console.pageErrors).toEqual([])
        } catch (error) {
          await saveFailureShot(page, 'web-e2e-convax-canvas-directories')
          throw error
        } finally { await page.close() }
      } finally { await browser.close() }
    } finally { await scaffold.close() }
  } finally { await rm(scratch, { recursive: true, force: true }) }
})

it('confines ordinary Convax scaffold directories to its owned temporary workspace', async () => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: [join(BUNDLE, 'cordis.patch.yml'), PICKER], extraInstallAnchors: [join(BUNDLE, 'package.json')],
  })
  try {
    const canvasId = randomUUID() as CanvasId
    await execute(scaffold, canvasId, { kind: 'create', title: 'Isolated default root' })
    const directory = join(scaffold.workspaceCwd, 'Documents', 'convax', `canvas-${encodeURIComponent(canvasId)}`)
    expect(await scaffold.ctx.convax.ensureCanvasDirectory(canvasId)).toBe(directory)
    expect((await stat(directory)).isDirectory()).toBe(true)
  } finally { await scaffold.close() }
})
