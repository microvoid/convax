/** Production-profile terminal card exercises native PTY output and real Gateway access decisions. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import type {} from '@deepseek-ai/dsh-convax-plugin-inernal-nodes-host'
import type { CanvasCommand, CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId } from '@deepseek-ai/dsh-convax-plugin-host'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TerminalInput, WebTerminalId } from '@deepseek-ai/dsh-api-terminal-controller/types'
import type { RemoteAccessBinding } from '@deepseek-ai/dsh-api-remote-access'
import { bootProductionProfile } from '../../../../libs/dsh/packages/test-support/loader-smoke/tests/fixtures/production-profile.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Test-only application caller with independently assigned Session or global access. */
    'canvas-terminal-test': { readonly kind: 'canvas-terminal-test' }
  }
}

const overlay = process.argv[2]
assert(overlay !== undefined)
const ctx = await bootProductionProfile({ binName: 'convax-terminal-test', profile: 'headless', overlayPaths: [
  fileURLToPath(new URL('../../../plugin-renderer/cordis.patch.yml', import.meta.url)), overlay,
] })
try {
  const hostRow = [...ctx.loader.entries()].find(entry => entry.options.id === 'convax-inernal-nodes-host')
  assert(hostRow?.fiber !== undefined)
  await hostRow.fiber.await()
  assert(ctx.get('convaxTerminal') !== undefined)
  const canvasId = 'terminal-loader-canvas' as CanvasId
  const nodeId = 'terminal-loader-card' as CanvasNodeId
  const id = 'terminal-loader-runtime' as WebTerminalId
  let operation = 0
  const execute = async (command: CanvasCommand) => {
    const operationId = `terminal-loader-${++operation}` as CanvasOperationId
    const result = await ctx.convax.execute({ canvasId, expectedRevision: ctx.convax.repository.revision(canvasId), operationId, command })
    assert(result.ok, JSON.stringify(result))
    return operationId
  }
  await execute({ kind: 'create', title: 'Native terminal card' })
  await execute({ kind: 'add-node', node: { id: nodeId, typeId: 'convax.terminal' as CanvasNodeTypeId,
    dataVersion: 1, revision: 0, data: {}, position: { x: 0, y: 0 } } })
  let bindings: readonly RemoteAccessBinding[] = [{
    role: { name: 'terminal-test-session', resource: 'session', actions: ['convaxTerminal/list', 'convaxTerminal/close'] },
    resource: { kind: 'session', id: 'unrelated-session' as SessionId },
  }]
  const releasePolicy = ctx.remoteAccess.registerPolicy('canvas-terminal-test', { bindings: () => bindings })
  const peer = new Peer(ctx, { principal: { kind: 'canvas-terminal-test' } })
  try {
    await assert.rejects(ctx.typertGateway.invoke({ peer, namespace: 'convaxTerminal', method: 'list', args: { canvasId, nodeId } }),
      { code: 'remote-access/denied' })
    bindings = [{ role: { name: 'terminal-test-global', resource: 'global', actions: ['convaxTerminal/list', 'convaxTerminal/close'] },
      resource: { kind: 'global' } }]
    assert.deepEqual(await ctx.typertGateway.invoke({ peer, namespace: 'convaxTerminal', method: 'list', args: { canvasId, nodeId } }), [])
    const info = await ctx.convaxTerminal.create(canvasId, nodeId, { id, cols: 80, rows: 24 }, new AbortController().signal)
    assert.equal(info.cwd, await ctx.convax.ensureCanvasDirectory(canvasId))
    const ownerPeer = new Peer(ctx, { principal: { kind: 'owner' } })
    const abort = new AbortController()
    let controls!: ReadableStreamDefaultController<TerminalInput>
    const input = new ReadableStream<TerminalInput>({ start(value) { controls = value } })
    const reader = input.getReader()
    const uplink: AsyncIterable<TerminalInput> = { [Symbol.asyncIterator]: () => ({
      async next() {
        const result = await reader.read()
        return result.done ? { done: true, value: undefined } : { done: false, value: result.value }
      },
      async return() { await reader.cancel(); return { done: true, value: undefined } },
    }) }
    const stream = await ctx.typertGateway.stream({ peer: ownerPeer, namespace: 'convaxTerminal', method: 'attach',
      args: { canvasId, nodeId, id }, signal: abort.signal, uplink })
    const outputPath = join(info.cwd, 'terminal-proof.txt')
    const script = "require('node:fs').writeFileSync('terminal-proof.txt','canvas-owned shell');console.log('terminal-proof-written')"
    const command = `"${process.execPath}" -e "${script}"\r`
    controls.enqueue({ type: 'write', sequence: 1, data: command })
    let output: string | undefined
    try {
      for await (const frame of stream) {
        if (typeof frame !== 'object' || frame === null || !('type' in frame) || frame.type !== 'output') continue
        try { output = await readFile(outputPath, 'utf8') }
        catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error }
        if (output === 'canvas-owned shell') break
      }
    } finally { abort.abort(); await ownerPeer.dispose() }
    assert.equal(output, 'canvas-owned shell')
    assert.equal(ctx.convaxTerminal.list(canvasId, nodeId)[0]?.state, 'running')
    const removal = await execute({ kind: 'remove-nodes', nodeIds: [nodeId] })
    await ctx.typertGateway.invoke({ peer, namespace: 'convaxTerminal', method: 'close', args: { canvasId, nodeId, id } })
    await execute({ kind: 'history', targetOperationId: removal, direction: 'undo' })
    assert.deepEqual(ctx.convaxTerminal.list(canvasId, nodeId), [])
    await assert.rejects(ctx.convaxTerminal.create(canvasId, nodeId, { id, cols: 80, rows: 24 }, new AbortController().signal),
      { code: 'terminal/unavailable' })
    await hostRow.update({ disabled: true })
    await ctx.loader.await()
    assert.equal(ctx.get('convaxTerminal'), undefined)
    assert(!ctx.convax.workspace().nodeTypes.some(type => type.id === 'convax.terminal'))
    await writeFile(join(process.cwd(), 'terminal-report.json'), JSON.stringify({ output, cwd: info.cwd,
      globalAccessRequired: true, closeAfterRemoval: true, undoRestoresConfig: true, providerDisposed: true }))
  } finally { await peer.dispose(); releasePolicy() }
} finally { await ctx.fiber.dispose() }
