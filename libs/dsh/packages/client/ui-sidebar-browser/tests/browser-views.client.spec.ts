// @vitest-environment jsdom
/** Independent browser owners reuse native navigation and checkpoint disposal. */
import { afterEach, expect, it, vi } from 'vitest'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { BrowserViews, type BrowserViewId } from '../src/client/browser/BrowserViews.ts'
import { createBrowserStore } from '../src/client/browser/store.ts'
import { createIframePage } from '../src/client/pages.ts'
import { browserAddressCheckpoint } from '../src/client/browser/BrowserPersistence.ts'

const owners: BrowserViews[] = []
afterEach(async () => {
  await Promise.all(owners.splice(0).map(owner => owner.dispose()))
  document.body.replaceChildren()
  localStorage.clear()
})

function fixture(pageFactory?: ConstructorParameters<typeof BrowserViews>[0]) {
  const owner = new BrowserViews(pageFactory ?? (() => createIframePage))
  owners.push(owner)
  const store = createBrowserStore().create()
  const lifetime = new AbortController()
  const popup = vi.fn()
  const create = (id: string) => {
    owner.create({ id: id as BrowserViewId, signal: lifetime.signal,
      workspace: async () => 'cwd:/canvas', openRequested: popup })
  }
  const mount = (id: string, url?: string) => {
    const host = document.createElement('div')
    host.id = id
    document.body.append(host)
    const unmount = owner.mount(id as BrowserViewId, host.id, url, store.getSnapshot().byTab[id as TabId], store.actions)
    return { host, unmount }
  }
  return { owner, store, lifetime, create, mount }
}

it('keeps independent views alive while another view opens and closes', async () => {
  const f = fixture()
  f.create('first')
  expect(f.owner.states.getSnapshot().first).toBeNull()
  const first = f.mount('first', 'https://first.example/')
  const firstFrame = first.host.querySelector('iframe')
  f.create('second')
  f.mount('second', 'https://second.example/')
  expect(first.host.querySelector('iframe')).toBe(firstFrame)
  await f.owner.close('second' as BrowserViewId)
  expect(first.host.querySelector('iframe')).toBe(firstFrame)
  expect(f.owner.states.getSnapshot().first?.frame.target?.url).toBe('https://first.example/')
  expect(f.store.getSnapshot().byTab['second' as TabId]).toBeUndefined()
  f.lifetime.abort()
  await vi.waitFor(() => { expect(first.host.querySelector('iframe')).toBeNull() })
  expect(f.store.getSnapshot().byTab['first' as TabId]).toBeDefined()
})

it('restores the persisted address only on user request and closes without retaining its checkpoint', async () => {
  const f = fixture()
  f.store.actions.replace('saved' as TabId,
    browserAddressCheckpoint({ kind: 'https', url: 'https://saved.example/', title: 'Saved' }, 1))
  f.create('saved')
  const { host } = f.mount('saved', 'https://configured.example/')
  expect(host.querySelector('iframe')).toBeNull()
  expect(f.owner.states.getSnapshot().saved?.restoreTarget?.url).toBe('https://saved.example/')
  f.owner.restore('saved' as BrowserViewId)
  expect(host.querySelector('iframe')?.src).toBe('https://saved.example/')
  await f.owner.close('saved' as BrowserViewId)
  expect(f.store.getSnapshot().byTab['saved' as TabId]).toBeUndefined()
  expect(host.querySelector('iframe')).toBeNull()
  f.create('saved')
  f.mount('saved')
  expect(f.owner.states.getSnapshot().saved?.restoreTarget).toBeUndefined()
})

it('disposes detached views without revoking another owner or deleting restart checkpoints', async () => {
  const f = fixture()
  f.create('first')
  const first = f.mount('first', 'https://first.example/')
  first.unmount()
  expect(f.owner.states.getSnapshot().first?.frame.target?.url).toBe('https://first.example/')
  f.create('first')
  await f.owner.dispose()
  await f.owner.dispose()
  expect(f.owner.states.getSnapshot()).toEqual({})
  expect(f.store.getSnapshot().byTab['first' as TabId]).toBeDefined()
})

it('offers an undone card configuration for explicit restoration without starting a page', async () => {
  const f = fixture()
  f.owner.create({ id: 'undone' as BrowserViewId, signal: f.lifetime.signal, workspace: async () => 'cwd:/canvas',
    restoreUrl: 'https://configured.example/', openRequested: vi.fn() })
  const { host } = f.mount('undone', 'https://configured.example/')
  expect(host.querySelector('iframe')).toBeNull()
  expect(f.owner.states.getSnapshot().undone?.restoreTarget?.url).toBe('https://configured.example/')
  f.owner.restore('undone' as BrowserViewId)
  expect(host.querySelector('iframe')?.src).toBe('https://configured.example/')
})

it('awaits guest cleanup already started by an owner signal before service shutdown', async () => {
  const drain = Promise.withResolvers<undefined>()
  const f = fixture(() => (options) => {
    const page = createIframePage(options)
    const dispose = page.frame.dispose.bind(page.frame)
    vi.spyOn(page.frame, 'dispose').mockImplementation(async () => { await drain.promise; await dispose() })
    return page
  })
  f.create('draining')
  f.mount('draining', 'https://first.example/')
  f.lifetime.abort()
  let settled = false
  const closing = f.owner.dispose().then(() => { settled = true })
  try {
    await Promise.resolve()
    expect(settled).toBe(false)
  } finally { drain.resolve(undefined) }
  await closing
  expect(settled).toBe(true)
})
