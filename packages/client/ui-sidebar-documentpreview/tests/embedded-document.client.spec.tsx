// @vitest-environment jsdom
/** Embedded previews use production Factory registration without a Session or Sidebar occurrence. */
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { apply as resourcesApply, inject as resourcesInject } from '@deepseek-ai/dsh-client-resources/src/client/index.ts'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { tabInfoFactory } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-info.ts'
import { apply, inject } from '../src/client/index.ts'
import type { EmbeddedDocumentProps, EmbeddedDocumentSource } from '../src/client/embedded/contract.ts'
import type { openPdf } from '../src/client/pdf/runtime.ts'
import type { PdfDocument } from '../src/client/pdf/document.ts'
import type { parseExcel } from '../src/client/excel/parse.ts'

const engines = vi.hoisted(() => ({
  openPdf: vi.fn<typeof openPdf>(),
  parseExcel: vi.fn<typeof parseExcel>(),
  workbook: vi.fn((_props: unknown) => null),
}))
vi.mock('../src/client/pdf/runtime.ts', () => ({ openPdf: engines.openPdf }))
vi.mock('../src/client/excel/parse.ts', () => ({ parseExcel: engines.parseExcel }))
vi.mock('@fortune-sheet/react', () => ({ Workbook: engines.workbook }))

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function setup(
  sources: readonly EmbeddedDocumentSource[], imageInset?: 'none', gestureMode?: EmbeddedDocumentProps['gestureMode'],
) {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const locale = new LocaleRuntime(runtime.ctx)
  locale.setLocale('en')
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  runtime.ctx.provide('sidebarRightTabs', new SidebarRightTabRegistry(runtime.ctx))
  runtime.ctx.provide('configForms', { developerTools: { enabled: createSnapshotStore(false) } } as never)
  runtime.ctx.provide('fileDrag', {
    actions: { prepare: async () => ({ start: () => true, release: () => {} }), reportFailure: () => {} },
    read: () => undefined,
  } satisfies import('@deepseek-ai/cordis').Context['fileDrag'])
  await runtime.mount({ inject: [...resourcesInject], apply: resourcesApply })
  const read = vi.fn(), readBytes = vi.fn()
  runtime.remote.provideNamespaces({ workspaceFiles: { read, readBytes } })
  await runtime.root.declare({
    'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session', inject: { hooks: { tabInfo: tabInfoFactory } } },
    'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session', inject: { hooks: { tabInfo: tabInfoFactory } } },
  }, ({ renderFactorySlot }) => <>
    {sources.map(source => <div key={source.path} data-file={source.path}>
      {renderFactorySlot('document.preview', {
        source, ...(imageInset === undefined ? {} : { imageInset }), ...(gestureMode === undefined ? {} : { gestureMode }),
      }, {
        fallback: <span>Preview plugin unavailable</span>,
      })}
    </div>)}
  </>)
  const feature = await runtime.mount({ inject: [...inject], apply })
  const view = runtime.renderRoot()
  return { runtime, feature, view, locale, read, readBytes }
}

const bytes = (text: string) => new TextEncoder().encode(text)

it('renders Markdown, code and unknown text through the root Factory without fetching or creating a Session', async () => {
  const h = await setup([
    { path: '/project/notes.md', bytes: bytes('# Notes\n\n![diagram](images/chart.png)') },
    { path: '/project/index.ts', bytes: bytes('export const value = 1') },
    { path: '/project/settings.custom', bytes: bytes('first\nsecond') },
  ])
  expect(await screen.findByRole('heading', { name: 'Notes' })).toBeTruthy()
  await waitFor(() => {
    expect(new URL(screen.getByAltText('diagram').getAttribute('src')!).searchParams.get('path')).toBe('/project/images/chart.png')
  })
  expect(h.view.container.querySelector('[data-file="/project/index.ts"] [data-code-preview]')).not.toBeNull()
  expect(h.view.container.querySelectorAll('[data-file="/project/settings.custom"] [data-textpreview-line]')).toHaveLength(2)
  expect(h.read).not.toHaveBeenCalled()
  expect(h.readBytes).not.toHaveBeenCalled()
  expect(h.view.container.querySelector('[data-document-markdown]')).toMatchSnapshot()
  expect(h.runtime.slots.entries('document.preview.body')).toHaveLength(7)
  await h.feature.dispose()
  expect(h.runtime.slots.spec('document.preview.body')).toBeUndefined()
  expect(screen.getAllByText('Preview plugin unavailable')).toHaveLength(3)
})

it('keeps each viewer selection local and follows locale changes', async () => {
  const h = await setup([
    { path: '/project/one.md', bytes: bytes('# First document') },
    { path: '/project/two.md', bytes: bytes('# Second document') },
  ])
  const menus = await screen.findAllByRole('button', { name: 'Open with' })
  fireEvent.click(menus[0]!)
  fireEvent.click(screen.getByRole('menuitem', { name: 'Plain text' }))
  expect(screen.queryByRole('heading', { name: 'First document' })).toBeNull()
  expect(screen.getByRole('heading', { name: 'Second document' })).toBeTruthy()
  await act(async () => { h.locale.setLocale('zh') })
  expect(screen.getAllByRole('button', { name: '打开方式' })).toHaveLength(2)
})

it('releases image Blob URLs when the embedded preview is removed', async () => {
  const createObjectURL = vi.fn(() => 'blob:embedded-image')
  const revokeObjectURL = vi.fn()
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = createObjectURL
    static override revokeObjectURL = revokeObjectURL
  })
  const h = await setup([{ path: '/project/image.png', bytes: new Uint8Array([1, 2, 3]) }])
  await waitFor(() => { expect(createObjectURL).toHaveBeenCalledTimes(1) })
  expect(h.view.container.querySelector('img')?.getAttribute('src')).toBe('blob:embedded-image')
  h.view.unmount()
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:embedded-image')
})

it.each([
  [undefined, '38%'],
  ['none', '50%'],
] as const)('fits images with imageInset=%s and retains the same image while zooming', async (imageInset, fit) => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100)
  const createObjectURL = vi.fn(() => 'blob:embedded-image')
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = createObjectURL
    static override revokeObjectURL = vi.fn()
  })
  const h = await setup([{ path: '/project/image.png', bytes: new Uint8Array([1, 2, 3]) }], imageInset)
  const image = await screen.findByRole('img', { hidden: true })
  Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 200 })
  fireEvent.load(image)
  const frame = h.view.container.querySelector('[data-image-preview]')
  expect(frame?.getAttribute('data-image-inset')).toBe(imageInset ?? null)
  expect(screen.getByRole('button', { name: 'Choose zoom' }).textContent).toContain(fit)
  fireEvent.click(screen.getByRole('button', { name: 'Choose zoom' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '150%' }))
  expect(screen.getByRole('button', { name: 'Choose zoom' }).textContent).toContain('150%')
  expect(screen.getByRole('img')).toBe(image)
  expect(createObjectURL).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'Choose zoom' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Fit width' }))
  expect(screen.getByRole('button', { name: 'Choose zoom' }).textContent).toContain(fit)
  expect(h.readBytes).not.toHaveBeenCalled()
})

it.each([
  ['/project/movie.mp4', bytes('video bytes')],
  ['/project/song.mp3', bytes('audio bytes')],
  ['/project/binary.custom', new Uint8Array([0, 255])],
])('shows an unavailable preview instead of treating %s as text', async (path, sourceBytes) => {
  await setup([{ path, bytes: sourceBytes }])
  expect(await screen.findByText('Preview is not available for this file type yet.')).toBeTruthy()
  expect(document.querySelector('video, audio, [data-textpreview-plain]')).toBeNull()
})

it('uses the existing static sandbox for HTML content', async () => {
  const h = await setup([{ path: '/project/page.html', bytes: bytes('<h1>Document</h1><script>parent.compromised = true</script>') }])
  const frame = await waitFor(() => {
    const element = h.view.container.querySelector('iframe')
    expect(element).not.toBeNull()
    return element!
  })
  expect(frame.getAttribute('sandbox')).toBe('')
  expect(frame.getAttribute('srcdoc')).toContain('Document')
  expect(frame.getAttribute('srcdoc')).not.toContain('parent.compromised')
  expect(screen.queryByRole('button', { name: 'Interact with content' })).toBeNull()
  expect(h.view.container.querySelector('[data-document-gesture-mode]')).toBeNull()
})

it('declares isolated HTML interaction explicitly without replacing its sandbox or browsing context', async () => {
  const h = await setup([{ path: '/project/page.html', bytes: bytes('<h1>Document</h1><p>Scrollable content</p>') }],
    undefined, 'container')
  const frame = await waitFor(() => {
    const element = h.view.container.querySelector('iframe')
    expect(element).not.toBeNull()
    return element!
  })
  const surface = frame.parentElement!
  expect(h.view.container.querySelector('[data-document-gesture-mode]')?.getAttribute('data-document-gesture-mode')).toBe('container')
  expect(surface.getAttribute('data-gesture-surface')).toBe('container')
  expect(frame.tabIndex).toBe(-1)
  expect(frame.hasAttribute('inert')).toBe(true)
  expect(frame.getAttribute('sandbox')).toBe('')
  const document = frame.getAttribute('srcdoc')
  const enter = screen.getByRole('button', { name: 'Interact with content' })
  expect(enter.getAttribute('aria-pressed')).toBe('false')
  fireEvent.click(enter)
  expect(surface.getAttribute('data-gesture-surface')).toBe('content')
  expect(frame.tabIndex).toBe(0)
  expect(frame.hasAttribute('inert')).toBe(false)
  const leave = screen.getByRole('button', { name: 'Stop interacting' })
  expect(leave.getAttribute('aria-pressed')).toBe('true')
  expect({ surface: surface.getAttribute('data-gesture-surface'), frameTabIndex: frame.tabIndex,
    sandbox: frame.getAttribute('sandbox'), exit: leave.textContent,
  }).toMatchSnapshot('isolated content interaction')
  fireEvent.click(leave)
  expect(surface.getAttribute('data-gesture-surface')).toBe('container')
  expect(frame.tabIndex).toBe(-1)
  expect(frame.hasAttribute('inert')).toBe(true)
  expect(h.view.container.querySelector('iframe')).toBe(frame)
  expect(frame.getAttribute('srcdoc')).toBe(document)
  expect(frame.getAttribute('sandbox')).toBe('')
  expect(h.read).not.toHaveBeenCalled()
  expect(h.readBytes).not.toHaveBeenCalled()
})

it('presents Office-converted PDF bytes with missing-font details and cancels the pending PDF on unmount', async () => {
  const deferred = Promise.withResolvers<PdfDocument>()
  const dispose = vi.fn(async () => {})
  engines.openPdf.mockReset().mockReturnValue({ document: deferred.promise, dispose })
  const pdf = bytes('%PDF converted')
  const h = await setup([{ path: '/project/report.docx', bytes: pdf, renderedAs: 'pdf', missingFonts: ['Unavailable Font'] }])
  await waitFor(() => { expect(engines.openPdf).toHaveBeenCalledTimes(1) })
  expect(engines.openPdf.mock.calls[0]?.[0]).toBe(pdf)
  const signal = engines.openPdf.mock.calls[0]![1]
  expect(signal.aborted).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Missing fonts: 1. Click to view.' }))
  expect(await screen.findByText('Unavailable Font')).toBeTruthy()
  h.view.unmount()
  expect(signal.aborted).toBe(true)
  expect(dispose).toHaveBeenCalledTimes(1)
  await act(async () => { deferred.resolve({ numPages: 0, getPage: vi.fn() }) })
  expect(h.view.container.querySelector('[data-pdf-preview]')).toBeNull()
})

it('passes complete workbook bytes to the existing read-only renderer and cancels parsing on unmount', async () => {
  const deferred = Promise.withResolvers<Awaited<ReturnType<typeof parseExcel>>>()
  engines.parseExcel.mockReset().mockReturnValue(deferred.promise)
  engines.workbook.mockClear()
  const sourceBytes = new Uint8Array([80, 75, 3, 4])
  const h = await setup([{ path: '/project/budget.xlsx', bytes: sourceBytes }], undefined, 'container')
  expect(h.view.container.querySelector('[data-gesture-surface="content"]')).not.toBeNull()
  await waitFor(() => { expect(engines.parseExcel).toHaveBeenCalledTimes(1) })
  const call = engines.parseExcel.mock.calls[0]!
  expect(call[0]).toBe(sourceBytes)
  expect(call[1]).toBe('xlsx')
  expect(call[3].aborted).toBe(false)
  await act(async () => { deferred.resolve({ sheets: [{ name: 'Budget', celldata: [] }], missingResults: 0, unsupportedFeatures: [] }) })
  expect(engines.workbook.mock.calls[0]?.[0]).toMatchObject({ allowEdit: false, forceCalculation: false })
  h.view.unmount()
  expect(call[3].aborted).toBe(true)
})
