/** Canvas terminal models own restart failures and drain detached Client work without ending Host processes. */
import { Context } from '@deepseek-ai/cordis'
import { ClientTerminals, type TerminalRemoteFor } from '@deepseek-ai/dsh-api-terminal-controller/client'
import type { TerminalEnvironment, WebTerminalInfo, WebTerminalId } from '@deepseek-ai/dsh-api-terminal-controller/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { RemoteStream, type ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import { RemoteMock, streamMethod } from '@deepseek-ai/dsh-remote-mock'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-convax-plugin-inernal-nodes-host/remote'
import type { CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasWorkspace } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { afterEach, expect, it, vi } from 'vitest'
import { CanvasTerminalCards } from '../src/client/terminal-cards.ts'

const canvasId = 'terminal-canvas' as CanvasId
const nodeId = 'terminal-node' as CanvasNodeId
const info: WebTerminalInfo = { id: 'terminal-runtime' as WebTerminalId, cwd: '/workspace', title: 'sh',
  shell: { name: 'sh', path: '/bin/sh', args: ['-i'] }, cols: 80, rows: 24, state: 'running', exitCode: null }
const environment: TerminalEnvironment = { cwd: info.cwd, maxInputBytes: 1000, maxBufferedBytes: 100_000,
  maxCols: 200, maxRows: 100, scrollback: 100 }
const success = <T>(value: T): RemoteResult<T> => ({ ok: true, value })
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function workspace(present = true): CanvasWorkspace {
  return { revision: 1, canvases: [{ id: canvasId, title: 'Tools', revision: 1, connections: [],
    nodes: present ? [{ id: nodeId, typeId: 'convax.terminal' as CanvasNodeTypeId, dataVersion: 1, revision: 1,
      data: {}, position: { x: 0, y: 0 } }] : [] }], nodeTypes: [], chats: [], nodeIssues: [] }
}

function fixture() {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const api: ClientRemote['convaxTerminal'] = {
    environment: vi.fn(async () => success(environment)), shells: vi.fn(async () => success([info.shell])),
    list: vi.fn(async () => success([])),
    create: vi.fn<ClientRemote['convaxTerminal']['create']>(async (_canvas, _node, request) => success({ ...info, id: request.id })),
    rename: vi.fn(async () => success(undefined)), close: vi.fn(async () => success(undefined)),
    retain: streamMethod<ClientRemote['convaxTerminal']['retain']>(async function* () { yield { type: 'retained' } }),
    attach: streamMethod<ClientRemote['convaxTerminal']['attach']>(async function* () {
      yield { type: 'snapshot', sequence: 0, screen: '', info, writable: true }
    }),
  }
  const native = RemoteMock.create()
  const gateway: Pick<ClientRemote, '$stream'> = { $stream: options => new RemoteStream({ generation: createSnapshotStore(undefined) }, options) }
  ctx.provide('remote', { ...gateway, convaxTerminal: api } as never)
  ctx.provide('connection', { generation: createSnapshotStore(undefined) } as never)
  const factory = new ClientTerminals(ctx, native.remote.terminal)
  const cards = new CanvasTerminalCards(factory, ctx.remote)
  cleanups.push(() => cards.dispose())
  return { ctx, api, factory, cards }
}

it('passes the explicit canvas resource to the shared model factory without creating a Session', async () => {
  const f = fixture()
  const create = vi.spyOn(f.factory, 'createView')
  f.cards.observe(workspace())
  const model = f.cards.model(nodeId)!
  await model.refresh()
  expect(create).toHaveBeenCalledOnce()
  expect(create.mock.calls[0]?.[0]).toEqual({ canvasId, nodeId })
  expect(f.api.environment).toHaveBeenCalledWith(canvasId, nodeId, expect.any(AbortSignal))
  expect(f.api.create).toHaveBeenCalledWith(canvasId, nodeId, expect.objectContaining({ id: model.id }), expect.any(AbortSignal))
  f.cards.observe(workspace())
  expect(f.cards.model(nodeId)).toBe(model)
  expect(f.api.close).not.toHaveBeenCalled()
})

it('keeps a failed restart visible and resolves the button action without an unhandled rejection', async () => {
  const f = fixture()
  f.cards.observe(workspace())
  await f.cards.model(nodeId)!.refresh()
  vi.mocked(f.api.close).mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/bad-request', 'Shell cleanup failed', {}) })
  await expect(f.cards.restart(nodeId)).resolves.toBeUndefined()
  expect(f.cards.state(nodeId)?.getSnapshot()).toMatchObject({ phase: 'failed', writable: false, error: 'Shell cleanup failed' })
  expect(f.api.create).toHaveBeenCalledOnce()
})

it('joins duplicate restarts and never replaces a model after its card was removed during close', async () => {
  const f = fixture()
  f.cards.observe(workspace())
  await f.cards.model(nodeId)!.refresh()
  const close = Promise.withResolvers<RemoteResult<void>>()
  vi.mocked(f.api.close).mockReturnValueOnce(close.promise)
  const first = f.cards.restart(nodeId)
  const second = f.cards.restart(nodeId)
  expect(first).toBe(second)
  f.cards.observe(workspace(false))
  close.resolve(success(undefined))
  await first
  await f.cards.dispose()
  expect(f.cards.model(nodeId)).toBeUndefined()
  expect(f.api.create).toHaveBeenCalledOnce()
})

it('contains background close failures while disposing deleted card models', async () => {
  const f = fixture()
  const report = vi.spyOn(console, 'error').mockImplementation(() => {})
  cleanups.push(() => { report.mockRestore() })
  f.cards.observe(workspace())
  await f.cards.model(nodeId)!.refresh()
  vi.mocked(f.api.close).mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/bad-request', 'Transport disconnected', {}) })
  f.cards.observe(workspace(false))
  await expect(f.cards.dispose()).resolves.toBeUndefined()
  expect(report).toHaveBeenCalledWith('Canvas terminal cleanup failed', expect.any(Error))
})

it('drains resource-owned discovery before shared model factory disposal without closing Host terminals', async () => {
  const f = fixture()
  const owner = { canvasId, nodeId }
  const listing = Promise.withResolvers<RemoteResult<WebTerminalInfo[]>>()
  vi.mocked(f.api.list).mockReturnValueOnce(listing.promise)
  const transport: TerminalRemoteFor<typeof owner> = {
    environment: (target, signal) => f.api.environment(target.canvasId, target.nodeId, signal),
    shells: (target, signal) => f.api.shells(target.canvasId, target.nodeId, signal),
    list: target => f.api.list(target.canvasId, target.nodeId),
    create: (target, request, signal) => f.api.create(target.canvasId, target.nodeId, request, signal),
    attach: (target, id, signal) => f.api.attach(target.canvasId, target.nodeId, id, signal),
    retain: (target, id, signal) => f.api.retain(target.canvasId, target.nodeId, id, signal),
    rename: (target, id, title) => f.api.rename(target.canvasId, target.nodeId, id, title),
    close: (target, id) => f.api.close(target.canvasId, target.nodeId, id),
  }
  const view = f.factory.createView(owner, transport, info.id, new AbortController().signal, false)
  const refresh = view.refresh()
  expect(f.api.list).toHaveBeenCalledOnce()
  let disposed = false
  const disposal = f.ctx.fiber.dispose().then(() => { disposed = true })
  await Promise.resolve()
  expect(disposed).toBe(false)
  listing.resolve(success([info]))
  await Promise.all([refresh, disposal])
  expect(f.api.close).not.toHaveBeenCalled()
})

it('uses the latest committed shell choice when starting a replacement instance', async () => {
  const f = fixture()
  const initial = workspace()
  initial.canvases[0]!.nodes[0]!.data.shellPath = '/bin/fish'
  f.cards.observe(initial)
  await f.cards.model(nodeId)!.refresh()
  expect(f.api.create).toHaveBeenLastCalledWith(canvasId, nodeId,
    expect.objectContaining({ shellPath: '/bin/fish' }), expect.any(AbortSignal))
  const changed = workspace()
  changed.canvases[0]!.nodes[0]!.data.shellPath = '/bin/zsh'
  f.cards.observe(changed)
  await f.cards.restart(nodeId)
  expect(f.api.create).toHaveBeenLastCalledWith(canvasId, nodeId,
    expect.objectContaining({ shellPath: '/bin/zsh' }), expect.any(AbortSignal))
})
