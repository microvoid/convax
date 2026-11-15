import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { ConnectionInspection, ConnectionSnapshot, CreationProvider, GenerationCapability, MediaKind, ProviderCheckpoint, ProviderDescriptor, ProviderId, ProviderOutput, ProviderPreparation, ProviderRequest, ProviderRuntime, ProviderSnapshot } from '../types.ts'
import { collectLocal, endpoint, failed, jsonResponse, objectSchema, preparationFailure, preparationUnavailable, readReceipt, record, responseBytes, saveBytes, saveReceipt, scalarString, setting, string, unavailable, unknownSubmission, type ProviderDependencies } from './common.ts'

/** OpenAI Images and Speech APIs. The retired Sora API is intentionally not advertised. */
export class OpenAIProvider implements CreationProvider {
  readonly checkpointVersion = 1
  readonly descriptor: ProviderDescriptor = {
    id: 'openai' as ProviderId, title: 'OpenAI · 图片 / 语音', usesApiKey: true, connectionKind: 'api', supportedKinds: ['image', 'audio'],
    configuration: [
      { key: 'baseUrl', label: 'API 地址', type: 'url', placeholder: 'https://api.openai.com/v1', advanced: true, affectsSetup: true },
      { key: 'imageModel', label: '图片模型', type: 'text', mediaKind: 'image' },
      { key: 'audioModel', label: '语音模型', type: 'text', mediaKind: 'audio' },
    ],
  }

  constructor(private readonly deps: ProviderDependencies) {}

  /** List account-visible models compatible with this adapter's Images and Speech endpoints. */
  async prepare(connection: ConnectionSnapshot, signal: AbortSignal, apiKey?: string): Promise<ProviderPreparation> {
    try {
      const key = apiKey ?? await this.deps.readCredential(connection)
      if (!key) return preparationUnavailable('Configure the OpenAI API key.', 'not-authorized')
      const response = await fetch(new URL('models', endpoint(connection, 'https://api.openai.com/v1')),
        { headers: { Authorization: `Bearer ${key}` }, signal })
      if (!response.ok) {
        await response.body?.cancel()
        return preparationUnavailable(`OpenAI model discovery failed (HTTP ${response.status}).`,
          [401, 403].includes(response.status) ? 'not-authorized' : 'unreachable')
      }
      const data = await jsonResponse(response)
      if (!Array.isArray(data.data)) return preparationUnavailable('OpenAI returned an invalid model catalog.', 'unreachable')
      const models = data.data.flatMap((value) => {
        const id = record(value).id
        if (typeof id !== 'string') return []
        const kind: MediaKind | undefined = /^(gpt-image-|chatgpt-image-latest$)/.test(id) ? 'image'
          : /^(gpt-4o-mini-tts|tts-1)(-|$)/.test(id) ? 'audio' : undefined
        return kind === undefined ? [] : [{ id, label: id, kind }]
      })
      return { state: 'ready', models }
    } catch (error) { return preparationFailure(error, signal, 'OpenAI') }
  }

  private capabilities(connection: ConnectionSnapshot): GenerationCapability[] {
    const capabilities: GenerationCapability[] = []
    if (connection.settings.imageModel) capabilities.push({
      kind: 'image', modelId: setting(connection, 'imageModel'), maxOutputs: 4,
      inputs: [{ role: 'reference', kinds: ['image'], minItems: 0, maxItems: 16 }],
      parameterSchema: objectSchema({
        n: { type: 'integer', minimum: 1, maximum: 4 },
        size: { type: 'string', enum: ['auto', '1024x1024', '1536x1024', '1024x1536'] },
        quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high'] },
        background: { type: 'string', enum: ['auto', 'opaque', 'transparent'] },
        output_format: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
      }),
    })
    if (connection.settings.audioModel) capabilities.push({
      kind: 'audio', modelId: setting(connection, 'audioModel'), maxOutputs: 1, inputs: [],
      parameterSchema: objectSchema({
        voice: { type: 'string', minLength: 1 },
        response_format: { type: 'string', enum: ['mp3', 'opus', 'aac', 'flac', 'wav'] },
        speed: { type: 'number', minimum: 0.25, maximum: 4 },
        instructions: { type: 'string' },
      }, ['voice']),
    })
    return capabilities
  }

  async describe(connection: ConnectionSnapshot, signal: AbortSignal): Promise<ConnectionInspection> {
    try {
      const base = endpoint(connection, 'https://api.openai.com/v1')
      const capabilities = this.capabilities(connection)
      if (!capabilities.length) return unavailable('Configure an image or speech model ID.')
      const key = await this.deps.readCredential(connection)
      if (!key) return unavailable('Configure the OpenAI API key.', 'not-authorized')
      for (const capability of capabilities) {
        const modelId = string(capability.modelId, 'model ID')
        const response = await fetch(new URL(`models/${encodeURIComponent(modelId)}`, base), { headers: { Authorization: `Bearer ${key}` }, signal })
        await response.body?.cancel()
        if (response.status === 401 || response.status === 403) return unavailable('The API key cannot access this model.', 'not-authorized')
        if (!response.ok) return unavailable(`Model inspection failed (HTTP ${response.status}).`, response.status === 404 ? 'invalid-configuration' : 'unreachable')
      }
      return { state: 'ready', capabilities, submissionRecovery: 'unsupported', cancellation: 'unsupported' }
    } catch (error) {
      signal.throwIfAborted()
      return unavailable(error instanceof TypeError ? 'Cannot reach the model API.' : (error as Error).message)
    }
  }

  async submit(request: ProviderRequest, runtime: ProviderRuntime): Promise<ProviderSnapshot> {
    const base = endpoint(runtime.connection, 'https://api.openai.com/v1')
    const key = string(await this.deps.readCredential(runtime.connection), 'API key')
    const model = request.modelId ?? setting(runtime.connection, request.kind === 'image' ? 'imageModel' : 'audioModel')
    if (request.kind === 'video') return failed('This provider supports images and speech.', 'unsupported-kind', 'configuration')
    const headers: Record<string, string> = { Authorization: `Bearer ${key}` }
    let body: BodyInit
    let path: string
    if (request.kind === 'image' && request.references.length) {
      const form = new FormData()
      form.set('model', model)
      form.set('prompt', request.prompt)
      for (const [name, value] of Object.entries(request.parameters)) form.set(name, scalarString(value))
      for (const reference of request.references) {
        if (reference.kind !== 'image' || reference.role !== 'reference') throw new Error('Only image references are supported')
        if ((await stat(reference.path)).size > 50 * 1024 * 1024) throw new Error('Image reference exceeds 50 MiB')
        form.append('image[]', new Blob([await readFile(reference.path)], { type: reference.mimeType }), basename(reference.path))
      }
      body = form
      path = 'images/edits'
    } else {
      if (request.references.length) throw new Error('Speech does not accept media references')
      headers['Content-Type'] = 'application/json'
      path = request.kind === 'image' ? 'images/generations' : 'audio/speech'
      body = JSON.stringify({ ...request.parameters, model, [request.kind === 'image' ? 'prompt' : 'input']: request.prompt })
    }
    await runtime.checkpoint({ version: 1, data: { attempted: true } })
    let response: Response
    try {
      response = await fetch(new URL(path, base), { method: 'POST', headers, body, signal: runtime.signal })
    } catch { return unknownSubmission() }
    if (!response.ok) {
      await response.body?.cancel()
      return response.status >= 500 || response.status === 408 ? unknownSubmission() : failed(`Model API rejected the request (HTTP ${response.status}).`, `http-${response.status}`, 'submission')
    }
    try {
      const outputs: ProviderOutput[] = []
      if (request.kind === 'audio') {
        outputs.push(await saveBytes(await responseBytes(response, runtime.maxBytes),
          'audio', 0, string(request.parameters.response_format ?? 'mp3', 'response format'), runtime))
      } else {
        const result = await jsonResponse(response, Math.ceil(runtime.maxBytes * 1.4))
        if (!Array.isArray(result.data) || !result.data.length || result.data.length > 4) throw new Error('Image API returned no usable outputs')
        for (const [index, entry] of result.data.entries()) {
          const image = record(entry)
          if (typeof image.b64_json !== 'string') throw new Error('GPT Image API did not return image bytes')
          outputs.push(await saveBytes(Buffer.from(image.b64_json, 'base64'),
            'image', index, string(request.parameters.output_format ?? 'png', 'output format'), runtime))
        }
      }
      await saveReceipt(outputs, runtime)
      return { state: 'completed', outputs }
    } catch { return unknownSubmission() }
  }

  reconcile(_request: ProviderRequest, _checkpoint: ProviderCheckpoint | undefined, runtime: ProviderRuntime): Promise<ProviderSnapshot> {
    return readReceipt(runtime)
  }

  collect(output: ProviderOutput, destination: { path: string }, runtime: ProviderRuntime): Promise<void> {
    return collectLocal(output, destination, runtime)
  }

  cancel(): Promise<{ state: 'unsupported' }> { return Promise.resolve({ state: 'unsupported' }) }
}
