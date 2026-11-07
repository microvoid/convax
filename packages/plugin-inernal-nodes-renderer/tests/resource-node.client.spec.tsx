// @vitest-environment jsdom
/** Resource actions address source paths while removal affects only the canvas reference. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { CanvasDirectory, CanvasNodeId, CanvasNodeTypeId, CanvasResource } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { ResourceSnapshot } from '@deepseek-ai/dsh-client-resources/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { ResourceNode } from '../src/client/nodes.tsx'
import type { CanvasNodeRendererProps } from '@deepseek-ai/dsh-convax-plugin-renderer/client'
import { en, type ConvaxKey } from '@deepseek-ai/dsh-convax-plugin-renderer/client'
import { resourceAddress, resourcePath } from '@deepseek-ai/dsh-convax-plugin-renderer/client'
import css from '../src/client/NodeCard.module.css'

vi.mock('@xyflow/react', () => ({ NodeToolbar: ({ children, role, 'aria-label': label }: { children: ReactNode; role?: 'toolbar'; 'aria-label'?: string }) => <div role={role} aria-label={label}>{children}</div>,
  Position: { Left: 'left', Right: 'right', Top: 'top' }, useUpdateNodeInternals: () => () => {},
  Handle: ({ id, type }: { id: string; type: string }) => <span data-port-id={id} data-port-direction={type} />,
}))
vi.mock('../src/client/ResourcePreview.tsx', () => ({
  ResourcePreview: ({ path }: { path: string }) => <div data-preview-path={path}>Native file preview</div>,
}))

afterEach(cleanup)

function fixture(folder: boolean, resourcePathOverride?: string) {
  const path = resourcePathOverride ?? (folder ? '/project/project-b' : '/project/README.md')
  const remove = vi.fn()
  const openResource = vi.fn()
  const openSource = vi.fn()
  const focusNode = vi.fn()
  const createChat = vi.fn()
  const setResourceExpanded = vi.fn()
  const setResourcePreviewSize = vi.fn()
  const renderFactorySlot = vi.fn<CanvasNodeRendererProps['renderFactorySlot']>(() => <span>Native file preview</span>)
  const directories = new Map<string, ResourceSnapshot<CanvasDirectory>>([
    [path, { status: 'live', value: { path, entries: [] }, failure: undefined }],
  ])
  const useResource = vi.fn<(address: string) => ResourceSnapshot<CanvasDirectory | CanvasResource>>((address) => {
    if (new URL(address).hostname === 'convax-resource') return {
      status: 'live', value: { path, name: path.split('/').at(-1)!, kind: folder ? 'folder' : 'file', size: folder ? null : 256 }, failure: undefined,
    }
    const snapshot = directories.get(resourcePath(address))
    if (snapshot === undefined) throw new Error(`Unexpected directory resource: ${address}`)
    return snapshot
  })
  const props = {
    node: {
      id: 'resource-node' as CanvasNodeId, typeId: (folder ? 'convax.folder' : 'convax.file') as CanvasNodeTypeId,
      dataVersion: 1, data: { path }, position: { x: 0, y: 0 }, revision: 1,
    },
    selected: false, busy: false, remove, openResource, openSource, focusNode, createChat, useResource, renderFactorySlot,
    resourceExpanded: false, setResourceExpanded, setResourcePreviewSize,
    ports: [{ id: 'input', direction: 'input', valueKind: 'resource' }, { id: 'output', direction: 'output', valueKind: 'resource' }],
    t: ((key: ConvaxKey, values?: Record<string, string | number>) =>
      en[key].replace(/\{(\w+)\}/g, (_match, name: string) => String(values?.[name] ?? ''))) as CanvasNodeRendererProps['t'],
  } as CanvasNodeRendererProps
  return {
    props, path, remove, openResource, openSource, focusNode, createChat, useResource, directories,
    setResourceExpanded, setResourcePreviewSize, renderFactorySlot,
  }
}

function ControlledResourceNode(props: CanvasNodeRendererProps) {
  const [expanded, setExpanded] = useState(props.resourceExpanded)
  const [height, setHeight] = useState(props.resourcePreviewHeight)
  const [width, setWidth] = useState(props.resourcePreviewWidth)
  return <ResourceNode {...props} resourceExpanded={expanded} {...(height === undefined ? {} : { resourcePreviewHeight: height })}
    {...(width === undefined ? {} : { resourcePreviewWidth: width })}
    setResourceExpanded={(next) => { props.setResourceExpanded(next); setExpanded(next) }}
    setResourcePreviewSize={(next) => { props.setResourcePreviewSize(next); setWidth(next.width); setHeight(next.height) }} />
}

describe('Convax resource card actions', () => {
  it('starts folders collapsed without reading their contents and preserves the Chat action and ports', () => {
    const b = fixture(true)
    const view = render(<ControlledResourceNode {...b.props} />)
    expect(screen.getByRole('button', { name: 'Expand project-b' }).getAttribute('aria-expanded')).toBe('false')
    expect(b.useResource.mock.calls.every(([address]) => new URL(address).hostname === 'convax-resource')).toBe(true)
    expect(view.container.querySelector('[data-convax-directory-tree]')).toBeNull()
    expect(view.container.textContent).not.toContain(b.path)
    expect(screen.queryByRole('button', { name: 'Open in file manager' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    expect(b.createChat).toHaveBeenCalledWith(b.path, b.props.node.id)
    expect(screen.getByRole('button', { name: 'Remove reference' })).toBeDefined()
    expect(view.container.querySelector('[data-port-id="input"]')).not.toBeNull()
    expect(view.container.querySelector('[data-port-id="output"]')).not.toBeNull()
    const header = view.container.querySelector('[data-convax-resource-header]')!
    expect(header.contains(screen.getByRole('button', { name: 'New chat' }))).toBe(false)
    expect(within(screen.getByRole('toolbar', { name: 'Actions for project-b' })).getByRole('button', { name: 'New chat' })).toBeDefined()
    const card = view.container.querySelector<HTMLElement>('[data-convax-resource]')!
    expect(card.querySelectorAll(':scope > [data-port-id]')).toHaveLength(2)
    expect(header.querySelectorAll('[data-port-id]')).toHaveLength(0)
    expect(card.hasAttribute('data-convax-file')).toBe(false)
    const identity = header.querySelector(`.${css.resourceIdentity}`)!
    const metadata = header.querySelector(`.${css.resourceMetadata}`)!
    expect(metadata).not.toBeNull()
    expect(metadata.parentElement).toBe(identity.parentElement)
    expect(identity.contains(metadata)).toBe(false)
    expect(screen.getByText('Folder')).toBeDefined()
  })

  it('opens and focuses folders from the toolbar while removal affects only the reference', () => {
    const b = fixture(true)
    const view = render(<ControlledResourceNode {...b.props} />)
    expect(view.container.textContent).not.toContain(b.path)
    const toolbar = screen.getByRole('toolbar', { name: 'Actions for project-b' })
    expect(screen.queryByRole('button', { name: 'Actions for project-b' })).toBeNull()
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Focus this card' }))
    expect(b.focusNode).toHaveBeenCalledOnce()
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Show in file manager' }))
    expect(b.openSource).toHaveBeenCalledExactlyOnceWith(b.path)
    expect(b.openResource).not.toHaveBeenCalled()
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Remove reference' }))
    expect(b.remove).toHaveBeenCalledOnce()
  })

  it('loads only expanded directories and previews leaf files without creating canvas references', () => {
    const b = fixture(true)
    const sourcePath = `${b.path}/src`
    const readme = { path: `${b.path}/README.md`, name: 'README.md', kind: 'file' as const, size: 20 }
    b.directories.set(b.path, {
      status: 'live', failure: undefined,
      value: { path: b.path, entries: [
        { path: sourcePath, name: 'src', kind: 'folder', size: null }, readme,
        { path: `${b.path}/socket`, name: 'socket', kind: 'other', size: null },
      ] },
    })
    b.directories.set(sourcePath, {
      status: 'live', failure: undefined,
      value: { path: sourcePath, entries: [{ path: `${sourcePath}/index.ts`, name: 'index.ts', kind: 'file', size: 8 }] },
    })
    const view = render(<ControlledResourceNode {...b.props} />)
    const header = view.container.querySelector('[data-convax-resource-header]')!
    const card = view.container.querySelector('[data-convax-resource]')!
    const endpoints = [...card.querySelectorAll('[data-port-id]')]
    expect(endpoints).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Expand project-b' }))
    expect(screen.getByRole('button', { name: 'Collapse project-b' }).getAttribute('aria-expanded')).toBe('true')
    const preview = view.container.querySelector('[data-convax-directory-preview]')!
    const tree = view.container.querySelector('[data-convax-directory-tree]')!
    expect(preview).not.toBeNull()
    expect(tree).not.toBeNull()
    expect(preview.contains(tree)).toBe(true)
    expect(header.querySelectorAll('[data-port-id]')).toHaveLength(0)
    expect(preview.querySelectorAll('[data-port-id]')).toHaveLength(0)
    expect(tree.querySelectorAll('[data-port-id]')).toHaveLength(0)
    for (const endpoint of endpoints) expect(endpoint.parentElement).toBe(card)
    expect(card.querySelectorAll('[data-port-id]')).toHaveLength(2)
    expect(b.useResource).toHaveBeenCalledWith(`${resourceAddress('convax-directory', b.path)}?attempt=0`)
    expect(b.useResource.mock.calls.some(([address]) => resourcePath(address) === sourcePath)).toBe(false)
    expect(screen.getByRole('button', { name: 'Expand src' }).getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'README.md' }))
    expect(b.openResource).toHaveBeenCalledWith(readme)
    expect(screen.getByRole('button', { name: 'socket' }).getAttribute('disabled')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Expand src' }))
    expect(b.useResource).toHaveBeenCalledWith(`${resourceAddress('convax-directory', sourcePath)}?attempt=0`)
    expect(screen.getByRole('button', { name: 'index.ts' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse src' }))
    b.useResource.mockClear()
    view.rerender(<ControlledResourceNode {...b.props} />)
    expect(screen.queryByRole('button', { name: 'index.ts' })).toBeNull()
    expect(b.useResource.mock.calls.some(([address]) => resourcePath(address) === sourcePath)).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse project-b' }))
    b.useResource.mockClear()
    view.rerender(<ControlledResourceNode {...b.props} />)
    expect(view.container.querySelector('[data-convax-directory-tree]')).toBeNull()
    expect(view.container.querySelector('[data-convax-directory-preview]')).toBeNull()
    expect(header.querySelectorAll('[data-port-id]')).toHaveLength(0)
    for (const endpoint of endpoints) expect(endpoint.parentElement).toBe(card)
    expect(card.querySelectorAll('[data-port-id]')).toHaveLength(2)
    expect(b.useResource.mock.calls.every(([address]) => new URL(address).hostname === 'convax-resource')).toBe(true)
    expect(b.createChat).not.toHaveBeenCalled()
    expect(b.remove).not.toHaveBeenCalled()
  })

  it('keeps loaded children visible through a failure and retries before showing a refreshed empty folder', () => {
    const b = fixture(true)
    const value: CanvasDirectory = {
      path: b.path, entries: [{ path: `${b.path}/README.md`, name: 'README.md', kind: 'file', size: 20 }],
    }
    b.directories.set(b.path, { status: 'live', value, failure: undefined })
    const view = render(<ControlledResourceNode {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand project-b' }))
    expect(screen.getByRole('button', { name: 'README.md' })).toBeDefined()
    b.directories.set(b.path, {
      status: 'failed', value,
      failure: new RemoteError('gateway/internal', 'Directory cannot be read', {}),
    })
    view.rerender(<ControlledResourceNode {...b.props} />)
    expect(screen.getByRole('alert')).toBeDefined()
    expect(screen.getByRole('button', { name: 'README.md' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(b.useResource).toHaveBeenLastCalledWith(`${resourceAddress('convax-directory', b.path)}?attempt=1`)
    b.directories.set(b.path, { status: 'live', value: { path: b.path, entries: [] }, failure: undefined })
    view.rerender(<ControlledResourceNode {...b.props} />)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: 'README.md' })).toBeNull()
    expect(screen.getByText('This folder is empty')).toBeDefined()
  })

  it.each(['failed', 'none'] as const)('keeps an unread folder distinct from empty and retries its %s state', (status) => {
    const b = fixture(true)
    b.directories.set(b.path, { status: 'loading', value: undefined, failure: undefined })
    const view = render(<ControlledResourceNode {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand project-b' }))
    expect(screen.getByRole('status', { name: 'Loading project-b' })).toBeDefined()
    expect(screen.queryByText('This folder is empty')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    b.directories.set(b.path, {
      status, value: undefined,
      failure: status === 'failed' ? new RemoteError('gateway/internal', 'Directory cannot be read', {}) : undefined,
    })
    view.rerender(<ControlledResourceNode {...b.props} />)
    expect(screen.getByRole('alert')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(b.useResource).toHaveBeenLastCalledWith(`${resourceAddress('convax-directory', b.path)}?attempt=1`)
  })

  it('keeps file preview and system opening as separate toolbar actions', () => {
    const b = fixture(false)
    render(<ControlledResourceNode {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand preview' }))
    expect(b.openResource).toHaveBeenCalledWith({ path: b.path, name: 'README.md', kind: 'file', size: null })
    expect(screen.queryByRole('button', { name: 'New chat' })).toBeNull()
    const toolbar = screen.getByRole('toolbar', { name: 'Actions for README.md' })
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Show in file manager' }))
    expect(b.openSource).toHaveBeenCalledExactlyOnceWith(b.path)
    expect(b.openResource).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Actions for README.md' })).toBeNull()
    expect(b.remove).not.toHaveBeenCalled()
  })

  it.each(['README.md', 'image.png', 'tone.wav', 'budget.xlsx', 'unsupported.bin'])('expands %s with the shared file header and retains its card ports', (name) => {
    const b = fixture(false, `/project/${name}`)
    const view = render(<ControlledResourceNode {...b.props} />)
    const header = view.container.querySelector('[data-convax-resource-header]')!
    const card = view.container.querySelector<HTMLElement>('[data-convax-resource]')!
    const endpoints = [...card.querySelectorAll('[data-port-id]')]
    expect(endpoints).toHaveLength(2)
    expect(card.hasAttribute('data-convax-file')).toBe(true)
    const identity = header.querySelector(`.${css.resourceIdentity}`)!
    const metadata = header.querySelector(`.${css.resourceMetadata}`)!
    expect(metadata).not.toBeNull()
    expect(metadata.parentElement).toBe(identity.parentElement)
    expect(identity.contains(metadata)).toBe(false)
    expect(view.container.textContent).not.toContain(b.path)
    expect(header.contains(screen.getByRole('button', { name: 'Expand preview' }))).toBe(false)
    expect(header.querySelectorAll('[data-port-id]')).toHaveLength(0)
    expect(view.container.querySelector('[data-preview-path]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: `Expand ${name}` }))
    expect(b.setResourceExpanded).toHaveBeenCalledExactlyOnceWith(true)
    expect(screen.getByRole('button', { name: `Collapse ${name}` }).getAttribute('aria-expanded')).toBe('true')
    expect(view.container.querySelector('[data-preview-path]')?.getAttribute('data-preview-path')).toBe(b.path)
    expect(header.querySelectorAll('[data-port-id]')).toHaveLength(0)
    expect(view.container.querySelectorAll('[data-convax-file-preview] [data-port-id]')).toHaveLength(0)
    for (const endpoint of endpoints) expect(endpoint.parentElement).toBe(card)
    expect(card.querySelectorAll('[data-port-id]')).toHaveLength(2)
    expect(b.openResource).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: `Collapse ${name}` }))
    expect(view.container.querySelector('[data-preview-path]')).toBeNull()
    expect(header.querySelectorAll('[data-port-id]')).toHaveLength(0)
    for (const endpoint of endpoints) expect(endpoint.parentElement).toBe(card)
    expect(card.querySelectorAll('[data-port-id]')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Expand preview' })).toBeDefined()
  })

  it.each([
    { folder: true, path: '/project/project-b' },
    ...['README.md', 'image.png', 'clip.mp4', 'tone.wav', 'unsupported.bin'].map(name => ({ folder: false, path: `/project/${name}` })),
  ])('resizes $path while expanded and retains its preview height when resized collapsed', ({ folder, path }) => {
    const b = fixture(folder, path)
    const view = render(<ControlledResourceNode {...b.props} resourceExpanded resourcePreviewWidth={360} resourcePreviewHeight={280} />)
    const name = path.split('/').at(-1)!
    const body = (): HTMLElement => view.container.querySelector<HTMLElement>(folder ? '[data-convax-directory-preview]' : '[data-convax-file-preview]')!
    const grip = screen.getByRole('button', { name: 'Resize preview' })
    expect(body().style.height).toBe('280px')
    fireEvent.keyDown(grip, { key: 'ArrowRight' })
    fireEvent.keyDown(grip, { key: 'ArrowDown' })
    expect(b.setResourcePreviewSize).toHaveBeenLastCalledWith({ width: 370, height: 290 })
    fireEvent.click(screen.getByRole('button', { name: `Collapse ${name}` }))
    expect(view.container.querySelector('[data-convax-resource-resize]')).toBe(grip)
    fireEvent.keyDown(grip, { key: 'ArrowRight' })
    expect(b.setResourcePreviewSize).toHaveBeenLastCalledWith({ width: 380, height: 290 })
    fireEvent.keyDown(grip, { key: 'ArrowDown' })
    expect(b.setResourcePreviewSize).toHaveBeenCalledTimes(3)
    fireEvent.click(screen.getByRole('button', { name: `Expand ${name}` }))
    expect(body().style.height).toBe('290px')
  })

  it('resizes both preview dimensions in fixed steps with or without Shift and retains the mounted preview', () => {
    const b = fixture(false)
    const view = render(<ControlledResourceNode {...b.props} resourceExpanded />)
    const preview = view.container.querySelector('[data-preview-path]')
    const card = view.container.querySelector<HTMLElement>('[data-convax-resource]')!
    const grip = screen.getByRole('button', { name: 'Resize preview' })
    fireEvent.keyDown(grip, { key: 'ArrowDown' })
    expect(b.setResourcePreviewSize).toHaveBeenLastCalledWith({ width: 320, height: 250 })
    fireEvent.keyDown(grip, { key: 'ArrowRight' })
    expect(b.setResourcePreviewSize).toHaveBeenLastCalledWith({ width: 330, height: 250 })
    fireEvent.keyDown(grip, { key: 'ArrowLeft', shiftKey: true })
    expect(b.setResourcePreviewSize).toHaveBeenLastCalledWith({ width: 320, height: 250 })
    fireEvent.keyDown(grip, { key: 'ArrowUp', shiftKey: true })
    expect(b.setResourcePreviewSize).toHaveBeenLastCalledWith({ width: 320, height: 240 })
    for (let i = 0; i < 8; i++) fireEvent.keyDown(grip, { key: 'ArrowUp' })
    expect(b.setResourcePreviewSize).toHaveBeenLastCalledWith({ width: 320, height: 160 })
    fireEvent.keyDown(grip, { key: 'ArrowRight', shiftKey: true })
    expect(b.setResourcePreviewSize).toHaveBeenLastCalledWith({ width: 330, height: 160 })
    expect(card.style.width).toBe('330px')
    expect(view.container.querySelector<HTMLElement>('[data-convax-file-preview]')?.style.height).toBe('160px')
    expect(view.container.querySelector('[data-preview-path]')).toBe(preview)
    b.setResourcePreviewSize.mockClear()
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }]) {
      fireEvent.keyDown(grip, { key: 'ArrowDown', ...modifiers })
    }
    fireEvent.keyDown(grip, { key: 'Enter' })
    expect(b.setResourcePreviewSize).not.toHaveBeenCalled()
  })

  it('restores a height-only preview at the default card width before its first horizontal resize', () => {
    const b = fixture(false)
    const view = render(<ControlledResourceNode {...b.props} resourceExpanded resourcePreviewHeight={360} />)
    const card = view.container.querySelector<HTMLElement>('[data-convax-resource]')!
    const body = view.container.querySelector<HTMLElement>('[data-convax-file-preview]')!
    expect(card.style.width).toBe('320px')
    expect(body.style.height).toBe('360px')
    fireEvent.keyDown(screen.getByRole('button', { name: 'Resize preview' }), { key: 'ArrowRight' })
    expect(b.setResourcePreviewSize).toHaveBeenCalledExactlyOnceWith({ width: 330, height: 360 })
  })

  it('keeps audio transport in its collapsed header and resizes from the compact waveform height', () => {
    const b = fixture(false, '/project/tone.wav')
    const view = render(<ControlledResourceNode {...b.props} />)
    const card = view.container.querySelector<HTMLElement>('[data-convax-resource]')!
    expect(card.hasAttribute('data-convax-audio')).toBe(true)
    expect(b.renderFactorySlot).toHaveBeenLastCalledWith('convax.media.preview', {
      path: b.path, presentation: 'compact', metadataFallback: 'WAV · 256B',
    }, expect.anything())
    fireEvent.click(screen.getByRole('button', { name: 'Expand tone.wav' }))
    const body = view.container.querySelector<HTMLElement>('[data-convax-file-preview]')!
    expect(body.style.height).toBe('104px')
    expect(body.style.minHeight).toBe('104px')
    expect(b.renderFactorySlot).toHaveBeenLastCalledWith('convax.media.preview', {
      path: b.path, presentation: 'metadata', metadataFallback: 'WAV · 256B',
    }, expect.anything())
    const grip = screen.getByRole('button', { name: 'Resize preview' })
    fireEvent.keyDown(grip, { key: 'ArrowRight' })
    expect(b.setResourcePreviewSize).toHaveBeenLastCalledWith({ width: 330, height: 104 })
    fireEvent.keyDown(grip, { key: 'ArrowUp' })
    expect(b.setResourcePreviewSize).toHaveBeenLastCalledWith({ width: 330, height: 104 })
    fireEvent.keyDown(grip, { key: 'ArrowDown' })
    expect(b.setResourcePreviewSize).toHaveBeenLastCalledWith({ width: 330, height: 114 })
    fireEvent.click(screen.getByRole('button', { name: 'Collapse tone.wav' }))
    expect(b.renderFactorySlot.mock.calls.at(-1)?.[1]).toMatchObject({ presentation: 'compact' })
    expect(view.container.querySelector('[data-convax-file-preview]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Expand tone.wav' }))
    expect(view.container.querySelector<HTMLElement>('[data-convax-file-preview]')?.style.height).toBe('114px')
    expect(card.style.width).toBe('330px')
  })

  it('preserves an audio preview height explicitly saved by resizing', () => {
    const b = fixture(false, '/project/tone.wav')
    const view = render(<ControlledResourceNode {...b.props} resourceExpanded resourcePreviewHeight={240} />)
    expect(view.container.querySelector<HTMLElement>('[data-convax-file-preview]')?.style.height).toBe('240px')
    expect(b.setResourcePreviewSize).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Resize preview' }), { key: 'ArrowRight' })
    expect(b.setResourcePreviewSize).toHaveBeenCalledExactlyOnceWith({ width: 330, height: 240 })
  })

  it.each([
    { width: undefined, height: undefined, expectedWidth: 320, expectedHeight: 180 },
    { width: 640, height: undefined, expectedWidth: 640, expectedHeight: 360 },
    { width: undefined, height: 240, expectedWidth: 320, expectedHeight: 240 },
    { width: 640, height: 240, expectedWidth: 640, expectedHeight: 240 },
  ])('uses a widescreen video default while preserving saved preview dimensions: $expectedWidth × $expectedHeight',
    ({ width, height, expectedWidth, expectedHeight }) => {
      const b = fixture(false, '/project/clip.mp4')
      const view = render(<ControlledResourceNode {...b.props} resourceExpanded
        {...(width === undefined ? {} : { resourcePreviewWidth: width })}
        {...(height === undefined ? {} : { resourcePreviewHeight: height })} />)
      const card = view.container.querySelector<HTMLElement>('[data-convax-resource]')!
      const preview = view.container.querySelector<HTMLElement>('[data-convax-file-preview]')!
      const header = view.container.querySelector<HTMLElement>('[data-convax-resource-header]')!
      const endpoints = [...card.querySelectorAll('[data-port-id]')]
      expect(endpoints).toHaveLength(2)
      expect(card.style.width).toBe(`${expectedWidth}px`)
      expect(preview.style.height).toBe(`${expectedHeight}px`)
      expect(header.querySelectorAll('[data-port-id]')).toHaveLength(0)
      expect(preview.querySelectorAll('[data-port-id]')).toHaveLength(0)
      for (const endpoint of endpoints) expect(endpoint.parentElement).toBe(card)
      expect(b.setResourcePreviewSize).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Collapse clip.mp4' }))
      expect(header.querySelectorAll('[data-port-id]')).toHaveLength(0)
      for (const endpoint of endpoints) expect(endpoint.parentElement).toBe(card)
      expect(card.querySelectorAll('[data-port-id]')).toHaveLength(2)
      expect(view.container.querySelector('[data-convax-file-preview]')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Expand clip.mp4' }))
      expect(view.container.querySelector<HTMLElement>('[data-convax-file-preview]')?.style.height).toBe(`${expectedHeight}px`)
      for (const endpoint of endpoints) expect(endpoint.parentElement).toBe(card)
      expect(card.querySelectorAll('[data-port-id]')).toHaveLength(2)
    })

  it('previews two-dimensional resizing at canvas scale and commits only completed gestures', () => {
    const b = fixture(false)
    const view = render(<ControlledResourceNode {...b.props} resourceExpanded />)
    const card = view.container.querySelector<HTMLElement>('[data-convax-resource]')!
    const body = view.container.querySelector<HTMLElement>('[data-convax-file-preview]')!
    const preview = view.container.querySelector('[data-preview-path]')
    const grip = screen.getByRole('button', { name: 'Resize preview' })
    let captured: number | undefined
    Object.defineProperties(grip, {
      setPointerCapture: { configurable: true, value: (id: number) => { captured = id } },
      hasPointerCapture: { configurable: true, value: (id: number) => captured === id },
      releasePointerCapture: { configurable: true, value: () => { captured = undefined } },
    })
    Object.defineProperties(card, {
      offsetWidth: { configurable: true, get: () => Number.parseFloat(card.style.width) },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect(100, 200, Number.parseFloat(card.style.width) / 2, 150) },
    })
    Object.defineProperty(body, 'offsetHeight', { configurable: true, get: () => Number.parseFloat(body.style.height) })
    const pointer = (type: string, x: number, y: number): void => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })
      Object.defineProperty(event, 'pointerId', { value: 7 })
      fireEvent(grip, event)
    }
    pointer('pointerdown', 100, 100)
    pointer('pointermove', 140, 140)
    expect(grip.hasAttribute('data-resizing')).toBe(true)
    expect(card.style.width).toBe('400px')
    expect(body.style.height).toBe('320px')
    expect(b.setResourcePreviewSize).not.toHaveBeenCalled()
    pointer('pointercancel', 140, 140)
    expect(grip.hasAttribute('data-resizing')).toBe(false)
    expect(card.style.width).toBe('320px')
    expect(body.style.height).toBe('240px')
    expect(b.setResourcePreviewSize).not.toHaveBeenCalled()
    for (const cancel of [
      () => { fireEvent.keyDown(grip, { key: 'Escape' }) },
      () => { fireEvent(window, new Event('blur')) },
      () => { fireEvent.blur(grip) },
    ]) {
      pointer('pointerdown', 100, 100)
      pointer('pointermove', 140, 140)
      cancel()
      expect(card.style.width).toBe('320px')
      expect(body.style.height).toBe('240px')
      expect(captured).toBeUndefined()
      expect(b.setResourcePreviewSize).not.toHaveBeenCalled()
      expect(view.container.querySelector('[data-preview-path]')).toBe(preview)
    }
    pointer('pointerdown', 100, 100)
    pointer('pointermove', 120, 120)
    pointer('pointerup', 130, 130)
    expect(b.setResourcePreviewSize).toHaveBeenCalledExactlyOnceWith({ width: 380, height: 300 })
    expect(card.style.width).toBe('380px')
    expect(body.style.height).toBe('300px')
    expect(captured).toBeUndefined()
    pointer('pointerdown', 100, 100)
    pointer('pointerup', 120, 100)
    expect(b.setResourcePreviewSize).toHaveBeenLastCalledWith({ width: 420, height: 300 })
    expect(b.setResourcePreviewSize).toHaveBeenCalledTimes(2)
    expect(view.container.querySelector('[data-preview-path]')).toBe(preview)
    pointer('pointerdown', 100, 100)
    pointer('pointermove', 140, 140)
    expect(captured).toBe(7)
    view.unmount()
    expect(captured).toBeUndefined()
    expect(b.setResourcePreviewSize).toHaveBeenCalledTimes(2)
  })
})
