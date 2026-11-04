/** Built-in nodes are ordinary optional providers and displays in the real product composition. */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {} from '@deepseek-ai/dsh-convax-plugin-host'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import type {
  CanvasCommand, CanvasConnectionId, CanvasId, CanvasNode, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId,
} from '@deepseek-ai/dsh-convax-plugin-host/types'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, readPersistedEvents,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const BUNDLE = fileURLToPath(new URL('../../../../../packages/plugin-renderer/', import.meta.url))
const PICKER = fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url))
const REPLAY = fileURLToPath(new URL('../../../snapshots/web/live-interactions/session.v4.jsonl', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/convax-internal-nodes/', import.meta.url))
const ARTIFACTS = fileURLToPath(new URL('../../../../../.artifacts/convax-internal-nodes/', import.meta.url))
const NODE_TYPES = ['convax.chat', 'convax.file', 'convax.folder', 'convax.window']
const DRAFT = 'An unsent draft belongs to the DSH composer.'
const PROMPT = 'Keep this native turn running while the node plugins reload.'

async function execute(scaffold: WebScaffold, canvasId: CanvasId, command: CanvasCommand): Promise<void> {
  const revision = scaffold.ctx.convax.workspace().canvases.find(canvas => canvas.id === canvasId)?.revision ?? 0
  const result = await scaffold.ctx.convax.execute({ canvasId, expectedRevision: revision,
    operationId: randomUUID() as CanvasOperationId, command })
  if (!result.ok) throw new Error(`Internal node fixture ${command.kind}: ${result.code}: ${result.message}`)
}

/** Replace only the operating system capture boundary, retaining real MediaStream tracks and cleanup. */
async function installCaptureFixture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const image = document.createElement('canvas')
    image.width = 80; image.height = 60
    const paint = image.getContext('2d')!
    paint.fillStyle = '#386c59'; paint.fillRect(0, 0, image.width, image.height)
    const streams = new Set<MediaStream>()
    const leases = new Set<string>()
    let pending: string | undefined
    let nextLease = 0
    const source = { id: 'internal-node-window', name: 'Acceptance window' }
    Object.defineProperty(globalThis, 'dshDesktop', { configurable: true, value: {
      protocolVersion: 1, windowCapture: {
        list: async () => [source],
        prepare: async (id: string) => {
          if (id !== source.id || pending !== undefined) throw new Error('No such acceptance window')
          pending = `internal-node-lease-${++nextLease}`
          leases.add(pending)
          return { id: pending, source }
        },
        validate: async (id: string) => leases.has(id),
        release: async (id: string) => { leases.delete(id); if (pending === id) pending = undefined },
      },
    } })
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async () => {
      if (pending === undefined) throw new DOMException('No explicit window selection', 'NotAllowedError')
      pending = undefined
      const stream = image.captureStream(5)
      streams.add(stream)
      return stream
    } })
    Object.defineProperty(globalThis, '__convaxInternalCaptureFixture', { value: {
      activeTracks: () => [...streams].flatMap(stream => stream.getTracks()).filter(track => track.readyState === 'live').length,
      leases: () => leases.size,
    } })
  })
}

async function captureResources(page: Page): Promise<{ tracks: number; leases: number }> {
  return await page.evaluate(() => {
    const fixture = (globalThis as { __convaxInternalCaptureFixture?: { activeTracks(): number; leases(): number } })
      .__convaxInternalCaptureFixture
    if (fixture === undefined) throw new Error('Missing external capture fixture')
    return { tracks: fixture.activeTracks(), leases: fixture.leases() }
  })
}

async function toggle(scaffold: WebScaffold, patchId: string, enabled: boolean): Promise<void> {
  const plugin = (await scaffold.ctx.pluginManager.listPlugins()).find(plugin => plugin.patchId === patchId)
  expect(plugin, `The shipped product must compose ${patchId} as an independently switchable plugin`).toBeDefined()
  if (plugin === undefined) throw new Error(`Missing node plugin ${patchId}`)
  const result = await scaffold.ctx.pluginManager.setPluginEnabled(plugin.entryId, enabled)
  expect(result, `The product's plugin manager must apply ${patchId} ${enabled ? 'enablement' : 'disposal'}`)
    .toMatchObject({ application: 'applied' })
}

/** A no-build third-party bundle uses only the same public APIs as the shipped nodes. */
async function writeExtensionBundle(directory: string, referencePath: string): Promise<void> {
  await mkdir(directory)
  await writeFile(join(directory, 'package.json'), JSON.stringify({
    name: '@local/convax-acceptance-reference', version: '1.0.0', type: 'module',
    exports: { '.': './index.js', './client': './client.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', immediately: true,
      inject: ['@deepseek-ai/dsh-convax-plugin-renderer'], external: ['@deepseek-ai/dsh-convax-plugin-renderer/client'],
    } },
  }))
  await writeFile(join(directory, 'cordis.patch.yml'), '- insert:\n    - id: acceptance-reference\n      name: \'@local/convax-acceptance-reference\'\n')
  await writeFile(join(directory, 'index.js'), `
export function apply(ctx) {
  ctx.inject(['convax'], scope => {
    scope.effect(() => scope.convax.registerNodeType({
      id: 'acceptance.reference', dataVersion: 1,
      description: 'An external reference adapter with a provider-owned payload.',
      dataSchema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false },
      ports: [{ id: 'out', direction: 'output', valueKind: 'resource' }],
      parse(data) {
        if (typeof data.label !== 'string') throw new TypeError('Missing reference label')
        return { label: data.label }
      },
      prepareInput() { return { path: ${JSON.stringify(referencePath)}, name: 'third-party.txt', kind: 'file', size: null } },
    }))
  })
}
`)
  await writeFile(join(directory, 'client.js'), `
window.__ModuleLoader__.load({
  id: '@local/convax-acceptance-reference',
  factory(require) {
    const React = require('react')
    const { NodePorts } = require('@deepseek-ai/dsh-convax-plugin-renderer/client')
    const h = React.createElement
    function Reference(props) {
      return h('article', {
        'data-acceptance-reference': props.node.id,
        style: { boxSizing: 'border-box', width: 410, height: 140, padding: 16,
          border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12,
          background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)' },
      }, h('header', { 'data-acceptance-drag': '', style: { paddingBlockEnd: 16 } }, props.node.data.label),
      h('p', null, 'Only the header moves this third-party card.'),
      h(NodePorts, { nodeId: props.node.id, ports: props.ports, connectable: !props.busy }))
    }
    return { apply(ctx) {
      ctx.inject(['convaxRenderer'], scope => {
        scope.convaxRenderer.registerNodeRenderer('acceptance.reference', {
          dataVersion: 1, component: Reference, defaultSize: { width: 410, height: 140 }, dragHandle: '[data-acceptance-drag]',
        })
        scope.convaxRenderer.registerCreation({
          id: 'acceptance.reference', label: 'Acceptance reference', defaultSize: { width: 410, height: 140 }, connected: false,
          create(context) { void context.command({ kind: 'add-node', node: {
            id: crypto.randomUUID(), typeId: 'acceptance.reference', dataVersion: 1, revision: 0,
            data: { label: 'Third-party reference' }, position: context.position,
          } }) },
        })
      })
    } }
  },
})
`)
}

async function dragBetween(page: Page, sourceSelector: string, targetSelector: string): Promise<void> {
  const source = await page.locator(sourceSelector).boundingBox()
  const target = await page.locator(targetSelector).boundingBox()
  if (source === null || target === null) throw new Error('Expected visible graph connection handles')
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
  await page.mouse.down()
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 })
  await page.mouse.up()
}

it('unloads and restores all built-in displays and providers without losing graphs, drafts or running DSH work', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'convax-internal-nodes-'))
  try {
    const ready = join(scratch, 'turn-ready')
    const script = join(scratch, 'replay.json')
    await writeFile(script, JSON.stringify([{ kind: 'hang', readyFile: ready }]))
    const scaffold = await launchWebScaffold({
      extraOverlayPath: PICKER,
      profile: { packages: [{ dir: BUNDLE, enabled: true }] },
      replayFixture: REPLAY, replayOverride: script, compareReplaySession: false,
      replayProviders: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{
        id: 'deepseek-v4-flash-vision-exp', name: 'Vision', inputModalities: ['text', 'image'], contextWindow: 1_000_000,
      }] }],
    })
    try {
      const browser = await chromium.launch()
      try {
        const page = await newEnglishPage(browser)
        const console = watchConsole(page)
        const diagnostics: string[] = []
        page.on('console', (message) => { diagnostics.push(`${message.type()}: ${message.text()}`) })
        try {
          const rows = [...scaffold.ctx.loader.entries()].map(entry => entry.options.id)
          expect(rows).toContain('convax-inernal-nodes-host')
          expect(rows).toContain('convax-inernal-nodes-renderer')
          expect(scaffold.ctx.convax.workspace().nodeTypes.map(type => type.id).sort()).toEqual(NODE_TYPES)
          const canvasId = randomUUID() as CanvasId
          const fileId = randomUUID() as CanvasNodeId, folderId = randomUUID() as CanvasNodeId
          const chatId = randomUUID() as CanvasNodeId
          const path = join(scaffold.workspaceCwd, 'source.txt')
          await writeFile(path, 'An ordinary file preview survives node plugin reload.\n')
          await execute(scaffold, canvasId, { kind: 'create', title: 'Optional built-in nodes' })
          const initialNodes: Pick<CanvasNode, 'id' | 'typeId' | 'data' | 'position'>[] = [
            { id: fileId, typeId: 'convax.file' as CanvasNodeTypeId, data: { path }, position: { x: 0, y: 40 } },
            { id: folderId, typeId: 'convax.folder' as CanvasNodeTypeId, data: { path: scaffold.workspaceCwd }, position: { x: 0, y: 210 } },
            { id: chatId, typeId: 'convax.chat' as CanvasNodeTypeId,
              data: { title: 'Running native Session', cwd: scaffold.workspaceCwd }, position: { x: 420, y: 40 } },
          ]
          for (const node of initialNodes) await execute(scaffold, canvasId, { kind: 'add-node', node: { ...node, dataVersion: 1, revision: 0 } })
          const document = () => scaffold.ctx.convax.workspace().canvases.find(canvas => canvas.id === canvasId)!
          const created = await scaffold.ctx.convax.createThread({ canvasId, nodeId: chatId, expectedRevision: document().revision,
            operationId: randomUUID() as CanvasOperationId, kind: 'create', cwd: scaffold.workspaceCwd, agentPreset: 'standard' })
          if (!created.ok) throw new Error(`Native thread fixture: ${created.code}`)
          await scaffold.ctx.sessionController.selectModel({ sessionId: created.sessionId,
            provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' })
          await execute(scaffold, canvasId, { kind: 'add-connection', connection: {
            id: randomUUID() as CanvasConnectionId, source: folderId, sourcePort: 'output', target: chatId, targetPort: 'input', purpose: 'input',
          } })

          await installCaptureFixture(page)
          await page.emulateMedia({ reducedMotion: 'reduce' })
          await page.goto(scaffold.authenticatedUrl)
          await page.locator('[data-convax-workspace]').waitFor({ timeout: 30_000 })
          await page.getByRole('button', { name: 'Workspace actions', exact: true }).click()
          await page.getByRole('menuitem', { name: 'All canvases', exact: true }).click()
          await page.locator(`[data-canvas-manager-row="${canvasId}"] button`).first().click()
          await page.locator(`[data-convax-resource="${fileId}"]`).getByRole('button', { name: 'Expand source.txt', exact: true }).click()
          await page.getByText('An ordinary file preview survives node plugin reload.', { exact: false }).waitFor()
          await page.locator(`[data-convax-resource="${folderId}"]`).waitFor()
          const chat = page.locator(`[data-convax-chat="${chatId}"]`)
          const input = chat.locator('[data-composer-input][contenteditable="true"]:visible')
          await input.waitFor({ timeout: 30_000 })
          await page.getByRole('button', { name: 'Application window', exact: true }).click()
          await page.getByRole('dialog', { name: 'Application window', exact: true })
            .getByRole('button', { name: 'Acceptance window', exact: true }).click()
          await expect.poll(() => document().nodes.filter(node => node.typeId === 'convax.window').length).toBe(1)
          const windowNode = document().nodes.find(node => node.typeId === 'convax.window')!
          await page.locator(`[data-convax-window="${windowNode.id}"] video`).waitFor()
          await expect.poll(() => captureResources(page)).toEqual({ tracks: 1, leases: 1 })
          await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()

          // The native turn intentionally spans both plugins' disable/enable transitions.
          const historyStart = (await readPersistedEvents(scaffold, created.sessionId)).length
          const settled = scaffold.whenTurnSettled(120_000)
          void settled.catch(() => { /* Awaited after explicit cancellation below. */ })
          await input.fill(PROMPT)
          await input.press('Enter')
          await expect.poll(async () => readFile(ready, 'utf8').then(() => true, () => false), { timeout: 15_000 }).toBe(true)
          await input.fill(DRAFT)
          const agent = scaffold.ctx.agents.get(created.sessionId)
          if (agent === undefined) throw new Error('The running DSH Agent is missing')
          const before = document()
          const boundSessions = scaffold.ctx.convax.workspace().chats.find(chat => chat.nodeId === chatId)!
            .threads.map(thread => thread.sessionId)
          await toggle(scaffold, 'convax-inernal-nodes-renderer', false)
          await expect.poll(() => page.locator('[data-convax-placeholder="renderer"]').count(), { timeout: 30_000 }).toBe(4)
          await expect.poll(() => captureResources(page)).toEqual({ tracks: 0, leases: 0 })
          expect(document()).toEqual(before)
          expect(scaffold.ctx.convax.workspace().nodeTypes.map(type => type.id).sort()).toEqual(NODE_TYPES)
          expect(scaffold.ctx.agents.get(created.sessionId)).toBe(agent)
          expect(scaffold.ctx.agents.turnBoundaryOf(agent.session).openTurnStartSeq).not.toBeNull()
          await mkdir(EXPECTED, { recursive: true })
          await compareOrRefreshGolden(join(EXPECTED, 'missing-renderer.expected.md'),
            await captureStableAria(page, `.react-flow__node[data-id="${chatId}"]`, scaffold.workspaceCwd), webSnapshotMode())

          await toggle(scaffold, 'convax-inernal-nodes-renderer', true)
          await input.waitFor({ timeout: 30_000 })
          expect(await input.textContent()).toContain(DRAFT)
          await chat.getByRole('button', { name: 'Queue message', exact: true }).waitFor()
          await page.locator(`[data-convax-window="${windowNode.id}"]`).waitFor()
          expect(await captureResources(page)).toEqual({ tracks: 0, leases: 0 })
          expect(document()).toEqual(before)

          await toggle(scaffold, 'convax-inernal-nodes-host', false)
          await expect.poll(() => page.locator('[data-convax-placeholder="provider"]').count(), { timeout: 30_000 }).toBe(4)
          expect(scaffold.ctx.convax.workspace().nodeTypes).toEqual([])
          expect(document()).toEqual(before)
          expect(scaffold.ctx.agents.get(created.sessionId)).toBe(agent)
          expect(scaffold.ctx.agents.turnBoundaryOf(agent.session).openTurnStartSeq).not.toBeNull()
          const rejected = await scaffold.ctx.convax.execute({ canvasId, expectedRevision: before.revision,
            operationId: randomUUID() as CanvasOperationId, command: { kind: 'add-node', node: {
              id: randomUUID() as CanvasNodeId, typeId: 'convax.file' as CanvasNodeTypeId, dataVersion: 1,
              data: { path }, position: { x: 0, y: 500 }, revision: 0,
            } } })
          expect(rejected).toMatchObject({ ok: false, code: 'provider-unavailable' })
          expect(document()).toEqual(before)
          await compareOrRefreshGolden(join(EXPECTED, 'missing-provider.expected.md'),
            await captureStableAria(page, `.react-flow__node[data-id="${chatId}"]`, scaffold.workspaceCwd), webSnapshotMode())

          await toggle(scaffold, 'convax-inernal-nodes-host', true)
          await input.waitFor({ timeout: 30_000 })
          expect(scaffold.ctx.convax.workspace().chats.find(chat => chat.nodeId === chatId)!
            .threads.map(thread => thread.sessionId)).toEqual(boundSessions)
          expect(scaffold.ctx.agents.get(created.sessionId)).toBe(agent)
          expect(scaffold.ctx.agents.turnBoundaryOf(agent.session).openTurnStartSeq).not.toBeNull()
          expect(await input.textContent()).toContain(DRAFT)
          // An empty running composer offers Stop in place of Queue.
          await input.fill('')
          await chat.getByRole('button', { name: 'Stop generating', exact: true }).click()
          await settled
          const history = (await readPersistedEvents(scaffold, created.sessionId)).slice(historyStart)
          const messages = history.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'user'
            ? [event.data.content] : [])
          expect(messages).toEqual([[{ type: 'text', text: PROMPT }]])
          expect(history.filter(event => event.type === 'turn/end')).toHaveLength(1)
          await page.reload()
          await input.waitFor({ timeout: 30_000 })
          expect(document()).toEqual(before)
          await mkdir(ARTIFACTS, { recursive: true })
          await page.screenshot({ path: join(ARTIFACTS, 'restored.png') })
          expect(console.pageErrors).toEqual([])
        } catch (error) {
          await saveFailureShot(page, 'convax-internal-nodes')
          await mkdir(ARTIFACTS, { recursive: true })
          await writeFile(join(ARTIFACTS, 'failure.json'), JSON.stringify({
            console: diagnostics,
            pageErrors: console.pageErrors,
            plugins: (await scaffold.ctx.pluginManager.listPlugins()).filter(plugin => plugin.patchId?.includes('convax')),
            aria: await page.locator('[data-convax-workspace]').ariaSnapshot(),
          }, null, 2))
          throw error
        }
      } finally { await browser.close() }
    } finally { await scaffold.close() }
  } finally { await rm(scratch, { recursive: true, force: true }) }
})

it('lets an ordinary third-party plugin contribute a creation entry, drag region, dimensions and composer reference', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'convax-external-node-'))
  try {
    const referencePath = join(scratch, 'third-party.txt')
    await writeFile(referencePath, 'The provider prepares this reference without storing a path in its node.\n')
    const directory = join(scratch, 'reference-plugin')
    await writeExtensionBundle(directory, referencePath)
    const scaffold = await launchWebScaffold({
      extraOverlayPath: [join(BUNDLE, 'cordis.patch.yml'), PICKER], extraInstallAnchors: [join(BUNDLE, 'package.json')],
      profile: { packages: [{ dir: directory, enabled: true }] },
    })
    try {
      const browser = await chromium.launch()
      try {
        const page = await newEnglishPage(browser)
        const console = watchConsole(page)
        try {
          const canvasId = randomUUID() as CanvasId
          const chatId = randomUUID() as CanvasNodeId
          await execute(scaffold, canvasId, { kind: 'create', title: 'Public extension capabilities' })
          await execute(scaffold, canvasId, { kind: 'add-node', node: {
            id: chatId, typeId: 'convax.chat' as CanvasNodeTypeId, dataVersion: 1, revision: 0,
            data: { title: 'Native reference recipient', cwd: scaffold.workspaceCwd }, position: { x: 800, y: 0 },
          } })
          await page.emulateMedia({ reducedMotion: 'reduce' })
          await page.goto(scaffold.authenticatedUrl)
          await page.locator('[data-convax-workspace]').waitFor({ timeout: 30_000 })
          await page.getByRole('button', { name: 'Workspace actions', exact: true }).click()
          await page.getByRole('menuitem', { name: 'All canvases', exact: true }).click()
          await page.locator(`[data-canvas-manager-row="${canvasId}"] button`).first().click()
          const creation = page.getByRole('button', { name: 'Acceptance reference', exact: true })
          await creation.waitFor({ timeout: 30_000 })
          await creation.click()
          const document = () => scaffold.ctx.convax.workspace().canvases.find(canvas => canvas.id === canvasId)!
          await expect.poll(() => document().nodes.filter(node => node.typeId === 'acceptance.reference').length).toBe(1)
          const reference = document().nodes.find(node => node.typeId === 'acceptance.reference')!
          const card = page.locator(`[data-acceptance-reference="${reference.id}"]`)
          await card.waitFor()
          expect(await card.evaluate(element => ({ width: element.clientWidth, height: element.clientHeight })))
            .toEqual({ width: 408, height: 138 })
          // The registered width centers the new card itself, rather than the kernel's fallback width.
          await expect.poll(async () => {
            const bounds = await card.boundingBox(), canvas = await page.locator('.react-flow').boundingBox()
            if (bounds === null || canvas === null) return Infinity
            return Math.abs(bounds.x + bounds.width / 2 - canvas.x - canvas.width / 2)
          }).toBeLessThan(2)
          expect(reference.data).toEqual({ label: 'Third-party reference' })
          await execute(scaffold, canvasId, { kind: 'move-nodes', nodes: [{ id: reference.id, position: { x: 0, y: 80 } }] })
          await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
          const before = document().nodes.find(node => node.id === reference.id)!.position
          const body = await card.getByText('Only the header moves this third-party card.').boundingBox()
          if (body === null) throw new Error('The reference body is not visible')
          await page.mouse.move(body.x + body.width / 2, body.y + body.height / 2)
          await page.mouse.down()
          await page.mouse.move(body.x + body.width / 2 + 80, body.y + body.height / 2 + 30, { steps: 12 })
          await page.mouse.up()
          expect(document().nodes.find(node => node.id === reference.id)!.position).toEqual(before)
          const header = await card.locator('[data-acceptance-drag]').boundingBox()
          if (header === null) throw new Error('The registered reference drag region is not visible')
          await page.mouse.move(header.x + header.width / 2, header.y + header.height / 2)
          await page.mouse.down()
          await page.mouse.move(header.x + header.width / 2 + 60, header.y + header.height / 2 + 30, { steps: 12 })
          await page.mouse.up()
          await expect.poll(() => document().nodes.find(node => node.id === reference.id)!.position.x).toBeGreaterThan(before.x)
          await dragBetween(page, `[data-acceptance-reference="${reference.id}"] .react-flow__handle.source`,
            `.react-flow__node[data-id="${chatId}"] .react-flow__handle.target`)
          const chat = page.locator(`[data-convax-chat="${chatId}"]`)
          await chat.getByRole('button', { name: 'Remove reference third-party.txt', exact: true }).waitFor({ timeout: 15_000 })
          expect(document().connections).toHaveLength(1)
          const saved = document()
          await toggle(scaffold, 'acceptance-reference', false)
          await expect.poll(() => creation.count(), { timeout: 30_000 }).toBe(0)
          await expect.poll(() => card.count(), { timeout: 30_000 }).toBe(0)
          await page.locator(`.react-flow__node[data-id="${reference.id}"] [data-convax-placeholder="provider"]`).waitFor()
          expect(document()).toEqual(saved)
          await toggle(scaffold, 'acceptance-reference', true)
          await creation.waitFor({ timeout: 30_000 })
          await card.waitFor({ timeout: 30_000 })
          expect(document()).toEqual(saved)
          await mkdir(EXPECTED, { recursive: true })
          await compareOrRefreshGolden(join(EXPECTED, 'external-creation.expected.md'),
            await captureStableAria(page, `[data-acceptance-reference="${reference.id}"]`, scaffold.workspaceCwd), webSnapshotMode())
          expect(console.pageErrors).toEqual([])
        } catch (error) {
          await saveFailureShot(page, 'convax-external-node')
          throw error
        }
      } finally { await browser.close() }
    } finally { await scaffold.close() }
  } finally { await rm(scratch, { recursive: true, force: true }) }
})
