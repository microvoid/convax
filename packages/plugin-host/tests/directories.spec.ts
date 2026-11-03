/** Canvas-owned working directories survive graph organization without moving existing work. */
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CanvasDatabase } from '../src/database.ts'
import { CanvasWorkingDirectories } from '../src/directories.ts'
import { ConvaxHost } from '../src/index.ts'
import { CanvasNodeRegistry } from '../src/registry.ts'
import { CanvasRepository } from '../src/repository.ts'
import type { CanvasCommand, CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId } from '../src/types.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'convax-directories-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalFileSystem, { cwd: root })
  const database = await CanvasDatabase.open({ path: join(root, 'canvas.sqlite') })
  cleanups.push(() => database.close())
  const repository = new CanvasRepository(database, new CanvasNodeRegistry((error) => { throw error }), (error) => { throw error })
  cleanups.push(async () => { repository.close() })
  const directoryRoot = join(root, 'workspaces')
  const directories = new CanvasWorkingDirectories(ctx, database, repository, directoryRoot)
  const host = new ConvaxHost(ctx, repository, { previewBytes: 1024, documentBytes: 1024, mediaChunkBytes: 1024 }, { directories })
  cleanups.push(() => host.close())
  let operation = 0
  const execute = (id: string, command: CanvasCommand, legacy = false) => {
    const request = { canvasId: id as CanvasId, operationId: `operation-${++operation}` as CanvasOperationId,
      expectedRevision: repository.revision(id as CanvasId), command }
    return legacy ? repository.execute(request) : host.execute(request)
  }
  return { root, ctx, directoryRoot, directories, host, repository, database, execute }
}

describe('Canvas working directories', () => {
  it('creates an independent directory before publishing each new or copied canvas', async () => {
    const f = await fixture()
    expect((await f.execute('first', { kind: 'create', title: 'First' })).ok).toBe(true)
    expect((await stat(join(f.directoryRoot, 'canvas-first'))).isDirectory()).toBe(true)
    const first = await f.host.ensureCanvasDirectory('first' as CanvasId)
    await writeFile(join(first, 'output.txt'), 'keep this work')
    expect((await f.execute('first', { kind: 'duplicate', newCanvasId: 'copy' as CanvasId, title: 'Copy' })).ok).toBe(true)
    const copy = await f.host.ensureCanvasDirectory('copy' as CanvasId)
    expect(copy).not.toBe(first)
    expect(await readdir(copy)).toEqual([])
    await f.execute('first', { kind: 'rename', title: 'Changed title' })
    await f.execute('first', { kind: 'set-archived', archived: true })
    expect(await f.host.ensureCanvasDirectory('first' as CanvasId)).toBe(first)
    await f.execute('first', { kind: 'delete' })
    expect(await readFile(join(first, 'output.txt'), 'utf8')).toBe('keep this work')
    await expect(f.host.ensureCanvasDirectory('first' as CanvasId)).rejects.toMatchObject({ code: 'gateway/bad-request' })
  })

  it('allocates legacy canvases once, preserves the saved path after root changes, and rejects absent canvases without writes', async () => {
    const f = await fixture()
    await expect(f.host.ensureCanvasDirectory('absent' as CanvasId)).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(stat(f.directoryRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    await f.execute('../legacy', { kind: 'create', title: 'Legacy' }, true)
    const [first, second] = await Promise.all([
      f.host.ensureCanvasDirectory('../legacy' as CanvasId), f.host.ensureCanvasDirectory('../legacy' as CanvasId),
    ])
    expect(first).toBe(join(f.directoryRoot, 'canvas-..%2Flegacy'))
    expect(second).toBe(first)
    const replacement = new CanvasWorkingDirectories(f.ctx, f.database, f.repository, join(f.root, 'new-root'))
    expect(await replacement.ensure('../legacy' as CanvasId, new AbortController().signal)).toBe(first)
    expect(f.database.table('directories').size).toBe(1)
  })

  it('leaves the graph uncommitted if its working directory cannot be created and allows a safe retry', async () => {
    const f = await fixture()
    await writeFile(f.directoryRoot, 'a file blocks the configured root')
    await expect(f.execute('blocked', { kind: 'create', title: 'Blocked' })).rejects.toMatchObject({ code: 'canvas-directory/unavailable' })
    expect(f.repository.snapshot().canvases).toEqual([])
    await rm(f.directoryRoot)
    expect((await f.execute('blocked', { kind: 'create', title: 'Retry' })).ok).toBe(true)
    expect((await stat(await f.host.ensureCanvasDirectory('blocked' as CanvasId))).isDirectory()).toBe(true)
  })

  it('binds copied default Chats to their new canvas while retaining explicit folder directories', async () => {
    const f = await fixture()
    const typeId = 'convax.chat' as CanvasNodeTypeId
    const unregister = f.repository.nodeTypes.register({ id: typeId, dataVersion: 1, ports: [], parse: data => data })
    cleanups.push(unregister)
    await f.execute('source', { kind: 'create', title: 'Source' })
    const directory = await f.host.ensureCanvasDirectory('source' as CanvasId)
    for (const [id, cwd] of [['default', directory], ['folder', f.root]] as const) {
      await f.execute('source', { kind: 'add-node', node: {
        id: id as CanvasNodeId, typeId, dataVersion: 1, revision: 0, position: { x: 0, y: 0 }, data: { title: id, cwd },
      } })
    }
    await f.execute('source', { kind: 'duplicate', title: 'Copy', newCanvasId: 'copied' as CanvasId })
    const copy = f.repository.snapshot().canvases.find(canvas => canvas.id === 'copied')!
    const copiedDirectory = await f.host.ensureCanvasDirectory('copied' as CanvasId)
    expect(copy.nodes.map(node => node.data.cwd)).toEqual([copiedDirectory, f.root])
    expect(f.repository.snapshot().canvases.find(canvas => canvas.id === 'source')!.nodes.map(node => node.data.cwd)).toEqual([directory, f.root])
    await f.database.close()
    const reopened = await CanvasDatabase.open({ path: join(f.root, 'canvas.sqlite') })
    cleanups.push(() => reopened.close())
    expect(reopened.table('directories').get('source' as CanvasId)?.path).toBe(directory)
    expect(reopened.table('directories').get('copied' as CanvasId)?.path).toBe(copiedDirectory)
  })

  it('reports a composed filesystem that cannot use the local directory and commits no canvas', async () => {
    const f = await fixture()
    vi.spyOn(f.ctx.fs, 'stat').mockResolvedValueOnce(undefined)
    await expect(f.execute('unavailable', { kind: 'create', title: 'Unavailable' })).rejects.toMatchObject({ code: 'canvas-directory/unavailable' })
    expect(f.repository.snapshot().canvases).toEqual([])
    expect((await stat(join(f.directoryRoot, 'canvas-unavailable'))).isDirectory()).toBe(true)
  })

  it('creates the default directory for graph batch creation and drains provider validation on close', async () => {
    const f = await fixture()
    expect((await f.execute('batch', { kind: 'batch', ops: [{ op: 'canvas.add', title: 'Batch' }] })).ok).toBe(true)
    const source = await f.host.ensureCanvasDirectory('batch' as CanvasId)
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof f.ctx.fs.stat>>>()
    const original = await f.ctx.fs.stat(await f.ctx.fs.resolve(source))
    const probe = vi.spyOn(f.ctx.fs, 'stat').mockReturnValueOnce(pending.promise)
    const reading = f.host.ensureCanvasDirectory('batch' as CanvasId)
    const observed = expect(reading).rejects.toThrow()
    await vi.waitFor(() => { expect(probe).toHaveBeenCalled() })
    let closed = false
    const closing = f.host.close().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    pending.resolve(original)
    await observed
    await closing
  })
})
