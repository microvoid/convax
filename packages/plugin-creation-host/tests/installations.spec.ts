import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SubprocessExecutableNotFoundError, type SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CreationCliInstallations } from '../src/installations.ts'
import type { ProviderId } from '../src/types.ts'

const jimeng = 'jimeng-cli' as ProviderId
const libtv = 'libtv-cli' as ProviderId
const source = 'https://jimeng.jianying.com/canvas-cli/install/1_0_0_60/dreamina-canvas_darwin_arm64'
const cdn = 'https://lf3-lv-buz.vlabstatic.com/obj/image-lvweb-buz/videocut/aigc/dreamina_canvas_cli/1_0_0_60/dreamina-canvas_darwin_arm64'
const executableBytes = Buffer.from('cffaedfe000000000000000000000000', 'hex')
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function fixture(options: { fetch?: typeof fetch; platform?: NodeJS.Platform; arch?: string; existing?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'convax-cli-install-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'private', 'cli')
  const existing = join(root, 'existing-cli')
  if (options.existing) await writeFile(existing, executableBytes, { mode: 0o700 })
  const ctx = new Context()
  const fiber = await ctx.plugin(LocalSubprocessRuntime)
  cleanups.push(() => fiber.dispose())
  const subprocess = ctx.subprocess
  const resolve = subprocess.resolveExecutable.bind(subprocess)
  const spawn = subprocess.spawn.bind(subprocess)
  const processes: SubprocessSpawnSpec[] = []
  const boundary = { exitCode: 0, stdout: 'fixture CLI 1.0', existing: options.existing ?? false }
  subprocess.resolveExecutable = async (command, env, signal) => {
    if (!isAbsolute(command)) {
      if (boundary.existing) return resolve(existing, env, signal)
      throw new SubprocessExecutableNotFoundError('Fixture command is missing')
    }
    return resolve(command, env, signal)
  }
  // Only the external CLI is substituted. Real process ownership, cwd, signal and filesystem remain in use.
  subprocess.spawn = (spec) => {
    processes.push(spec)
    return spawn({ ...spec, argv: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(boundary.stdout)}); process.exitCode = ${boundary.exitCode}`] })
  }
  const download = vi.fn(options.fetch ?? (async () => new Response(executableBytes)))
  const manager = new CreationCliInstallations({ directory, subprocess, fetch: download, platform: options.platform ?? 'darwin', arch: options.arch ?? 'arm64' })
  cleanups.push(() => manager.close())
  return { root, directory, existing, subprocess, processes, boundary, download, manager,
    destination: join(directory, 'jimeng-cli', '1_0_0_60', 'dreamina-canvas') }
}

async function settled(manager: CreationCliInstallations, providerId = jimeng) {
  await expect.poll(() => manager.status(providerId).state).toMatch(/^(ready|failed)$/)
  return manager.status(providerId)
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : input.toString()
}

describe('product-owned CLI installation', () => {
  it('does no work until requested and rejects unknown or unsupported installations', async () => {
    const f = await fixture({ platform: 'win32', arch: 'arm64' })
    expect(f.manager.status(jimeng)).toEqual({ state: 'idle' })
    expect(f.manager.descriptor(jimeng)).toMatchObject({ supported: false })
    expect(f.manager.descriptor(libtv)).toMatchObject({ supported: true })
    expect(f.manager.descriptor('constructor' as ProviderId)).toBeUndefined()
    expect(() => f.manager.start('constructor' as ProviderId)).toThrow('does not offer')
    expect(f.manager.start(jimeng).state).toBe('failed')
    expect(f.manager.status(jimeng).state).toBe('failed')
    expect(f.download).not.toHaveBeenCalled()
    await expect(access(f.directory)).rejects.toThrow()
  })

  it('downloads the pinned official redirect, verifies privately, then atomically publishes a reusable executable', async () => {
    const f = await fixture({ fetch: async input => requestUrl(input) === source
      ? new Response(null, { status: 302, headers: { location: cdn } }) : new Response(executableBytes) })
    expect(f.manager.start(jimeng)).toEqual({ state: 'checking' })
    expect(await settled(f.manager)).toEqual({ state: 'ready', executable: f.destination })
    expect(f.download.mock.calls.map(([input]) => requestUrl(input))).toEqual([source, cdn])
    expect(await readFile(f.destination)).toEqual(executableBytes)
    expect(f.processes).toHaveLength(1)
    expect(f.processes[0]?.argv.slice(1)).toEqual(['--format', 'json', 'version'])
    expect(f.processes[0]?.argv[0]).toContain('.install-')
    expect((await readdir(f.directory)).filter(name => name.startsWith('.install-'))).toEqual([])
    if (process.platform !== 'win32') expect((await stat(f.destination)).mode & 0o777).toBe(0o700)
    await f.manager.close()
    const restarted = new CreationCliInstallations({ directory: f.directory, subprocess: f.subprocess, fetch: f.download, platform: 'darwin', arch: 'arm64' })
    cleanups.push(() => restarted.close())
    expect(await restarted.resolveExecutable('dreamina-canvas', {}, new AbortController().signal)).toBe(f.destination)
    restarted.start(jimeng)
    expect((await settled(restarted)).state).toBe('ready')
    expect(f.download).toHaveBeenCalledTimes(2)
  })

  it('reuses PATH without requiring the private installation directory to exist', async () => {
    const f = await fixture({ existing: true })
    f.manager.start(jimeng)
    expect(await settled(f.manager)).toEqual({ state: 'ready', executable: f.existing })
    expect(f.download).not.toHaveBeenCalled()
    expect(f.processes[0]?.cwd).toBe(f.root)
    await expect(access(f.directory)).rejects.toThrow()
    expect(await readFile(f.existing)).toEqual(executableBytes)
  })

  it('keeps an existing but broken PATH executable intact instead of downloading over it', async () => {
    const f = await fixture({ existing: true })
    f.boundary.exitCode = 1
    f.manager.start(jimeng)
    expect((await settled(f.manager)).state).toBe('failed')
    expect(f.download).not.toHaveBeenCalled()
    expect(await readFile(f.existing)).toEqual(executableBytes)
    await expect(access(f.directory)).rejects.toThrow()
  })

  it('deduplicates active clicks and reports streamed byte progress without publishing a partial binary', async () => {
    const stream = new TransformStream<Uint8Array, Uint8Array>()
    const writer = stream.writable.getWriter()
    cleanups.push(() => writer.abort())
    const f = await fixture({ fetch: async () => new Response(stream.readable, { headers: { 'content-length': String(executableBytes.length) } }) })
    f.manager.start(jimeng)
    await writer.write(executableBytes.subarray(0, 4))
    await expect.poll(() => f.manager.status(jimeng).receivedBytes).toBe(4)
    expect(f.manager.start(jimeng)).toEqual({ state: 'downloading', receivedBytes: 4, totalBytes: executableBytes.length })
    expect(f.download).toHaveBeenCalledTimes(1)
    await expect(access(f.destination)).rejects.toThrow()
    await writer.write(executableBytes.subarray(4))
    await writer.close()
    expect((await settled(f.manager)).state).toBe('ready')
  })

  it('cleans failed downloads and supports a fresh retry without leaking network details', async () => {
    const f = await fixture()
    f.download.mockRejectedValueOnce(new Error('private-token-must-not-leak'))
    f.manager.start(jimeng)
    expect(await settled(f.manager)).toEqual({ state: 'failed', message: 'Could not install the CLI. Try again.' })
    expect(await readdir(f.directory)).toEqual([])
    f.manager.start(jimeng)
    expect((await settled(f.manager)).state).toBe('ready')
    expect(f.download).toHaveBeenCalledTimes(2)
    expect(await readFile(f.destination)).toEqual(executableBytes)
  })

  it.each([
    'https://example.com/cli',
    'https://lf3-lv-buz.vlabstatic.com/other/evil',
    `${cdn}?untrusted=1`,
    cdn.replace('1_0_0_60', 'latest'),
  ])('rejects an unapproved redirect before contacting it: %s', async (location) => {
    const f = await fixture({ fetch: async () => new Response(null, { status: 302, headers: { location } }) })
    f.manager.start(jimeng)
    expect(await settled(f.manager)).toMatchObject({ state: 'failed', message: 'The download source is not an approved official site.' })
    expect(f.download).toHaveBeenCalledTimes(1)
    expect(f.processes).toEqual([])
    expect(await readdir(f.directory)).toEqual([])
  })

  it.each([
    { bytes: Buffer.from('#!/bin/sh\necho unsafe'), headers: {}, message: 'not an executable' },
    { bytes: executableBytes, headers: { 'content-length': '134217729' }, message: 'exceeds the size limit' },
    { bytes: executableBytes, headers: { 'content-length': '100' }, message: 'incomplete' },
  ])('rejects malformed or oversized responses before executing: $message', async ({ bytes, headers, message }) => {
    const f = await fixture({ fetch: async () => new Response(bytes, { headers }) })
    f.manager.start(jimeng)
    expect((await settled(f.manager)).message).toContain(message)
    expect(f.processes).toEqual([])
    expect(await readdir(f.directory)).toEqual([])
  })

  it('extracts only the LibTV executable and never installs bundled scripts or skills', async () => {
    const archive = zipSync({ 'bundle/libtv': executableBytes, 'bundle/install.sh': Buffer.from('unsafe'), 'bundle/skills/SKILL.md': Buffer.from('not installed') })
    const f = await fixture({ fetch: async () => new Response(Buffer.from(archive)) })
    f.manager.start(libtv)
    const destination = join(f.directory, 'libtv-cli', '1.2.0', 'libtv')
    expect(await settled(f.manager, libtv)).toEqual({ state: 'ready', executable: destination })
    expect(requestUrl(f.download.mock.calls[0]![0])).toBe('https://liblibai-web-static.liblib.cloud/cli/1.2.0/libtv-macos-arm64.zip')
    expect(await readFile(destination)).toEqual(executableBytes)
    expect(await readdir(join(f.directory, 'libtv-cli', '1.2.0'))).toEqual(['libtv'])
    expect(f.processes[0]?.argv.slice(1)).toEqual(['--help'])
  })

  it.each([
    { '../libtv': executableBytes },
    { '/libtv': executableBytes },
    { 'one/libtv': executableBytes, 'two/libtv': executableBytes },
  ])('rejects ambiguous or unsafe archive entries', async (files) => {
    const archive = zipSync(files)
    const f = await fixture({ fetch: async () => new Response(Buffer.from(archive)) })
    f.manager.start(libtv)
    expect((await settled(f.manager, libtv)).state).toBe('failed')
    expect(f.processes).toEqual([])
    expect(await readdir(f.directory)).toEqual([])
  })

  it('does not publish a downloaded executable when its version probe fails', async () => {
    const f = await fixture()
    f.boundary.exitCode = 1
    f.manager.start(jimeng)
    expect((await settled(f.manager)).state).toBe('failed')
    await expect(access(f.destination)).rejects.toThrow()
    expect(await readdir(f.directory)).toEqual([])
    await expect(f.manager.resolveExecutable(join(f.root, 'custom-cli'), {}, new AbortController().signal))
      .rejects.toBeInstanceOf(SubprocessExecutableNotFoundError)
  })

  it('cancels stalled response bodies and drains cleanup on Host disposal', async () => {
    const cancelled = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(executableBytes.subarray(0, 4)) }, cancel: cancelled,
    })
    const f = await fixture({ fetch: async () => new Response(stream) })
    f.manager.start(jimeng)
    await expect.poll(() => f.manager.status(jimeng).receivedBytes).toBe(4)
    await f.manager.close()
    expect(cancelled).toHaveBeenCalledTimes(1)
    expect(f.manager.status(jimeng)).toMatchObject({ state: 'failed' })
    expect(await readdir(f.directory)).toEqual([])
    expect(f.processes).toEqual([])
    expect(() => f.manager.start(jimeng)).toThrow('closing')
  })
})
