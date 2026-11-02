/** Real canvas, draft, queue and attachment persistence with only the OS capture replaced. */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
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
const EXPECTED_DIRECTORY = fileURLToPath(new URL('./expected/convax-window-mirror/', import.meta.url))
const EXPECTED = join(EXPECTED_DIRECTORY, 'mirror.expected.md')
const HISTORY_EXPECTED = fileURLToPath(new URL('./expected/convax-window-mirror/message-history.expected.json', import.meta.url))
const ARTIFACTS = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))

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
    const leases = new Map<string, string>()
    let next = 0
    let pending: string | undefined
    let available = true
    let otherAvailable = false
    let denyNext = false
    let heldAcquisition: Promise<void> | undefined
    let finishAcquisition: (() => void) | undefined
    const preparedSources: string[] = []
    let captures = 0
    let currentColor = 'red'
    const paint = (color: string): void => {
      currentColor = color; ctx.fillStyle = color; ctx.fillRect(0, 0, image.width, image.height)
    }
    paint('red')
    const source = { id: 'owned-fixture-window', name: 'Mirror fixture', appIcon: image.toDataURL() }
    const other = { ...source, id: 'other-fixture-window' }
    const capture = {
      list: async () => [...available ? [source] : [], ...otherAvailable ? [other] : []],
      prepare: async (id: string) => {
        if (!(available && id === source.id || otherAvailable && id === other.id) || pending !== undefined) throw new Error('Unavailable fixture window')
        const lease = `lease-${++next}`
        leases.set(lease, id); pending = lease
        preparedSources.push(id)
        return { id: lease, source: id === source.id ? source : other }
      },
      validate: async (id: string) => leases.get(id) === source.id ? available : leases.get(id) === other.id && otherAvailable,
      release: async (id: string) => { leases.delete(id); if (pending === id) pending = undefined },
    }
    Object.defineProperty(globalThis, 'dshDesktop', { configurable: true,
      value: { protocolVersion: 1, windowCapture: capture } })
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async () => {
      if (pending === undefined || !(leases.get(pending) === source.id ? available : leases.get(pending) === other.id && otherAvailable)) {
        throw new DOMException('No selected source', 'NotAllowedError')
      }
      pending = undefined
      await heldAcquisition
      if (denyNext) { denyNext = false; throw new DOMException('Fixture screen recording permission denied', 'NotAllowedError') }
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
      restore: () => { available = true },
      sameNameOther: () => { otherAvailable = true },
      deny: () => { denyNext = true },
      hold: () => { heldAcquisition = new Promise<void>((resolve) => { finishAcquisition = resolve }) },
      resume: () => { finishAcquisition?.(); heldAcquisition = undefined; finishAcquisition = undefined },
      disconnect: () => {
        for (const stream of streams) for (const track of stream.getTracks()) {
          if (track.readyState !== 'live') continue
          track.stop(); track.dispatchEvent(new Event('ended'))
        }
      },
      preparedSources: () => [...preparedSources], leases: () => leases.size,
      captures: () => captures,
      activeTracks: () => [...streams].flatMap(stream => stream.getTracks()).filter(track => track.readyState === 'live').length,
    } })
  })
}

interface MirrorFixture {
  paint(color: string): void
  close(): void
  restore(): void
  sameNameOther(): void
  deny(): void
  hold(): void
  resume(): void
  disconnect(): void
  preparedSources(): string[]
  leases(): number
  captures(): number
  activeTracks(): number
}

async function mirrorFixture(
  page: Page, action: {
    readonly color?: string
    readonly close?: boolean
    readonly restore?: boolean
    readonly sameNameOther?: boolean
    readonly deny?: boolean
    readonly hold?: boolean
    readonly resume?: boolean
    readonly disconnect?: boolean
  } = {},
): Promise<{ captures: number; activeTracks: number; preparedSources: string[]; leases: number }> {
  return await page.evaluate((action) => {
    const fixture = (globalThis as { __windowMirrorFixture?: MirrorFixture }).__windowMirrorFixture
    if (fixture === undefined) throw new Error('Missing OS mirror fixture')
    if (action.color !== undefined) fixture.paint(action.color)
    if (action.close === true) fixture.close()
    if (action.restore === true) fixture.restore()
    if (action.sameNameOther === true) fixture.sameNameOther()
    if (action.deny === true) fixture.deny()
    if (action.hold === true) fixture.hold()
    if (action.resume === true) fixture.resume()
    if (action.disconnect === true) fixture.disconnect()
    return { captures: fixture.captures(), activeTracks: fixture.activeTracks(),
      preparedSources: fixture.preparedSources(), leases: fixture.leases() }
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

async function newMirrorFixture(withChat = false) {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: [join(BUNDLE, 'cordis.patch.yml'), PICKER], extraInstallAnchors: [join(BUNDLE, 'package.json')],
  })
  const acquired: { browser?: Browser; page?: Page } = {}
  onTestFinished(async ({ task }) => {
    const { page, browser } = acquired
    try {
      if (page !== undefined && !page.isClosed()) {
        await page.evaluate(() => { (globalThis as { __windowMirrorFixture?: MirrorFixture }).__windowMirrorFixture?.resume() })
        if (task.result?.state === 'fail') await saveFailureShot(page, 'convax-window-reconnect')
      }
    } finally { try { await browser?.close() } finally { await scaffold.close() } }
  })
  const canvasId = randomUUID() as CanvasId
  const chatId = randomUUID() as CanvasNodeId
  await execute(scaffold, canvasId, { kind: 'create', title: 'Window reconnect' })
  if (withChat) {
    await execute(scaffold, canvasId, { kind: 'add-node', node: {
      id: chatId, typeId: 'convax.chat' as CanvasNodeTypeId, dataVersion: 1,
      data: { title: 'Reconnect conversation', cwd: scaffold.workspaceCwd }, position: { x: 850, y: 50 }, revision: 0,
    } })
    const created = await scaffold.ctx.convax.createThread({ canvasId, nodeId: chatId,
      expectedRevision: scaffold.ctx.convax.workspace().canvases.find(item => item.id === canvasId)!.revision,
      operationId: randomUUID() as CanvasOperationId, kind: 'create', cwd: scaffold.workspaceCwd, agentPreset: 'standard' })
    if (!created.ok) throw new Error(`Reconnect thread fixture: ${created.code}`)
  }
  const browser = await chromium.launch()
  acquired.browser = browser
  const page = await newEnglishPage(browser)
  acquired.page = page
  const tripwire = watchConsole(page)
  await installCaptureFixture(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(scaffold.authenticatedUrl)
  await page.locator('[data-convax-workspace]').waitFor({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Workspace actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'All canvases', exact: true }).click()
  await page.locator(`[data-canvas-manager-row="${canvasId}"] button`).first().click()
  await page.getByRole('button', { name: 'Application window', exact: true }).click()
  await page.getByRole('dialog', { name: 'Application window', exact: true })
    .getByRole('button', { name: 'Mirror fixture', exact: true }).click()
  const document = () => scaffold.ctx.convax.workspace().canvases.find(item => item.id === canvasId)!
  await expect.poll(() => document().nodes.filter(node => node.typeId === 'convax.window').length).toBe(1)
  const windowNode = document().nodes.find(node => node.typeId === 'convax.window')!
  const card = page.locator(`[data-convax-window="${windowNode.id}"]`)
  await card.locator('video').waitFor()
  await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  return { scaffold, page, document, windowNode, card, chatId, tripwire }
}

async function videoPixel(page: Page, nodeId: CanvasNodeId): Promise<readonly number[]> {
  return await page.locator(`[data-convax-window="${nodeId}"] video`).evaluate((element) => {
    if (!(element instanceof HTMLVideoElement) || element.readyState < 2) return []
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')!
    context.drawImage(element, 0, 0, 1, 1)
    return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3)
  })
}

it('reconnects the exact window with fresh pixels while preserving graph bindings and composer references', async () => {
  const b = await newMirrorFixture(true)
  const { page, card } = b
  await expect.poll(() => videoPixel(page, b.windowNode.id)).toEqual([255, 0, 0])
  await connect(page, b.windowNode.id, b.chatId)
  const chat = page.locator(`[data-convax-chat="${b.chatId}"]`)
  const reference = chat.getByRole('button', { name: 'Remove reference Mirror fixture', exact: true })
  const input = chat.locator('[data-composer-input][contenteditable="true"]')
  await reference.waitFor({ timeout: 15_000 })
  await input.fill('Retain this draft and its exact window reference.')
  const before = b.document()
  await mirrorFixture(page, { disconnect: true, color: 'blue', hold: true })
  await card.getByRole('button', { name: 'Reconnect', exact: true }).waitFor()
  await mkdir(ARTIFACTS, { recursive: true })
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expect.poll(() => page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme')))
      .toBe(colorScheme === 'dark')
    await page.screenshot({ path: join(ARTIFACTS, `convax-window-reconnect-${colorScheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: 'light' })
  await card.getByRole('button', { name: 'Reconnect', exact: true }).click()
  await card.getByRole('status').filter({ hasText: 'Connecting…' }).waitFor()
  expect(await card.getByRole('button', { name: 'Reconnect', exact: true }).isDisabled()).toBe(true)
  expect(await card.getByRole('button', { name: 'Choose another window', exact: true }).isDisabled()).toBe(true)
  await page.screenshot({ path: join(ARTIFACTS, 'convax-window-reconnect-pending.png') })
  await compareOrRefreshGolden(join(EXPECTED_DIRECTORY, 'reconnect-pending.expected.md'),
    await captureStableAria(page, `[data-convax-window="${b.windowNode.id}"]`, b.scaffold.workspaceCwd), webSnapshotMode())
  await mirrorFixture(page, { resume: true })
  await card.locator('video').waitFor()
  await expect.poll(() => videoPixel(page, b.windowNode.id)).toEqual([0, 0, 255])
  expect((await mirrorFixture(page)).preparedSources).toEqual(['owned-fixture-window', 'owned-fixture-window'])
  expect((await mirrorFixture(page)).activeTracks).toBe(1)
  expect((await mirrorFixture(page)).leases).toBe(1)
  expect(b.document()).toEqual(before)
  await reference.waitFor()
  expect(await input.textContent()).toContain('Retain this draft and its exact window reference.')
  await page.screenshot({ path: join(ARTIFACTS, 'convax-window-reconnect-live.png') })
  expect(b.tripwire.pageErrors).toEqual([])
})

it('rejects a same-name replacement and permits retry after screen recording is denied', async () => {
  const b = await newMirrorFixture()
  const { page, card } = b
  const before = b.document()
  await mirrorFixture(page, { disconnect: true, close: true, sameNameOther: true })
  await card.getByRole('button', { name: 'Reconnect', exact: true }).click()
  await card.getByRole('alert').filter({ hasText: 'Could not reconnect.' }).waitFor()
  expect((await mirrorFixture(page)).preparedSources).toEqual(['owned-fixture-window'])
  expect((await mirrorFixture(page)).activeTracks).toBe(0)
  expect(await page.getByRole('dialog', { name: 'Choose another window', exact: true }).count()).toBe(0)
  await mirrorFixture(page, { restore: true, deny: true })
  await card.getByRole('button', { name: 'Reconnect', exact: true }).click()
  await expect.poll(async () => (await mirrorFixture(page)).preparedSources.length).toBe(2)
  await expect.poll(() => card.getByRole('button', { name: 'Reconnect', exact: true }).isDisabled()).toBe(false)
  await card.getByRole('alert').filter({ hasText: 'Could not reconnect.' }).waitFor()
  expect((await mirrorFixture(page)).activeTracks).toBe(0)
  expect((await mirrorFixture(page)).leases).toBe(0)
  await mkdir(ARTIFACTS, { recursive: true })
  await page.screenshot({ path: join(ARTIFACTS, 'convax-window-reconnect-denied.png') })
  await compareOrRefreshGolden(join(EXPECTED_DIRECTORY, 'reconnect-failed.expected.md'),
    await captureStableAria(page, `[data-convax-window="${b.windowNode.id}"]`, b.scaffold.workspaceCwd), webSnapshotMode())
  await card.getByRole('button', { name: 'Reconnect', exact: true }).click()
  await card.locator('video').waitFor()
  expect((await mirrorFixture(page)).preparedSources).toEqual(['owned-fixture-window', 'owned-fixture-window', 'owned-fixture-window'])
  expect((await mirrorFixture(page)).activeTracks).toBe(1)
  expect(b.document()).toEqual(before)
  expect(b.tripwire.pageErrors).toEqual([])
})

it('requires explicit window selection after reload without reusing a source by title', async () => {
  const b = await newMirrorFixture()
  const { page, card } = b
  const bindingId = b.windowNode.data.bindingId
  await page.reload()
  await card.getByRole('button', { name: 'Reconnect', exact: true }).waitFor({ timeout: 30_000 })
  expect((await mirrorFixture(page)).preparedSources).toEqual([])
  expect((await mirrorFixture(page)).activeTracks).toBe(0)
  await mirrorFixture(page, { close: true, sameNameOther: true })
  await card.getByRole('button', { name: 'Reconnect', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Choose another window', exact: true })
  await picker.waitFor()
  expect((await mirrorFixture(page)).preparedSources).toEqual([])
  expect(b.document().nodes.find(node => node.id === b.windowNode.id)?.data.bindingId).toBe(bindingId)
  await picker.getByRole('button', { name: 'Mirror fixture', exact: true }).click()
  await card.locator('video').waitFor()
  expect((await mirrorFixture(page)).preparedSources).toEqual(['other-fixture-window'])
  expect(b.document().nodes.find(node => node.id === b.windowNode.id)?.data.bindingId).not.toBe(bindingId)
  expect(b.tripwire.pageErrors).toEqual([])
})

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
      const finalTurn = Promise.withResolvers<undefined>()
      scaffold.ctx.on('session/event', (session, event: SessionEvent) => {
        if (session.id !== created.sessionId) return
        events.push(event)
        if (event.type === 'turn/end' && events.filter(item => item.type === 'turn/end').length === 3) finalTurn.resolve(undefined)
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
        await mirrorFixture(page, { disconnect: true })
        await card.getByRole('button', { name: 'Reconnect', exact: true }).click()
        await card.locator('video').waitFor()
        await mirrorFixture(page, { color: 'blue' })
        await input.fill('Inspect this window snapshot')
        await input.press('Enter')
        await expect.poll(() => events.some(event => event.type === 'agent/inbox/spliced'
          && event.data.inserted.some(message => message.content.some(block => block.type === 'image')))).toBe(true)
        await mirrorFixture(page, { color: 'red' })
        await chat.getByRole('button', { name: 'Stop generating', exact: true }).click()
        await activeSettled
        await input.fill('Continue with the queued window snapshot')
        await input.press('Enter')
        await finalTurn.promise
        await scaffold.ctx.agents.get(created.sessionId)!.whenIdle()
        expect(events.filter(event => event.type === 'turn/end')).toHaveLength(3)
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
