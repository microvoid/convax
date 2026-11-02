/** Real canvas, draft, queue and attachment persistence with only the OS capture replaced. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { deriveReplayScript, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import type {} from '@deepseek-ai/dsh-convax-plugin-host'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { CanvasCommand, CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, readPersistedEvents, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'
import { projectWindowMirrorHistory } from './convax-window-history.ts'

const BUNDLE = fileURLToPath(new URL('../../../packages/convax/plugin-renderer/', import.meta.url))
const PICKER = fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url))
const REPLAY = fileURLToPath(new URL('../../../snapshots/web/live-interactions/session.v4.jsonl', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/convax-window-mirror/mirror.expected.md', import.meta.url))
const HISTORY_EXPECTED = fileURLToPath(new URL('./expected/convax-window-mirror/message-history.expected.json', import.meta.url))

async function execute(scaffold: WebScaffold, canvasId: CanvasId, command: CanvasCommand): Promise<void> {
  const canvas = scaffold.ctx.convax.workspace().canvases.find(item => item.id === canvasId)
  const result = await scaffold.ctx.convax.execute({ canvasId, expectedRevision: canvas?.revision ?? 0,
    operationId: randomUUID() as CanvasOperationId, command })
  if (!result.ok) throw new Error(`Window fixture ${command.kind}: ${result.code}: ${result.message}`)
}

async function installCaptureFixture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const image = document.createElement('canvas')
    image.width = 64; image.height = 48
    const ctx = image.getContext('2d')!
    const streams = new Set<MediaStream>()
    const leases = new Map<string, boolean>()
    let next = 0
    let pending: string | undefined
    let available = true
    let captures = 0
    let currentColor = 'red'
    const paint = (color: string): void => {
      currentColor = color; ctx.fillStyle = color; ctx.fillRect(0, 0, image.width, image.height)
    }
    paint('red')
    const source = { id: 'owned-fixture-window', name: 'Mirror fixture', appIcon: image.toDataURL() }
    const capture = {
      list: async () => available ? [source] : [],
      prepare: async (id: string) => {
        if (!available || id !== source.id || pending !== undefined) throw new Error('Unavailable fixture window')
        const lease = `lease-${++next}`
        leases.set(lease, true); pending = lease
        return { id: lease, source }
      },
      validate: async (id: string) => available && leases.get(id) === true,
      release: async (id: string) => { leases.delete(id); if (pending === id) pending = undefined },
    }
    Object.defineProperty(globalThis, 'dshDesktop', { configurable: true,
      value: { protocolVersion: 1, windowCapture: capture } })
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async () => {
      if (pending === undefined || !available) throw new DOMException('No selected source', 'NotAllowedError')
      pending = undefined
      const stream = image.captureStream(5)
      paint(currentColor)
      streams.add(stream)
      return stream
    } })
    Object.defineProperty(globalThis, 'ImageCapture', { configurable: true, value: class {
      constructor(private readonly track: MediaStreamTrack) {}
      async grabFrame(): Promise<ImageBitmap> {
        if (this.track.readyState !== 'live') throw new Error('Fixture track ended')
        captures += 1
        return await createImageBitmap(image)
      }
    } })
    Object.defineProperty(globalThis, '__windowMirrorFixture', { value: {
      paint, close: () => { available = false },
      captures: () => captures,
      activeTracks: () => [...streams].flatMap(stream => stream.getTracks()).filter(track => track.readyState === 'live').length,
    } })
  })
}

interface MirrorFixture {
  paint(color: string): void
  close(): void
  captures(): number
  activeTracks(): number
}

async function mirrorFixture(
  page: Page, action: { readonly color?: string; readonly close?: boolean } = {},
): Promise<{ captures: number; activeTracks: number }> {
  return await page.evaluate((action) => {
    const fixture = (globalThis as { __windowMirrorFixture?: MirrorFixture }).__windowMirrorFixture
    if (fixture === undefined) throw new Error('Missing OS mirror fixture')
    if (action.color !== undefined) fixture.paint(action.color)
    if (action.close === true) fixture.close()
    return { captures: fixture.captures(), activeTracks: fixture.activeTracks() }
  }, action)
}

async function connect(page: Page, sourceId: CanvasNodeId, targetId: CanvasNodeId): Promise<void> {
  const source = await page.locator(`.react-flow__node[data-id="${sourceId}"] .react-flow__handle.source`).boundingBox()
  const target = await page.locator(`.react-flow__node[data-id="${targetId}"] .react-flow__handle.target`).boundingBox()
  if (source === null || target === null) throw new Error('Window/Chat connection endpoints are missing')
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
  await page.mouse.down()
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 })
  await page.mouse.up()
}

it('captures the current window into immutable queued image history and restores unavailable references', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'convax-window-browser-'))
  try {
    const ready = join(scratch, 'turn-ready')
    const replay = deriveReplayScript(parseSessionLog(await readFile(REPLAY, 'utf8')))
    const script = join(scratch, 'replay.json')
    await writeFile(script, JSON.stringify([{ kind: 'hang', readyFile: ready }, replay[0], replay[0]]))
    const scaffold = await launchWebScaffold({
      extraOverlayPath: [join(BUNDLE, 'cordis.patch.yml'), PICKER], extraInstallAnchors: [join(BUNDLE, 'package.json')],
      replayFixture: REPLAY, replayOverride: script, compareReplaySession: false,
      replayProviders: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{
        id: 'deepseek-v4-flash-vision-exp', name: 'Vision', inputModalities: ['text', 'image'], contextWindow: 1_000_000,
      }] }],
    })
    let failure: unknown
    try {
      const canvasId = randomUUID() as CanvasId
      const chatId = randomUUID() as CanvasNodeId
      await execute(scaffold, canvasId, { kind: 'create', title: 'Window mirror' })
      await execute(scaffold, canvasId, { kind: 'add-node', node: {
        id: chatId, typeId: 'convax.chat' as CanvasNodeTypeId, dataVersion: 1,
        data: { title: 'Window conversation', cwd: scaffold.workspaceCwd }, position: { x: 850, y: 50 }, revision: 0,
      } })
      const created = await scaffold.ctx.convax.createThread({ canvasId, nodeId: chatId,
        expectedRevision: scaffold.ctx.convax.workspace().canvases[0]!.revision,
        operationId: randomUUID() as CanvasOperationId, kind: 'create', cwd: scaffold.workspaceCwd, agentPreset: 'standard' })
      if (!created.ok) throw new Error(`Window thread: ${created.code}`)
      await scaffold.ctx.sessionController.selectModel({ sessionId: created.sessionId,
        provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' })
      const events: SessionEvent[] = []
      scaffold.ctx.on('session/event', (session, event: SessionEvent) => {
        if (session.id === created.sessionId) events.push(event)
      })
      const browser = await chromium.launch()
      const page = await newEnglishPage(browser)
      const tripwire = watchConsole(page)
      try {
        await installCaptureFixture(page)
        await page.goto(scaffold.authenticatedUrl)
        await page.locator('[data-convax-workspace]').waitFor({ timeout: 30_000 })
        await page.getByRole('button', { name: 'Workspace actions', exact: true }).click()
        await page.getByRole('menuitem', { name: 'All canvases', exact: true }).click()
        await page.locator(`[data-canvas-manager-row="${canvasId}"] button`).first().click()
        await page.getByRole('button', { name: 'Application window', exact: true }).click()
        const picker = page.getByRole('dialog', { name: 'Application window', exact: true })
        const source = picker.getByRole('button', { name: 'Mirror fixture', exact: true })
        await expect.poll(async () => source.locator('img').evaluate(element =>
          element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0)).toBe(true)
        await source.click()
        const document = () => scaffold.ctx.convax.workspace().canvases.find(item => item.id === canvasId)!
        await expect.poll(() => document().nodes.filter(node => node.typeId === 'convax.window').length).toBe(1)
        const windowNode = document().nodes.find(node => node.typeId === 'convax.window')!
        expect(Object.keys(windowNode.data).sort()).toEqual(['bindingId', 'name'])
        await execute(scaffold, canvasId, { kind: 'move-nodes', nodes: [{ id: windowNode.id, position: { x: 80, y: 80 } }] })
        const card = page.locator(`[data-convax-window="${windowNode.id}"]`)
        await card.locator('video').waitFor()
        await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
        await compareOrRefreshGolden(EXPECTED, await captureStableAria(page, `[data-convax-window="${windowNode.id}"]`, scaffold.workspaceCwd), webSnapshotMode())
        const chat = page.locator(`[data-convax-chat="${chatId}"]`)
        const input = chat.locator('[data-composer-input][contenteditable="true"]')
        await input.waitFor({ timeout: 30_000 })
        const activeSettled = scaffold.whenTurnSettled()
        void activeSettled.catch((_error: unknown) => { /* Awaited below; teardown stops the turn if an earlier assertion fails. */ })
        await input.fill('Wait for the next window image')
        await input.press('Enter')
        await expect.poll(async () => readFile(ready, 'utf8').then(() => true, () => false)).toBe(true)
        await connect(page, windowNode.id, chatId)
        await expect.poll(() => document().connections.length).toBe(1)
        const reference = chat.getByRole('button', { name: 'Remove reference Mirror fixture', exact: true })
        await reference.waitFor()
        await mirrorFixture(page, { color: 'blue' })
        await input.fill('Inspect this window snapshot')
        await input.press('Enter')
        await expect.poll(() => events.some(event => event.type === 'agent/inbox/spliced'
          && event.data.inserted.some(message => message.content.some(block => block.type === 'image')))).toBe(true)
        await mirrorFixture(page, { color: 'red' })
        await chat.getByRole('button', { name: 'Stop generating', exact: true }).click()
        await activeSettled
        const delivered = scaffold.whenTurnSettled()
        await input.fill('Continue with the queued window snapshot')
        await input.press('Enter')
        await delivered
        await expect.poll(() => events.filter(event => event.type === 'turn/end').length).toBe(3)
        const history = await readPersistedEvents(scaffold, created.sessionId)
        await compareOrRefreshGolden(HISTORY_EXPECTED, projectWindowMirrorHistory(history, 'Mirror fixture'), webSnapshotMode())
        const image = history.flatMap(event => event.type === 'user/message' ? event.data.content : []).find(block => block.type === 'image')
        if (image?.type !== 'image') throw new Error('Window screenshot was not admitted into Session history')
        const stored = await scaffold.ctx.attachments.readImage(image.attachment)
        const pixels = await sharp(stored.data).removeAlpha().raw().toBuffer()
        expect([...pixels.subarray(0, 3)]).toEqual([0, 0, 255])
        expect(JSON.stringify(history)).not.toContain('base64')
        expect((await mirrorFixture(page)).captures).toBe(1)
        expect(await reference.count()).toBe(0)
        expect(document().connections).toHaveLength(1)

        await execute(scaffold, canvasId, { kind: 'remove-connections', connectionIds: [document().connections[0]!.id] })
        await expect.poll(() => page.locator('.react-flow__edge').count()).toBe(0)
        await connect(page, windowNode.id, chatId)
        await reference.waitFor()
        await mirrorFixture(page, { close: true })
        await input.fill('Keep this draft if the window closes')
        await input.press('Enter')
        await reference.waitFor()
        await expect.poll(() => input.textContent()).toContain('Keep this draft')
        expect(document().connections).toHaveLength(1)
        expect((await mirrorFixture(page)).captures).toBe(1)
        await chat.getByRole('group', { name: 'Pending attachments', exact: true }).hover()
        await reference.click()
        expect(document().connections).toHaveLength(1)
        await page.reload()
        await card.getByRole('button', { name: 'Choose another window', exact: true }).waitFor({ timeout: 30_000 })
        expect(await card.locator('video').count()).toBe(0)
        const reopened = await readPersistedEvents(scaffold, created.sessionId)
        expect(reopened.filter(event => event.type === 'user/message')).toEqual(history.filter(event => event.type === 'user/message'))
        expect(tripwire.pageErrors).toEqual([])
      } catch (error) {
        await saveFailureShot(page, 'convax-window-mirror')
        console.error('Window mirror page:', await page.locator('body').innerText().catch(() => '(page closed)'))
        console.error('Window mirror errors:', JSON.stringify(tripwire.pageErrors))
        throw error
      } finally { await browser.close() }
    } catch (error) { failure = error; throw error }
    finally {
      try { await scaffold.close() } catch (error) {
        if (failure !== undefined) throw new AggregateError([failure, error], 'Window E2E and teardown failed')
        throw error
      }
    }
  } finally { await rm(scratch, { recursive: true, force: true }) }
}, 120_000)
