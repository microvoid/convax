// @vitest-environment jsdom
/** Media cards keep presentation gestures separate from the window-owned player. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ResourceSnapshot } from '@deepseek-ai/dsh-client-resources/client'
import type { MediaPlaybackState, MediaPreviewProps, MediaSource } from '../src/client/media-contract.ts'
import type { MediaWaveform } from '../src/client/media-waveform.ts'
import { MediaPreview } from '../src/client/MediaPreview.tsx'
import { en, type ConvaxKey } from '../src/client/locales.ts'
import { resourceAddress } from '../src/client/resources.ts'

const wave = vi.hoisted(() => ({ read: vi.fn<(url: string, signal: AbortSignal) => Promise<MediaWaveform>>() }))
vi.mock('../src/client/media-waveform.ts', () => ({ readMediaWaveform: wave.read }))

beforeEach(() => { wave.read.mockReset(); wave.read.mockResolvedValue({ duration: 40, peaks: [0, 0.25, 1, 0.5] }) })
afterEach(cleanup)

function fixture(kind: MediaSource['kind'] = 'video') {
  const source: MediaSource = {
    path: '/private/tmp/project/clip.mp4', url: '/api/media/clip?v=one', version: 'one', mimeType: 'video/mp4', kind,
  }
  let resource: ResourceSnapshot<MediaSource> = { status: 'live', value: source, failure: undefined }
  let playback: MediaPlaybackState = { intent: 'none', status: 'paused', currentTime: 5, duration: 40,
    volume: 0.6, autoplayBlocked: false, presented: true }
  const release = vi.fn()
  const callbacks = {
    mountMedia: vi.fn<MediaPreviewProps['mountMedia']>(() => release), hoverMedia: vi.fn(), toggleMedia: vi.fn(), seekMedia: vi.fn(),
    setMediaVolume: vi.fn(), fullscreenMedia: vi.fn<() => Promise<void>>().mockResolvedValue(),
    openSystem: vi.fn<() => Promise<void>>().mockResolvedValue(),
  }
  const useResource = vi.fn((_address: string) => resource)
  const props = {
    path: '/tmp/project/clip.mp4', ...callbacks, useResource,
    useMediaPlayback: (select: (state: Readonly<Record<string, MediaPlaybackState>>) => MediaPlaybackState | undefined) =>
      select({ [source.path]: playback }),
    t: (key: ConvaxKey, values?: Record<string, string | number>) =>
      en[key].replace(/\{(\w+)\}/g, (_match, name: string) => String(values?.[name] ?? '')),
  } as MediaPreviewProps
  return { props, callbacks, release, useResource, source,
    setResource: (value: ResourceSnapshot<MediaSource>) => { resource = value },
    setPlayback: (value: Partial<MediaPlaybackState>) => { playback = { ...playback, ...value } },
  }
}

it('attaches by viewport identity, uses the canonical source path for gestures, and releases only the presentation', () => {
  const f = fixture()
  const view = render(<MediaPreview {...f.props} />)
  expect(f.useResource).toHaveBeenCalledWith(`${resourceAddress('convax-media', f.props.path)}?attempt=0`)
  const [source, viewportId] = f.callbacks.mountMedia.mock.calls[0] ?? []
  expect(source).toEqual(f.source)
  expect(document.getElementById(String(viewportId))).not.toBeNull()
  const player = view.container.querySelector('[data-kind="video"]') as HTMLElement
  fireEvent.pointerEnter(player, { pointerType: 'mouse' })
  expect(f.callbacks.hoverMedia).toHaveBeenLastCalledWith(f.source.path, true)
  fireEvent.click(screen.getByRole('button', { name: 'Play' }))
  expect(f.callbacks.toggleMedia).toHaveBeenCalledWith(f.source.path)
  fireEvent.pointerLeave(player, { pointerType: 'mouse' })
  expect(f.callbacks.hoverMedia).toHaveBeenLastCalledWith(f.source.path, false)
  fireEvent.change(screen.getByRole('slider', { name: 'Playback position' }), { target: { value: '12' } })
  expect(f.callbacks.seekMedia).toHaveBeenLastCalledWith(f.source.path, 12)
  fireEvent.click(screen.getByRole('button', { name: 'Volume' }))
  fireEvent.change(screen.getByRole('slider', { name: 'Volume' }), { target: { value: '0.25' } })
  expect(f.callbacks.setMediaVolume).toHaveBeenLastCalledWith(f.source.path, 0.25)
  f.release.mockImplementation(() => { expect(document.getElementById(String(viewportId))?.isConnected).toBe(true) })
  view.unmount()
  expect(f.release).toHaveBeenCalledOnce()
})

it('places video transport in one overlay group and retains the presentation across playback changes', () => {
  const f = fixture()
  const view = render(<MediaPreview {...f.props} />)
  const viewportId = f.callbacks.mountMedia.mock.calls[0]![1]
  const viewport = document.getElementById(viewportId)
  const controls = screen.getByRole('group', { name: 'Playback controls' })
  expect(controls.hasAttribute('data-convax-video-controls')).toBe(true)
  expect(within(controls).getByRole('slider', { name: 'Playback position' })).toBeDefined()
  const pausedPlay = screen.getByRole('button', { name: 'Play video' })
  expect(controls.contains(pausedPlay)).toBe(false)
  const presentation = () => ({
    centralPlay: screen.queryByRole('button', { name: 'Play video' }) !== null,
    controls: within(controls).getAllByRole('button').map(button => ({
      label: button.getAttribute('aria-label'), disabled: button.hasAttribute('disabled'),
      expanded: button.getAttribute('aria-expanded'),
    })),
    position: within(controls).getByRole('slider', { name: 'Playback position' }).getAttribute('aria-valuetext'),
    volumeSlider: screen.queryByRole('slider', { name: 'Volume' }) !== null,
  })
  expect(presentation()).toMatchSnapshot('paused video overlay')
  pausedPlay.focus()
  fireEvent.click(pausedPlay, { detail: 0 })
  expect(f.callbacks.toggleMedia).toHaveBeenCalledExactlyOnceWith(f.source.path)
  expect(document.activeElement).toBe(within(controls).getByRole('button', { name: 'Play' }))
  f.setPlayback({ status: 'playing', intent: 'manual', currentTime: 12 })
  view.rerender(<MediaPreview {...f.props} />)
  expect(presentation()).toMatchSnapshot('playing video overlay')
  expect(document.activeElement).toBe(within(controls).getByRole('button', { name: 'Pause' }))
  expect(document.getElementById(viewportId)).toBe(viewport)
  expect(f.callbacks.mountMedia).toHaveBeenCalledOnce()
  expect(f.release).not.toHaveBeenCalled()
})

it.each(['audio', 'video'] as const)('opens %s volume on demand and dismisses it with Escape or an outside pointer without remounting playback', async (kind) => {
  const f = fixture(kind)
  render(<MediaPreview {...f.props} />)
  if (kind === 'audio') await screen.findByRole('slider', { name: 'Waveform' })
  const volume = screen.getByRole('button', { name: 'Volume' })
  expect(volume.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByRole('slider', { name: 'Volume' })).toBeNull()
  fireEvent.click(volume)
  const popup = screen.getByRole('group', { name: 'Volume' })
  const slider = within(popup).getByRole('slider', { name: 'Volume' })
  expect(volume.getAttribute('aria-expanded')).toBe('true')
  expect(document.activeElement).toBe(slider)
  fireEvent.change(slider, { target: { value: '0.25' } })
  expect(f.callbacks.setMediaVolume).toHaveBeenCalledExactlyOnceWith(f.source.path, 0.25)
  fireEvent.keyDown(slider, { key: 'Escape' })
  expect(screen.queryByRole('group', { name: 'Volume' })).toBeNull()
  expect(volume.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(volume)
  fireEvent.click(volume)
  expect(screen.getByRole('group', { name: 'Volume' })).toBeDefined()
  fireEvent.pointerDown(document.body)
  expect(screen.queryByRole('group', { name: 'Volume' })).toBeNull()
  expect(volume.getAttribute('aria-expanded')).toBe('false')
  expect(f.callbacks.toggleMedia).not.toHaveBeenCalled()
  expect(f.callbacks.mountMedia).toHaveBeenCalledOnce()
  expect(f.release).not.toHaveBeenCalled()
})

it('shows native video metadata without mounting another player and keeps file metadata as the loading fallback', () => {
  const f = fixture()
  f.setPlayback({ duration: 0, videoWidth: 0, videoHeight: 0 })
  const view = render(<MediaPreview {...f.props} presentation="metadata" metadataFallback="MP4 · 256B" />)
  expect(screen.getByText('MP4 · 256B')).toBeDefined()
  f.setPlayback({ duration: 65, videoWidth: 1920, videoHeight: 1080 })
  view.rerender(<MediaPreview {...f.props} presentation="metadata" metadataFallback="MP4 · 256B" />)
  expect(view.container.textContent).toContain('1920')
  expect(view.container.textContent).toContain('1080')
  expect(view.container.textContent).toContain('1:05')
  expect(view.container.textContent).toMatchSnapshot('native video dimensions and duration')
  expect(f.callbacks.mountMedia).not.toHaveBeenCalled()
  expect(f.release).not.toHaveBeenCalled()
  expect(wave.read).not.toHaveBeenCalled()
})

it('keeps content and retries when metadata observation fails after the source has loaded', () => {
  const f = fixture()
  const view = render(<MediaPreview {...f.props} />)
  f.setResource({ status: 'failed', value: f.source, failure: undefined })
  view.rerender(<MediaPreview {...f.props} />)
  expect(screen.getByRole('alert').textContent).toContain(en['media.failed'])
  expect(screen.getByRole('button', { name: 'Play' })).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(f.useResource).toHaveBeenLastCalledWith(`${resourceAddress('convax-media', f.props.path)}?attempt=1`)
  expect(f.callbacks.mountMedia).toHaveBeenCalledOnce()
})

it('shows loading without constructing a player before source metadata arrives', () => {
  const f = fixture()
  f.setResource({ status: 'loading', value: undefined, failure: undefined })
  render(<MediaPreview {...f.props} />)
  expect(screen.getByRole('status', { name: 'Loading media' })).toBeDefined()
  expect(f.callbacks.mountMedia).not.toHaveBeenCalled()
})

it('shows blocked autoplay and offers a manual play gesture', () => {
  const f = fixture()
  f.setPlayback({ autoplayBlocked: true })
  render(<MediaPreview {...f.props} />)
  expect(screen.getByRole('status').textContent).toContain(en['media.autoplayBlocked'])
  fireEvent.click(screen.getByRole('button', { name: 'Play' }))
  expect(f.callbacks.toggleMedia).toHaveBeenCalledWith(f.source.path)
})

it('offers keep-playing while hovering and pause after the user chooses manual playback', () => {
  const f = fixture()
  f.setPlayback({ status: 'playing', intent: 'hover' })
  const view = render(<MediaPreview {...f.props} />)
  fireEvent.click(screen.getByRole('button', { name: en['media.keepPlaying'] }))
  expect(f.callbacks.toggleMedia).toHaveBeenCalledWith(f.source.path)
  f.setPlayback({ intent: 'manual' })
  view.rerender(<MediaPreview {...f.props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
  expect(f.callbacks.toggleMedia).toHaveBeenCalledTimes(2)
})

it.each(['audio', 'video'] as const)('offers system opening for unsupported %s and reports an unsuccessful launch', async (kind) => {
  const f = fixture(kind)
  f.setPlayback({ status: 'failed', failure: 'unsupported' })
  f.callbacks.openSystem.mockRejectedValue(new Error('No handler'))
  render(<MediaPreview {...f.props} />)
  expect(screen.getByRole('alert').textContent).toContain(en['media.unsupported'])
  expect(screen.getByRole('button', { name: 'Play' }).hasAttribute('disabled')).toBe(true)
  expect(wave.read).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Open in system app' }))
  await waitFor(() => { expect(screen.getByText(en['media.openFailed'])).toBeDefined() })
  expect(f.callbacks.openSystem).toHaveBeenCalledWith(f.source.path)
})

it('requests video fullscreen and keeps a failed request visible', async () => {
  const f = fixture()
  f.callbacks.fullscreenMedia.mockRejectedValue(new Error('Denied'))
  render(<MediaPreview {...f.props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }))
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en['media.fullscreenFailed']) })
  expect(f.callbacks.fullscreenMedia).toHaveBeenCalledWith(f.source.path)
})

it('draws real audio peaks and seeks by scaled pointer position or keyboard without changing play intent', async () => {
  const f = fixture('audio')
  const view = render(<MediaPreview {...f.props} />)
  const waveform = await screen.findByRole('slider', { name: 'Waveform' })
  expect(waveform.querySelectorAll('line')).toHaveLength(4)
  expect(waveform.querySelectorAll('line')[2]?.getAttribute('y1')).toBe('2')
  vi.spyOn(waveform, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 0, 200, 64))
  fireEvent.click(waveform, { clientX: 150 })
  expect(f.callbacks.seekMedia).toHaveBeenLastCalledWith(f.source.path, 10)
  fireEvent.keyDown(waveform, { key: 'ArrowRight' })
  expect(f.callbacks.seekMedia).toHaveBeenLastCalledWith(f.source.path, 10)
  fireEvent.keyDown(waveform, { key: 'End' })
  expect(f.callbacks.seekMedia).toHaveBeenLastCalledWith(f.source.path, 40)
  fireEvent.keyDown(waveform, { key: 'Home' })
  expect(f.callbacks.seekMedia).toHaveBeenLastCalledWith(f.source.path, 0)
  expect(f.callbacks.toggleMedia).not.toHaveBeenCalled()
  const signal = wave.read.mock.calls[0]?.[1]
  view.unmount()
  expect(signal?.aborted).toBe(true)
})

it('keeps native audio playback available when waveform decoding fails', async () => {
  const f = fixture('audio')
  wave.read.mockRejectedValue(new Error('Decoder unavailable'))
  render(<MediaPreview {...f.props} />)
  await screen.findByText(en['media.waveformUnavailable'])
  expect(screen.queryByRole('slider', { name: 'Waveform' })).toBeNull()
  const seek = screen.getByRole('slider', { name: 'Playback position' })
  expect(screen.getAllByRole('slider')).toHaveLength(1)
  fireEvent.keyDown(seek, { key: 'End' })
  expect(f.callbacks.seekMedia).toHaveBeenLastCalledWith(f.source.path, 40)
  fireEvent.click(screen.getByRole('button', { name: 'Play' }))
  expect(f.callbacks.toggleMedia).toHaveBeenCalledWith(f.source.path)
})

it('does not publish old waveform results after a source version is replaced', async () => {
  const f = fixture('audio')
  const old = Promise.withResolvers<MediaWaveform>()
  wave.read.mockReturnValueOnce(old.promise)
  const view = render(<MediaPreview {...f.props} />)
  f.setResource({ status: 'live', value: { ...f.source, version: 'two', url: '/api/media/clip?v=two' }, failure: undefined })
  view.rerender(<MediaPreview {...f.props} />)
  const waveform = await screen.findByRole('slider', { name: 'Waveform' })
  old.resolve({ duration: 20, peaks: [1] })
  await Promise.resolve()
  expect(waveform.querySelectorAll('line')).toHaveLength(4)
  expect(wave.read.mock.calls[0]?.[1].aborted).toBe(true)
})

it('retains playback attachment and the decoded waveform when equivalent metadata is republished', async () => {
  const f = fixture('audio')
  const view = render(<MediaPreview {...f.props} />)
  await screen.findByRole('slider', { name: 'Waveform' })
  f.setResource({ status: 'live', value: { ...f.source }, failure: undefined })
  view.rerender(<MediaPreview {...f.props} />)
  expect(f.callbacks.mountMedia).toHaveBeenCalledOnce()
  expect(f.release).not.toHaveBeenCalled()
  expect(wave.read).toHaveBeenCalledOnce()
  expect(screen.queryByRole('status', { name: 'Loading waveform' })).toBeNull()
})

it('scrubs a scaled waveform through captured pointer movement and releases the gesture on cancellation', async () => {
  const f = fixture('audio')
  const view = render(<MediaPreview {...f.props} />)
  const waveform = await screen.findByRole('slider', { name: 'Waveform' })
  const capture = vi.fn()
  const release = vi.fn()
  Object.defineProperties(waveform, {
    setPointerCapture: { value: capture }, releasePointerCapture: { value: release },
    hasPointerCapture: { value: () => true },
  })
  vi.spyOn(waveform, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 0, 200, 64))
  const pointer = (type: string, clientX: number, pointerId = 7) => {
    const event = new MouseEvent(type, { button: 0, clientX, bubbles: true, cancelable: true })
    Object.defineProperty(event, 'pointerId', { value: pointerId })
    fireEvent(waveform, event)
  }
  pointer('pointerdown', 150)
  expect(capture).toHaveBeenCalledExactlyOnceWith(7)
  expect(document.activeElement).toBe(waveform)
  expect(f.callbacks.seekMedia).toHaveBeenLastCalledWith(f.source.path, 10)
  pointer('pointermove', 250, 8)
  expect(f.callbacks.seekMedia).toHaveBeenCalledTimes(1)
  pointer('pointermove', 250)
  expect(f.callbacks.seekMedia).toHaveBeenLastCalledWith(f.source.path, 30)
  pointer('pointercancel', 250)
  expect(release).toHaveBeenCalledExactlyOnceWith(7)
  pointer('pointermove', 50)
  expect(f.callbacks.seekMedia).toHaveBeenCalledTimes(2)
  pointer('pointerdown', 400)
  expect(f.callbacks.seekMedia).toHaveBeenLastCalledWith(f.source.path, 40)
  pointer('pointerup', 50)
  expect(f.callbacks.seekMedia).toHaveBeenLastCalledWith(f.source.path, 0)
  expect(release).toHaveBeenCalledTimes(2)
  pointer('pointerdown', 200)
  view.unmount()
  expect(release).toHaveBeenCalledTimes(3)
  expect(f.callbacks.toggleMedia).not.toHaveBeenCalled()
})

it('keeps one seek control usable while the waveform loads and swaps its display without moving focus', async () => {
  const f = fixture('audio')
  const decoding = Promise.withResolvers<MediaWaveform>()
  wave.read.mockReturnValueOnce(decoding.promise)
  render(<MediaPreview {...f.props} />)
  const slider = screen.getByRole('slider', { name: 'Playback position' })
  slider.focus()
  expect(screen.getAllByRole('slider')).toHaveLength(1)
  expect(screen.getByRole('status', { name: 'Loading waveform' })).toBeDefined()
  fireEvent.keyDown(slider, { key: 'ArrowRight' })
  expect(f.callbacks.seekMedia).toHaveBeenCalledExactlyOnceWith(f.source.path, 10)
  decoding.resolve({ duration: 40, peaks: [0.25, 0.5] })
  const loaded = await screen.findByRole('slider', { name: 'Waveform' })
  expect(loaded).toBe(slider)
  expect(document.activeElement).toBe(slider)
  expect(screen.getAllByRole('slider')).toHaveLength(1)
  expect(screen.queryByRole('slider', { name: 'Volume' })).toBeNull()
})

it('retains the audio presentation across compact and expanded controls with one transport and no waveform work while folded', async () => {
  const f = fixture('audio')
  f.setPlayback({ status: 'playing', intent: 'manual', currentTime: 12 })
  const view = render(<MediaPreview {...f.props} presentation="compact" />)
  const viewportId = f.callbacks.mountMedia.mock.calls[0]![1]
  const viewport = document.getElementById(viewportId)
  expect(wave.read).not.toHaveBeenCalled()
  expect(screen.queryByRole('slider')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Volume' })).toBeNull()
  expect(screen.getByText('0:12 / 0:40')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
  expect(f.callbacks.toggleMedia).toHaveBeenCalledExactlyOnceWith(f.source.path)
  expect({ buttons: screen.getAllByRole('button').map(button => button.getAttribute('aria-label')),
    time: screen.getByRole('group', { name: 'Playback controls' }).textContent,
  }).toMatchSnapshot('compact audio transport')
  view.rerender(<MediaPreview {...f.props} />)
  await screen.findByRole('slider', { name: 'Waveform' })
  expect(document.getElementById(viewportId)).toBe(viewport)
  expect(f.callbacks.mountMedia).toHaveBeenCalledOnce()
  view.rerender(<MediaPreview {...f.props} presentation="compact" />)
  expect(wave.read.mock.calls[0]?.[1].aborted).toBe(true)
  expect(f.release).not.toHaveBeenCalled()
  view.unmount()
  expect(f.release).toHaveBeenCalledOnce()
})

it('keeps source failures in a compact retry action before a player can be attached', () => {
  const f = fixture('audio')
  f.setResource({ status: 'failed', value: undefined, failure: undefined })
  render(<MediaPreview {...f.props} presentation="compact" />)
  expect(screen.getAllByRole('button')).toHaveLength(1)
  expect(screen.getByRole('alert').textContent).toBe(en['media.failed'])
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(f.useResource).toHaveBeenLastCalledWith(`${resourceAddress('convax-media', f.props.path)}?attempt=1`)
  expect(f.callbacks.mountMedia).not.toHaveBeenCalled()
})

it('replaces a failed compact audio transport with one system-open action and preserves an unsuccessful launch', async () => {
  const f = fixture('audio')
  f.setPlayback({ status: 'failed', failure: 'unsupported' })
  f.callbacks.openSystem.mockRejectedValue(new Error('No handler'))
  render(<MediaPreview {...f.props} presentation="compact" />)
  expect(screen.getAllByRole('button')).toHaveLength(1)
  expect(screen.getByRole('alert').textContent).toBe(en['media.unsupported'])
  fireEvent.click(screen.getByRole('button', { name: 'Open in system app' }))
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en['media.openFailed']) })
  expect(f.callbacks.openSystem).toHaveBeenCalledExactlyOnceWith(f.source.path)
  expect(f.callbacks.mountMedia).toHaveBeenCalledOnce()
  expect(wave.read).not.toHaveBeenCalled()
})

it('keeps a keyless snapshot of the audio waveform controls and hover-to-manual action labels', async () => {
  const f = fixture('audio')
  f.setPlayback({ status: 'playing', intent: 'hover' })
  const view = render(<MediaPreview {...f.props} />)
  const waveform = await screen.findByRole('slider', { name: 'Waveform' })
  const controls = () => screen.getAllByRole('button').map(button => ({
    label: button.getAttribute('aria-label'), disabled: button.hasAttribute('disabled'),
  }))
  const svg = waveform.querySelector('svg')?.cloneNode(true) as SVGElement
  svg.querySelectorAll('[class]').forEach((element) => { element.removeAttribute('class') })
  expect({ waveform: svg.outerHTML, controls: controls(),
    position: waveform.getAttribute('aria-valuetext'),
    seekControls: screen.getAllByRole('slider').length,
  }).toMatchSnapshot('hover preview offers keep-playing')
  f.setPlayback({ intent: 'manual' })
  view.rerender(<MediaPreview {...f.props} />)
  expect(controls()).toMatchSnapshot('manual playback offers pause')
})
