/** Real Session status and question delivery drive the canvas activity popover. */
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-convax-plugin-host'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { CanvasCommand, CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const BUNDLE = fileURLToPath(new URL('../../../packages/convax/plugin-renderer/', import.meta.url))
const PICKER = fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/convax-activity/', import.meta.url))
const ARTIFACTS = fileURLToPath(new URL('../../../.artifacts/convax-activity/', import.meta.url))
const PROVIDER = 'convax-activity-test'
const MODEL = 'controlled'

/** Each model call waits for a test-owned completion barrier or its Agent cancellation. */
class ActivityAdapter extends LlmAdapter {
  private readonly waiting: (() => void)[] = []

  override async listModels(provider: string) { return [{ provider, id: MODEL, name: 'Activity fixture' }] }

  get pendingCalls(): number { return this.waiting.length }

  complete(): void {
    const release = this.waiting.shift()
    if (release === undefined) throw new Error('No activity model call is waiting')
    release()
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const signal = options.signal
    if (signal === undefined) throw new Error('Activity model requires an owned turn signal')
    const gate = Promise.withResolvers<undefined>()
    const abort = (): void => { gate.reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    const release = (): void => { gate.resolve(undefined) }
    this.waiting.push(release)
    try {
      signal.throwIfAborted()
      await gate.promise
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Background review completed.' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Background review completed.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally {
      signal.removeEventListener('abort', abort)
      const index = this.waiting.indexOf(release)
      if (index >= 0) this.waiting.splice(index, 1)
    }
  }
}

async function execute(scaffold: WebScaffold, canvasId: CanvasId, command: CanvasCommand): Promise<void> {
  const canvas = scaffold.ctx.convax.workspace().canvases.find(item => item.id === canvasId)
  const result = await scaffold.ctx.convax.execute({ canvasId, expectedRevision: canvas?.revision ?? 0,
    operationId: randomUUID() as CanvasOperationId, command })
  if (!result.ok) throw new Error(`Activity fixture ${command.kind}: ${result.code}: ${result.message}`)
}

async function seedChat(scaffold: WebScaffold, title: string, count: number) {
  const canvasId = randomUUID() as CanvasId, nodeId = randomUUID() as CanvasNodeId
  await execute(scaffold, canvasId, { kind: 'create', title })
  await execute(scaffold, canvasId, { kind: 'add-node', node: {
    id: nodeId, typeId: 'convax.chat' as CanvasNodeTypeId, dataVersion: 1,
    data: { title: `${title} chat`, cwd: scaffold.workspaceCwd }, position: { x: 1200, y: 900 }, revision: 0,
  } })
  const threads: SessionId[] = []
  for (let index = 0; index < count; index += 1) {
    const canvas = scaffold.ctx.convax.workspace().canvases.find(item => item.id === canvasId)!
    const result = await scaffold.ctx.convax.createThread({ canvasId, nodeId, expectedRevision: canvas.revision,
      operationId: randomUUID() as CanvasOperationId, kind: 'create', cwd: scaffold.workspaceCwd, agentPreset: 'standard' })
    if (!result.ok) throw new Error(`Activity fixture thread: ${result.code}: ${result.message}`)
    threads.push(result.sessionId)
  }
  return { canvasId, nodeId, threads }
}

async function openCanvas(page: Page, canvasId: CanvasId): Promise<void> {
  await page.getByRole('button', { name: 'Workspace actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'All canvases', exact: true }).click()
  await page.locator(`[data-canvas-manager-row="${canvasId}"] button`).first().click()
}

async function activityAria(page: Page, scaffold: WebScaffold): Promise<string> {
  const times = await page.getByRole('dialog', { name: 'Activity', exact: true }).locator('time').allTextContents()
  return await captureStableAria(page, '[role="dialog"][aria-label="Activity"]', scaffold.workspaceCwd, {
    replacements: times.map(time => [time.trim(), '{{activityTime}}'] as const),
  })
}

it('keeps unread activity in the titlebar and reveals the correct closed canvas Chat', async () => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: [join(BUNDLE, 'cordis.patch.yml'), PICKER], extraInstallAnchors: [join(BUNDLE, 'package.json')],
  })
  const owned: {
    browser?: Awaited<ReturnType<typeof chromium.launch>>
    page?: Page
    handles: AgentHandle[]
    question?: Promise<unknown>
  } = { handles: [] }
  const controller = new AbortController()
  onTestFinished(async ({ task }) => {
    const failures: unknown[] = []
    if (task.result?.state === 'fail' && owned.page !== undefined) {
      await saveFailureShot(owned.page, 'convax-activity').catch((error: unknown) => failures.push(error))
    }
    controller.abort()
    await owned.question
    await owned.browser?.close().catch((error: unknown) => failures.push(error))
    for (const handle of owned.handles) {
      handle.agent.cancel({ kind: 'user' })
      await handle.dispose().catch((error: unknown) => failures.push(error))
    }
    await scaffold.close().catch((error: unknown) => failures.push(error))
    if (failures.length > 0) throw new AggregateError([...(task.result?.errors ?? []), ...failures], 'Activity fixture teardown failed')
  })
  const adapter = new ActivityAdapter()
  scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter([PROVIDER], adapter), 'activity fixture model')
  const background = await seedChat(scaffold, 'Background board', 2)
  const foreground = await seedChat(scaffold, 'Current board', 1)
  const titles = ['First thread', 'Completed review', 'Confirmation needed']
  for (const [index, sessionId] of [...background.threads, ...foreground.threads].entries()) {
    const handle = await scaffold.ctx.agents.resume({ resumeSessionId: sessionId,
      agentOptions: { provider: PROVIDER, model: MODEL },
      setup: ctx => scaffold.ctx.agentPresets.mount(ctx, 'standard').then(() => undefined),
    })
    owned.handles.push(handle)
    handle.agent.session.append('session/title', { title: titles[index]!, messageSeqs: [], source: { kind: 'user' } })
    await scaffold.ctx.sessions.flush(handle.agent.session)
  }
  const completed = owned.handles[1]!.agent, questioning = owned.handles[2]!.agent
  const browser = await chromium.launch()
  owned.browser = browser
  const page = await newEnglishPage(browser)
  owned.page = page
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' })
  const tripwire = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl)
  await page.locator('[data-convax-workspace]').waitFor({ timeout: 30_000 })
  const activity = () => page.getByRole('button', { name: /^Activity(?:, \d+ unread)?$/ })
  await activity().click()
  const panel = () => page.getByRole('dialog', { name: 'Activity', exact: true })
  await panel().getByText('No activity yet', { exact: true }).waitFor()
  await mkdir(EXPECTED, { recursive: true })
  await compareOrRefreshGolden(join(EXPECTED, 'empty.expected.md'),
    await activityAria(page, scaffold), webSnapshotMode())
  await page.keyboard.press('Escape')
  await expect.poll(() => activity().evaluate(element => element === document.activeElement)).toBe(true)

  await openCanvas(page, background.canvasId)
  const backgroundChat = () => page.locator(`[data-convax-chat="${background.nodeId}"]`)
  await backgroundChat().getByRole('tab', { name: 'First thread', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  completed.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Finish a background review.' }] }))
  await expect.poll(() => adapter.pendingCalls).toBe(1)
  await backgroundChat().getByRole('tab', { name: /^Completed review\b/ }).click()
  await backgroundChat().getByRole('button', { name: 'Stop generating', exact: true }).waitFor()
  await backgroundChat().getByRole('tab', { name: 'First thread', exact: true }).click()
  await backgroundChat().getByRole('button', { name: 'Collapse chat', exact: true }).click()
  await openCanvas(page, foreground.canvasId)
  await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  await page.locator(`[data-canvas-tab="${background.canvasId}"]`).hover()
  await page.getByRole('button', { name: 'Close Background board', exact: true }).click()
  expect(await page.locator(`[data-canvas-tab="${background.canvasId}"]`).count()).toBe(0)
  await page.locator(`[data-convax-chat="${foreground.nodeId}"] [data-composer-input]`).waitFor()

  expect(completed.status).toBe('running')
  await activity().getByText('Activity', { exact: true }).waitFor()
  adapter.complete()
  await completed.whenIdle()
  await page.getByRole('button', { name: 'Activity, 1 unread', exact: true }).waitFor()
  const asked = scaffold.ctx.userQuestions.ask({ agent: questioning, signal: controller.signal, questions: [{
    id: 'continue-review', question: 'Continue the activity fixture?', options: [{ label: 'Continue' }, { label: 'Stop' }],
  }] })
  const outcome = asked.then(value => ({ value }), (error: unknown) => ({ error }))
  owned.question = outcome
  await page.locator('[data-question-key]').waitFor()
  await page.getByRole('button', { name: 'Activity, 2 unread', exact: true }).click()
  const pendingRow = () => panel().locator(`[data-convax-activity-session="${questioning.id}"]`)
  const completedRow = () => panel().locator(`[data-convax-activity-session="${completed.id}"]`)
  await pendingRow().waitFor()
  expect(await pendingRow().getAttribute('data-unread')).toBe('true')
  expect(await completedRow().getAttribute('data-unread')).toBe('true')
  expect(await panel().locator('[data-convax-activity-session]').first().getAttribute('data-convax-activity-session')).toBe(questioning.id)
  expect(await page.getByRole('button', { name: 'Activity, 2 unread', exact: true }).count()).toBe(1)
  await compareOrRefreshGolden(join(EXPECTED, 'unread.expected.md'),
    await activityAria(page, scaffold), webSnapshotMode())
  await mkdir(ARTIFACTS, { recursive: true })
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expect.poll(() => page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme'))).toBe(colorScheme === 'dark')
    await page.screenshot({ path: join(ARTIFACTS, `${colorScheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: 'light' })
  await panel().getByRole('button', { name: 'Mark all as read', exact: true }).click()
  await page.getByRole('button', { name: 'Activity', exact: true }).waitFor()
  expect(await pendingRow().getAttribute('data-unread')).not.toBe('true')
  expect(await completedRow().count()).toBe(1)
  await compareOrRefreshGolden(join(EXPECTED, 'read.expected.md'),
    await activityAria(page, scaffold), webSnapshotMode())
  await page.keyboard.press('Escape')
  await expect.poll(() => activity().evaluate(element => element === document.activeElement)).toBe(true)
  await activity().click()
  await pendingRow().waitFor()
  await page.getByRole('tab', { name: 'Current board', exact: true }).click()
  await panel().waitFor({ state: 'detached' })

  await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  const question = page.locator('[data-question-key]')
  await question.getByRole('radio', { name: 'Continue', exact: true }).click()
  await question.getByRole('button', { name: 'Submit', exact: true }).click()
  expect(await outcome).toEqual({ value: { answers: [{ id: 'continue-review', selected: ['Continue'] }] } })
  await activity().click()
  await expect.poll(() => pendingRow().count()).toBe(0)
  await completedRow().click()
  await panel().waitFor({ state: 'detached' })
  await page.getByRole('tab', { name: 'Background board', exact: true, selected: true }).waitFor()
  await backgroundChat().getByRole('tab', { name: 'Completed review', exact: true, selected: true }).waitFor()
  expect(await backgroundChat().getAttribute('data-collapsed')).toBeNull()
  await page.locator(`[data-id="${background.nodeId}"][data-convax-activity-highlight="true"]`).waitFor()
  const card = await backgroundChat().boundingBox(), graph = await page.locator('[data-convax-graph]').boundingBox()
  if (card === null || graph === null) throw new Error('Activity target Chat or canvas is not visible')
  expect(card.x + card.width / 2).toBeGreaterThanOrEqual(graph.x)
  expect(card.x + card.width / 2).toBeLessThanOrEqual(graph.x + graph.width)
  expect(card.y + card.height / 2).toBeGreaterThanOrEqual(graph.y)
  expect(card.y + card.height / 2).toBeLessThanOrEqual(graph.y + graph.height)

  await page.setViewportSize({ width: 400, height: 650 })
  await activity().click()
  await panel().waitFor()
  const narrow = await panel().boundingBox()
  if (narrow === null) throw new Error('Activity panel did not open at a narrow viewport')
  expect(narrow.x).toBeGreaterThanOrEqual(0)
  expect(narrow.y).toBeGreaterThanOrEqual(0)
  expect(narrow.x + narrow.width).toBeLessThanOrEqual(400)
  expect(narrow.y + narrow.height).toBeLessThanOrEqual(650)
  await page.screenshot({ path: join(ARTIFACTS, 'narrow.png') })
  expect(tripwire.pageErrors).toEqual([])
})
