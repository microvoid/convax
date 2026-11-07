/** Composer choices become durable defaults for later Convax Chat threads. */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { bundlePatchPaths, composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-convax-plugin-host'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { chromium, type Locator, type Page } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, readPersistedEvents,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, REPO_ROOT, saveFailureShot } from './support.ts'

const BUNDLE = fileURLToPath(new URL('../../../../../packages/plugin-renderer/', import.meta.url))
const PICKER = fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/convax-composer-preferences/', import.meta.url))

function creationDock(page: Page): Locator {
  return page.locator('[data-convax-creation-dock]')
}

async function expectFreshSession(
  scaffold: WebScaffold, sessionId: SessionId, preset: string, permission: string,
): Promise<void> {
  await expect.poll(() => {
    const agent = scaffold.ctx.agents.get(sessionId)
    return agent === undefined ? undefined : {
      preset: scaffold.ctx.agentPresets.presetForSession(agent.session),
      permission: scaffold.ctx.permissionPresets.current(agent.session),
    }
  }, { timeout: 15_000 }).toEqual({ preset, permission })
  const agent = scaffold.ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error('Composer preferences Session detached before persistence')
  await scaffold.ctx.sessions.flush(agent.session)
  expect((await scaffold.ctx.sessionPersistence.stat(sessionId))?.header.agentPreset).toBe(preset)
  const events = await readPersistedEvents(scaffold, sessionId)
  expect(events.findLast(event => event.type === 'permission/preset')?.data).toEqual({ preset: permission })
}

async function recordCompletedTurn(scaffold: WebScaffold, sessionId: SessionId): Promise<void> {
  const agent = scaffold.ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error('Composer preferences fixture has no active Agent')
  agent.session.append('turn/start', { turn: 1 })
  agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Remember the selected conversation defaults.' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  agent.session.append('step/start', { turn: 1, step: 1 })
  agent.session.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: createAssistantMessage({ content: [{ type: 'text', text: 'The conversation has a completed turn.' }],
      source: { provider: 'fixture', model: 'fixture' } }),
  }, { surfaceOp: 'append' })
  agent.session.append('step/end', { turn: 1, step: 1 })
  agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await scaffold.ctx.sessions.flush(agent.session)
}

it('remembers mode and confirmed permissions across new threads and a browser reload', async () => {
  const webBundle = join(REPO_ROOT, 'packages/bundle/web-app')
  const manifest = JSON.parse(await readFile(join(webBundle, 'package.json'), 'utf8')) as {
    dsh: { bundle: { patch: string[] } }
  }
  const shipped = composeEntries([
    loadOverlayPatches('Convax composer preferences', join(REPO_ROOT, 'packages/bundle/base/cordis.patch.yml')),
    bundlePatchPaths(webBundle, manifest.dsh.bundle).flatMap(path => loadOverlayPatches('Convax composer preferences', path)),
    loadOverlayPatches('Convax composer preferences', join(BUNDLE, 'cordis.patch.yml')),
  ])
  expect(shipped.find(entry => entry.id === 'agent-preset-registry')?.config).toMatchObject({ default: 'ptc' })
  expect(shipped.find(entry => entry.id === 'permission')?.config).toMatchObject({ defaultPreset: 'workspace-write' })
  const scaffold = await launchWebScaffold({
    extraOverlayPath: [join(BUNDLE, 'cordis.patch.yml'), PICKER], extraInstallAnchors: [join(BUNDLE, 'package.json')],
    // The shared scaffold pins Standard for unrelated scenarios; this lane exercises Convax's PTC default.
    agentPresets: { default: 'ptc' }, developerTools: true,
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  onTestFinished(() => page.close())
  onTestFailed(() => saveFailureShot(page, 'web-e2e-convax-composer-preferences'))
  const console = watchConsole(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(scaffold.authenticatedUrl)
  await page.locator('[data-convax-workspace]').waitFor({ timeout: 30_000 })
  const previous = new Set(scaffold.ctx.convax.workspace().canvases.map(canvas => canvas.id))
  await page.getByRole('button', { name: 'New canvas', exact: true }).first().click()
  await expect.poll(() => scaffold.ctx.convax.workspace().canvases.filter(canvas => !previous.has(canvas.id)).length).toBe(1)
  const canvasId = scaffold.ctx.convax.workspace().canvases.find(canvas => !previous.has(canvas.id))!.id
  await creationDock(page).getByRole('button', { name: 'New chat', exact: true }).click()
  await expect.poll(() => scaffold.ctx.convax.workspace().chats.filter(chat => chat.canvasId === canvasId).length).toBe(1)
  const nodeId = scaffold.ctx.convax.workspace().chats.find(chat => chat.canvasId === canvasId)!.nodeId
  const chatSelector = `[data-convax-chat="${nodeId}"]`
  const chat = page.locator(chatSelector)
  const threads = () => scaffold.ctx.convax.workspace().chats.find(chat => chat.nodeId === nodeId)!.threads
  const composerSelector = `${chatSelector} [data-composer-card]:visible`
  const mode = (name: string) => chat.getByRole('button', { name: `Agent mode: ${name} mode`, exact: true }).filter({ visible: true })
  const access = (name: string) => chat.getByRole('button', { name: `Access mode, current: ${name}`, exact: true }).filter({ visible: true })
  await chat.locator('[data-composer-input][contenteditable="true"]:visible').waitFor({ timeout: 15_000 })
  await expect.poll(() => threads().length).toBe(1)
  await expectFreshSession(scaffold, threads()[0]!.sessionId, 'ptc', 'workspace-write')
  await expect.poll(() => mode('PTC').isEnabled()).toBe(true)
  await access('Workspace Write').waitFor()
  await mkdir(EXPECTED, { recursive: true })
  await compareOrRefreshGolden(join(EXPECTED, 'initial.expected.md'),
    await captureStableAria(page, composerSelector, scaffold.workspaceCwd), webSnapshotMode())

  await mode('PTC').click()
  await page.getByRole('menuitem', { name: /^Standard mode/ }).click()
  await expect.poll(() => scaffold.ctx.agentPresets.defaultId, { timeout: 15_000 }).toBe('standard')
  await expect.poll(() => mode('Standard').isEnabled()).toBe(true)
  await access('Workspace Write').click()
  await page.getByRole('menuitem', { name: 'Full access', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: 'Enable Full access?', exact: true })
  await confirmation.getByRole('checkbox', { name: 'I understand the risks and want to continue', exact: true }).check()
  await confirmation.getByRole('button', { name: 'Enable Full access', exact: true }).click()
  await confirmation.waitFor({ state: 'detached' })
  await expect.poll(() => scaffold.ctx.permissionPresets.defaultPreset, { timeout: 15_000 }).toBe('danger-full-access')
  await expect.poll(() => access('Full access').isEnabled()).toBe(true)
  const settingsPath = join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml')
  const saved = await readFile(settingsPath, 'utf8')
  expect(saved).toContain('selectedDefault: standard')
  expect(saved).toContain('defaultPreset: danger-full-access')

  const newThread = async (count: number, preset: string): Promise<SessionId> => {
    await chat.getByRole('button', { name: 'New thread', exact: true }).click()
    await expect.poll(() => threads().length, { timeout: 15_000 }).toBe(count)
    const sessionId = threads().at(-1)!.sessionId
    await expectFreshSession(scaffold, sessionId, preset, 'danger-full-access')
    await expect.poll(() => access('Full access').isEnabled()).toBe(true)
    return sessionId
  }
  await newThread(2, 'standard')
  await compareOrRefreshGolden(join(EXPECTED, 'remembered.expected.md'),
    await captureStableAria(page, composerSelector, scaffold.workspaceCwd), webSnapshotMode())

  await page.reload()
  await chat.locator('[data-composer-input][contenteditable="true"]:visible').waitFor({ timeout: 30_000 })
  const started = await newThread(3, 'standard')
  await recordCompletedTurn(scaffold, started)
  await chat.getByText('The conversation has a completed turn.', { exact: true }).waitFor()
  await mode('Standard').click()
  await page.getByRole('menuitem', { name: /^New conversation in PTC mode/ }).click()
  await expect.poll(() => threads().length, { timeout: 15_000 }).toBe(4)
  await expectFreshSession(scaffold, threads().at(-1)!.sessionId, 'ptc', 'danger-full-access')
  await expect.poll(() => scaffold.ctx.agentPresets.defaultId, { timeout: 15_000 }).toBe('ptc')
  expect(await readFile(settingsPath, 'utf8')).toContain('selectedDefault: ptc')
  await newThread(5, 'ptc')
  expect((await scaffold.ctx.sessionPersistence.stat(started))?.header.agentPreset).toBe('standard')
  expect((await readPersistedEvents(scaffold, started)).filter(event => event.type === 'agent-preset/selected')).toEqual([])
  expect(console.pageErrors).toEqual([])
})
