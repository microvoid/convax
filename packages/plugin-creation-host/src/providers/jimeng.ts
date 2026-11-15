import { randomBytes, randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import type { ConnectionInspection, ConnectionSnapshot, CreationProvider, GenerationCapability, MediaKind, ProviderCheckpoint, ProviderDescriptor, ProviderId, ProviderOutput, ProviderPreparation, ProviderRequest, ProviderRuntime, ProviderSnapshot } from '../types.ts'
import { CliRunner, preparationFailure, preparationUnavailable, record, scalarString, setting, string, unavailable, unknownSubmission, type ProviderDependencies } from './common.ts'
import { JimengGeneration } from './jimeng-generation.ts'
import { JIMENG_FLAGS, jimengCapability, validateJimengRequest, type JimengVoice } from './jimeng-capabilities.ts'
import { verifyJimengDownload } from './jimeng-download.ts'

const MEDIA_KINDS = ['image', 'video', 'audio'] as const

/** Adapter for the official dreamina-canvas CLI JSON schema v2. */
export class JimengProvider implements CreationProvider {
  readonly checkpointVersion = 1
  readonly descriptor: ProviderDescriptor = {
    id: 'jimeng-cli' as ProviderId, title: '即梦 CLI', connectionKind: 'cli', supportedKinds: MEDIA_KINDS,
    configuration: [
      { key: 'executable', label: 'CLI 可执行文件', type: 'text', placeholder: 'dreamina-canvas', advanced: true, affectsSetup: true },
      { key: 'cwd', label: '工作目录', type: 'text', advanced: true, affectsSetup: true },
      { key: 'profile', label: '登录配置', type: 'text', placeholder: 'default', advanced: true, affectsSetup: true },
      { key: 'projectId', label: '即梦项目 ID', type: 'text', managed: true },
      { key: 'creditCeiling', label: '自动批准积分上限', type: 'number', advanced: true },
      { key: 'imageModel', label: '图片模型', type: 'text', mediaKind: 'image' },
      { key: 'videoModel', label: '视频模型', type: 'text', mediaKind: 'video' },
      { key: 'audioModel', label: '音频模型', type: 'text', mediaKind: 'audio' },
    ],
  }
  private readonly cli: CliRunner
  private readonly generation: JimengGeneration

  constructor(deps: ProviderDependencies) {
    this.cli = new CliRunner(deps, 'dreamina-canvas')
    this.generation = new JimengGeneration((connection, args, signal) => this.command(connection, args, signal))
  }

  private async command(connection: ConnectionSnapshot, args: readonly string[], signal: AbortSignal) {
    return this.cli.run(connection, [...args, '--format', 'json', '--non-interactive', '--profile', setting(connection, 'profile', 'default')], signal)
  }

  private project(connection: ConnectionSnapshot): string {
    const project = setting(connection, 'projectId')
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(project)) throw new Error('Jimeng projectId must be a UUID')
    const ceiling = connection.settings.creditCeiling
    if (ceiling !== undefined && (typeof ceiling !== 'number' || !Number.isSafeInteger(ceiling) || ceiling < 0)) throw new Error('Set a nonnegative automatic credit ceiling, or leave it empty to approve each quote')
    return project
  }

  private async models(connection: ConnectionSnapshot, kind: MediaKind, signal: AbortSignal): Promise<Record<string, unknown>[]> {
    const result = await this.command(connection, ['model', 'list', '--type', kind], signal)
    if (result.exitCode !== 0 || result.json?.ok === false || !result.json) throw new Error(`Jimeng ${kind} model discovery failed`)
    const data = record(result.json.data)
    if (!Array.isArray(data.items)) throw new Error('Jimeng returned an invalid model catalog')
    return data.items.map(record)
  }

  private async voices(connection: ConnectionSnapshot, model: Record<string, unknown>, signal: AbortSignal): Promise<JimengVoice[]> {
    if (!Array.isArray(model.modes) || !model.modes.some(value => record(value).name === 'tts')) return []
    const modelId = string(model.model, 'model ID')
    const voices: JimengVoice[] = []
    let offset = 0
    for (let page = 0; page < 20; page++) {
      const result = await this.command(connection, ['voice', 'list', '--model', modelId, '--count', '100', '--offset', String(offset)], signal)
      if (result.exitCode !== 0 || result.json?.ok === false || !result.json) throw new Error('Jimeng voice discovery failed')
      const catalog = record(record(record(result.json.data).models)[modelId])
      if (!Array.isArray(catalog.items)) throw new Error('Jimeng returned an invalid voice catalog')
      for (const value of catalog.items) {
        const item = record(value)
        const name = string(item.voiceName, 'voice name')
        const id = typeof item.voiceId === 'string' && /^[1-9]\d*$/.test(item.voiceId) ? item.voiceId : undefined
        voices.push({ name, ...(id === undefined ? {} : { id }) })
      }
      if (catalog.hasMore === false) return voices
      if (catalog.hasMore !== true || typeof catalog.nextOffset !== 'number' || !Number.isSafeInteger(catalog.nextOffset)
        || catalog.nextOffset <= offset) throw new Error('Jimeng returned invalid voice pagination')
      offset = catalog.nextOffset
    }
    throw new Error('Jimeng voice catalog exceeds the discovery limit')
  }

  private async selectedModel(connection: ConnectionSnapshot, kind: MediaKind, modelId: string, signal: AbortSignal) {
    const model = (await this.models(connection, kind, signal)).find(item => item.model === modelId)
    if (!model) throw new Error(`The configured ${kind} model is not in the Jimeng catalog`)
    return { model, voices: kind === 'audio' ? await this.voices(connection, model, signal) : [] }
  }

  /** Detect the CLI and list models before project, budget and model choices exist. */
  async prepare(connection: ConnectionSnapshot, signal: AbortSignal): Promise<ProviderPreparation> {
    try {
      const auth = await this.command(connection, ['auth', 'status'], signal)
      if (auth.exitCode !== 0 || !auth.json || record(auth.json.data).loggedIn !== true) {
        return preparationUnavailable('Log in to the configured Jimeng CLI profile.', 'not-authorized')
      }
      const catalogs = await Promise.all(MEDIA_KINDS.map(async kind => ({ kind, items: await this.models(connection, kind, signal) })))
      const models = catalogs.flatMap(({ kind, items }) => items.map(item => ({ id: string(item.model, 'model ID'),
        label: typeof item.displayName === 'string' && item.displayName.trim() ? item.displayName : string(item.model, 'model ID'), kind })))
      return { state: 'ready', models }
    } catch (error) { return preparationFailure(error, signal, 'Jimeng') }
  }

  async describe(connection: ConnectionSnapshot, signal: AbortSignal): Promise<ConnectionInspection> {
    try {
      this.project(connection)
      const auth = await this.command(connection, ['auth', 'status'], signal)
      if (auth.exitCode !== 0 || !auth.json || record(auth.json.data).loggedIn !== true) return unavailable('Log in to the configured Jimeng CLI profile.', 'not-authorized')
      const capabilities: GenerationCapability[] = []
      for (const kind of MEDIA_KINDS) {
        const selected = connection.settings[`${kind}Model`]
        if (selected === undefined || selected === '') continue
        const { model, voices } = await this.selectedModel(connection, kind, string(selected, `${kind} model`), signal)
        capabilities.push(jimengCapability(kind, model, voices))
      }
      if (!capabilities.length) return unavailable('Choose at least one Jimeng image, video or audio model')
      return { state: 'ready', capabilities, submissionRecovery: 'recoverable-resource', cancellation: 'unsupported' }
    } catch (error) {
      signal.throwIfAborted()
      return unavailable((error as Error).message, (error as Error).name === 'SubprocessExecutableNotFoundError' ? 'not-installed' : 'invalid-configuration')
    }
  }

  async submit(request: ProviderRequest, runtime: ProviderRuntime): Promise<ProviderSnapshot> {
    const projectId = this.project(runtime.connection)
    const modelId = request.modelId ?? setting(runtime.connection, `${request.kind}Model`)
    const { model, voices } = await this.selectedModel(runtime.connection, request.kind, modelId, runtime.signal)
    validateJimengRequest(request, model, voices)
    const alphabet = '0123456789abcdefghjkmnpqrstvwxyz'
    const nodeId = `node_${[...randomBytes(10)].map(byte => alphabet[byte & 31]).join('')}`
    const submitId = randomUUID()
    const args = ['node', 'create', request.kind, '--project-id', projectId, '--node-id', nodeId,
      '--title', `Convax ${runtime.operationId}`, '--prompt', request.prompt,
      '--model', modelId, '--mode', string(request.parameters.mode, 'mode')]
    for (const name of JIMENG_FLAGS[request.kind]) {
      if (request.parameters[name] !== undefined) args.push(`--${name}`, scalarString(request.parameters[name]))
    }
    for (const reference of request.references) {
      if (reference.role !== 'reference') throw new Error('Jimeng inputs use the reference role')
      const result = await this.command(runtime.connection, ['resource', 'upload', '--file', reference.path, '--type', reference.kind, '--project-id', projectId, '--resource-id', randomUUID(), '--import-kind', 'local_upload'], runtime.signal)
      if (result.exitCode !== 0 || !result.json) throw new Error('Jimeng reference upload failed before generation')
      args.push('--ref', `res:${string(record(result.json.data).resourceId, 'uploaded resource ID')}`)
    }
    const checkpoint: ProviderCheckpoint = { version: 1, data: { projectId, nodeId, submitId, phase: 'saving' } }
    return this.generation.save(args, checkpoint, runtime, request.kind)
  }

  async reconcile(
    request: ProviderRequest, checkpoint: ProviderCheckpoint | undefined, runtime: ProviderRuntime,
  ): Promise<ProviderSnapshot> {
    if (!checkpoint?.data.submitId) return unknownSubmission()
    return this.generation.reconcile(checkpoint, runtime, request.kind)
  }

  /** Continue this saved draft only after the Host has recorded a user-approved ceiling. */
  approve(
    request: ProviderRequest, checkpoint: ProviderCheckpoint, creditCeiling: number, runtime: ProviderRuntime,
  ): Promise<ProviderSnapshot> {
    return this.generation.approve(checkpoint, creditCeiling, runtime, request.kind)
  }

  async collect(output: ProviderOutput, destination: { path: string }, runtime: ProviderRuntime): Promise<void> {
    const metadata = await this.command(runtime.connection, ['resource', 'get', string(output.locator.resourceId, 'resource ID'),
      '--project-id', string(output.locator.projectId, 'project ID')], runtime.signal)
    const resource = metadata.json?.data === undefined ? undefined : record(metadata.json.data)
    if (metadata.exitCode !== 0 || metadata.json?.ok === false || resource === undefined
      || resource.resourceId !== output.locator.resourceId
      || resource.type !== output.kind || resource.status !== 'success') throw new Error('Jimeng resource identity, type or completion could not be verified')
    await rm(destination.path, { force: true })
    const result = await this.command(runtime.connection, ['resource', 'download', string(output.locator.resourceId, 'resource ID'), '--project-id', string(output.locator.projectId, 'project ID'), '--output', destination.path], runtime.signal)
    await verifyJimengDownload(result, output, destination.path, runtime)
  }

  cancel(): Promise<{ state: 'unsupported' }> { return Promise.resolve({ state: 'unsupported' }) }
}
