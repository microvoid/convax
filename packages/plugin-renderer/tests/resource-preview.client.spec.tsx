// @vitest-environment jsdom
/** Canvas previews acquire complete document resources and keep their status within the card. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps, ReactNode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { CanvasDocumentPreview } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { ResourceSnapshot } from '@deepseek-ai/dsh-client-resources/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { ResourcePreview } from '../src/client/ResourcePreview.tsx'
import { en, type ConvaxKey } from '../src/client/locales.ts'
import { resourceAddress } from '../src/client/resources.ts'

afterEach(cleanup)

function fixture(path = '/project/notes.md') {
  const document: CanvasDocumentPreview = {
    path, name: 'notes.md', size: 12, version: 'file-v1',
    bytes: new Uint8Array([35, 32, 78, 111, 116, 101, 115]), mimeType: 'text/markdown',
  }
  let snapshot: ResourceSnapshot<CanvasDocumentPreview> = { status: 'live', value: document, failure: undefined }
  let provider = true
  const useResource = vi.fn((_address: string) => snapshot)
  const renderFactorySlot = vi.fn((_name: string, owner: { source?: CanvasDocumentPreview; path?: string },
    options: { fallback: ReactNode }) => provider ? <div data-shared-preview="">{owner.source?.path ?? owner.path}</div> : options.fallback)
  const props = {
    path, useResource, renderFactorySlot,
    t: ((key: ConvaxKey, values?: Record<string, string | number>) =>
      en[key].replace(/\{(\w+)\}/g, (_match, name: string) => String(values?.[name] ?? ''))) as ComponentProps<typeof ResourcePreview>['t'],
  } as ComponentProps<typeof ResourcePreview>
  return {
    props, document, useResource, renderFactorySlot,
    setSnapshot: (value: ResourceSnapshot<CanvasDocumentPreview>) => { snapshot = value },
    removeProvider: () => { provider = false },
  }
}

describe('Convax shared document previews', () => {
  it('forwards complete bytes and conversion metadata to the root document Factory without acquiring a thread', () => {
    const b = fixture('/project/report.docx')
    const source = { ...b.document, renderedAs: 'pdf' as const, missingFonts: ['Unavailable font'] }
    b.setSnapshot({ status: 'live', value: source, failure: undefined })
    render(<ResourcePreview {...b.props} />)
    expect(b.useResource).toHaveBeenCalledExactlyOnceWith(`${resourceAddress('convax-document', b.props.path)}?attempt=0`)
    expect(b.renderFactorySlot).toHaveBeenCalledOnce()
    expect(b.renderFactorySlot.mock.calls[0]?.slice(0, 2)).toEqual(['document.preview', { source, imageInset: 'none' }])
    expect(b.renderFactorySlot.mock.calls[0]?.[1].source?.bytes).toBe(source.bytes)
    expect(screen.getByText(b.props.path)).toBeDefined()
  })

  it('delegates gestures only for an embedded canvas occurrence', () => {
    const b = fixture()
    render(<ResourcePreview {...b.props} gestureMode="container" />)
    expect(b.renderFactorySlot.mock.calls[0]?.slice(0, 2)).toEqual(['document.preview', {
      source: b.document, imageInset: 'none', gestureMode: 'container',
    }])
  })

  it('shows a local loading status until the first complete document arrives', () => {
    const b = fixture()
    b.setSnapshot({ status: 'loading', value: undefined, failure: undefined })
    const view = render(<ResourcePreview {...b.props} />)
    expect(screen.getByRole('status', { name: 'Loading notes.md' })).toBeDefined()
    expect(b.renderFactorySlot).not.toHaveBeenCalled()
    b.setSnapshot({ status: 'live', value: b.document, failure: undefined })
    view.rerender(<ResourcePreview {...b.props} />)
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText(b.props.path)).toBeDefined()
  })

  it.each(['failed', 'none'] as const)('retries an unread %s preview using a new resource attempt', (status) => {
    const b = fixture()
    b.setSnapshot({
      status, value: undefined,
      failure: status === 'failed' ? new RemoteError('gateway/internal', 'Read failed', {}) : undefined,
    })
    render(<ResourcePreview {...b.props} />)
    expect(screen.getByRole('alert').textContent).toContain(en['files.preview.failed'])
    expect(b.renderFactorySlot).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(b.useResource).toHaveBeenLastCalledWith(`${resourceAddress('convax-document', b.props.path)}?attempt=1`)
  })

  it('retains the last readable preview beside a failure and removes the notice after recovery', () => {
    const b = fixture()
    const view = render(<ResourcePreview {...b.props} />)
    b.setSnapshot({
      status: 'failed', value: b.document,
      failure: new RemoteError('canvas-resource/source-changed', 'Source changed', { path: b.props.path }),
    })
    view.rerender(<ResourcePreview {...b.props} />)
    expect(screen.getByRole('alert').textContent).toContain(en['files.preview.sourceChanged'])
    expect(screen.getByText(b.props.path)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(b.useResource).toHaveBeenLastCalledWith(`${resourceAddress('convax-document', b.props.path)}?attempt=1`)
    b.setSnapshot({ status: 'live', value: { ...b.document, version: 'file-v2' }, failure: undefined })
    view.rerender(<ResourcePreview {...b.props} />)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText(b.props.path)).toBeDefined()
  })

  it('explains an exceeded preview limit with an available retry', () => {
    const b = fixture()
    b.setSnapshot({ status: 'failed', value: undefined,
      failure: new RemoteError('canvas-resource/too-large', 'Too large', { path: b.props.path, limit: 50 }) })
    render(<ResourcePreview {...b.props} />)
    expect(screen.getByRole('alert').textContent).toContain(en['files.preview.tooLarge'])
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined()
  })

  it('keeps the card usable when the document preview plugin is absent', () => {
    const b = fixture()
    b.removeProvider()
    render(<ResourcePreview {...b.props} />)
    expect(screen.getByRole('status').textContent).toBe(en['files.preview.providerUnavailable'])
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reports unavailable Office conversion within the preview instead of opening another surface', () => {
    const b = fixture('/project/slides.pptx')
    b.setSnapshot({ status: 'failed', value: undefined,
      failure: new RemoteError('document-render/failed', 'Converter unavailable', { reason: 'unavailable' }) })
    render(<ResourcePreview {...b.props} />)
    expect(screen.getByRole('alert').textContent).toContain(en['files.preview.officeUnavailable'])
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined()
    expect(b.renderFactorySlot).not.toHaveBeenCalled()
  })

  it.each(['/project/movie.MP4', '/project/audio.wav', '/project/audio.MP3'])('routes media through its window-retained player: %s', (path) => {
    const b = fixture(path)
    render(<ResourcePreview {...b.props} />)
    expect(screen.getByText(path)).toBeDefined()
    expect(b.useResource).not.toHaveBeenCalled()
    expect(b.renderFactorySlot.mock.calls[0]?.slice(0, 2)).toEqual(['convax.media.preview', { path }])
  })
})
