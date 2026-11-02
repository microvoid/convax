/** Ordinary local bundles register Convax Host/client contributions through Plugin Manager. */
import { randomUUID } from 'node:crypto'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {} from '@deepseek-ai/dsh-convax-plugin-host'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import type {} from '@deepseek-ai/dsh-skill'
import type { CanvasId, CanvasOperationId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const BUNDLE = fileURLToPath(new URL('../../../packages/convax/plugin-renderer/', import.meta.url))
const PICKER = fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url))
const TEMPLATE = fileURLToPath(new URL('../../../packages/convax/plugin-host/templates/canvas-note/', import.meta.url))

it('discovers the owned skill and installs, edits, disables and restores a real canvas plugin bundle', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'convax-plugin-development-'))
  try {
    const source = join(scratch, 'my note bundle')
    await cp(TEMPLATE, source, { recursive: true })
    const scaffold = await launchWebScaffold({
      extraOverlayPath: [join(BUNDLE, 'cordis.patch.yml'), PICKER], extraInstallAnchors: [join(BUNDLE, 'package.json')],
      profile: { packages: [], packageManager: {
        command: 'pnpm', args: [], env: { pnpm_config_store_dir: join(scratch, 'pnpm-store'),
          pnpm_config_cache_dir: join(scratch, 'pnpm-cache'), pnpm_config_offline: 'true' },
      } },
    })
    try {
      const skill = await scaffold.ctx.skills.get('convax-plugin-development', { cwd: scaffold.workspaceCwd })
      expect(skill?.content).toContain('plugin_manager')
      expect(skill?.resourceBase?.kind).toBe('directory')
      const canvasId = randomUUID() as CanvasId
      expect((await scaffold.ctx.convax.execute({ canvasId, expectedRevision: 0,
        operationId: randomUUID() as CanvasOperationId, command: { kind: 'create', title: 'Installed note plugin' },
      })).ok).toBe(true)
      const browser = await chromium.launch()
      try {
        const page = await newEnglishPage(browser)
        const console = watchConsole(page)
        await page.goto(scaffold.authenticatedUrl)
        await page.locator('[data-convax-workspace]').waitFor({ timeout: 30_000 })
        await page.getByRole('button', { name: 'Workspace actions', exact: true }).click()
        await page.getByRole('menuitem', { name: 'All canvases', exact: true }).click()
        await page.locator('[data-canvas-manager-row="' + canvasId + '"] button').first().click()
        const installed = await scaffold.ctx.pluginManager.installBundle(source)
        expect(installed, JSON.stringify({ error: installed.error, warnings: installed.warnings })).toMatchObject({ changed: true, application: 'applied' })
        await expect.poll(() => scaffold.ctx.convax.workspace().nodeTypes.some(type => type.id === 'local.note')).toBe(true)
        const rejected = await scaffold.ctx.tools.execute({
          calls: [{ type: 'tool-call', id: ToolCallId('reject-note'), name: 'convax_note_create', arguments: JSON.stringify({
            canvasId, expectedRevision: 1, operationId: randomUUID(), nodeId: 'invalid-note', text: 'Invalid', x: 'invalid', y: 120,
          }) }], signal: new AbortController().signal,
        })
        expect(rejected.results[0]?.result.isError).toBe(true)
        expect(scaffold.ctx.convax.workspace().canvases.find(canvas => canvas.id === canvasId)?.nodes).toEqual([])
        const created = await scaffold.ctx.tools.execute({
          calls: [{ type: 'tool-call', id: ToolCallId('create-note'), name: 'convax_note_create', arguments: JSON.stringify({
            canvasId, expectedRevision: 1, operationId: randomUUID(), nodeId: 'example-note',
            text: 'First note', x: 160, y: 120,
          }) }], signal: new AbortController().signal,
        })
        expect(created.results[0]?.result.isError).toBe(false)
        const card = page.locator('[data-local-convax-note="example-note"]')
        await card.waitFor({ timeout: 30_000 })
        expect(await card.getByRole('textbox', { name: 'Note text' }).inputValue()).toBe('First note')
        await card.getByRole('textbox', { name: 'Note text' }).fill('Saved in the canvas')
        await card.getByRole('button', { name: 'Save', exact: true }).click()
        const stored = () => scaffold.ctx.convax.workspace().canvases.find(canvas => canvas.id === canvasId)?.nodes[0]?.data.text
        await expect.poll(stored).toBe('Saved in the canvas')
        await page.reload()
        await card.waitFor({ timeout: 30_000 })
        expect(await card.getByRole('textbox', { name: 'Note text' }).inputValue()).toBe('Saved in the canvas')
        expect(await scaffold.ctx.pluginManager.setBundleEnabled('@local/convax-note', false)).toMatchObject({ application: 'applied' })
        await expect.poll(() => card.count()).toBe(0)
        expect(scaffold.ctx.convax.workspace().nodeTypes.some(type => type.id === 'local.note')).toBe(false)
        expect(stored()).toBe('Saved in the canvas')
        expect(scaffold.ctx.tools.get('convax_note_create')).toBeUndefined()
        expect(await scaffold.ctx.pluginManager.setBundleEnabled('@local/convax-note', true)).toMatchObject({ application: 'applied' })
        await card.waitFor({ timeout: 30_000 })
        expect(await card.getByRole('textbox', { name: 'Note text' }).inputValue()).toBe('Saved in the canvas')
        expect(console.pageErrors).toEqual([])
      } finally { await browser.close() }
    } finally { await scaffold.close() }
  } finally { await rm(scratch, { recursive: true, force: true }) }
})


it('installs the same ordinary bundle in native DSH without enabling a canvas product or tool', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'convax-plugin-native-'))
  try {
    const source = join(scratch, 'native note bundle')
    await cp(TEMPLATE, source, { recursive: true })
    const scaffold = await launchWebScaffold({
      extraOverlayPath: PICKER,
      profile: { packages: [], packageManager: {
        command: 'pnpm', args: [], env: { pnpm_config_store_dir: join(scratch, 'pnpm-store'),
          pnpm_config_cache_dir: join(scratch, 'pnpm-cache'), pnpm_config_offline: 'true' },
      } },
    })
    try {
      const browser = await chromium.launch()
      try {
        const page = await newEnglishPage(browser)
        const console = watchConsole(page)
        await page.goto(scaffold.authenticatedUrl)
        await page.locator('[class*="frame"]').first().waitFor({ timeout: 30_000 })
        const installed = await scaffold.ctx.pluginManager.installBundle(source)
        expect(installed, JSON.stringify({ error: installed.error, warnings: installed.warnings })).toMatchObject({ changed: true, application: 'applied' })
        const plugins = await scaffold.ctx.pluginManager.listPlugins()
        expect(plugins.find(plugin => plugin.patchId === 'local-convax-note')).toMatchObject({ fiberPhase: 'active' })
        expect(scaffold.ctx.get('convax')).toBeUndefined()
        expect(scaffold.ctx.tools.get('convax_note_create')).toBeUndefined()
        expect(await page.locator('[data-convax-workspace]').count()).toBe(0)
        expect(await page.locator('[data-local-convax-note]').count()).toBe(0)
        expect(console.pageErrors).toEqual([])
      } finally { await browser.close() }
    } finally { await scaffold.close() }
  } finally { await rm(scratch, { recursive: true, force: true }) }
})
