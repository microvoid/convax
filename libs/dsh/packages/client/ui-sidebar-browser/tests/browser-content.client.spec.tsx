// @vitest-environment jsdom
/** Independent browser content retains its page across its owner's visibility and title changes. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { BrowserViews, type BrowserViewId } from '../src/client/browser/BrowserViews.ts'
import { createBrowserStore } from '../src/client/browser/store.ts'
import { createIframePage } from '../src/client/pages.ts'
import { BrowserContent, browserContentInjected, type BrowserContentProps } from '../src/client/view/BrowserContent.tsx'
import { en } from '../src/client/locales.ts'

const owners: BrowserViews[] = []
afterEach(async () => {
  cleanup()
  await Promise.all(owners.splice(0).map(owner => owner.dispose()))
  localStorage.clear()
})

function selector<T>(source: { getSnapshot: () => T; subscribe: (listener: () => void) => () => void }) {
  return function useSelector<S>(select: (value: T) => S): S {
    return select(useSyncExternalStore(source.subscribe, source.getSnapshot))
  }
}

it('uses the shared navigation controls without remounting when the owning canvas is hidden', async () => {
  const owner = new BrowserViews(() => createIframePage)
  owners.push(owner)
  const lifetime = new AbortController()
  owner.create({ id: 'card' as BrowserViewId, signal: lifetime.signal, workspace: async () => 'cwd:/canvas', openRequested: vi.fn() })
  const store = createBrowserStore().create()
  const { hooks: _hooks, ...commands } = browserContentInjected(owner, store.actions)
  const props = { browserId: 'card' as BrowserViewId, initialUrl: 'https://first.example/', ...commands,
    useBrowserViews: selector(owner.states), useStore: selector(store), actions: store.actions,
    t: ((key: keyof typeof en) => en[key]) as BrowserContentProps['t'],
  } as BrowserContentProps
  const page = render(<div><BrowserContent {...props} /></div>)
  const frame = page.container.querySelector('iframe')
  expect(frame?.src).toBe('https://first.example/')
  const address = screen.getByRole('textbox', { name: en['address.placeholder'] })
  address.focus()
  expect(document.activeElement).toBe(address)
  page.rerender(<div hidden><BrowserContent {...props} active={false} initialUrl="https://changed-config.example/" /></div>)
  expect(document.activeElement).not.toBe(address)
  expect(page.container.querySelector<HTMLElement>('[data-browser-view]')?.inert).toBe(true)
  expect(page.container.querySelector('iframe')).toBe(frame)
  page.rerender(<div><BrowserContent {...props} /></div>)
  fireEvent.change(screen.getByRole('textbox', { name: en['address.placeholder'] }), { target: { value: 'https://second.example/' } })
  fireEvent.click(screen.getByRole('button', { name: en.go }))
  expect(page.container.querySelector('iframe')?.src).toBe('https://second.example/')
  await act(async () => { await owner.close('card' as BrowserViewId) })
  expect(page.container.querySelector('iframe')).toBeNull()
})
