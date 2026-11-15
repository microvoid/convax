import { readFile, stat } from 'node:fs/promises'
import type { ConnectionInspection, ConnectionSnapshot, CreationProvider, ProviderCheckpoint, ProviderDescriptor, ProviderId, ProviderOutput, ProviderPreparation, ProviderRequest, ProviderRuntime, ProviderSnapshot } from '../types.ts'
import { download, endpoint, failed, jsonResponse, objectSchema, preparationFailure, preparationUnavailable, record, setting, string, unavailable, unknownSubmission, type ProviderDependencies } from './common.ts'

/** Volcengine Ark's documented asynchronous video task API. */
export class ArkProvider implements CreationProvider {
  readonly checkpointVersion = 1
  readonly descriptor: ProviderDescriptor = {
    id: 'volcengine-ark' as ProviderId, title: '火山方舟 · 视频', usesApiKey: true, connectionKind: 'api', supportedKinds: ['video'],
    configuration: [
      { key: 'baseUrl', label: 'API 地址', type: 'url', placeholder: 'https://ark.cn-beijing.volces.com/api/v3', advanced: true, affectsSetup: true },
      { key: 'videoModel', label: '视频模型 / Endpoint ID', type: 'text', required: true, mediaKind: 'video' },
    ],
  }

  constructor(private readonly deps: ProviderDependencies) {}

  /** Discover Seedance models while preserving manual Endpoint ID entry. */
  async prepare(connection: ConnectionSnapshot, signal: AbortSignal, apiKey?: string): Promise<ProviderPreparation> {
    try {
      const key = apiKey ?? await this.deps.readCredential(connection)
      if (!key) return preparationUnavailable('Configure the Ark API key.', 'not-authorized')
      const response = await fetch(new URL('models', endpoint(connection, 'https://ark.cn-beijing.volces.com/api/v3')),
        { headers: { Authorization: `Bearer ${key}` }, signal })
      if (!response.ok) {
        await response.body?.cancel()
        return preparationUnavailable(`Ark model discovery failed (HTTP ${response.status}).`,
          [401, 403].includes(response.status) ? 'not-authorized' : 'unreachable')
      }
      const data = await jsonResponse(response)
      if (!Array.isArray(data.data)) return preparationUnavailable('Ark returned an invalid model catalog.', 'unreachable')
      const models = data.data.flatMap((value) => {
        const id = record(value).id
        return typeof id === 'string' && id.startsWith('doubao-seedance-') ? [{ id, label: id, kind: 'video' as const }] : []
      })
      return { state: 'ready', models }
    } catch (error) { return preparationFailure(error, signal, 'Ark') }
  }

  private async headers(connection: ConnectionSnapshot): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${string(await this.deps.readCredential(connection), 'API key')}`, 'Content-Type': 'application/json' }
  }

  async describe(connection: ConnectionSnapshot, signal: AbortSignal): Promise<ConnectionInspection> {
    try {
      const base = endpoint(connection, 'https://ark.cn-beijing.volces.com/api/v3')
      const modelId = setting(connection, 'videoModel')
      if (!await this.deps.readCredential(connection)) return unavailable('Configure the Ark API key.', 'not-authorized')
      const response = await fetch(new URL('models', base), { headers: await this.headers(connection), signal })
      if (!response.ok) {
        await response.body?.cancel()
        return unavailable(`Ark model inspection failed (HTTP ${response.status}).`, [401, 403].includes(response.status) ? 'not-authorized' : 'unreachable')
      }
      const models = await jsonResponse(response)
      if (!modelId.startsWith('ep-') && (!Array.isArray(models.data) || !models.data.some(item => record(item).id === modelId))) return unavailable('This model is not visible to the configured Ark account.')
      return { state: 'ready', submissionRecovery: 'recoverable-resource', cancellation: 'unsupported', capabilities: [{
        kind: 'video', modelId, maxOutputs: 1,
        inputs: [{ role: 'first-frame', kinds: ['image'], minItems: 0, maxItems: 1 }, { role: 'last-frame', kinds: ['image'], minItems: 0, maxItems: 1 }],
        parameterSchema: objectSchema({
          duration: { type: 'integer', minimum: 2, maximum: 30 },
          ratio: { type: 'string', enum: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'] },
          resolution: { type: 'string', enum: ['480p', '720p', '1080p', '4k'] },
          seed: { type: 'integer', minimum: -1, maximum: 4294967295 },
          generate_audio: { type: 'boolean' }, watermark: { type: 'boolean' }, camera_fixed: { type: 'boolean' },
        }),
      }] }
    } catch (error) {
      signal.throwIfAborted()
      return unavailable(error instanceof TypeError ? 'Cannot reach Ark.' : (error as Error).message)
    }
  }

  async submit(request: ProviderRequest, runtime: ProviderRuntime): Promise<ProviderSnapshot> {
    if (request.kind !== 'video') return failed('Ark video tasks only generate video.', 'unsupported-kind', 'configuration')
    const content: Record<string, unknown>[] = [{ type: 'text', text: request.prompt }]
    if (request.references.some(ref => ref.role === 'last-frame') && !request.references.some(ref => ref.role === 'first-frame')) throw new Error('A last frame requires a first frame')
    for (const reference of request.references) {
      if (reference.kind !== 'image' || !['first-frame', 'last-frame'].includes(reference.role)) throw new Error('Ark supports first-frame and last-frame image references here')
      if ((await stat(reference.path)).size >= 30 * 1024 * 1024) throw new Error('Ark image references must be smaller than 30 MiB')
      content.push({ type: 'image_url', image_url: { url: `data:${reference.mimeType};base64,${(await readFile(reference.path)).toString('base64')}` }, role: reference.role.replace('-', '_') })
    }
    const body = JSON.stringify({ ...request.parameters, model: request.modelId ?? setting(runtime.connection, 'videoModel'), content })
    if (Buffer.byteLength(body) > 64 * 1024 * 1024) throw new Error('Ark requests must be smaller than 64 MiB')
    const url = new URL('contents/generations/tasks', endpoint(runtime.connection, 'https://ark.cn-beijing.volces.com/api/v3'))
    const headers = await this.headers(runtime.connection)
    await runtime.checkpoint({ version: 1, data: { attempted: true } })
    try {
      const response = await fetch(url, { method: 'POST', headers, body, signal: runtime.signal })
      if (!response.ok) {
        await response.body?.cancel()
        return response.status >= 500 || response.status === 408 ? unknownSubmission() : failed(`Ark rejected the request (HTTP ${response.status}).`, `http-${response.status}`, 'submission')
      }
      const taskId = string((await jsonResponse(response)).id, 'Ark task ID')
      const checkpoint: ProviderCheckpoint = { version: 1, data: { taskId } }
      await runtime.checkpoint(checkpoint)
      return { state: 'running', checkpoint }
    } catch { return unknownSubmission() }
  }

  private async task(taskId: string, runtime: ProviderRuntime): Promise<Record<string, unknown>> {
    const url = new URL(`contents/generations/tasks/${encodeURIComponent(taskId)}`, endpoint(runtime.connection, 'https://ark.cn-beijing.volces.com/api/v3'))
    const response = await fetch(url, { headers: await this.headers(runtime.connection), signal: runtime.signal })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Ark task lookup failed (HTTP ${response.status}); the original task has not been resubmitted`)
    }
    return jsonResponse(response)
  }

  async reconcile(
    _request: ProviderRequest, checkpoint: ProviderCheckpoint | undefined, runtime: ProviderRuntime,
  ): Promise<ProviderSnapshot> {
    if (!checkpoint?.data.taskId) return unknownSubmission()
    const taskId = string(checkpoint.data.taskId, 'Ark task ID')
    const task = await this.task(taskId, runtime)
    if (task.id !== taskId) throw new Error('Ark returned a different task identity')
    if (task.status === 'succeeded') return { state: 'completed', outputs: [{ outputId: taskId, kind: 'video', locator: { taskId }, suggestedFilename: 'creation.mp4' }] }
    const status = string(task.status, 'task status')
    if (['failed', 'expired', 'cancelled'].includes(status)) return failed(`Ark task ${status}.`, `ark-${status}`)
    if (!['queued', 'running'].includes(status)) return unknownSubmission()
    return { state: 'running', checkpoint }
  }

  async collect(output: ProviderOutput, destination: { path: string }, runtime: ProviderRuntime): Promise<void> {
    const task = await this.task(string(output.locator.taskId, 'Ark task ID'), runtime)
    if (task.status !== 'succeeded') throw new Error('Ark task is not complete')
    await download(record(task.content).video_url, destination.path, runtime)
  }

  // DELETE also deletes completed task records; it cannot safely implement conditional cancellation.
  cancel(): Promise<{ state: 'unsupported' }> { return Promise.resolve({ state: 'unsupported' }) }
}
