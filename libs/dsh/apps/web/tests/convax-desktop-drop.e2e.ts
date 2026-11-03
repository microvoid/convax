/** Desktop File drops cross the existing preload capability into real Host resource commands. */
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {} from '@deepseek-ai/dsh-convax-plugin-host'
import type { CanvasId, CanvasOperationId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const BUNDLE = fileURLToPath(new URL('../../../../../packages/plugin-renderer/', import.meta.url))
const PICKER = fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url))

it('adds real file and folder nodes from browser File drops through the Desktop path adapter', async () => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: [join(BUNDLE, 'cordis.patch.yml'), PICKER], extraInstallAnchors: [join(BUNDLE, 'package.json')],
  })
  try {
    const browser = await chromium.launch()
    try {
      const folder = join(scaffold.workspaceCwd, 'folder with spaces')
      const file = join(scaffold.workspaceCwd, 'notes.txt')
      await mkdir(folder)
      await writeFile(join(folder, 'readme.md'), 'Folder resource\n')
      await writeFile(file, 'File resource\n')
      const canvasId = randomUUID() as CanvasId
      expect((await scaffold.ctx.convax.execute({ canvasId, expectedRevision: 0,
        operationId: randomUUID() as CanvasOperationId, command: { kind: 'create', title: 'Native path drop' },
      })).ok).toBe(true)
      const page = await newEnglishPage(browser)
      const console = watchConsole(page)
      await page.addInitScript((paths: Record<string, string>) => {
        Object.defineProperty(globalThis, '__DSH_HOST_PATHS__', { value: {
          pathFor(file: File) { return paths[file.name] ?? '' },
        } })
      }, { 'folder with spaces': folder, 'notes.txt': file })
      await page.goto(scaffold.authenticatedUrl)
      await page.locator('[data-convax-workspace]').waitFor({ timeout: 30_000 })
      await page.getByRole('button', { name: 'Workspace actions', exact: true }).click()
      await page.getByRole('menuitem', { name: 'All canvases', exact: true }).click()
      await page.locator('[data-canvas-manager-row="' + canvasId + '"] button').first().click()
      const pane = page.locator('.react-flow__pane')
      await pane.waitFor()
      const bounds = await pane.boundingBox()
      if (bounds === null) throw new Error('The canvas drop pane is not visible')
      const transfer = await page.evaluateHandle(() => {
        const value = new DataTransfer()
        value.items.add(new File([], 'folder with spaces'))
        value.items.add(new File(['Browser bytes are not the Host resource'], 'notes.txt'))
        return value
      })
      try {
        await expect.poll(async () => {
          await pane.dispatchEvent('dragover', { dataTransfer: transfer })
          return transfer.evaluate(value => value.dropEffect)
        }).toBe('copy')
        await pane.dispatchEvent('drop', { dataTransfer: transfer, clientX: bounds.x + 200, clientY: bounds.y + 150 })
      } finally { await transfer.dispose() }
      const nodes = () => scaffold.ctx.convax.workspace().canvases.find(canvas => canvas.id === canvasId)?.nodes ?? []
      await expect.poll(() => nodes().map(node => node.typeId).sort()).toEqual(['convax.file', 'convax.folder'])
      const folderResource = await scaffold.ctx.convax.describe(folder)
      const fileResource = await scaffold.ctx.convax.describe(file)
      expect(nodes().map(node => node.data.path).sort()).toEqual([folderResource.path, fileResource.path].sort())
      const preview = await scaffold.ctx.convax.previewFile(fileResource.path)
      expect(preview.text).toBe('File resource\n')
      const directory = await scaffold.ctx.convax.listDirectory(folderResource.path)
      expect(directory.entries.map(entry => entry.name)).toContain('readme.md')
      await expect.poll(() => page.locator('.react-flow__node').count()).toBe(2)
      await page.reload()
      await page.locator('.react-flow__node').first().waitFor({ timeout: 30_000 })
      expect(await page.locator('.react-flow__node').count()).toBe(2)
      expect(console.pageErrors).toEqual([])
    } finally { await browser.close() }
  } finally { await scaffold.close() }
})
