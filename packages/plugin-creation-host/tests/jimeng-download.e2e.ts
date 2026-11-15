/** Opt-in, read-only collection against explicitly supplied resources belonging to the user. Never generates or logs in. */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { expect, it, onTestFinished } from 'vitest'
import { inspectMedia } from '../src/media.ts'
import { CliRunner, record } from '../src/providers/common.ts'
import { JimengProvider } from '../src/providers/jimeng.ts'
import type { ConnectionSnapshot, MediaKind, ProviderRuntime } from '../src/types.ts'

const projectId = process.env.CONVAX_JIMENG_PROJECT_ID
const resources = {
  image: process.env.CONVAX_JIMENG_IMAGE_RESOURCE_ID,
  video: process.env.CONVAX_JIMENG_VIDEO_RESOURCE_ID,
  audio: process.env.CONVAX_JIMENG_AUDIO_RESOURCE_ID,
} satisfies Record<MediaKind, string | undefined>

for (const kind of ['image', 'video', 'audio'] as const) {
  const resourceId = resources[kind]
  it.skipIf(!projectId || !resourceId)(`collects the user's existing Jimeng ${kind} through the production adapter`, async () => {
    const executable = process.env.CONVAX_JIMENG_EXECUTABLE
    if (!executable || !isAbsolute(executable)) throw new Error('Set CONVAX_JIMENG_EXECUTABLE to the absolute path of the installed CLI')
    if (!projectId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
      throw new Error('Set CONVAX_JIMENG_PROJECT_ID to the explicitly approved canvas UUID')
    }
    if (!resourceId?.trim()) throw new Error(`Set CONVAX_JIMENG_${kind.toUpperCase()}_RESOURCE_ID to an explicitly approved existing resource`)
    const profile = process.env.CONVAX_JIMENG_PROFILE || 'default'
    const cwd = process.env.CONVAX_JIMENG_CWD || process.cwd()
    if (!isAbsolute(cwd)) throw new Error('CONVAX_JIMENG_CWD must be absolute')
    const maxBytes = Number(process.env.CONVAX_JIMENG_MAX_BYTES || 512 * 1024 * 1024)
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('CONVAX_JIMENG_MAX_BYTES must be a positive integer')
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'convax-jimeng-collection-')))
    const controller = new AbortController()
    const ctx = new Context()
    onTestFinished(async () => {
      controller.abort()
      await ctx.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    })
    await ctx.plugin(LocalSubprocessRuntime)
    const handles: SubprocessHandle[] = []
    const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    ctx.subprocess.spawn = (spec) => {
      // Observe the real command receipt without substituting any CLI or service response.
      const handle = spawn(spec)
      if (spec.argv[1] === 'resource' && spec.argv[2] === 'download') handles.push(handle)
      return handle
    }
    const deps = { subprocess: ctx.subprocess, readCredential: () => Promise.resolve(undefined) }
    const connection: ConnectionSnapshot = { id: 'smoke' as ConnectionSnapshot['id'],
      providerId: 'jimeng-cli' as ConnectionSnapshot['providerId'], revision: 1, accountBinding: 'explicit-collection-smoke',
      settings: { executable, cwd, profile, projectId } }
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(110_000)])
    const cli = new CliRunner(deps, 'dreamina-canvas')
    const metadata = await cli.run(connection,
      ['resource', 'get', resourceId, '--project-id', projectId, '--format', 'json', '--non-interactive', '--profile', profile], signal)
    expect(metadata.exitCode, 'Read-only resource lookup must succeed').toBe(0)
    const resource = record(metadata.json?.data)
    expect(resource.resourceId).toBe(resourceId)
    expect(resource.type).toBe(kind)
    expect(resource.status, 'Only already successful resources are eligible for this collection smoke').toBe('success')
    const runtime: ProviderRuntime = { operationId: randomUUID() as ProviderRuntime['operationId'], connection, workDirectory: directory,
      maxBytes, signal,
      checkpoint: () => Promise.reject(new Error('Read-only collection must not submit or save a generation checkpoint')) }
    const destination = join(directory, 'downloaded-media')
    await new JimengProvider(deps).collect(
      { outputId: resourceId, kind, locator: { projectId, resourceId } }, { path: destination }, runtime)
    expect(handles).toHaveLength(1)
    const handle = handles[0]!
    expect((await handle.done).exitCode).toBe(0)
    const output = handle.collected.stdout?.readFrom(0)
    expect(output?.lossy).toBe(false)
    const receipt = record(record(JSON.parse(output?.text ?? '{}')).data)
    expect(receipt.resourceId).toBe(resourceId)
    expect(typeof receipt.path).toBe('string')
    expect(await realpath(String(receipt.path))).toBe(await realpath(destination))
    const media = await inspectMedia(destination, maxBytes, kind)
    expect(media.kind).toBe(kind)
    expect(receipt.size).toBe(media.bytes)
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(destination)) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Expected binary media bytes')
      digest.update(chunk)
    }
    const sha256 = digest.digest('hex')
    expect(receipt.sha256).toBe(sha256)
    // Only non-secret evidence is printed. CLI output, URLs, profile state and credentials are never logged.
    process.stdout.write(`${JSON.stringify({ kind, mimeType: media.mimeType, bytes: media.bytes, sha256 })}\n`)
  })
}
