// @vitest-environment jsdom
/** Third-party card dictionaries follow the shared language without replacing user data. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import type { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CanvasId, CanvasNodeId, CanvasNodeTypeId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import * as React from 'react'
import { act, cleanup, fireEvent } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { ConvaxRenderer } from '../src/client/node-renderers.tsx'
import type { CanvasNodeOwner } from '../src/client/props.ts'
import { NS, en, zh } from '../src/client/locales.ts'

interface BrowserPlugin {
  inject: string[]
  apply(ctx: Context): void
}

interface BrowserRegistration {
  factory(require: (specifier: string) => object): BrowserPlugin
}

const counterDirectory = resolve(import.meta.dirname, '../examples/counter')
const noteDirectory = resolve(import.meta.dirname, '../../plugin-host/templates/canvas-note')
const languageLabels = [
  { id: 'en', counter: 'Increase', text: 'Note text', save: 'Save' },
  { id: 'zh', counter: '增加', text: '笔记内容', save: '保存' },
  { id: 'ja', counter: '増やす', text: 'メモの内容', save: '保存' },
  { id: 'es', counter: 'Aumentar', text: 'Texto de la nota', save: 'Guardar' },
  { id: 'fr', counter: 'Augmenter', text: 'Texte de la note', save: 'Enregistrer' },
  { id: 'de', counter: 'Erhöhen', text: 'Notiztext', save: 'Speichern' },
  { id: 'ru', counter: 'Увеличить', text: 'Текст заметки', save: 'Сохранить' },
  { id: 'pt', counter: 'Aumentar', text: 'Texto da nota', save: 'Salvar' },
] as const

function plugin(directory: string): BrowserPlugin {
  let registration: BrowserRegistration | undefined
  runInNewContext(readFileSync(resolve(directory, 'client.js'), 'utf8'), {
    AbortController, crypto: { randomUUID },
    window: { __ModuleLoader__: { load: (value: BrowserRegistration) => { registration = value } } },
  })
  if (registration === undefined) throw new Error('Example did not register its Client factory')
  return registration.factory((specifier) => {
    if (specifier === 'react') return React
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return { Button }
    throw new Error(`Unexpected example dependency: ${specifier}`)
  })
}

function owner(typeId: CanvasNodeTypeId): CanvasNodeOwner {
  return {
    node: { id: String(typeId) as CanvasNodeId, typeId, dataVersion: 1, data: { value: 2, text: 'User-authored note' },
      revision: 1, position: { x: 0, y: 0 } },
    canvasId: 'plugin-locale-canvas' as CanvasId, canvasRevision: 1,
    definition: { id: typeId, dataVersion: 1, ports: [] }, ports: [], selected: false, busy: false, chat: undefined,
    command: vi.fn(async () => true), remove: vi.fn(), openResource: vi.fn(), openSource: vi.fn(), createChat: vi.fn(),
    focusSessionId: undefined, consumeFocus: vi.fn(), inputs: [], focusNode: vi.fn(), resourceExpanded: false,
    setResourceExpanded: vi.fn(), setResourcePreviewSize: vi.fn(),
  }
}

afterEach(() => { cleanup() })

it.each(['counter', 'note'] as const)('updates the %s card namespace across all shared languages without changing content', async (kind) => {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  for (const language of languageLabels.filter(language => language.id !== 'en' && language.id !== 'zh')) {
    runtime.ctx.effect(() => locale.addLanguage({ id: language.id, label: language.id, fallback: 'en' }))
  }
  locale.setLocale('en')
  runtime.ctx.effect(() => locale.register(NS, { en, zh }))
  await runtime.declare({ 'shell.overlay': { kind: 'list', scope: 'root' }, 'convax.node': { kind: 'keyed', scope: 'root' } })
  await runtime.mount({ inject: ['slots'], apply(ctx) { new ConvaxRenderer(ctx) } })
  runtime.remote.provideNamespaces({ convax: {} })
  await runtime.mount(plugin(counterDirectory))
  await runtime.mount(plugin(noteDirectory))
  const counterType = 'example.convax.counter' as CanvasNodeTypeId
  const noteType = 'local.note' as CanvasNodeTypeId
  const typeId = kind === 'counter' ? counterType : noteType
  const card = owner(typeId)
  const original = structuredClone(card.node.data)
  const view = runtime.renderSlot('convax.node', card, { entryKey: typeId })
  if (kind === 'note') {
    fireEvent.change(view.view.getByRole('textbox', { name: 'Note text' }), { target: { value: 'Keep this draft verbatim' } })
  }
  for (const language of languageLabels) {
    await act(async () => { locale.setLocale(language.id) })
    if (kind === 'counter') {
      expect(view.view.getByRole('button', { name: language.counter })).toBeDefined()
      expect(view.container.querySelector('output')?.textContent).toBe('2')
    } else {
      expect(view.view.getByRole('button', { name: language.save })).toBeDefined()
      expect(view.view.getByRole('textbox', { name: language.text })).toHaveProperty('value', 'Keep this draft verbatim')
    }
  }
  expect(card.command).not.toHaveBeenCalled()
  expect(card.node.data).toEqual(original)
})

it('ships metadata for every supported language without duplicating runtime card dictionaries', () => {
  for (const directory of [counterDirectory, noteDirectory]) {
    for (const { id } of languageLabels) {
      const metadata: unknown = JSON.parse(readFileSync(resolve(directory, `locale/${id}.json`), 'utf8'))
      expect(metadata).toHaveProperty('meta.title')
      expect(metadata).toHaveProperty('meta.description')
      if (typeof metadata !== 'object' || metadata === null) throw new Error('Expected package metadata')
      expect(Object.keys(metadata)).toEqual(['meta'])
    }
  }
})
