/** Canvas ownership, directory edges and terminal cleanup use the shared user-terminal runtime. */
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { TerminalController, type Config } from '@deepseek-ai/dsh-api-terminal-controller'
import type { WebTerminalId } from '@deepseek-ai/dsh-api-terminal-controller/types'
import type { SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { ConvaxHost, CanvasNodeRegistry, CanvasRepository, type CanvasCommand, type CanvasId, type CanvasNodeId, type CanvasNodeTypeId, type CanvasOperationId, type CanvasConnectionId } from '@deepseek-ai/dsh-convax-plugin-host'
import { CanvasDatabase } from '@deepseek-ai/dsh-convax-plugin-host/src/database.ts'
import { CanvasWorkingDirectories } from '@deepseek-ai/dsh-convax-plugin-host/src/directories.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerDefaultNodes } from '../src/definitions.ts'
import { CanvasTerminalController } from '../src/terminals.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const canvasId = 'canvas-terminal-test' as CanvasId
const nodeId = 'terminal-card' as CanvasNodeId
const terminalId = 'runtime-first' as WebTerminalId
const request = { id: terminalId, cols: 80, rows: 24 }
const signal = (): AbortSignal => new AbortController().signal
const config: Config = { shell: { path: '/bin/sh', name: 'sh', args: ['-i'] }, shellCandidates: [], maxTerminals: 8,
  maxCols: 200, maxRows: 100, scrollback: 100, maxBufferedBytes: 100_000, maxInputBytes: 1000,
  disposeGraceMs: 100, unattendedTimeoutMs: 1, activityPollIntervalMs: 10, cleanupRetryMs: 100 }

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'convax-terminal-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const database = await CanvasDatabase.open({ path: join(root, 'canvas.sqlite') })
  cleanups.push(() => database.close())
  const repository = new CanvasRepository(database, new CanvasNodeRegistry((error) => { throw error }), (error) => { throw error })
  cleanups.push(async () => { repository.close() })
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalFileSystem, { cwd: root })
  registerDefaultNodes((definition) => { ctx.effect(() => repository.nodeTypes.register(definition)) })
  const handles: Array<{ handle: SubprocessTerminalHandle; terminate: ReturnType<typeof vi.fn>; output: PassThrough }> = []
  const subprocess = {
    terminalEnvironment: vi.fn(async () => ({ platform: 'posix', defaultShell: '/bin/sh' })),
    resolveExecutable: vi.fn(async (path: string) => path),
    spawnTerminal: vi.fn(async (): Promise<SubprocessTerminalHandle> => {
      const output = new PassThrough()
      const done = Promise.withResolvers<{ exitCode: number; signal: null }>()
      const terminate = vi.fn(async () => { output.end(); done.resolve({ exitCode: 0, signal: null }) })
      const handle: SubprocessTerminalHandle = {
        pid: 123, output, done: done.promise, write: async () => {}, resize: async () => {}, terminate,
        inspectActivity: async () => ({ state: 'idle', revision: 0 }), inspectForeground: async () => undefined,
        signalForeground: async () => 123,
      }
      handles.push({ handle, terminate, output })
      return handle
    }),
  }
  ctx.provide('subprocess', subprocess as never)
  new TerminalController(ctx, config)
  const directories = new CanvasWorkingDirectories(ctx, database, repository, join(root, 'workspaces'))
  const host = new ConvaxHost(ctx, repository, { previewBytes: 1024, documentBytes: 1024, mediaChunkBytes: 1024 }, { directories })
  ctx.effect(() => () => host.close())
  const terminals = new CanvasTerminalController(ctx)
  let operation = 0
  const execute = async (command: CanvasCommand) => {
    const operationId = `op-${++operation}` as CanvasOperationId
    const result = await host.execute({ canvasId, expectedRevision: repository.revision(canvasId), operationId, command })
    expect(result.ok).toBe(true)
    return operationId
  }
  await execute({ kind: 'create', title: 'Terminal workspace' })
  await execute({ kind: 'add-node', node: { id: nodeId, typeId: 'convax.terminal' as CanvasNodeTypeId,
    dataVersion: 1, revision: 0, data: {}, position: { x: 0, y: 0 } } })
  return { root, ctx, host, repository, terminals, handles, subprocess, execute }
}

describe('Canvas user terminals', () => {
  it('creates one process across windows without a Session and retains it without any mounted view', async () => {
    const f = await fixture()
    const [first, second] = await Promise.all([
      f.terminals.create(canvasId, nodeId, request, signal()),
      f.terminals.create(canvasId, nodeId, { ...request, id: 'other-window' as WebTerminalId }, signal()),
    ])
    expect(first.id).toBe(second.id)
    expect(f.subprocess.spawnTerminal).toHaveBeenCalledOnce()
    expect(first.cwd).toBe(await f.host.ensureCanvasDirectory(canvasId))
    expect(f.subprocess.spawnTerminal).toHaveBeenCalledWith(expect.objectContaining({
      cwd: first.cwd, env: { CONVAX_CANVAS_ID: canvasId, CONVAX_NODE_ID: nodeId },
    }))
    expect(f.ctx.get('agents')).toBeUndefined()
    const hold = new AbortController()
    const stream = f.terminals.retain(canvasId, nodeId, first.id, hold.signal)[Symbol.asyncIterator]()
    expect(await stream.next()).toMatchObject({ value: { type: 'retained' } })
    hold.abort()
    await stream.return?.()
    await f.execute({ kind: 'rename', title: 'Renamed while hidden' })
    expect(f.handles[0]?.terminate).not.toHaveBeenCalled()
    expect(f.terminals.list(canvasId, nodeId)).toMatchObject([{ id: first.id, state: 'running' }])
  })

  it('resolves committed folder and file input edges for new process directories', async () => {
    const f = await fixture()
    const project = join(f.root, 'project')
    await mkdir(project)
    const file = join(project, 'input.txt')
    await writeFile(file, 'input')
    for (const [id, typeId, path] of [['folder', 'convax.folder', project], ['file', 'convax.file', file]] as const) {
      await f.execute({ kind: 'add-node', node: { id: id as CanvasNodeId, typeId: typeId as CanvasNodeTypeId,
        dataVersion: 1, revision: 0, data: { path }, position: { x: 10, y: 0 } } })
      await f.execute({ kind: 'add-connection', connection: { id: `edge-${id}` as CanvasConnectionId,
        source: id as CanvasNodeId, sourcePort: 'output', target: nodeId, targetPort: 'input', purpose: 'input' } })
      expect((await f.terminals.environment(canvasId, nodeId, signal())).cwd).toBe(project)
      const processId = `runtime-${id}` as WebTerminalId
      const info = await f.terminals.create(canvasId, nodeId, { ...request, id: processId }, signal())
      expect(info.cwd).toBe(project)
      await f.terminals.close(canvasId, nodeId, processId)
    }
    expect(f.subprocess.spawnTerminal).toHaveBeenCalledTimes(2)
  })

  it('closes the process after graph deletion and undo restores configuration without reviving its runtime', async () => {
    const f = await fixture()
    await f.terminals.create(canvasId, nodeId, request, signal())
    const removal = await f.execute({ kind: 'remove-nodes', nodeIds: [nodeId] })
    await f.terminals.close(canvasId, nodeId, terminalId)
    expect(f.handles[0]?.terminate).toHaveBeenCalledOnce()
    await f.execute({ kind: 'history', targetOperationId: removal, direction: 'undo' })
    expect(f.terminals.list(canvasId, nodeId)).toEqual([])
    await expect(f.terminals.create(canvasId, nodeId, request, signal())).rejects.toMatchObject({ code: 'terminal/unavailable' })
    const next = await f.terminals.create(canvasId, nodeId, { ...request, id: 'runtime-new' as WebTerminalId }, signal())
    expect(next.id).toBe('runtime-new')
    expect(f.subprocess.spawnTerminal).toHaveBeenCalledTimes(2)
  })

  it('rejects a missing directory source and never allocates a fallback shell', async () => {
    const f = await fixture()
    await f.execute({ kind: 'add-node', node: { id: 'missing' as CanvasNodeId, typeId: 'convax.file' as CanvasNodeTypeId,
      dataVersion: 1, revision: 0, data: { path: join(f.root, 'missing', 'input.txt') }, position: { x: 10, y: 0 } } })
    await f.execute({ kind: 'add-connection', connection: { id: 'edge' as CanvasConnectionId,
      source: 'missing' as CanvasNodeId, sourcePort: 'output', target: nodeId, targetPort: 'input', purpose: 'input' } })
    await expect(f.terminals.create(canvasId, nodeId, request, signal())).rejects.toThrow('working directory is unavailable')
    expect(f.subprocess.spawnTerminal).not.toHaveBeenCalled()
  })

  it('closes a pending allocation when its card is deleted', async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const spawn = f.subprocess.spawnTerminal.getMockImplementation()!
    f.subprocess.spawnTerminal.mockImplementationOnce(async () => { entered.resolve(undefined); await release.promise; return spawn() })
    const creating = f.terminals.create(canvasId, nodeId, request, signal())
    const rejected = expect(creating).rejects.toMatchObject({ code: 'terminal/unavailable' })
    try {
      await entered.promise
      await f.execute({ kind: 'remove-nodes', nodeIds: [nodeId] })
      release.resolve(undefined)
      await rejected
      await f.terminals.close(canvasId, nodeId, terminalId)
      expect(f.handles[0]?.terminate).toHaveBeenCalledOnce()
    } finally { release.resolve(undefined); await creating.catch(() => {}) }
  })
})
