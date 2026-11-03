// @vitest-environment jsdom
/** Exercise the committed example factory through real Client slots and renderer registration. */
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import type { Context } from '@deepseek-ai/cordis'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { CanvasCommand, CanvasCommandRequest, CanvasCommandResult, CanvasId, CanvasNodeId,
  CanvasNodeTypeId, CanvasWorkspace } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import * as React from 'react'
import { act, cleanup, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { ConvaxRenderer } from '../src/client/node-renderers.tsx'
import type { CanvasNodeOwner } from '../src/client/props.ts'
import { NS, en, zh } from '../src/client/locales.ts'

interface ExamplePlugin {
  inject: string[]
  apply(ctx: Context): void
}

interface BrowserRegistration {
  id: string
  factory(require: (specifier: string) => object): ExamplePlugin
}

const typeId = 'example.convax.counter' as CanvasNodeTypeId
const canvasId = 'example-board' as CanvasId
const secondCanvasId = 'other-board' as CanvasId
const nodeId = 'example-counter' as CanvasNodeId
const source = readFileSync(resolve(import.meta.dirname, '../examples/counter/client.js'), 'utf8')

function examplePlugin(): ExamplePlugin {
  let registration: BrowserRegistration | undefined
  runInNewContext(source, {
    AbortController, crypto: { randomUUID },
    window: { __ModuleLoader__: { load: (value: BrowserRegistration) => { registration = value } } },
  })
  if (registration === undefined) throw new Error('Example did not publish its browser factory')
  expect(registration.id).toBe('@local/dsh-convax-counter-example')
  return registration.factory((specifier) => {
    if (specifier === 'react') return React
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return { Button }
    throw new Error(`Unexpected example runtime dependency: ${specifier}`)
  })
}

function workspace(): CanvasWorkspace {
  return {
    revision: 11,
    canvases: [
      { id: canvasId, title: 'First board', revision: 4, nodes: [], connections: [] },
      { id: secondCanvasId, title: 'Other board', revision: 7, nodes: [], connections: [] },
    ],
    nodeTypes: [{ id: typeId, dataVersion: 1, ports: [] }], chats: [], nodeIssues: [],
  }
}

function owner(command: (command: CanvasCommand) => Promise<boolean>, value = 2): CanvasNodeOwner {
  return {
    node: { id: nodeId, typeId, dataVersion: 1, data: { value }, revision: 0, position: { x: 160, y: 120 } },
    canvasId, canvasRevision: 4, definition: { id: typeId, dataVersion: 1, ports: [] },
    ports: [], selected: false, busy: false, chat: undefined, command, remove: vi.fn(),
    openResource: vi.fn(), openSource: vi.fn(), createChat: vi.fn(),
    focusSessionId: undefined, consumeFocus: vi.fn(), inputs: [], focusNode: vi.fn(),
    resourceExpanded: false, setResourceExpanded: vi.fn(), setResourcePreviewSize: vi.fn(),
  }
}

async function fixture(options: { connected?: boolean } = {}) {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const activationErrors: string[] = []
  runtime.ctx.logger.exporter({ export(message) {
    if (message.type === 'error') activationErrors.push(message.args.map(value => value instanceof Error ? value.stack : String(value)).join(' '))
  } })
  onTestFinished(() => { expect(activationErrors).toEqual([]) })
  const locale = new LocaleRuntime(runtime.ctx)
  locale.setLocale('en')
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  runtime.ctx.effect(() => locale.register(NS, { en, zh }))
  await runtime.declare({
    'shell.overlay': { kind: 'list', scope: 'root' },
    'convax.node': { kind: 'keyed', scope: 'root' },
  })
  const current = workspace()
  const list = vi.fn<() => Promise<RemoteResult<CanvasWorkspace>>>(async () => ({ ok: true, value: current }))
  const execute = vi.fn<(request: CanvasCommandRequest) => Promise<RemoteResult<CanvasCommandResult>>>(async () => ({
    ok: true, value: { ok: true, workspace: current },
  }))
  const connect = async () => {
    await runtime.mount({ inject: ['slots'], apply(ctx) { new ConvaxRenderer(ctx) } })
    runtime.remote.provideNamespaces({ convax: { workspace: list, execute } })
  }
  if (options.connected !== false) await connect()
  const handle = await runtime.mount(examplePlugin())
  return { runtime, locale, current, list, execute, handle, connect }
}

afterEach(() => { cleanup() })

describe('Convax counter example Client', () => {
  it('waits for optional canvas services and removes its visible entries on unload', async () => {
    const b = await fixture({ connected: false })
    expect(b.runtime.slots.entries('shell.overlay')).toHaveLength(0)
    expect(b.runtime.slots.entries('convax.node')).toHaveLength(0)
    await b.connect()
    await vi.waitFor(() => {
      expect(b.runtime.slots.entries('shell.overlay')).toHaveLength(1)
      expect(b.runtime.slots.entries('convax.node')).toHaveLength(1)
    })
    await b.handle.dispose()
    expect(b.runtime.slots.entries('shell.overlay')).toHaveLength(0)
    expect(b.runtime.slots.entries('convax.node')).toHaveLength(0)
    expect(b.list).not.toHaveBeenCalled()
    expect(b.execute).not.toHaveBeenCalled()
  })

  it('updates through the node command and waits for the committed revision before another edit', async () => {
    const b = await fixture()
    const saved = Promise.withResolvers<boolean>()
    try {
      const command = vi.fn<(command: CanvasCommand) => Promise<boolean>>(() => saved.promise)
      const props = owner(command)
      const view = b.runtime.renderSlot('convax.node', props, { entryKey: typeId })
      const increase = view.view.getByRole('button', { name: 'Increase' })
      fireEvent.click(increase)
      expect(command).toHaveBeenCalledExactlyOnceWith({
        kind: 'update-node', nodeId, dataVersion: 1, data: { value: 3 },
      })
      expect(increase.hasAttribute('disabled')).toBe(true)
      expect(view.view.getByLabelText('Counter value').textContent).toBe('2')
      await act(async () => { saved.resolve(true); await saved.promise })
      expect(increase.hasAttribute('disabled')).toBe(true)
      view.update({ ...props, node: { ...props.node, data: { value: 3 }, revision: 1 }, canvasRevision: 5 })
      expect(view.view.getByLabelText('Counter value').textContent).toBe('3')
      expect(increase.hasAttribute('disabled')).toBe(false)
      fireEvent.click(view.view.getByRole('button', { name: 'Remove reference' }))
      expect(props.remove).toHaveBeenCalledOnce()
      expect(b.execute).not.toHaveBeenCalled()
    } finally { saved.resolve(false) }
  })

  it('reports a rejected save, respects busy state and guards safe-integer limits', async () => {
    const b = await fixture()
    const command = vi.fn(async () => false)
    const props = owner(command)
    const view = b.runtime.renderSlot('convax.node', { ...props, busy: true }, { entryKey: typeId })
    fireEvent.click(view.view.getByRole('button', { name: 'Increase' }))
    expect(command).not.toHaveBeenCalled()
    view.update(props)
    fireEvent.click(view.view.getByRole('button', { name: 'Decrease' }))
    await vi.waitFor(() => {
      expect(view.view.getByText('Saving was not confirmed. Check the latest value before trying again.')).toBeDefined()
    })
    expect(command).toHaveBeenCalledExactlyOnceWith({
      kind: 'update-node', nodeId, dataVersion: 1, data: { value: 1 },
    })
    expect(view.view.getByLabelText('Counter value').textContent).toBe('2')
    view.update({ ...props, node: { ...props.node, data: { value: Number.MAX_SAFE_INTEGER }, revision: 1 } })
    expect(view.view.getByRole('button', { name: 'Increase' }).hasAttribute('disabled')).toBe(true)
    expect(view.view.getByRole('button', { name: 'Decrease' }).hasAttribute('disabled')).toBe(false)
  })

  it('creates on the explicitly selected canvas and reports revision conflicts without retrying', async () => {
    const b = await fixture()
    const rejected = structuredClone(b.current)
    rejected.canvases[1]!.revision = 8
    b.execute.mockResolvedValueOnce({ ok: true, value: {
      ok: false, code: 'conflict', message: 'stale canvas', workspace: rejected,
    } })
    const view = b.runtime.renderSlot('shell.overlay', {})
    await vi.waitFor(() => { expect(view.view.getByRole('button', { name: 'Add counter' }).hasAttribute('disabled')).toBe(false) })
    fireEvent.change(view.view.getByRole('combobox', { name: 'Target canvas' }), { target: { value: secondCanvasId } })
    fireEvent.click(view.view.getByRole('button', { name: 'Add counter' }))
    await vi.waitFor(() => { expect(view.view.getByRole('status').textContent).toContain('The canvas changed') })
    expect(b.execute).toHaveBeenCalledOnce()
    expect(b.execute.mock.calls[0]?.[0]).toMatchObject({
      canvasId: secondCanvasId, expectedRevision: 7,
      command: { kind: 'add-node', node: { typeId, dataVersion: 1, data: { value: 0 }, revision: 0 } },
    })
    expect(b.execute.mock.calls[0]?.[0].operationId).toMatch(/^[\da-f-]{36}$/u)
    expect(view.view.getByRole('button', { name: 'Add counter' }).hasAttribute('disabled')).toBe(false)
  })

  it('retains an uncertain creation request for an identical explicit retry', async () => {
    const b = await fixture()
    b.execute.mockRejectedValueOnce(new Error('response lost'))
    const view = b.runtime.renderSlot('shell.overlay', {})
    await vi.waitFor(() => { expect(view.view.getByRole('button', { name: 'Add counter' }).hasAttribute('disabled')).toBe(false) })
    fireEvent.click(view.view.getByRole('button', { name: 'Add counter' }))
    await vi.waitFor(() => { expect(view.view.getByRole('button', { name: 'Retry creation' }).hasAttribute('disabled')).toBe(false) })
    const first = b.execute.mock.calls[0]?.[0]
    expect(first).toBeDefined()
    expect(view.view.getByRole('combobox', { name: 'Target canvas' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(view.view.getByRole('button', { name: 'Retry creation' }))
    await vi.waitFor(() => { expect(b.execute).toHaveBeenCalledTimes(2) })
    expect(b.execute.mock.calls[1]?.[0]).toEqual(first)
    expect(view.view.queryByText('Creation was not confirmed. Refresh to check, or retry this request.')).toBeNull()
  })

  it('reports a failed canvas query and drains an owned query before unload completes', async () => {
    const b = await fixture()
    const pending = Promise.withResolvers<RemoteResult<CanvasWorkspace>>()
    try {
      b.list.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/bad-request', 'query unavailable', {}) })
      const view = b.runtime.renderSlot('shell.overlay', {})
      await vi.waitFor(() => { expect(view.view.getByRole('status').textContent).toContain('Canvases could not be loaded') })
      b.list.mockImplementationOnce(() => pending.promise)
      fireEvent.click(view.view.getByRole('button', { name: 'Refresh' }))
      await vi.waitFor(() => { expect(b.list).toHaveBeenCalledTimes(2) })
      let closed = false
      const closing = b.handle.dispose().then(() => { closed = true })
      expect(closed).toBe(false)
      await act(async () => { pending.resolve({ ok: true, value: b.current }); await closing })
      expect(closed).toBe(true)
      expect(b.runtime.slots.entries('shell.overlay')).toHaveLength(0)
      expect(b.runtime.slots.entries('convax.node')).toHaveLength(0)
      expect(b.execute).not.toHaveBeenCalled()
    } finally { pending.resolve({ ok: true, value: b.current }) }
  })
})
