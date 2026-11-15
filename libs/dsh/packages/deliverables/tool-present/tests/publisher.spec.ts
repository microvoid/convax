/** Background delivery retains invocation ownership and durable retry identity. */
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { DeliverablePublisher, DeliveryKeyConflictError } from '../src/publisher.ts'
import type { PublishDeliverables } from '../src/types.ts'

async function fixture(live: boolean) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-background-delivery-')))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  const id = SessionId('background-owner')
  const session = live ? ctx.sessions.create(id, { meta: { cwd: root } }) : Session.create(id, [], {
    id, version: SESSION_FORMAT_VERSION, cwd: root, createdAt: Date.now(), isSeeded: false,
  })
  session.append('turn/start', { turn: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  const writer = await ctx.sessionPersistence.create(session.header)
  await writer.append(session.snapshotEvents())
  await writer.flush()
  if (!live) await writer.close()
  const file = join(root, 'image.png')
  await writeFile(file, Uint8Array.of(1, 2, 3))
  const publisher = new DeliverablePublisher(ctx)
  await publisher.start()
  onTestFinished(async () => {
    await publisher.close()
    await writer.close()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const request: PublishDeliverables = {
    deliveryKey: 'creation:job:output', origin: { sessionId: id, turn: 1, callId: ToolCallId('generate-image') },
    files: [{ path: file, description: 'Product image' }],
  }
  const stored = async () => {
    const reader = await ctx.sessionPersistence.open(id, 'read')
    try { return (await reader.read()).events.filter(event => event.type === 'deliverables/presented') }
    finally { await reader.close() }
  }
  return { ctx, root, session, publisher, request, stored, file }
}

describe.each([true, false])('Host delivery with live Session = %s', (live) => {
  it('publishes a late result into its original turn and flushes before announcing', async () => {
    const f = await fixture(live)
    const announced: string[] = []
    f.ctx.on('deliverables/published', (id, seq) => { announced.push(`${id}:${seq}`) })
    const receipt = await f.publisher.publish(f.request)
    const events = await f.stored()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ seq: receipt.eventSeq, data: {
      deliveryKey: f.request.deliveryKey, turn: 1, callId: 'generate-image', files: f.request.files,
    } })
    expect(announced).toEqual([`${f.session.id}:${receipt.eventSeq}`])
    expect(f.ctx.get('agents')).toBeUndefined()
    expect(f.ctx.sessions.get(f.session.id)).toBe(live ? f.session : undefined)
  })

  it('serializes concurrent retries and returns the same persisted event', async () => {
    const f = await fixture(live)
    const receipts = await Promise.all([f.publisher.publish(f.request), f.publisher.publish(f.request)])
    expect(receipts[0]).toEqual(receipts[1])
    expect(await f.stored()).toHaveLength(1)
    await rm(f.file)
    expect(await f.publisher.publish(f.request)).toEqual(receipts[0])
    expect(await f.stored()).toHaveLength(1)
  })

  it('rejects a changed payload for an existing key without adding an event', async () => {
    const f = await fixture(live)
    await f.publisher.publish(f.request)
    await expect(f.publisher.publish({ ...f.request, files: [{ path: f.file, description: 'Different output' }] }))
      .rejects.toBeInstanceOf(DeliveryKeyConflictError)
    expect(await f.stored()).toHaveLength(1)
  })

  it('contains notification failures after the delivery has committed', async () => {
    const f = await fixture(live)
    const logger = vi.spyOn(f.ctx.logger, 'error').mockImplementation(() => {})
    f.ctx.on('deliverables/published', () => { throw new Error('observer failed') })
    await expect(f.publisher.publish(f.request)).resolves.toMatchObject({ sessionId: f.session.id })
    expect(logger).toHaveBeenCalled()
    expect(await f.stored()).toHaveLength(1)
  })
})

it('recovers the key after the publisher is recreated', async () => {
  const f = await fixture(false)
  const first = await f.publisher.publish(f.request)
  await f.publisher.close()
  const resumed = new DeliverablePublisher(f.ctx)
  await resumed.start()
  try { expect(await resumed.publish(f.request)).toEqual(first) }
  finally { await resumed.close() }
  expect(await f.stored()).toHaveLength(1)
})

it('retains retry identity when a flush fails after live append', async () => {
  const f = await fixture(true)
  vi.spyOn(f.ctx.sessions, 'flush').mockRejectedValueOnce(new Error('disk temporarily unavailable'))
  await expect(f.publisher.publish(f.request)).rejects.toThrow('disk temporarily unavailable')
  await f.publisher.publish(f.request)
  expect(await f.stored()).toHaveLength(1)
})

it('rejects invalid files and cancelled publication before writing a declaration', async () => {
  const f = await fixture(false)
  await symlink(f.file, join(f.root, 'link.png'))
  for (const path of [join(f.root, 'missing.png'), f.root, join(f.root, 'link.png'), 'relative.png']) {
    await expect(f.publisher.publish({ ...f.request, files: [{ path }] })).rejects.toThrow()
  }
  await expect(f.publisher.publish(f.request, AbortSignal.abort())).rejects.toThrow()
  expect(await f.stored()).toEqual([])
  await f.publisher.close()
  await expect(f.publisher.publish(f.request)).rejects.toThrow()
})
