import { randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdtemp, realpath, rm } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import type { ConnectionInspection, ConnectionSnapshot, CreationProvider, GenerationCapability, JsonObject, MediaKind, ProviderCheckpoint, ProviderDescriptor, ProviderId, ProviderOutput, ProviderPreparation, ProviderRequest, ProviderRuntime, ProviderSnapshot } from '../types.ts'
import { CliRunner, failed, objectSchema, preparationFailure, preparationUnavailable, record, scalarString, setting, string, unavailable, unknownSubmission, type ProviderDependencies } from './common.ts'

function modelCapability(kind: MediaKind, modelId: string, modelLabel: string, schema: Record<string, unknown>): GenerationCapability {
  const source = record(schema.properties)
  const properties: JsonObject = {}
  let maxReferences = 0
  const inputKinds = new Set<MediaKind>()
  for (const [key, raw] of Object.entries(source)) {
    if (!/^[A-Za-z][\w-]*$/.test(key) || ['prompt', 'model'].includes(key)) continue
    if (key === 'count') {
      const counts = Array.isArray(raw) ? raw : record(raw).enum
      if (Array.isArray(counts) && !counts.includes(1)) throw new Error('This LibTV model only produces batches; select a single-output model')
      properties.count = { type: 'integer', const: 1 }
      continue
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const property = record(raw)
    if (key === 'modeType') {
      const modes = record(property.items)
      properties.modeType = { type: 'string', enum: Object.keys(modes) }
      for (const [mode, counts] of Object.entries(modes)) {
        if (Array.isArray(counts) && typeof counts[1] === 'number') maxReferences = Math.max(maxReferences, counts[1])
        if (/image|Image|frames|mixed/.test(mode)) inputKinds.add('image')
        if (/^video|mixed/.test(mode)) inputKinds.add('video')
        if (/^audio|mixed/.test(mode)) inputKinds.add('audio')
      }
      continue
    }
    const values = Array.isArray(property.enum) ? (property.enum as unknown[]).map(value =>
      typeof value === 'object' ? record(value).value : value).filter(value => ['string', 'number', 'boolean'].includes(typeof value)) : undefined
    if (values?.length) properties[key] = { enum: values as (string | number | boolean)[] }
    else if (typeof property.min === 'number' || typeof property.max === 'number' || typeof property.default === 'number') {
      properties[key] = { type: 'number', ...(typeof property.min === 'number' ? { minimum: property.min } : {}), ...(typeof property.max === 'number' ? { maximum: property.max } : {}) }
    } else if (property.component === 'input' || typeof property.default === 'string') {
      properties[key] = { type: 'string', ...(typeof property.maxLength === 'number' ? { maxLength: property.maxLength } : {}) }
    } else if (typeof property.default === 'boolean') properties[key] = { type: 'boolean' }
  }
  return { kind, modelId, modelLabel, parameterSchema: objectSchema(properties), maxOutputs: 1,
    inputs: maxReferences && inputKinds.size ? [{ role: 'reference', kinds: [...inputKinds], minItems: 0, maxItems: maxReferences }] : [] }
}

/** Official LibTV CLI: each operation owns a fresh node and runs it at most once. */
export class LibTVProvider implements CreationProvider {
  readonly checkpointVersion = 1
  readonly descriptor: ProviderDescriptor = {
    id: 'libtv-cli' as ProviderId, title: 'LibTV CLI', usesApiKey: true, credentialOptional: true,
    connectionKind: 'cli', supportedKinds: ['image', 'video', 'audio'],
    configuration: [
      { key: 'executable', label: 'CLI 可执行文件', type: 'text', placeholder: 'libtv', advanced: true, affectsSetup: true },
      { key: 'cwd', label: '工作目录', type: 'text', advanced: true, affectsSetup: true },
      { key: 'projectUuid', label: 'LibTV 画布 UUID', type: 'text', required: true },
      { key: 'watermark', label: '下载带社区水印（非会员）', type: 'boolean', required: true, default: true },
      { key: 'imageModel', label: '图片模型', type: 'text', mediaKind: 'image' },
      { key: 'videoModel', label: '视频模型', type: 'text', mediaKind: 'video' },
      { key: 'audioModel', label: '音频模型', type: 'text', mediaKind: 'audio' },
    ],
  }
  private readonly cli: CliRunner

  constructor(deps: ProviderDependencies) { this.cli = new CliRunner(deps, 'libtv', 'LIBTV_TOKEN') }

  private project(connection: ConnectionSnapshot): string {
    if (typeof connection.settings.watermark !== 'boolean') throw new Error('Set the LibTV download watermark option for your membership')
    return setting(connection, 'projectUuid')
  }

  private async models(connection: ConnectionSnapshot, kind: MediaKind, signal: AbortSignal, apiKey?: string) {
    const result = await this.cli.run(connection, ['model', 'search', '--type', kind], signal, apiKey)
    if (result.exitCode !== 0 || !result.json || !Array.isArray(result.json.matches)) {
      throw new TypeError('LibTV model catalog unavailable')
    }
    return result.json.matches.map((value) => {
      const item = record(value)
      return { id: string(item.modelKey, 'model key').trim(), label: string(item.modelName, 'model name').trim(), kind }
    })
  }

  private async selectedModel(connection: ConnectionSnapshot, kind: MediaKind, modelId: string, signal: AbortSignal) {
    const models = await this.models(connection, kind, signal)
    const matches = models.filter(model => model.id === modelId || model.label === modelId)
    const model = matches[0]
    if (model === undefined || matches.some(value => value.id !== model.id)) throw new Error('The configured LibTV model is unavailable or ambiguous')
    // Node creation accepts names only and resolves its first match, so a shared display name cannot identify a model safely.
    if (models.some(value => value.label === model.label && value.id !== model.id)) throw new Error('The selected LibTV model name matches multiple models')
    return model
  }

  /** Reuse local login and query model catalogs without creating or binding a LibTV node. */
  async prepare(connection: ConnectionSnapshot, signal: AbortSignal, apiKey?: string): Promise<ProviderPreparation> {
    try {
      const status = await this.cli.run(connection, ['status'], signal, apiKey)
      if (status.exitCode !== 0 || !status.json || record(status.json.auth).loggedIn !== true) {
        return preparationUnavailable('Log in to LibTV CLI or configure its token.', 'not-authorized')
      }
      if (status.json.binding && record(status.json.binding).groupNodeKey) {
        return preparationUnavailable('Choose a CLI working directory without an active LibTV group binding.')
      }
      const catalogs = await Promise.all((['image', 'video', 'audio'] as const).map(kind => this.models(connection, kind, signal, apiKey)))
      return { state: 'ready', models: catalogs.flat() }
    } catch (error) { return preparationFailure(error, signal, 'LibTV') }
  }

  async describe(connection: ConnectionSnapshot, signal: AbortSignal): Promise<ConnectionInspection> {
    try {
      this.project(connection)
      const status = await this.cli.run(connection, ['status'], signal)
      if (status.exitCode !== 0 || !status.json || record(status.json.auth).loggedIn !== true) return unavailable('Log in to LibTV CLI or configure its token.', 'not-authorized')
      if (status.json.binding && record(status.json.binding).groupNodeKey) return unavailable('Choose a CLI working directory without an active LibTV group binding.')
      const capabilities: GenerationCapability[] = []
      for (const kind of ['image', 'video', 'audio'] as const) {
        if (!connection.settings[`${kind}Model`]) continue
        const modelId = setting(connection, `${kind}Model`)
        const model = await this.selectedModel(connection, kind, modelId, signal)
        const result = await this.cli.run(connection, ['model', modelId], signal)
        if (result.exitCode !== 0 || !result.json?.schema) return unavailable(`Cannot inspect the configured LibTV ${kind} model.`)
        capabilities.push(modelCapability(kind, modelId, model.label, record(result.json.schema)))
      }
      if (!capabilities.length) return unavailable('Configure at least one LibTV model.')
      return { state: 'ready', capabilities, submissionRecovery: 'recoverable-resource', cancellation: 'unsupported' }
    } catch (error) {
      signal.throwIfAborted()
      return unavailable((error as Error).message, (error as Error).name === 'SubprocessExecutableNotFoundError' ? 'not-installed' : 'invalid-configuration')
    }
  }

  async submit(request: ProviderRequest, runtime: ProviderRuntime): Promise<ProviderSnapshot> {
    const projectUuid = this.project(runtime.connection)
    const model = await this.selectedModel(runtime.connection, request.kind,
      request.modelId ?? setting(runtime.connection, `${request.kind}Model`), runtime.signal)
    const nodeName = `Convax-${randomUUID()}`
    const args = ['node', 'create', nodeName, '-p', projectUuid, '-t', request.kind, '--prompt', request.prompt, '-s', `model=${model.label}`]
    if (request.kind === 'image' && request.parameters.count === undefined) args.push('-s', 'count=1')
    for (const [name, value] of Object.entries(request.parameters)) {
      if (!/^[A-Za-z][\w-]*$/.test(name) || ['model', 'prompt'].includes(name) || !['string', 'number', 'boolean'].includes(typeof value)) throw new Error('Invalid LibTV generation parameter')
      if (name === 'count' && value !== 1) throw new Error('LibTV currently imports one output per generation')
      args.push('-s', `${name}=${scalarString(value)}`)
    }
    for (const reference of request.references) {
      if (reference.role !== 'reference') throw new Error('LibTV inputs use the reference role')
      const uploaded = await this.cli.run(runtime.connection, ['upload', `Convax-ref-${randomUUID()}`, '-p', projectUuid, '--file', reference.path, '-t', reference.kind], runtime.signal)
      if (uploaded.exitCode !== 0 || !uploaded.json) throw new Error('LibTV reference upload failed before generation')
      args.push('--left', string(uploaded.json.nodeKey, 'uploaded node key'))
    }
    await runtime.checkpoint({ version: 1, data: { projectUuid, nodeName, phase: 'creating' } })
    const created = await this.cli.run(runtime.connection, args, runtime.signal)
    if (created.exitCode !== 0 || !created.json) return failed('LibTV could not create the generation node.', 'libtv-node-create-failed', 'submission')
    const nodeKey = string(created.json.nodeKey, 'LibTV node key')
    const checkpoint: ProviderCheckpoint = { version: 1, data: { projectUuid, nodeKey, phase: 'dispatching' } }
    await runtime.checkpoint(checkpoint)
    try {
      const result = await this.cli.run(runtime.connection, ['node', nodeKey, '-p', projectUuid, '--run'], runtime.signal)
      if (result.json?.status === 3 || result.json?.status === 4) return failed(`LibTV generation ${result.json.status === 4 ? 'timed out' : 'failed'}.`, 'libtv-generation-failed')
      if (result.exitCode === 0 && result.json?.status === 2) return { state: 'completed', outputs: [this.output(request.kind, projectUuid, nodeKey)] }
      return await this.reconcile(request, checkpoint, runtime)
    } catch { return unknownSubmission() }
  }

  private output(kind: MediaKind, projectUuid: string, nodeKey: string): ProviderOutput {
    return { outputId: nodeKey, kind, locator: { projectUuid, nodeKey } }
  }

  async reconcile(
    request: ProviderRequest, checkpoint: ProviderCheckpoint | undefined, runtime: ProviderRuntime,
  ): Promise<ProviderSnapshot> {
    if (!checkpoint?.data.nodeKey) return unknownSubmission()
    const projectUuid = string(checkpoint.data.projectUuid, 'project UUID')
    const nodeKey = string(checkpoint.data.nodeKey, 'node key')
    const result = await this.cli.run(runtime.connection, ['node', nodeKey, '-p', projectUuid], runtime.signal)
    if (result.exitCode !== 0 || !result.json) return unknownSubmission()
    const data = result.json.data ? record(result.json.data) : result.json
    if (Array.isArray(data.url) && data.url.length) {
      if (data.url.length !== 1) return failed('LibTV returned a batch; only single-output nodes can be imported.', 'unsupported-output-batch')
      return { state: 'completed', outputs: [this.output(request.kind, projectUuid, nodeKey)] }
    }
    // LibTV writeback depends on its original --run process; an interrupted run cannot safely be replayed.
    return unknownSubmission()
  }

  async collect(output: ProviderOutput, destination: { path: string }, runtime: ProviderRuntime): Promise<void> {
    const directory = await mkdtemp(join(dirname(destination.path), 'libtv-download-'))
    try {
      const result = await this.cli.run(runtime.connection, ['download', '-n', string(output.locator.nodeKey, 'node key'), '-p', string(output.locator.projectUuid, 'project UUID'), '--watermark', scalarString(runtime.connection.settings.watermark), '-o', directory], runtime.signal)
      if (result.exitCode !== 0) throw new Error('LibTV download failed; verify membership and watermark configuration')
      const paths = result.stdout.trim().split(/\r?\n/)
      if (paths.length !== 1 || !paths[0]) throw new Error('LibTV returned an unsupported download batch')
      const source = await realpath(paths[0])
      const inside = relative(await realpath(directory), source)
      const info = await lstat(source)
      if (inside.startsWith('..') || !info.isFile() || info.size > runtime.maxBytes || source.endsWith('.zip')) throw new Error('LibTV returned an invalid media download')
      await copyFile(source, destination.path)
    } finally { await rm(directory, { recursive: true, force: true }) }
  }

  cancel(): Promise<{ state: 'unsupported' }> { return Promise.resolve({ state: 'unsupported' }) }
}
