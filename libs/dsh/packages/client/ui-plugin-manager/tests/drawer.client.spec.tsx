// @vitest-environment jsdom
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import * as settings from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import { apply, inject, PANEL_ID } from '../src/client/index.ts'

afterEach(cleanup)

it('hosts native plugin content in a right drawer while retaining the canvas and nested dialog ownership', async () => {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const fonts = Object.getOwnPropertyDescriptor(document, 'fonts')
  Object.defineProperty(document, 'fonts', { configurable: true, value: new EventTarget() })
  onTestFinished(() => {
    if (fonts === undefined) Reflect.deleteProperty(document, 'fonts')
    else Object.defineProperty(document, 'fonts', fonts)
  })
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  })
  onTestFinished(() => { vi.unstubAllGlobals() })
  const locale = new LocaleRuntime(runtime.ctx)
  locale.setLocale('en')
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  const list = vi.fn(async () => ({ ok: true as const, value: { entries: [], managementAvailable: true } }))
  runtime.remote.provideNamespaces({
    settings: { describe: async () => ({ ok: true as const, value: { writable: true, hasDocument: true, namespaces: [] } }) },
    pluginInventory: { list },
    pluginRegistryProbe: { fastest: async () => ({ ok: true as const, value: null }) },
    pluginManager: {
      listBundles: async () => ({ ok: true as const, value: [] }),
      listPlugins: async () => ({ ok: true as const, value: [] }),
      registries: async () => ({ ok: true as const, value: { registry: null, fallbackRegistries: [], resolved: null } }),
      readBundleDetail: async () => ({ ok: true as const, value: { status: 'none' as const } }),
    },
  })
  const selectPanel = vi.fn<ILayout['selectPanel']>((activePanelId) => { runtime.panelInfo.set({ activePanelId }) })
  runtime.ctx.provide('layout', {
    panelInfo: runtime.panelInfo, selectPanel, beginNavigation: () => new AbortController().signal,
    toggleSidebar: vi.fn(), openRightbar: vi.fn(), closeRightbar: vi.fn(),
  })
  await runtime.mount(settings)
  const open = (): void => { runtime.ctx.pluginNavigation.openList({ presentation: 'drawer' }) }
  await runtime.root.declare({
    main: { kind: 'keyed', scope: 'root' },
    'shell.overlay': { kind: 'list', scope: 'root' },
    'sidebar.panellist': { kind: 'list', scope: 'root' },
  }, ({ renderSlot, usePanelInfo }) => <>
    <button type="button" onClick={open}>Workspace plugins</button>
    {usePanelInfo(value => value.activePanelId) === PANEL_ID
      ? renderSlot('main', {}, { entryKey: PANEL_ID })
      : <div data-testid="canvas">Retained canvas</div>}
    {renderSlot('shell.overlay', {})}
  </>)
  const feature = await runtime.mount({ inject: [...inject], apply })
  runtime.renderRoot()
  const opener = screen.getByRole('button', { name: 'Workspace plugins' })
  opener.focus()
  fireEvent.click(opener)
  const drawer = await screen.findByRole('dialog', { name: 'Plugins' })
  expect(drawer.parentElement?.dataset.placement).toBe('right')
  expect(drawer.querySelector('[data-plugin-presentation="drawer"]')).not.toBeNull()
  expect(screen.getByTestId('canvas').textContent).toBe('Retained canvas')
  expect(selectPanel).not.toHaveBeenCalled()
  await waitFor(() => { expect(within(drawer).getByRole<HTMLButtonElement>('button', { name: 'Add plugin' }).disabled).toBe(false) })
  fireEvent.click(within(drawer).getByRole('button', { name: 'Add plugin' }))
  const install = await screen.findByRole('dialog', { name: 'Add plugin' })
  expect(screen.getAllByRole('dialog')).toHaveLength(2)
  fireEvent.keyDown(document.activeElement ?? install, { key: 'Escape' })
  await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Add plugin' })).toBeNull() })
  expect(screen.getByRole('dialog', { name: 'Plugins' })).toBe(drawer)
  fireEvent.keyDown(document.activeElement ?? drawer, { key: 'Escape' })
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  expect(document.activeElement).toBe(opener)
  expect(screen.getByTestId('canvas').textContent).toBe('Retained canvas')
  expect(selectPanel).not.toHaveBeenCalled()
  act(() => { runtime.ctx.pluginNavigation.openList() })
  expect(selectPanel).toHaveBeenCalledWith(PANEL_ID)
  await waitFor(() => { expect(document.querySelector('[data-plugin-presentation="page"]')).not.toBeNull() })
  expect(screen.queryByRole('dialog')).toBeNull()
  act(open)
  await screen.findByRole('dialog', { name: 'Plugins' })
  expect(document.querySelectorAll('[data-plugin-panel]')).toHaveLength(1)
  expect(document.querySelector('[data-plugin-presentation="page"]')).toBeNull()
  expect(runtime.panelInfo.getSnapshot().activePanelId).toBe(PANEL_ID)
  await feature.dispose()
  expect(runtime.slots.entries('main')).toHaveLength(0)
  expect(runtime.slots.entries('shell.overlay')).toHaveLength(0)
  expect(runtime.slots.spec('plugins.item')).toBeUndefined()
  expect(runtime.ctx.get('pluginNavigation')).toBeUndefined()
})
