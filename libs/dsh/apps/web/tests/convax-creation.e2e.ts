/** Workbench→Chat→file rounds with external generation isolated at Provider or CLI boundaries. */
import { existsSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-convax-plugin-host'
import type {} from '@deepseek-ai/dsh-convax-plugin-creation-host'
import type { ConnectionInspection, ConnectionSnapshot, MediaKind, ProviderCheckpoint, ProviderDescriptor, ProviderId,
  ProviderRequest, ProviderRuntime, ProviderSnapshot } from '@deepseek-ai/dsh-convax-plugin-creation-host/types'
import { FixtureCreationProvider, fixtureMedia } from '../../../../../packages/plugin-creation-host/tests/fixtures/provider.ts'
import { launchWebScaffold, readPersistedEvents, watchConsole } from './scaffold.ts'
import { newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

const BUNDLE = fileURLToPath(new URL('../../../../../packages/plugin-renderer/', import.meta.url))
const ARTIFACTS = fileURLToPath(new URL('../../../../../.artifacts/convax-creation/', import.meta.url))
const PROVIDER = 'creation-chat-fixture'
const MODEL = 'controlled'

/** A selected model is supplied once, and an unavailable model must not leave a connection behind. */
class SetupCreationProvider extends FixtureCreationProvider {
  approvals = 0
  override readonly descriptor: ProviderDescriptor = { id: 'fixture-creation' as ProviderId, title: 'Fixture media', configuration: [
    { key: 'imageModel', label: 'Image model', type: 'text', required: true },
  ] }
  override async describe(connection?: ConnectionSnapshot): Promise<ConnectionInspection> {
    if (connection?.settings.imageModel !== 'fixture-image-v1') {
      return { state: 'unavailable', reason: 'invalid-configuration', message: 'Choose the available fixture image model' }
    }
    const inspection = await super.describe()
    if (inspection.state !== 'ready') return inspection
    return { ...inspection, capabilities: inspection.capabilities.filter(capability => capability.kind === 'image')
      .map(capability => ({ ...capability, modelId: 'fixture-image-v1' })) }
  }
  override async submit(_request: ProviderRequest, runtime: ProviderRuntime): Promise<ProviderSnapshot> {
    this.submissions += 1
    const checkpoint = { version: 1, data: { task: runtime.operationId } }
    await runtime.checkpoint(checkpoint)
    return { state: 'awaiting-approval', checkpoint, approval: { credits: 12, unit: 'credits', message: 'One image' } }
  }
  async approve(request: ProviderRequest, checkpoint: ProviderCheckpoint,
    _credits: number, runtime: ProviderRuntime): Promise<ProviderSnapshot> {
    this.approvals += 1
    return super.reconcile(request, checkpoint, runtime)
  }
}

/** The native Agent receives a normal model tool call and normal completion text. */
class CreationAdapter extends LlmAdapter {
  calls = 0
  override async listModels(provider: string) { return [{ provider, id: MODEL, name: 'Creation fixture model' }] }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    if (this.calls++ === 0) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'creation-image-call' as ToolCallId, name: 'creation_generate',
        arguments: JSON.stringify({ kind: 'image', prompt: 'A small test image' }) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'The image is being created through your workbench.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

const mediaKinds = ['image', 'video', 'audio'] as const
const fixturePrompts: Record<MediaKind, string> = {
  image: 'Fixture poster image', video: 'Fixture five-second video', audio: 'Fixture narration: hello from the workbench',
}
const fixtureCredits: Record<MediaKind, number> = { image: 3, video: 7, audio: 2 }

/** Exercise the production model schemas and tools while replacing only the external LLM. */
class JimengMediaAdapter extends LlmAdapter {
  calls = 0
  constructor(private readonly mixedProviders = false) { super() }
  override async listModels(provider: string) { return [{ provider, id: MODEL, name: 'Jimeng media fixture model' }] }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    const call = this.calls++
    if (call === 0) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'jimeng-describe' as ToolCallId,
        name: 'creation_describe', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else if (call === 1) {
      const parameters = {
        image: this.mixedProviders ? { ratio: '1:1', count: 1 } : { mode: 't2i', ratio: '1:1', count: 1 },
        video: { mode: 't2v', ratio: '16:9', resolution: '720p', duration: 5, count: 1 },
        audio: { mode: 'tts', scenario: 'text-reading', 'voice-id': '12345' },
      }
      for (const [index, kind] of mediaKinds.entries()) {
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'block-end', index, block: { type: 'tool-call', id: `jimeng-${kind}` as ToolCallId,
          name: 'creation_generate', arguments: JSON.stringify({ kind, prompt: fixturePrompts[kind], parameters: parameters[kind] }) } }
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text',
        text: 'Fixture image, video and narration requests are saved in the workbench tasks.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

/** Model CLI protocol state without replacing JimengProvider, the runner or delivery. */
class JimengMediaCliFixture {
  readonly commands: string[][] = []
  projectId: string | undefined
  complete = false
  readonly nodes = new Map<string, { kind: MediaKind; confirmed: boolean; runs: number }>()
  readonly operations = new Map<string, string>()

  private value(args: readonly string[], flag: string): string {
    const index = args.indexOf(flag)
    if (index === -1 || args[index + 1] === undefined) throw new Error(`Fixture CLI requires ${flag}`)
    return args[index + 1]!
  }

  private catalog(kind: string) {
    const image = [{ name: 't2i', flags: [
      { flag: '--ratio', values: ['1:1'] }, { flag: '--count', min: 1, max: 1 },
    ] }]
    const video = [{ name: 't2v', flags: [
      { flag: '--ratio', values: ['16:9'] }, { flag: '--resolution', values: ['720p'] },
      { flag: '--duration', values: [5] }, { flag: '--count', min: 1, max: 1 },
    ] }]
    const audio = [{ name: 'tts', scenario: 'text-reading', flags: [
      { flag: '--scenario', required: true, values: ['text-reading'] }, { flag: '--voice-id' }, { flag: '--voice-name' },
    ], references: { min: 0, max: 0, types: [] } }]
    if (kind !== 'image' && kind !== 'video' && kind !== 'audio') throw new Error(`Unexpected fixture model type ${kind}`)
    return { items: [{ model: `jimeng-fixture-${kind}`, displayName: `Fixture ${kind} model`, modes: { image, video, audio }[kind] },
      ...(kind === 'image' ? [{ model: 'jimeng-fixture-image-v2', displayName: 'Fixture image model two', modes: image }] : [])] }
  }

  run(args: readonly string[]): unknown {
    this.commands.push(args.map((arg, index) => args[index - 1] === '--credit-token' ? '[private]' : arg))
    const command = args.slice(0, 2).join(' ')
    let data: unknown
    if (args.join(' ') === '--format json version') data = { version: '1.3.0' }
    else if (command === 'auth status') data = { loggedIn: true }
    else if (command === 'model list') data = this.catalog(this.value(args, '--type'))
    else if (command === 'voice list') data = { models: { 'jimeng-fixture-audio': {
      items: [{ voiceId: '12345', voiceName: 'Fixture narrator' }], hasMore: false, nextOffset: 1, totalCount: 1,
    } } }
    else if (command === 'canvas create') {
      expect(this.projectId).toBeUndefined()
      this.projectId = this.value(args, '--project-id')
      expect(this.projectId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/)
      data = { project: { projectId: this.projectId, name: args[2] } }
    }
    else if (command === 'node create') {
      const kind = args[2]
      if (kind !== 'image' && kind !== 'video' && kind !== 'audio') throw new Error('Unexpected fixture node kind')
      expect(args).not.toContain('--run')
      expect(this.value(args, '--model')).toBe(kind === 'image' ? 'jimeng-fixture-image-v2' : `jimeng-fixture-${kind}`)
      expect(this.value(args, '--project-id')).toBe(this.projectId)
      expect(this.value(args, '--prompt')).toBe(fixturePrompts[kind])
      const nodeId = this.value(args, '--node-id')
      expect(this.nodes.has(nodeId)).toBe(false)
      this.nodes.set(nodeId, { kind, confirmed: false, runs: 0 })
      data = { node: { nodeId } }
    } else if (command === 'node quote' || command === 'node confirm' || command === 'node run' || command === 'node show') {
      const nodeId = this.value(args, '--node-id'), node = this.nodes.get(nodeId)
      if (node === undefined) throw new Error('Fixture node was never saved')
      if (command === 'node quote') data = { items: [{ nodeId, maxCredits: fixtureCredits[node.kind] }],
        totalMaxCredits: fixtureCredits[node.kind], confirmable: true, confirmationRequired: true }
      else if (command === 'node show') data = { nodes: [{ result: 'FOUND', node: { nodeId } }] }
      else if (command === 'node confirm') {
        expect(Number(this.value(args, '--credit-ceiling'))).toBe(fixtureCredits[node.kind])
        node.confirmed = true
        data = { creditConfirmationToken: `private-${nodeId}`, creditCeiling: fixtureCredits[node.kind] }
      } else {
        expect(node.confirmed).toBe(true)
        expect(this.value(args, '--credit-token')).toBe(`private-${nodeId}`)
        expect(node.runs).toBe(0)
        node.runs += 1
        const submitId = this.value(args, '--submit-id')
        this.operations.set(submitId, nodeId)
        data = { items: [{ nodeId, submitId, state: 'accepted' }] }
      }
    } else if (command === 'operation status') {
      const nodeId = this.operations.get(args[2]!), node = nodeId === undefined ? undefined : this.nodes.get(nodeId)
      data = node === undefined ? { state: 'unknown', submission: { state: 'absent', resubmittable: false }, resources: [] }
        : !this.complete ? { state: 'running', submission: { state: 'accepted', resubmittable: false }, resources: [] }
          : { state: 'succeeded', submission: { state: 'completed', resubmittable: false },
            resources: [{ resourceId: `fixture-resource-${node.kind}`, state: 'succeeded' }] }
    } else if (command === 'resource get' || command === 'resource download') {
      const kind = mediaKinds.find(kind => args[2] === `fixture-resource-${kind}`)
      if (kind === undefined || ![...this.nodes.values()].some(node => node.kind === kind && node.runs === 1)) {
        throw new Error('Fixture resource was not generated after approval')
      }
      if (command === 'resource get') data = { resourceId: args[2], type: kind, status: 'success' }
      else {
        const path = this.value(args, '--output'), bytes = fixtureMedia(kind)
        expect(isAbsolute(path)).toBe(true)
        expect(path).toContain(`${process.platform === 'win32' ? '\\' : '/'}.creation`)
        writeFileSync(path, bytes)
        data = { resourceId: args[2], path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
      }
    } else throw new Error(`Unimplemented fixture CLI command: ${command}`)
    return { schemaVersion: '2', ok: true, data }
  }
}

/** The real LibTV adapter consumes CLI output and downloads ordinary image bytes. */
class LibTVMediaCliFixture {
  readonly commands: string[][] = []
  readonly projectId = 'libtv-fixture-project'
  runs = 0
  private created = false

  run(args: readonly string[]): string {
    this.commands.push([...args])
    if (args[0] === 'status') return JSON.stringify({ auth: { loggedIn: true }, binding: {} })
    if (args[0] === 'model' && args[1] === 'search') {
      return JSON.stringify({ nodeType: args[args.indexOf('--type') + 1], query: '', matchKind: 'all',
        matches: args[args.indexOf('--type') + 1] === 'image' ? [
          { modelKey: 'libtv-fixture-image', modelName: 'LibTV fixture image', supportModality: 'image' },
          { modelKey: 'libtv-fixture-image-v2', modelName: 'LibTV fixture image two', supportModality: 'image' },
        ] : [] })
    }
    if (args[0] === 'model') return JSON.stringify({ nameOrId: args[1], modelName: args[1], modelKey: args[1],
      modality: 'image', schema: { properties: { count: [1], ratio: { enum: ['1:1'] } } } })
    if (args[0] === 'node' && args[1] === 'create') {
      expect(this.created).toBe(false)
      expect(args).toContain('model=LibTV fixture image two')
      expect(args[args.indexOf('-t') + 1]).toBe('image')
      expect(args[args.indexOf('-p') + 1]).toBe(this.projectId)
      expect(args[args.indexOf('--prompt') + 1]).toBe(fixturePrompts.image)
      this.created = true
      return JSON.stringify({ nodeKey: 'libtv-fixture-node' })
    }
    if (args[0] === 'node' && args.includes('--run')) {
      expect(this.created).toBe(true)
      expect(this.runs).toBe(0)
      this.runs += 1
      return JSON.stringify({ nodeKey: 'libtv-fixture-node', status: 2 })
    }
    if (args[0] === 'download') {
      expect(this.runs).toBe(1)
      expect(args[args.indexOf('--watermark') + 1]).toBe('true')
      const directory = args[args.indexOf('-o') + 1]!
      expect(isAbsolute(directory)).toBe(true)
      const path = join(directory, 'libtv-image.png')
      writeFileSync(path, fixtureMedia('image'))
      return `${path}\n`
    }
    throw new Error(`Unimplemented LibTV fixture command: ${args.slice(0, 2).join(' ')}`)
  }
}

it('configures one workbench, creates a connected native Chat and automatically publishes its generated file', async () => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: join(BUNDLE, 'cordis.patch.yml'), extraInstallAnchors: [join(BUNDLE, 'package.json')],
  })
  onTestFinished(() => scaffold.close())
  const provider = new SetupCreationProvider()
  scaffold.ctx.effect(() => scaffold.ctx.convaxCreation.registerProvider(provider), 'Creation browser fixture Provider')
  const adapter = new CreationAdapter()
  scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter([PROVIDER], adapter), 'Creation browser fixture model')
  await scaffold.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: MODEL })
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const console = watchConsole(page)
  const diagnostics: string[] = []
  page.on('console', message => diagnostics.push(`${message.type()}: ${message.text()}`))
  onTestFinished(async ({ task }) => {
    if (task.result?.state === 'fail') {
      await saveFailureShot(page, 'convax-creation')
      await mkdir(ARTIFACTS, { recursive: true })
      await writeFile(join(ARTIFACTS, 'failure.json'), JSON.stringify({ console: diagnostics, pageErrors: console.pageErrors,
        aria: await page.locator('[data-convax-workspace]').ariaSnapshot() }, null, 2))
    }
    await page.close()
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(scaffold.authenticatedUrl)
  await page.locator('[data-convax-workspace]').waitFor({ timeout: 30_000 })
  await page.getByRole('button', { name: 'New canvas', exact: true }).first().click()
  await page.locator('[data-convax-creation-dock]').getByRole('button', { name: 'Creation workbench', exact: true }).click()
  const workbench = page.locator('[data-convax-creation]')
  await workbench.waitFor()
  const workbenchId = await workbench.getAttribute('data-convax-creation')
  const document = () => scaffold.ctx.convax.workspace().canvases.find(canvas => canvas.nodes.some(node => node.id === workbenchId))!
  const ref = { canvasId: document().id, nodeId: document().nodes.find(node => node.id === workbenchId)!.id }
  await workbench.getByRole('button', { name: 'Connect services', exact: true }).click()
  const settings = page.getByRole('dialog')
  await settings.getByRole('button', { name: 'Fixture media', exact: true }).click()
  const viewport = page.viewportSize()!
  await page.setViewportSize({ width: 480, height: 800 })
  await expect.poll(() => settings.evaluate((element) => {
    const box = element.getBoundingClientRect()
    return box.left >= 23 && box.top >= 23 && box.right <= innerWidth - 23 && box.bottom <= innerHeight - 23
  })).toBe(true)
  expect(await settings.getByLabel('Image model', { exact: true }).count()).toBe(1)
  await settings.getByLabel('Image model', { exact: true }).fill('unavailable-model')
  await settings.getByRole('button', { name: 'Connect and apply', exact: true }).click()
  await expect.poll(() => settings.getByRole('alert').textContent()).toContain('Could not update the connection. Check its configuration.')
  expect(await settings.getByText('Choose the available fixture image model', { exact: true }).count()).toBe(1)
  expect(await scaffold.ctx.convaxCreation.listConnections(ref)).toEqual([])
  expect(document().nodes.find(node => node.id === workbenchId)!.data.routes).toEqual({})
  expect(await settings.getByLabel('Image model', { exact: true }).inputValue()).toBe('unavailable-model')
  await settings.getByLabel('Image model', { exact: true }).fill('fixture-image-v1')
  await settings.getByRole('button', { name: 'Connect and apply', exact: true }).click()
  await settings.waitFor({ state: 'detached' })
  await page.setViewportSize(viewport)
  await expect.poll(() => workbench.textContent()).toContain('Fixture media')
  const connections = await scaffold.ctx.convaxCreation.listConnections(ref)
  expect(connections).toHaveLength(1)
  expect(connections[0]!.settings).toEqual({ imageModel: 'fixture-image-v1' })
  expect(document().nodes.find(node => node.id === workbenchId)!.data.routes).toEqual({ image: { connectionId: connections[0]!.id } })
  expect(provider.submissions).toBe(0)
  await workbench.getByRole('button', { name: 'Manage', exact: true }).click()
  expect(await settings.getByLabel('Image model', { exact: true }).count()).toBe(0)
  await settings.getByRole('button', { name: 'Edit', exact: true }).click()
  expect(await settings.getByLabel('Image model', { exact: true }).inputValue()).toBe('fixture-image-v1')
  await mkdir(ARTIFACTS, { recursive: true })
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await settings.screenshot({ path: join(ARTIFACTS, `connect-service-${colorScheme}.png`) })
  }
  await settings.getByRole('button', { name: 'Cancel', exact: true }).click()
  await settings.waitFor({ state: 'detached' })

  // The workbench action delegates to native Chat creation and binds its existing capability port.
  await workbench.getByRole('button', { name: 'New Chat', exact: true }).click()
  const chat = page.locator('[data-convax-chat]')
  await chat.waitFor()
  await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  const chatId = await chat.getAttribute('data-convax-chat')
  await expect.poll(() => document().connections).toMatchObject([{ source: workbenchId, target: chatId, purpose: 'capability' }])
  expect(await chat.getByRole('button', { name: 'Configure', exact: true }).count()).toBe(0)
  const input = chat.locator('[data-composer-input][contenteditable="true"]').filter({ visible: true })
  await input.waitFor({ timeout: 15_000 })
  await writeComposerDraft(page, input, 'Create a small test image using the connected workbench.')
  await chat.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(() => scaffold.ctx.convaxCreation.listPendingApprovals(ref), { timeout: 30_000 })
    .toMatchObject([{ prompt: 'A small test image', approval: { credits: 12 } }])
  expect(document().nodes.filter(node => node.typeId === 'convax.file')).toHaveLength(0)
  expect(provider.approvals).toBe(0)
  await workbench.getByRole('button', { name: /^Tasks(?: \(\d+\))?$/ }).click()
  const tasks = page.getByRole('dialog', { name: 'Creation tasks', exact: true })
  await tasks.getByText('Up to 12 credits in total', { exact: true }).waitFor()
  expect(await tasks.getByRole('button', { name: 'Save changes', exact: true }).count()).toBe(0)
  await tasks.screenshot({ path: join(ARTIFACTS, 'generation-approval.png') })
  await tasks.getByRole('button', { name: 'Confirm batch and generate', exact: true }).click()
  await expect.poll(() => document().nodes.filter(node => node.typeId === 'convax.file').length, { timeout: 30_000 }).toBe(1)
  await tasks.getByText('Completed', { exact: true }).waitFor()
  expect(await tasks.getByText('A small test image', { exact: true }).count()).toBe(1)
  await tasks.getByRole('button', { name: 'Close', exact: true }).last().click()
  await tasks.waitFor({ state: 'detached' })
  const file = document().nodes.find(node => node.typeId === 'convax.file')!
  expect(document().connections).toEqual(expect.arrayContaining([expect.objectContaining({ source: chatId, target: file.id, purpose: 'delivery' })]))
  expect(provider.submissions).toBe(1)
  expect(provider.approvals).toBe(1)
  const binding = scaffold.ctx.convax.workspace().chats.find(value => value.nodeId === chatId)!
  const sessionId = binding.threads[0]!.sessionId
  await expect.poll(async () => (await readPersistedEvents(scaffold, sessionId)).some(event => event.type === 'deliverables/presented'), { timeout: 15_000 }).toBe(true)
  await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  await page.locator(`.react-flow__node[data-id="${file.id}"]`).waitFor()
  await mkdir(ARTIFACTS, { recursive: true })
  await page.screenshot({ path: join(ARTIFACTS, 'workbench-chat-output.png') })
  await page.reload()
  await page.locator(`[data-convax-creation="${workbenchId}"]`).waitFor({ timeout: 30_000 })
  await page.locator(`[data-convax-chat="${chatId}"]`).waitFor()
  expect(document().nodes.filter(node => node.typeId === 'convax.file')).toHaveLength(1)
  expect(provider.submissions).toBe(1)
  expect(console.pageErrors).toEqual([])
})

it.each([false, true])('selects Provider then model and delivers media with mixed Providers=%s', async (mixedProviders) => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: join(BUNDLE, 'cordis.patch.yml'), extraInstallAnchors: [join(BUNDLE, 'package.json')],
  })
  let closing: Promise<void> | undefined
  const closeScaffold = () => closing ??= scaffold.close()
  onTestFinished(closeScaffold)
  const cli = new JimengMediaCliFixture()
  const libtv = new LibTVMediaCliFixture()
  const jimengKinds = mixedProviders ? ['video', 'audio'] as const : mediaKinds
  const filename = process.platform === 'win32' ? 'dreamina-canvas.exe' : 'dreamina-canvas'
  const executable = join(scaffold.harnessHome, 'fixture-bin', filename)
  const libtvFilename = process.platform === 'win32' ? 'libtv.exe' : 'libtv'
  const libtvExecutable = join(scaffold.harnessHome, 'fixture-bin', libtvFilename)
  await mkdir(join(scaffold.harnessHome, 'fixture-bin'), { recursive: true })
  await writeFile(executable, 'This inert CLI fixture is never executed.', { mode: 0o700 })
  await writeFile(libtvExecutable, 'This inert CLI fixture is never executed.', { mode: 0o700 })
  const subprocess = scaffold.ctx.subprocess
  const resolveExecutable = subprocess.resolveExecutable.bind(subprocess)
  const resolveSpy = vi.spyOn(subprocess, 'resolveExecutable').mockImplementation((command, env, signal) => {
    if (command === 'dreamina-canvas' || command === 'dreamina-canvas.exe' || command === executable) return Promise.resolve(executable)
    if (command === 'libtv' || command === 'libtv.exe' || command === libtvExecutable) return Promise.resolve(libtvExecutable)
    return resolveExecutable(command, env, signal)
  })
  onTestFinished(() => { resolveSpy.mockRestore() })
  const spawn = subprocess.spawn.bind(subprocess)
  const spawnSpy = vi.spyOn(subprocess, 'spawn').mockImplementation((spec) => {
    const name = basename(spec.argv[0]!)
    if (name !== filename && name !== libtvFilename) return spawn(spec)
    expect(spec.argv[0]).toBe(name === filename ? executable : libtvExecutable)
    const output = name === filename ? JSON.stringify(cli.run(spec.argv.slice(1))) : libtv.run(spec.argv.slice(1))
    return spawn({ ...spec, argv: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(output)})`] })
  })
  onTestFinished(() => { spawnSpy.mockRestore() })
  const adapter = new JimengMediaAdapter(mixedProviders)
  scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter([PROVIDER], adapter), 'Jimeng media browser fixture model')
  await scaffold.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: MODEL })
  try {
    const browser = await chromium.launch()
    try {
      const page = await newEnglishPage(browser)
      const console = watchConsole(page)
      try {
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await page.goto(scaffold.authenticatedUrl)
        await page.locator('[data-convax-workspace]').waitFor({ timeout: 30_000 })
        await page.getByRole('button', { name: 'New canvas', exact: true }).first().click()
        await page.locator('[data-convax-creation-dock]').getByRole('button', { name: 'Creation workbench', exact: true }).click()
        const workbench = page.locator('[data-convax-creation]')
        await workbench.waitFor()
        const workbenchId = await workbench.getAttribute('data-convax-creation')
        const document = () => scaffold.ctx.convax.workspace().canvases.find(canvas => canvas.nodes.some(node => node.id === workbenchId))!
        const ref = { canvasId: document().id, nodeId: document().nodes.find(node => node.id === workbenchId)!.id }
        await workbench.getByRole('button', { name: 'Connect services', exact: true }).click()
        const settings = page.getByRole('dialog')
        await settings.getByRole('button', { name: '即梦 CLI', exact: true }).click()
        for (const kind of mediaKinds) {
          const label = kind[0]!.toUpperCase() + kind.slice(1)
          const model = settings.getByRole('combobox', { name: `${label} model`, exact: true })
          await model.selectOption({ label: `Fixture ${kind} model` })
        }
        expect(await settings.getByRole('combobox', { name: 'Creation canvas', exact: true }).count()).toBe(0)
        expect(await settings.getByLabel('Canvas name', { exact: true }).count()).toBe(0)
        expect(cli.projectId).toBeUndefined()
        expect(await settings.getByText(/official CLI cannot export/).count()).toBe(0)
        await settings.getByRole('button', { name: 'Connect and apply', exact: true }).click()
        await settings.waitFor({ state: 'detached' })
        const connections = await scaffold.ctx.convaxCreation.listConnections(ref)
        expect(connections).toHaveLength(1)
        expect(connections[0]!.settings).toMatchObject({ projectId: cli.projectId,
          imageModel: 'jimeng-fixture-image', videoModel: 'jimeng-fixture-video', audioModel: 'jimeng-fixture-audio' })
        expect(connections[0]!.settings.creditCeiling).toBeUndefined()
        expect(document().nodes.find(node => node.id === workbenchId)!.data.routes).toEqual({
          image: { connectionId: connections[0]!.id }, video: { connectionId: connections[0]!.id },
          audio: { connectionId: connections[0]!.id },
        })
        expect(cli.commands.filter(args => args[0] === 'canvas' && args[1] === 'create')).toHaveLength(1)
        expect(cli.commands.filter(args => args[0] === 'canvas' && args[1] === 'ls')).toHaveLength(0)
        for (const kind of mediaKinds) {
          const label = kind[0]!.toUpperCase() + kind.slice(1)
          await workbench.getByRole('button', { name: `${label} model: Fixture ${kind} model`, exact: true }).waitFor()
        }
        const viewport = page.viewportSize()!
        await page.setViewportSize({ width: 480, height: 400 })
        await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
        await workbench.getByRole('button', { name: 'Audio model: Fixture audio model', exact: true }).click()
        const modelMenu = page.getByRole('menu')
        const providerItem = page.getByRole('menuitem', { name: '即梦 CLI', exact: true })
        await providerItem.click()
        const audioModel = page.getByRole('menuitem', { name: 'Fixture audio model', exact: true })
        await audioModel.waitFor()
        expect(await audioModel.getAttribute('aria-current')).toBe('true')
        const positionBeforeMenuKeys = { ...document().nodes.find(node => node.id === workbenchId)!.position }
        const workbenchNode = page.locator(`.react-flow__node[data-id="${workbenchId}"]`)
        const transformBeforeMenuKeys = await workbenchNode.evaluate(element => getComputedStyle(element).transform)
        await providerItem.press('ArrowRight')
        await expect.poll(() => audioModel.evaluate(element => element === window.document.activeElement)).toBe(true)
        expect(await workbenchNode.evaluate(element => getComputedStyle(element).transform)).toBe(transformBeforeMenuKeys)
        expect(document().nodes.find(node => node.id === workbenchId)!.position).toEqual(positionBeforeMenuKeys)
        await page.keyboard.press('ArrowLeft')
        await expect.poll(() => modelMenu.count()).toBe(1)
        await expect.poll(() => providerItem.evaluate(element => element === window.document.activeElement)).toBe(true)
        expect(await workbenchNode.evaluate(element => getComputedStyle(element).transform)).toBe(transformBeforeMenuKeys)
        expect(document().nodes.find(node => node.id === workbenchId)!.position).toEqual(positionBeforeMenuKeys)
        await providerItem.press('ArrowRight')
        await expect.poll(() => modelMenu.count()).toBe(2)
        await expect.poll(() => modelMenu.evaluateAll(elements => elements.every((element) => {
          const box = element.getBoundingClientRect()
          return box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight
        }))).toBe(true)
        await mkdir(ARTIFACTS, { recursive: true })
        const colors: string[] = []
        for (const colorScheme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme })
          await expect.poll(() => page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme')))
            .toBe(colorScheme === 'dark')
          colors.push(await workbench.evaluate(element => getComputedStyle(element).backgroundColor))
          await page.screenshot({ path: join(ARTIFACTS, `workbench-models-narrow-${colorScheme}.png`) })
        }
        expect(colors[0]).not.toBe(colors[1])
        await page.keyboard.press('Escape')
        await expect.poll(() => modelMenu.count()).toBe(0)
        expect(document().nodes.find(node => node.id === workbenchId)!.position).toEqual(positionBeforeMenuKeys)
        await page.setViewportSize(viewport)
        await page.emulateMedia({ colorScheme: 'light' })
        await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
        await workbench.getByRole('button', { name: 'Image model: Fixture image model', exact: true }).click()
        await page.getByRole('menuitem', { name: '即梦 CLI', exact: true }).click()
        await page.getByRole('menuitem', { name: 'Fixture image model two', exact: true }).click()
        await workbench.getByRole('button', { name: 'Image model: Fixture image model two', exact: true }).waitFor()
        await expect.poll(() => document().nodes.find(node => node.id === workbenchId)!.data.routes).toEqual({
          image: { connectionId: connections[0]!.id, modelId: 'jimeng-fixture-image-v2' },
          video: { connectionId: connections[0]!.id }, audio: { connectionId: connections[0]!.id },
        })
        expect((await scaffold.ctx.convaxCreation.listConnections(ref))[0]!.settings.imageModel).toBe('jimeng-fixture-image')
        if (mixedProviders) {
          await workbench.getByRole('button', { name: 'Image model: Fixture image model two', exact: true }).click()
          await page.getByRole('menuitem', { name: 'LibTV CLI', exact: true }).click()
          await page.getByRole('menuitem', { name: 'Connect LibTV CLI', exact: true }).click()
          await settings.getByRole('combobox', { name: 'Image model', exact: true }).selectOption({ label: 'LibTV fixture image' })
          expect(await settings.getByRole('combobox', { name: 'Video model', exact: true }).count()).toBe(0)
          expect(await settings.getByRole('combobox', { name: 'Audio model', exact: true }).count()).toBe(0)
          await settings.getByLabel('LibTV 画布 UUID', { exact: true }).fill(libtv.projectId)
          await settings.getByRole('button', { name: 'Connect and apply', exact: true }).click()
          await settings.waitFor({ state: 'detached' })
          await workbench.getByRole('button', { name: 'Image model: LibTV fixture image', exact: true }).waitFor()
          await workbench.getByRole('button', { name: 'Image model: LibTV fixture image', exact: true }).click()
          await page.getByRole('menuitem', { name: 'LibTV CLI', exact: true }).click()
          await page.getByRole('menuitem', { name: 'LibTV fixture image two', exact: true }).click()
          await workbench.getByRole('button', { name: 'Image model: LibTV fixture image two', exact: true }).waitFor()
          const mixedConnections = await scaffold.ctx.convaxCreation.listConnections(ref)
          const imageConnection = mixedConnections.find(value => value.providerId === 'libtv-cli')!
          expect(mixedConnections).toHaveLength(2)
          expect(imageConnection.settings.imageModel).toBe('libtv-fixture-image')
          await expect.poll(() => document().nodes.find(node => node.id === workbenchId)!.data.routes).toEqual({
            image: { connectionId: imageConnection.id, modelId: 'libtv-fixture-image-v2' },
            video: { connectionId: connections[0]!.id }, audio: { connectionId: connections[0]!.id },
          })
          expect(libtv.runs).toBe(0)
        }
        expect(cli.nodes.size).toBe(0)
        await workbench.getByRole('button', { name: 'New Chat', exact: true }).click()
        const chat = page.locator('[data-convax-chat]')
        await chat.waitFor()
        await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
        const chatId = await chat.getAttribute('data-convax-chat')
        const input = chat.locator('[data-composer-input][contenteditable="true"]').filter({ visible: true })
        await input.waitFor({ timeout: 15_000 })
        await writeComposerDraft(page, input, 'FIXTURE: create a poster, a five-second video and a spoken narration with the connected workbench.')
        await chat.getByRole('button', { name: 'Send message', exact: true }).click()
        await expect.poll(async () => (await scaffold.ctx.convaxCreation.listPendingApprovals(ref)).map(item => item.kind).sort(),
          { timeout: 30_000 }).toEqual([...jimengKinds].sort())
        await expect.poll(() => document().nodes.filter(node => node.typeId === 'convax.file').length, { timeout: 15_000 })
          .toBe(mixedProviders ? 1 : 0)
        expect([...cli.nodes.values()].map(node => node.runs)).toEqual(jimengKinds.map(() => 0))
        expect(cli.commands.filter(args => args[0] === 'node' && args[1] === 'confirm')).toHaveLength(0)
        await workbench.getByRole('button', { name: /^Tasks(?: \(\d+\))?$/ }).click()
        const tasks = page.getByRole('dialog', { name: 'Creation tasks', exact: true })
        await tasks.getByText(`Up to ${mixedProviders ? 9 : 12} credits in total`, { exact: true }).waitFor()
        await expect.poll(() => tasks.locator('[data-creation-job]').count()).toBe(3)
        for (const kind of mediaKinds) expect(await tasks.getByText(fixturePrompts[kind], { exact: true }).count()).toBe(1)
        expect(await tasks.getByRole('button', { name: 'Save changes', exact: true }).count()).toBe(0)
        await tasks.getByRole('button', { name: 'Confirm batch and generate', exact: true }).click()
        await expect.poll(() => [...cli.nodes.values()].map(node => node.runs)).toEqual(jimengKinds.map(() => 1))
        await expect.poll(() => tasks.getByText('Generating', { exact: true }).count(), { timeout: 15_000 }).toBe(jimengKinds.length)
        expect(await tasks.locator('[data-creation-job]').count()).toBe(3)
        expect(document().nodes.filter(node => node.typeId === 'convax.file')).toHaveLength(mixedProviders ? 1 : 0)
        await tasks.getByRole('button', { name: 'Close', exact: true }).last().click()
        await tasks.waitFor({ state: 'detached' })
        await workbench.getByRole('button', { name: /^Tasks(?: \(\d+\))?$/ }).click()
        await expect.poll(() => tasks.getByText('Generating', { exact: true }).count(), { timeout: 15_000 }).toBe(jimengKinds.length)
        cli.complete = true
        await expect.poll(() => document().nodes.filter(node => node.typeId === 'convax.file').length, { timeout: 30_000 }).toBe(3)
        await expect.poll(() => tasks.getByText('Completed', { exact: true }).count(), { timeout: 15_000 }).toBe(3)
        expect(await tasks.locator('[data-creation-job]').count()).toBe(3)
        await expect.poll(() => scaffold.ctx.convaxCreation.listPendingApprovals(ref)).toEqual([])
        await tasks.getByRole('button', { name: 'Close', exact: true }).last().click()
        await tasks.waitFor({ state: 'detached' })
        const files = document().nodes.filter(node => node.typeId === 'convax.file').map((node) => {
          const path = node.data.path
          if (typeof path !== 'string') throw new Error('Delivered file node must contain a string path')
          return { ...node, path }
        })
        expect(files.map(node => node.path.split('.').at(-1)).sort()).toEqual(['mp4', 'png', 'wav'])
        const separatedFiles = async (): Promise<boolean> => {
          const boxes = await Promise.all(files.map(file => page.locator(`[data-convax-resource="${file.id}"]`).boundingBox()))
          return boxes.every((box, index) => box !== null && boxes.slice(index + 1).every(other => other !== null
            && (box.x + box.width < other.x || other.x + other.width < box.x
              || box.y + box.height < other.y || other.y + other.height < box.y)))
        }
        await expect.poll(separatedFiles).toBe(true)
        for (const file of files) {
          expect(document().connections).toEqual(expect.arrayContaining([
            expect.objectContaining({ source: chatId, target: file.id, purpose: 'delivery' }),
          ]))
        }
        expect([...cli.nodes.values()].map(node => node.runs)).toEqual(jimengKinds.map(() => 1))
        expect(cli.commands.filter(args => args[0] === 'node' && args[1] === 'create')).toHaveLength(jimengKinds.length)
        expect(cli.commands.filter(args => args[0] === 'resource' && args[1] === 'download')).toHaveLength(jimengKinds.length)
        expect(libtv.runs).toBe(mixedProviders ? 1 : 0)
        expect(libtv.commands.filter(args => args[0] === 'download')).toHaveLength(mixedProviders ? 1 : 0)
        const video = cli.commands.find(args => args[0] === 'node' && args[1] === 'create' && args[2] === 'video')!
        expect(video[video.indexOf('--duration') + 1]).toBe('5')
        const audio = cli.commands.find(args => args[0] === 'node' && args[1] === 'create' && args[2] === 'audio')!
        expect(audio[audio.indexOf('--voice-id') + 1]).toBe('12345')
        expect(audio[audio.indexOf('--scenario') + 1]).toBe('text-reading')
        const binding = scaffold.ctx.convax.workspace().chats.find(value => value.nodeId === chatId)!
        const sessionId = binding.threads[0]!.sessionId
        await expect.poll(async () => (await readPersistedEvents(scaffold, sessionId)).filter(event => event.type === 'deliverables/presented').length,
          { timeout: 15_000 }).toBe(3)
        const events = await readPersistedEvents(scaffold, sessionId)
        expect(events.flatMap(event => event.type === 'tool/call' ? [event.data.name] : []))
          .toEqual(['creation_describe', 'creation_generate', 'creation_generate', 'creation_generate'])
        await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
        for (const file of files) {
          const card = page.locator(`.react-flow__node[data-id="${file.id}"]`)
          await card.waitFor()
          const extension = file.path.split('.').at(-1)
          const media = card.locator(extension === 'png' ? 'img' : extension === 'mp4' ? 'video' : 'audio')
          await media.waitFor({ state: 'attached' })
          await expect.poll(() => media.evaluate(element => element instanceof HTMLImageElement
            ? element.complete && element.naturalWidth > 0
            : element instanceof HTMLMediaElement && element.readyState >= 1 && element.duration > 0 && element.error === null),
          { timeout: 15_000 }).toBe(true)
        }
        await expect.poll(separatedFiles).toBe(true)
        await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
        await mkdir(ARTIFACTS, { recursive: true })
        await page.screenshot({ path: join(ARTIFACTS, mixedProviders ? 'mixed-providers-fixture.png' : 'jimeng-three-media-fixture.png') })
        await page.reload()
        await page.locator(`[data-convax-creation="${workbenchId}"]`).waitFor({ timeout: 30_000 })
        await workbench.getByRole('button', { name: mixedProviders ? 'Image model: LibTV fixture image two'
          : 'Image model: Fixture image model two', exact: true }).waitFor()
        await workbench.getByRole('button', { name: /^Tasks(?: \(\d+\))?$/ }).click()
        await expect.poll(() => tasks.getByText('Completed', { exact: true }).count(), { timeout: 15_000 }).toBe(3)
        expect(document().nodes.filter(node => node.typeId === 'convax.file')).toHaveLength(3)
        expect([...cli.nodes.values()].map(node => node.runs)).toEqual(jimengKinds.map(() => 1))
        expect(libtv.runs).toBe(mixedProviders ? 1 : 0)
        expect(console.pageErrors).toEqual([])
      } catch (error) {
        await saveFailureShot(page, 'jimeng-three-media-fixture')
        await mkdir(ARTIFACTS, { recursive: true })
        await writeFile(join(ARTIFACTS, 'jimeng-three-media-fixture-failure.json'), JSON.stringify({
          aria: await page.locator('body').ariaSnapshot(), commands: cli.commands, libtvCommands: libtv.commands,
          mixedProviders, pageErrors: console.pageErrors,
        }, null, 2))
        throw error
      } finally { await page.close() }
    } finally { await browser.close() }
  } finally {
    try { await closeScaffold() }
    finally { spawnSpy.mockRestore(); resolveSpy.mockRestore() }
  }
})

// Jimeng publishes these native targets; unsupported targets keep the manual installation guidance.
const jimengTarget = ['darwin', 'linux'].includes(process.platform) && ['arm64', 'x64'].includes(process.arch)
  ? `${process.platform}_${process.arch === 'x64' ? 'amd64' : 'arm64'}`
  : process.platform === 'win32' && process.arch === 'x64' ? 'windows_amd64.exe' : undefined

it.skipIf(jimengTarget === undefined)('installs and authorizes Jimeng before connecting its model with an automatically managed canvas', async () => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: join(BUNDLE, 'cordis.patch.yml'), extraInstallAnchors: [join(BUNDLE, 'package.json')],
  })
  const filename = process.platform === 'win32' ? 'dreamina-canvas.exe' : 'dreamina-canvas'
  const managedExecutable = join(scaffold.harnessHome, 'creation', 'cli', 'jimeng-cli', '1_0_0_60', filename)
  const downloadUrl = `https://jimeng.jianying.com/canvas-cli/install/1_0_0_60/dreamina-canvas_${jimengTarget}`
  const cdnUrl = `https://lf3-lv-buz.vlabstatic.com/obj/image-lvweb-buz/videocut/aigc/dreamina_canvas_cli/1_0_0_60/dreamina-canvas_${jimengTarget}`
  // Native header validation stays real, but these inert bytes are never executed.
  const binary = Buffer.alloc(64)
  binary.set(process.platform === 'darwin' ? [0xcf, 0xfa, 0xed, 0xfe]
    : process.platform === 'win32' ? [0x4d, 0x5a] : [0x7f, 0x45, 0x4c, 0x46])
  const downloads: ReadableStreamDefaultController<Uint8Array>[] = []
  const unexpectedDownloads: string[] = []
  const commands: string[][] = []
  let redirects = 0
  let loggedIn = false
  const authorizationApproved = join(scaffold.harnessHome, 'fixture-authorization-approved')
  const deviceCode = 'fixture-private-device-code'
  const verificationUrl = 'https://jimeng.jianying.com/ai-tool/cli-auth?agent_role=convax&cli_name=dreamina&verification_uri='
    + encodeURIComponent('https://jimeng.jianying.com/passport/open/scan_user_code/?user_code=FIXTURE-CODE')
  let createdCanvas: string | undefined
  const nativeFetch = globalThis.fetch
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url === downloadUrl) {
      redirects += 1
      return Promise.resolve(new Response(null, { status: 302, headers: { location: cdnUrl } }))
    }
    if (url === cdnUrl) {
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) { downloads.push(controller); controller.enqueue(binary.subarray(0, 8)) },
      }), { headers: { 'content-type': 'application/octet-stream', 'content-length': String(binary.byteLength) } }))
    }
    if (url.startsWith('https://jimeng.jianying.com/canvas-cli/') || url.startsWith('https://lf3-lv-buz.vlabstatic.com/')) {
      unexpectedDownloads.push(url)
      return Promise.reject(new Error('Unexpected official CLI request in the isolated browser fixture'))
    }
    return nativeFetch(input, init)
  })
  const subprocess = scaffold.ctx.subprocess
  const resolveExecutable = subprocess.resolveExecutable.bind(subprocess)
  const resolveSpy = vi.spyOn(subprocess, 'resolveExecutable').mockImplementation((command, env, signal) => {
    // Never discover or execute a developer's installed CLI or read its local account.
    if (command === 'dreamina-canvas' || command === 'dreamina-canvas.exe') {
      return Promise.reject(new SubprocessExecutableNotFoundError('Jimeng fixture has no CLI on PATH'))
    }
    return resolveExecutable(command, env, signal)
  })
  const spawn = subprocess.spawn.bind(subprocess)
  const spawnSpy = vi.spyOn(subprocess, 'spawn').mockImplementation((spec) => {
    if (basename(spec.argv[0]!) !== filename) return spawn(spec)
    if (!isAbsolute(spec.argv[0]!) || !spec.argv[0]!.startsWith(join(scaffold.harnessHome, 'creation', 'cli'))) {
      throw new Error('The fixture must use only its isolated app-managed CLI')
    }
    const args = spec.argv.slice(1)
    commands.push(args.map((arg, index) => args[index - 1] === '--device-code' ? '[private]' : arg))
    let result: unknown
    let gate: string | undefined
    if (args.join(' ') === '--format json version') result = { version: '1_0_0_60' }
    else if (args[0] === 'auth' && args[1] === 'status') result = { data: { loggedIn } }
    else if (args[0] === 'auth' && args[1] === 'login') result = { data: { status: 'authorization_required', challenge: {
      deviceCode, userCode: 'FIXTURE-CODE', verificationUri: verificationUrl, verificationUriComplete: verificationUrl,
      pollSeconds: 1, expiresAt: new Date(Date.now() + 120_000).toISOString(),
    } } }
    else if (args[0] === 'auth' && args[1] === 'wait') {
      expect(args[args.indexOf('--device-code') + 1]).toBe(deviceCode)
      gate = authorizationApproved
      result = { data: { status: 'logged_in' } }
    } else if (args[0] === 'model' && args[1] === 'list') result = { data: { items: args[args.indexOf('--type') + 1] === 'image' ? [{
      model: 'jimeng-fixture-image', displayName: 'Seedream fixture display name', modes: [{ name: 't2i', flags: [] }],
    }] : [] } }
    else if (args[0] === 'canvas' && args[1] === 'create') {
      createdCanvas = args[args.indexOf('--project-id') + 1]
      result = { data: { project: { projectId: createdCanvas, name: args[2] } } }
    } else throw new Error(`Unexpected Jimeng command in browser fixture: ${args.slice(0, 2).join(' ')}`)
    // Keep the real subprocess lifetime/output collection; replace only the external binary.
    const source = `const fs = require('node:fs'); const run = () => {
      if (${JSON.stringify(gate ?? null)} && !fs.existsSync(${JSON.stringify(gate ?? '')})) { setTimeout(run, 10); return }
      process.stdout.write(${JSON.stringify(JSON.stringify(result))});
    }; run()`
    return spawn({ ...spec, argv: [process.execPath, '-e', source] })
  })
  try {
    const browser = await chromium.launch()
    try {
      const page = await newEnglishPage(browser)
      await page.context().route('https://jimeng.jianying.com/**', route => route.fulfill({
        contentType: 'text/html', body: '<main>Controlled authorization page. No real account is used.</main>',
      }))
      const console = watchConsole(page)
      try {
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await page.goto(scaffold.authenticatedUrl)
        await page.locator('[data-convax-workspace]').waitFor({ timeout: 30_000 })
        await page.getByRole('button', { name: 'New canvas', exact: true }).first().click()
        await page.locator('[data-convax-creation-dock]').getByRole('button', { name: 'Creation workbench', exact: true }).click()
        const workbench = page.locator('[data-convax-creation]')
        await workbench.waitFor()
        const workbenchId = await workbench.getAttribute('data-convax-creation')
        const document = () => scaffold.ctx.convax.workspace().canvases.find(canvas => canvas.nodes.some(node => node.id === workbenchId))!
        const ref = { canvasId: document().id, nodeId: document().nodes.find(node => node.id === workbenchId)!.id }
        await workbench.getByRole('button', { name: 'Connect services', exact: true }).click()
        const settings = page.getByRole('dialog')
        await settings.getByRole('button', { name: '即梦 CLI', exact: true }).click()
        const install = settings.getByRole('button', { name: 'Install 即梦 CLI', exact: true })
        await install.waitFor()
        expect(downloads).toHaveLength(0)
        expect(await settings.getByLabel('图片模型', { exact: true }).count()).toBe(0)
        await install.click()
        const progress = settings.getByRole('progressbar', { name: 'Downloading the official CLI', exact: true })
        await expect.poll(() => progress.getAttribute('value')).toBe('8')
        expect(await progress.getAttribute('max')).toBe(String(binary.byteLength))
        downloads[0]!.error(new Error('Fixture download interrupted'))
        const retry = settings.getByRole('button', { name: 'Retry installing 即梦 CLI', exact: true })
        await retry.waitFor()
        expect(existsSync(managedExecutable)).toBe(false)
        expect(await scaffold.ctx.convaxCreation.listConnections(ref)).toEqual([])
        await retry.click()
        await expect.poll(() => downloads.length).toBe(2)
        await expect.poll(() => progress.getAttribute('value')).toBe('8')
        await settings.getByRole('button', { name: 'Close', exact: true }).filter({ hasText: /^Close$/ }).click()
        await settings.waitFor({ state: 'detached' })
        await workbench.getByRole('button', { name: 'Connect services', exact: true }).click()
        await expect.poll(() => progress.getAttribute('value')).toBe('8')
        expect(downloads).toHaveLength(2)
        expect(redirects).toBe(2)
        downloads[1]!.enqueue(binary.subarray(8)); downloads[1]!.close()
        const authorize = settings.getByRole('button', { name: 'Go to 即梦 CLI authorization', exact: true })
        await authorize.waitFor()
        await expect.poll(() => settings.textContent()).toContain('Authorize your local account to continue.')
        expect(await readFile(managedExecutable)).toEqual(binary)
        expect(await settings.getByText('CLI ready · using the local account', { exact: true }).count()).toBe(0)
        expect(await settings.getByRole('button', { name: 'Connect and apply', exact: true }).count()).toBe(0)
        expect(await scaffold.ctx.convaxCreation.listConnections(ref)).toEqual([])
        expect(document().nodes.find(node => node.id === workbenchId)!.data.routes).toEqual({})
        expect(commands.filter(args => args[0] === 'auth' && args[1] === 'login')).toHaveLength(0)
        const authorizationPage = page.context().waitForEvent('page')
        await authorize.click()
        const popup = await authorizationPage
        await popup.waitForLoadState('domcontentloaded')
        expect(new URL(popup.url()).pathname).toBe('/ai-tool/cli-auth')
        await popup.close()
        await settings.getByText('Complete authorization in your browser. This window updates automatically.', { exact: true }).waitFor()
        expect(await settings.textContent()).not.toContain(deviceCode)
        await mkdir(ARTIFACTS, { recursive: true })
        await settings.screenshot({ path: join(ARTIFACTS, 'jimeng-authorization.png') })
        await settings.getByRole('button', { name: 'Close', exact: true }).filter({ hasText: /^Close$/ }).click()
        await settings.waitFor({ state: 'detached' })
        await workbench.getByRole('button', { name: 'Connect services', exact: true }).click()
        await settings.getByText('Complete authorization in your browser. This window updates automatically.', { exact: true }).waitFor()
        expect(commands.filter(args => args[0] === 'auth' && args[1] === 'login')).toHaveLength(1)
        expect(commands.filter(args => args[0] === 'auth' && args[1] === 'wait')).toHaveLength(1)
        loggedIn = true
        await writeFile(authorizationApproved, '')
        await settings.getByText('CLI ready · using the local account', { exact: true }).waitFor()
        // Checking the account must not become a submit action when the footer re-renders.
        expect(await settings.locator('input:user-invalid').count()).toBe(0)
        const model = settings.getByRole('combobox', { name: 'Image model', exact: true })
        await model.selectOption({ label: 'Seedream fixture display name' })
        expect(await model.inputValue()).toBe('jimeng-fixture-image')
        expect(await settings.getByRole('combobox', { name: 'Creation canvas', exact: true }).count()).toBe(0)
        expect(await settings.getByLabel('Canvas name', { exact: true }).count()).toBe(0)
        expect(createdCanvas).toBeUndefined()
        const optionalCeiling = settings.getByLabel('自动批准积分上限', { exact: true })
        expect(await optionalCeiling.isVisible()).toBe(false)
        expect(await optionalCeiling.getAttribute('required')).toBeNull()
        await settings.screenshot({ path: join(ARTIFACTS, 'jimeng-canvas-model.png') })
        expect(await settings.getByRole('button', { name: 'Connect and apply', exact: true }).count()).toBe(1)
        await settings.getByRole('button', { name: 'Connect and apply', exact: true }).click()
        await settings.waitFor({ state: 'detached' })
        const saved = await scaffold.ctx.convaxCreation.listConnections(ref)
        expect(saved).toHaveLength(1)
        expect(createdCanvas).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/)
        expect(saved[0]!.settings).toMatchObject({ projectId: createdCanvas, imageModel: 'jimeng-fixture-image' })
        expect(saved[0]!.settings.creditCeiling).toBeUndefined()
        expect(downloads).toHaveLength(2)
        expect(unexpectedDownloads).toEqual([])
        expect(commands.filter(args => args[0] === 'canvas' && args[1] === 'create')).toHaveLength(1)
        expect(commands.filter(args => args[0] === 'canvas' && args[1] === 'ls')).toHaveLength(0)
        expect(commands.some(args => args.includes('--use') || args.includes('--force') || args.includes('logout'))).toBe(false)
        expect(console.pageErrors).toEqual([])
      } catch (error) {
        await saveFailureShot(page, 'convax-creation-installation')
        await mkdir(ARTIFACTS, { recursive: true })
        await writeFile(join(ARTIFACTS, 'installation-failure.json'), JSON.stringify({
          aria: await page.getByRole('dialog').ariaSnapshot(), commands, downloads: downloads.length, pageErrors: console.pageErrors,
        }, null, 2))
        throw error
      } finally { await page.close() }
    } finally { await browser.close() }
  } finally {
    for (const controller of downloads) {
      try { controller.error(new Error('Browser installation fixture disposed')) } catch { /* Already settled. */ }
    }
    try { await scaffold.close() }
    finally { spawnSpy.mockRestore(); resolveSpy.mockRestore(); fetchSpy.mockRestore() }
  }
})
