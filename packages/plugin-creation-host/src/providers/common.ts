import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { ConnectionInspection, ConnectionSnapshot, CreationIssue, JsonObject, ProviderOutput, ProviderPreparation, ProviderRuntime, ProviderSnapshot } from '../types.ts'

export interface ProviderDependencies {
  subprocess: SubprocessRuntime
  readCredential(connection: ConnectionSnapshot): Promise<string | undefined>
  /** Product-managed CLI paths share the same resolver across setup and generation. */
  resolveExecutable?(executable: string, env: Record<string, string>, signal: AbortSignal): Promise<string>
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Provider returned an invalid object')
  return value as Record<string, unknown>
}

export function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
  return value
}

export function scalarString(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    throw new Error('Provider parameter must be a string, number or boolean')
  }
  return String(value)
}

export function setting(connection: ConnectionSnapshot, key: string, fallback?: string): string {
  return string(connection.settings[key] ?? fallback, key)
}

export function unavailable(message: string, reason: Extract<ConnectionInspection, { state: 'unavailable' }>['reason'] = 'invalid-configuration'): ConnectionInspection {
  return { state: 'unavailable', reason, message }
}

/** Preparation shares actionable failure states without claiming generation is configured. */
export function preparationUnavailable(message: string,
  reason: Extract<ConnectionInspection, { state: 'unavailable' }>['reason'] = 'invalid-configuration'): ProviderPreparation {
  return { state: 'unavailable', reason, message }
}

/** Keep provider output and credentials out of configuration error messages. */
export function preparationFailure(error: unknown, signal: AbortSignal, provider: string): ProviderPreparation {
  signal.throwIfAborted()
  if (error instanceof Error && error.name === 'SubprocessExecutableNotFoundError') {
    return preparationUnavailable(`${provider} CLI was not found. Install it or choose its executable.`, 'not-installed')
  }
  return preparationUnavailable(`Could not check ${provider}. Check its connection settings and try again.`,
    error instanceof TypeError ? 'unreachable' : 'invalid-configuration')
}

export function failed(message: string, code: string, stage: CreationIssue['stage'] = 'generation'): ProviderSnapshot {
  return { state: 'failed', issue: { stage, code, message, recovery: stage === 'configuration' ? 'configure-provider' : 'new-generation' } }
}

export function unknownSubmission(): ProviderSnapshot {
  return { state: 'submission-unknown', message: 'The provider may have accepted this generation. Check its original task; automatic resubmission is disabled.' }
}

export function endpoint(connection: ConnectionSnapshot, fallback: string): URL {
  const url = new URL(setting(connection, 'baseUrl', fallback).replace(/\/$/, '') + '/')
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('baseUrl must use HTTPS (HTTP is allowed only on loopback) without embedded credentials')
  }
  return url
}

export async function responseBytes(response: Response, maxBytes: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel()
    throw new Error('Provider response exceeds the output size limit')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Provider returned an empty response')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      size += item.value.byteLength
      if (size > maxBytes) throw new Error('Provider response exceeds the output size limit')
      chunks.push(item.value)
    }
  } finally {
    await reader.cancel()
  }
  return Buffer.concat(chunks)
}

export async function jsonResponse(response: Response, maxBytes = 4 * 1024 * 1024): Promise<Record<string, unknown>> {
  return record(JSON.parse((await responseBytes(response, maxBytes)).toString('utf8')))
}

export async function download(urlValue: unknown, destination: string, runtime: ProviderRuntime): Promise<void> {
  const url = new URL(string(urlValue, 'download URL'))
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Provider returned an invalid media URL')
  const response = await fetch(url, { signal: runtime.signal })
  if (!response.ok) throw new Error(`Media download failed (HTTP ${response.status})`)
  await writeFile(destination, await responseBytes(response, runtime.maxBytes), { mode: 0o600 })
}

export async function saveReceipt(outputs: readonly ProviderOutput[], runtime: ProviderRuntime): Promise<void> {
  const path = join(runtime.workDirectory, 'provider-receipt.json')
  await writeFile(`${path}.tmp`, JSON.stringify(outputs), { mode: 0o600 })
  await rename(`${path}.tmp`, path)
}

export async function readReceipt(runtime: ProviderRuntime): Promise<ProviderSnapshot> {
  try {
    const outputs: unknown = JSON.parse(await readFile(join(runtime.workDirectory, 'provider-receipt.json'), 'utf8'))
    if (!Array.isArray(outputs)) throw new Error('Invalid provider receipt')
    return { state: 'completed', outputs: outputs as ProviderOutput[] }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return unknownSubmission()
    throw error
  }
}

export async function saveBytes(bytes: Uint8Array, kind: ProviderOutput['kind'], index: number, extension: string, runtime: ProviderRuntime): Promise<ProviderOutput> {
  if (bytes.byteLength === 0 || bytes.byteLength > runtime.maxBytes) throw new Error('Provider output is empty or exceeds the output size limit')
  const filename = `provider-output-${index}.${extension}`
  await mkdir(runtime.workDirectory, { recursive: true })
  const path = join(runtime.workDirectory, filename)
  await writeFile(`${path}.tmp`, bytes, { mode: 0o600 })
  await rename(`${path}.tmp`, path)
  return { outputId: String(index), kind, locator: { filename }, suggestedFilename: `creation-${index + 1}.${extension}` }
}

export async function collectLocal(output: ProviderOutput, destination: { path: string }, runtime: ProviderRuntime): Promise<void> {
  const filename = string(output.locator.filename, 'output filename')
  if (!/^provider-output-\d+\.[a-z0-9]+$/.test(filename)) throw new Error('Invalid provider output filename')
  const source = join(runtime.workDirectory, filename)
  const info = await stat(source)
  if (!info.isFile() || info.size > runtime.maxBytes) throw new Error('Invalid provider output file')
  await mkdir(dirname(destination.path), { recursive: true })
  await copyFile(source, destination.path)
}

export class CliRunner {
  constructor(
    private readonly deps: ProviderDependencies,
    private readonly defaultExecutable: string,
    private readonly tokenEnvironment?: string,
  ) {}

  async run(connection: ConnectionSnapshot, args: readonly string[], signal: AbortSignal, draftToken?: string): Promise<{
    exitCode: number | null
    stdout: string
    json?: Record<string, unknown>
  }> {
    const cwd = setting(connection, 'cwd', process.cwd())
    if (!isAbsolute(cwd)) throw new Error('CLI working directory must be absolute')
    const env: Record<string, string> = {}
    if (this.tokenEnvironment) {
      const token = draftToken ?? await this.deps.readCredential(connection)
      if (token) env[this.tokenEnvironment] = token
    }
    const command = setting(connection, 'executable', this.defaultExecutable)
    const executable = await (this.deps.resolveExecutable?.(command, env, signal)
      ?? this.deps.subprocess.resolveExecutable(command, env, signal))
    const handle = this.deps.subprocess.spawn({ argv: [executable, ...args], cwd, env, signal, graceMs: 2_000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 8 * 1024 * 1024 }, stderr: { maxBytes: 16 * 1024 } } })
    const result = await handle.done
    signal.throwIfAborted()
    const output = handle.collected.stdout?.readFrom(0)
    if (!output || output.lossy) throw new Error('CLI output was missing or truncated')
    let json: Record<string, unknown> | undefined
    if (output.text.trimStart().startsWith('{') || output.text.trimStart().startsWith('[')) {
      const parsed: unknown = JSON.parse(output.text)
      json = Array.isArray(parsed) ? { items: parsed } : record(parsed)
    }
    return { exitCode: result.exitCode, stdout: output.text, ...(json ? { json } : {}) }
  }
}

export function objectSchema(properties: JsonObject, required: string[] = []): JsonObject {
  return { type: 'object', properties, additionalProperties: false, ...(required.length ? { required } : {}) }
}
