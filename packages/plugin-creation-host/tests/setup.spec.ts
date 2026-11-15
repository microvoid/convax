import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it } from 'vitest'
import { CreationProviderSetup } from '../src/setup.ts'
import type { ConnectionSnapshot, WorkbenchRef } from '../src/types.ts'

const ref = { canvasId: 'canvas', nodeId: 'workbench' } as WorkbenchRef
const projectId = '49e12936-cec9-4421-a9d7-413d02b6e001'
const secondProjectId = '49e12936-cec9-4421-a9d7-413d02b6e002'
const deviceCode = 'private-device-code'
const verificationUrl = 'https://jimeng.jianying.com/ai-tool/cli-auth?agent_role=convax&cli_name=dreamina&verification_uri='
  + encodeURIComponent('https://jimeng.jianying.com/passport/open/scan_user_code/?user_code=USER-1234')
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

interface ResponseAction { data?: unknown; error?: unknown; exitCode?: number; barrier?: string }
function challenge(overrides: Record<string, unknown> = {}): ResponseAction {
  return { data: { status: 'authorization_required', challenge: { deviceCode, userCode: 'USER-1234',
    verificationUri: verificationUrl, verificationUriComplete: verificationUrl,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), pollSeconds: 1, ...overrides } } }
}

async function fixture(action: (args: readonly string[], index: number) => ResponseAction) {
  const root = await mkdtemp(join(tmpdir(), 'convax-cli-setup-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  const fiber = await ctx.plugin(LocalSubprocessRuntime)
  cleanups.push(() => fiber.dispose())
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  const calls: SubprocessSpawnSpec[] = []
  const children: ReturnType<typeof spawn>[] = []
  // The external CLI boundary is controlled; subprocess cancellation, cwd and all setup logic remain real.
  ctx.subprocess.resolveExecutable = command => Promise.resolve(isAbsolute(command) ? command : join(root, command))
  ctx.subprocess.spawn = (spec) => {
    calls.push(spec)
    const response = action(spec.argv.slice(1), calls.length)
    const payload = JSON.stringify({ ok: response.error === undefined, ...(response.data === undefined ? {} : { data: response.data }),
      ...(response.error === undefined ? {} : { error: response.error }) })
    const source = `const fs = require('node:fs'); const run = () => {
      if (${JSON.stringify(response.barrier ?? null)} && !fs.existsSync(${JSON.stringify(response.barrier ?? '')})) { setTimeout(run, 10); return }
      process.stdout.write(${JSON.stringify(payload)}); process.exitCode = ${response.exitCode ?? 0};
    }; run()`
    const child = spawn({ ...spec, argv: [process.execPath, '-e', source] })
    children.push(child)
    return child
  }
  const setup = new CreationProviderSetup({ subprocess: ctx.subprocess, readCredential: () => Promise.resolve(undefined),
    resolveExecutable: (command, env, signal) => ctx.subprocess.resolveExecutable(command, env, signal) })
  cleanups.push(() => setup.close())
  const connection: ConnectionSnapshot = { id: 'draft' as ConnectionSnapshot['id'], providerId: 'jimeng-cli' as ConnectionSnapshot['providerId'],
    revision: 1, accountBinding: 'draft', settings: { cwd: root, profile: 'chosen-profile' } }
  return { root, calls, children, setup, connection }
}

async function authState(f: Awaited<ReturnType<typeof fixture>>, expected: string, connection = f.connection) {
  await expect.poll(async () => (await f.setup.status(ref, connection)).state, { timeout: 10_000 }).toBe(expected)
  return f.setup.status(ref, connection)
}

describe('Jimeng workbench setup', () => {
  it('derives managed canvas IDs without mutation and isolates workbenches and CLI contexts', async () => {
    const f = await fixture(() => ({ data: {} }))
    const id = await f.setup.managedCanvasId(ref, f.connection)
    expect(await f.setup.managedCanvasId(ref, { ...f.connection, settings: { ...f.connection.settings, imageModel: 'new-model' } })).toBe(id)
    for (const settings of [{ profile: 'other' }, { cwd: join(f.root, 'other') }, { executable: join(f.root, 'other-cli') }]) {
      expect(await f.setup.managedCanvasId(ref, { ...f.connection, settings: { ...f.connection.settings, ...settings } })).not.toBe(id)
    }
    expect(await f.setup.managedCanvasId({ ...ref, nodeId: 'other' as WorkbenchRef['nodeId'] }, f.connection)).not.toBe(id)
    expect(f.calls).toEqual([])
    expect(f.setup.descriptor(f.connection.providerId).canvasSelection).toBeUndefined()
  })

  it('reads login state without starting authorization, creating canvases or writing product credentials', async () => {
    const f = await fixture(() => ({ data: { loggedIn: false } }))
    expect(await f.setup.status(ref, f.connection)).toEqual({ state: 'idle' })
    expect(f.calls.map(call => call.argv.slice(1, 3))).toEqual([['auth', 'status']])
    expect(await readdir(f.root)).toEqual([])
  })

  it('reuses a logged-in profile without starting a challenge', async () => {
    const f = await fixture(() => ({ data: { loggedIn: true } }))
    expect((await f.setup.begin(ref, f.connection)).state).toBe('starting')
    await authState(f, 'authorized')
    expect(f.calls.every(call => call.argv[2] === 'status')).toBe(true)
    expect(f.calls.every(call => call.argv.includes('--non-interactive') && call.argv.at(-1) === 'chosen-profile')).toBe(true)
    expect(await readdir(f.root)).toEqual([])
  })

  it('starts one challenge, performs auth wait with the private device code, and finishes while observers are closed', async () => {
    let release = ''
    const f = await fixture(args => args[1] === 'status' ? { data: { loggedIn: false } }
      : args[1] === 'login' ? challenge() : { data: { status: 'logged_in' }, barrier: release })
    release = join(f.root, 'continue')
    await Promise.all([f.setup.begin(ref, f.connection), f.setup.begin(ref, f.connection)])
    const waiting = await authState(f, 'waiting')
    expect(waiting.verificationUrl).toBe(verificationUrl)
    expect(JSON.stringify(waiting)).not.toContain(deviceCode)
    expect(waiting.userCode).toBeUndefined()
    const wait = f.calls.find(call => call.argv[2] === 'wait')
    expect(wait?.argv).toContain(deviceCode)
    expect(wait?.argv).toContain('60s')
    expect(f.calls.filter(call => call.argv[2] === 'login')).toHaveLength(1)
    expect(f.calls.filter(call => call.argv[2] === 'wait')).toHaveLength(1)
    expect(wait?.cwd).toBe(f.root)
    expect(new Set(f.calls.map(call => call.argv[0])).size).toBe(1)
    await writeFile(release, '')
    await authState(f, 'authorized')
    expect(f.calls.some(call => call.argv.includes('logout') || call.argv.includes('--force'))).toBe(false)
    expect(await readdir(f.root)).toEqual(['continue'])
  })

  it('resumes the same challenge after a network error and a CLI wait-budget timeout', async () => {
    let waits = 0
    const f = await fixture((args) => {
      if (args[1] === 'status') return { data: { loggedIn: false } }
      if (args[1] === 'login') return challenge()
      waits += 1
      return waits === 1 ? { exitCode: 1, error: { code: 40020, reason: 'network_timeout', message: `secret ${deviceCode}` } }
        : waits === 2 ? { exitCode: 1, error: { code: 40011 } } : { data: { status: 'logged_in' } }
    })
    await f.setup.begin(ref, f.connection)
    const failed = await authState(f, 'failed')
    expect(failed.reason).toBe('unreachable')
    expect(failed.message).toContain('(CLI exit=1, code=40020, reason=network_timeout)')
    expect(JSON.stringify(failed)).not.toContain(deviceCode)
    await f.setup.begin(ref, f.connection)
    await authState(f, 'authorized')
    expect(f.calls.filter(call => call.argv[2] === 'login')).toHaveLength(1)
    expect(f.calls.filter(call => call.argv[2] === 'wait')).toHaveLength(3)
    expect(f.calls.filter(call => call.argv[2] === 'wait').every(call => call.argv.includes(deviceCode))).toBe(true)
  })

  it('omits unrecognized authorization details from public diagnostics', async () => {
    const f = await fixture(args => args[1] === 'status' ? { data: { loggedIn: false } }
      : args[1] === 'login' ? challenge() : { exitCode: 1,
        error: { code: deviceCode, reason: deviceCode, message: deviceCode, diagnostics: { token: deviceCode } } })
    await f.setup.begin(ref, f.connection)
    const result = await authState(f, 'failed')
    expect(result.message).toContain('(CLI exit=1)')
    expect(JSON.stringify(result)).not.toContain(deviceCode)
    expect(f.calls.filter(call => call.argv[2] === 'login')).toHaveLength(1)
  })

  it.each([
    { error: { code: 40014 }, state: 'expired' },
    { error: { reason: 'access_denied' }, state: 'rejected' },
  ])('reports $state and only creates a fresh challenge after another explicit action', async ({ error, state }) => {
    const f = await fixture(args => args[1] === 'status' ? { data: { loggedIn: false } }
      : args[1] === 'login' ? challenge() : { exitCode: 1, error })
    await f.setup.begin(ref, f.connection)
    await authState(f, state)
    expect(f.calls.filter(call => call.argv[2] === 'login')).toHaveLength(1)
    await f.setup.begin(ref, f.connection)
    await authState(f, state)
    expect(f.calls.filter(call => call.argv[2] === 'login')).toHaveLength(2)
  })

  it.each([
    'https://example.com/authorize',
    'javascript:alert(1)',
    `https://jimeng.jianying.com/ai-tool/cli-auth?device_code=${deviceCode}`,
    'https://jimeng.jianying.com/ai-tool/cli-auth?token=private-token',
    'https://jimeng.jianying.com/redirect?url=https://example.com',
    'https://jimeng.jianying.com/ai-tool/cli-auth?verification_uri=https%3A%2F%2Fexample.com%2Fauthorize',
    `${verificationUrl}&verification_uri=https%3A%2F%2Fexample.com%2Fauthorize`,
  ])('never exposes an unsafe challenge URL or starts its wait: %s', async (url) => {
    const f = await fixture(args => args[1] === 'status' ? { data: { loggedIn: false } } : challenge({ verificationUriComplete: url }))
    await f.setup.begin(ref, f.connection)
    const result = await authState(f, 'failed')
    expect(result.reason).toBe('unsafe-url')
    expect(result.verificationUrl).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain(deviceCode)
    expect(f.calls.some(call => call.argv[2] === 'wait')).toBe(false)
  })

  it('isolates pending authorization by executable, working directory and profile', async () => {
    let barrier = ''
    const f = await fixture(args => args[1] === 'status' ? { data: { loggedIn: false } }
      : args[1] === 'login' ? challenge() : { data: { status: 'logged_in' }, barrier })
    barrier = join(f.root, 'never-released')
    await f.setup.begin(ref, f.connection)
    await authState(f, 'waiting')
    const otherDirectory = join(f.root, 'other')
    await mkdir(otherDirectory)
    for (const change of [{ profile: 'other' }, { cwd: otherDirectory }, { executable: join(f.root, 'other-cli') }]) {
      const connection = { ...f.connection, settings: { ...f.connection.settings, ...change } }
      expect(await f.setup.status(ref, connection)).toEqual({ state: 'idle' })
    }
    expect(f.calls.filter(call => call.argv[2] === 'login')).toHaveLength(1)
    expect(f.calls.filter(call => call.argv[2] === 'wait')).toHaveLength(1)
    await f.setup.close()
    expect(await Promise.all(f.children.map(child => child.waitForExit()))).not.toContain(false)
    expect((await f.setup.begin(ref, f.connection)).state).toBe('failed')
  })

  it('lists bounded opaque pages without choosing a current canvas or making mutations', async () => {
    const cursor = 'opaque cursor +/=literal'
    const f = await fixture(args => ({ data: args.includes('--cursor')
      ? { items: [{ projectId: secondProjectId, name: 'Second', webUrl: 'https://example.com/private' }], hasMore: false }
      : { items: [{ projectId, name: 'First', webUrl: 'https://jimeng.jianying.com/ai-tool/ai-canvas' }], hasMore: true, nextCursor: cursor } }))
    expect(await f.setup.list(ref, f.connection)).toMatchObject({ state: 'ready', nextCursor: cursor, items: [{ id: projectId, label: 'First' }] })
    expect(await f.setup.list(ref, f.connection, cursor)).toEqual({ state: 'ready', items: [{ id: secondProjectId, label: 'Second' }] })
    expect(f.calls.map(call => call.argv.slice(1, 3))).toEqual([['canvas', 'ls'], ['canvas', 'ls']])
    expect(f.calls[1]?.argv).toContain(cursor)
    expect(f.calls.every(call => call.argv.includes('50') && !call.argv.includes('--use'))).toBe(true)
  })

  it('accepts unnamed canvases created on the official website', async () => {
    const f = await fixture(() => ({ data: { items: [
      { projectId, name: '', createdAt: 1, updatedAt: 1 },
      { projectId: secondProjectId, name: '  ', createdAt: 1, updatedAt: 1 },
    ], hasMore: false } }))
    expect(await f.setup.list(ref, f.connection)).toEqual({ state: 'ready', items: [
      { id: projectId, label: '' }, { id: secondProjectId, label: '  ' },
    ] })
    expect(f.calls.map(call => call.argv.slice(1, 3))).toEqual([['canvas', 'ls']])
  })

  it('retries an ambiguous canvas create with the same UUID, rejects changed payloads and deduplicates success', async () => {
    let creates = 0
    const f = await fixture(() => {
      creates += 1
      return creates === 1 ? { exitCode: 1, error: { message: 'network outcome unknown' } }
        : { data: { project: { projectId, name: 'New canvas' } } }
    })
    const request = { name: 'New canvas', requestId: projectId }
    expect((await f.setup.create(ref, f.connection, request)).state).toBe('unavailable')
    expect(await f.setup.create(ref, f.connection, { ...request, name: 'Different' })).toMatchObject({ reason: 'request-conflict' })
    const results = await Promise.all([f.setup.create(ref, f.connection, request), f.setup.create(ref, f.connection, request)])
    expect(results).toEqual([{ state: 'ready', canvas: { id: projectId, label: 'New canvas' } },
      { state: 'ready', canvas: { id: projectId, label: 'New canvas' } }])
    await f.setup.create(ref, f.connection, request)
    expect(creates).toBe(2)
    expect(f.calls.every(call => call.argv.includes(projectId) && !call.argv.includes('--use'))).toBe(true)
    expect(await readdir(f.root)).toEqual([])
  })

  it('rejects invalid creation input before executing a mutating command', async () => {
    const f = await fixture(() => ({ data: {} }))
    expect(await f.setup.create(ref, f.connection, { name: '', requestId: projectId })).toMatchObject({ reason: 'invalid-configuration' })
    expect(await f.setup.create(ref, f.connection, { name: 'New', requestId: 'not-uuid' })).toMatchObject({ reason: 'invalid-configuration' })
    expect(f.calls).toEqual([])
  })
})
