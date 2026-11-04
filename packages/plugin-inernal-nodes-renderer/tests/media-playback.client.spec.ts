// @vitest-environment jsdom
/** Native media ownership survives presentation changes and rejects stale playback completions. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CanvasMediaPlayback } from '../src/client/media-playback.ts'
import type { MediaSource } from '../src/client/media-contract.ts'

const owners: CanvasMediaPlayback[] = []
const source: MediaSource = { path: '/project/movie.mp4', url: '/api/media?path=movie&v=1', version: 'v1', mimeType: 'video/mp4', kind: 'video' }
let paused: WeakMap<HTMLMediaElement, boolean>
const play = vi.fn<(this: HTMLMediaElement) => Promise<void>>()
const load = vi.fn<() => void>()

beforeEach(() => {
  paused = new WeakMap()
  vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(function (this: HTMLMediaElement) {
    return paused.get(this) ?? true
  })
  play.mockReset().mockImplementation(function (this: HTMLMediaElement) {
    paused.set(this, false)
    return Promise.resolve()
  })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    paused.set(this, true)
    this.dispatchEvent(new Event('pause'))
  })
  load.mockReset()
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(load)
})

afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

function viewport(id: string) {
  const host = document.createElement('div')
  host.id = id
  document.body.append(host)
  return host
}

function fixture(value = source) {
  const owner = new CanvasMediaPlayback()
  owners.push(owner)
  const host = viewport('media-inline')
  const release = owner.mount(value, host.id)
  const element = host.querySelector('video, audio') as HTMLMediaElement
  return { owner, host, release, element, value, state: () => owner.getSnapshot()[value.path]! }
}

function metadata(element: HTMLMediaElement, duration: number, currentTime = 0) {
  Object.defineProperty(element, 'duration', { configurable: true, value: duration })
  element.currentTime = currentTime
  element.dispatchEvent(new Event('loadedmetadata'))
}

async function settled() { await Promise.resolve() }

describe('Canvas media playback', () => {
  it('attaches a native player without controls and publishes detached metadata and position', () => {
    const b = fixture()
    const listener = vi.fn()
    const unsubscribe = b.owner.subscribe(listener)
    expect(b.element.tagName).toBe('VIDEO')
    expect(b.element.controls).toBe(false)
    expect(b.element.getAttribute('src')).toBe(source.url)
    expect(b.state()).toMatchObject({ presented: true, status: 'paused', currentTime: 0, duration: 0, volume: 1,
      videoWidth: 0, videoHeight: 0 })
    metadata(b.element, 20, 3)
    expect(b.state()).toMatchObject({ duration: 20, currentTime: 3 })
    expect(listener).toHaveBeenCalled()
    unsubscribe()
    listener.mockClear()
    b.element.currentTime = 5
    b.element.dispatchEvent(new Event('timeupdate'))
    expect(listener).not.toHaveBeenCalled()
  })

  it('publishes native video dimensions and retains them only for the same source version', () => {
    const b = fixture()
    Object.defineProperties(b.element, {
      videoWidth: { configurable: true, value: 1920 },
      videoHeight: { configurable: true, value: 1080 },
    })
    metadata(b.element, 40, 5)
    expect(b.state()).toMatchObject({ videoWidth: 1920, videoHeight: 1080, duration: 40 })
    Object.defineProperties(b.element, {
      videoWidth: { configurable: true, value: 1280 },
      videoHeight: { configurable: true, value: 720 },
    })
    b.element.dispatchEvent(new Event('resize'))
    expect(b.state()).toMatchObject({ videoWidth: 1280, videoHeight: 720, currentTime: 5 })
    b.release()
    expect(b.state()).toMatchObject({ videoWidth: 1280, videoHeight: 720, presented: false })
    const remounted = viewport('media-remounted')
    const release = b.owner.mount(source, remounted.id)
    expect(b.state()).toMatchObject({ videoWidth: 1280, videoHeight: 720, currentTime: 5, presented: true })
    release()
    b.owner.mount({ ...source, version: 'v2', url: '/api/media?v=2' }, remounted.id)
    expect(b.state()).toMatchObject({ videoWidth: 0, videoHeight: 0, currentTime: 0, duration: 0 })
  })

  it('plays on hover and pauses when the pointer leaves', async () => {
    const b = fixture()
    b.owner.hover(source.path, true)
    expect(b.state()).toMatchObject({ intent: 'hover', status: 'starting' })
    await settled()
    expect(b.state()).toMatchObject({ intent: 'hover', status: 'playing' })
    b.owner.hover(source.path, false)
    expect(b.state()).toMatchObject({ intent: 'none', status: 'paused' })
    expect(b.element.paused).toBe(true)
  })

  it('latches hover playback on a click and retains the same player while folded or on another canvas', async () => {
    const b = fixture()
    b.owner.hover(source.path, true)
    await settled()
    b.owner.toggle(source.path)
    await settled()
    b.owner.hover(source.path, false)
    b.release()
    b.host.remove()
    await settled()
    expect(b.state()).toMatchObject({ intent: 'manual', status: 'playing', presented: false })
    expect(b.element.isConnected).toBe(true)
    expect(b.element.paused).toBe(false)
    const remounted = viewport('media-remounted')
    const release = b.owner.mount(source, remounted.id)
    await settled()
    expect(remounted.querySelector('video')).toBe(b.element)
    expect(b.state()).toMatchObject({ intent: 'manual', status: 'playing', presented: true })
    release()
  })

  it('stops a hover preview when its presentation is folded', async () => {
    const b = fixture()
    b.owner.hover(source.path, true)
    await settled()
    b.host.remove()
    b.release()
    expect(b.state()).toMatchObject({ intent: 'none', status: 'paused', presented: false })
    expect(b.element.paused).toBe(true)
    expect(b.element.isConnected).toBe(false)
    expect(b.element.hasAttribute('src')).toBe(false)
  })

  it('releases paused media buffers and restores same-version progress and volume on remount', () => {
    const b = fixture()
    metadata(b.element, 30, 12)
    b.owner.volume(source.path, 0.4)
    b.release()
    expect(b.element.isConnected).toBe(false)
    expect(b.element.hasAttribute('src')).toBe(false)
    expect(load).toHaveBeenCalledOnce()
    expect(b.state()).toMatchObject({ intent: 'none', status: 'paused', currentTime: 12, volume: 0.4, presented: false })
    const remounted = viewport('media-remounted')
    b.owner.mount(source, remounted.id)
    const replacement = remounted.querySelector('video')!
    expect(replacement).not.toBe(b.element)
    expect(replacement.volume).toBe(0.4)
    b.owner.seek(source.path, 18)
    expect(b.state().currentTime).toBe(18)
    b.owner.volume(source.path, 0.6)
    expect(b.state().volume).toBe(0.6)
    metadata(replacement, 30)
    expect(replacement.currentTime).toBe(18)
    expect(b.state()).toMatchObject({ currentTime: 18, duration: 30, volume: 0.6, presented: true })
  })

  it('releases parked manual playback when paused and forgets checkpoints removed by reconciliation', async () => {
    const b = fixture()
    metadata(b.element, 30, 8)
    b.owner.toggle(source.path)
    await settled()
    b.release()
    await settled()
    expect(b.element.isConnected).toBe(true)
    b.owner.toggle(source.path)
    expect(b.element.isConnected).toBe(false)
    expect(b.element.hasAttribute('src')).toBe(false)
    expect(b.state()).toMatchObject({ intent: 'none', currentTime: 8, presented: false })
    b.owner.reconcile(new Set())
    expect(b.owner.getSnapshot()).toEqual({})
  })

  it('restarts ended checkpoints from zero but does not restore progress into a changed version', async () => {
    const b = fixture()
    metadata(b.element, 30, 30)
    b.element.dispatchEvent(new Event('ended'))
    b.release()
    expect(b.element.hasAttribute('src')).toBe(false)
    const remounted = viewport('media-remounted')
    const release = b.owner.mount(source, remounted.id)
    const replacement = remounted.querySelector('video')!
    b.owner.toggle(source.path)
    metadata(replacement, 30)
    await settled()
    expect(replacement.currentTime).toBe(0)
    expect(b.state()).toMatchObject({ intent: 'manual', currentTime: 0 })
    metadata(replacement, 30, 20)
    b.owner.volume(source.path, 0.8)
    b.owner.toggle(source.path)
    release()
    b.owner.mount({ ...source, version: 'v2', url: '/api/media?v=2' }, remounted.id)
    expect(b.state()).toMatchObject({ currentTime: 0, volume: 1, status: 'paused' })
  })

  it('keeps manual pause effective for the current hover cycle and allows another cycle', async () => {
    const b = fixture()
    b.owner.hover(source.path, true)
    b.owner.toggle(source.path)
    await settled()
    b.owner.toggle(source.path)
    b.owner.hover(source.path, true)
    expect(b.state()).toMatchObject({ intent: 'none', status: 'paused' })
    b.owner.hover(source.path, false)
    b.owner.hover(source.path, true)
    await settled()
    expect(b.state()).toMatchObject({ intent: 'hover', status: 'playing' })
  })

  it('does not let a late hover play completion restart playback after leaving', async () => {
    const pending = Promise.withResolvers<undefined>()
    play.mockReturnValueOnce(pending.promise)
    const b = fixture()
    b.owner.hover(source.path, true)
    b.owner.hover(source.path, false)
    pending.resolve(undefined)
    await settled()
    expect(b.state()).toMatchObject({ intent: 'none', status: 'paused' })
    expect(b.element.paused).toBe(true)
  })

  it('ignores stale play failure after a newer manual request succeeds', async () => {
    const pending = Promise.withResolvers<undefined>()
    play.mockReturnValueOnce(pending.promise)
    const b = fixture()
    b.owner.hover(source.path, true)
    b.owner.toggle(source.path)
    await settled()
    pending.reject(new DOMException('Autoplay was blocked', 'NotAllowedError'))
    await settled()
    expect(b.state()).toMatchObject({ intent: 'manual', status: 'playing', autoplayBlocked: false })
    expect(b.state().failure).toBeUndefined()
  })

  it('keeps a manual pause effective while its original play request is pending', async () => {
    const pending = Promise.withResolvers<undefined>()
    play.mockReturnValueOnce(pending.promise)
    const b = fixture()
    b.owner.toggle(source.path)
    b.owner.toggle(source.path)
    pending.resolve(undefined)
    await settled()
    expect(b.state()).toMatchObject({ intent: 'none', status: 'paused' })
    expect(b.element.paused).toBe(true)
  })

  it('keeps blocked autoplay distinct from a failed manual play and allows explicit retry', async () => {
    play.mockRejectedValueOnce(new DOMException('Blocked', 'NotAllowedError'))
    const b = fixture()
    b.owner.hover(source.path, true)
    await settled()
    expect(b.state()).toMatchObject({ intent: 'none', status: 'paused', autoplayBlocked: true })
    expect(b.state().failure).toBeUndefined()
    play.mockRejectedValueOnce(new Error('Playback failed'))
    b.owner.toggle(source.path)
    await settled()
    expect(b.state()).toMatchObject({ intent: 'none', status: 'failed', failure: 'playback', autoplayBlocked: false })
    b.owner.toggle(source.path)
    await settled()
    expect(b.state()).toMatchObject({ intent: 'manual', status: 'playing' })
    expect(b.state().failure).toBeUndefined()
  })

  it.each([[4, 'unsupported'], [3, 'playback']] as const)('maps native media error %s to %s', (code, failure) => {
    const b = fixture()
    Object.defineProperty(b.element, 'error', { configurable: true, value: { code } })
    b.element.dispatchEvent(new Event('error'))
    expect(b.state()).toMatchObject({ status: 'failed', intent: 'none', failure })
    expect(b.element.paused).toBe(true)
  })

  it('ends once without looping while hovered, and restarts from zero on a new explicit play', async () => {
    const b = fixture()
    metadata(b.element, 10, 10)
    b.owner.hover(source.path, true)
    await settled()
    b.element.dispatchEvent(new Event('ended'))
    expect(b.state()).toMatchObject({ intent: 'none', status: 'ended', currentTime: 10 })
    const calls = play.mock.calls.length
    b.owner.hover(source.path, true)
    expect(play).toHaveBeenCalledTimes(calls)
    b.owner.toggle(source.path)
    await settled()
    expect(b.element.currentTime).toBe(0)
    expect(b.state()).toMatchObject({ intent: 'manual', status: 'playing', currentTime: 0 })
  })

  it('clamps seeking and volume without producing nonfinite snapshot fields or changing playback intent', () => {
    const b = fixture()
    b.owner.seek(source.path, 5)
    expect(b.element.currentTime).toBe(0)
    metadata(b.element, 20)
    b.owner.seek(source.path, 200)
    expect(b.state()).toMatchObject({ currentTime: 20, intent: 'none', status: 'paused' })
    b.owner.seek(source.path, -5)
    expect(b.state().currentTime).toBe(0)
    b.owner.seek(source.path, Number.NaN)
    b.owner.volume(source.path, 2)
    expect(b.state().volume).toBe(1)
    b.owner.volume(source.path, -1)
    b.owner.volume(source.path, Number.POSITIVE_INFINITY)
    expect(b.state().volume).toBe(0)
    metadata(b.element, Number.NaN, 5)
    expect(b.state()).toMatchObject({ currentTime: 0, duration: 0 })
  })

  it('stacks modal presentation over inline and restores its connected predecessor', async () => {
    const b = fixture()
    b.owner.toggle(source.path)
    await settled()
    const modal = viewport('media-modal')
    const releaseModal = b.owner.mount(source, modal.id)
    await settled()
    expect(modal.querySelector('video')).toBe(b.element)
    expect(b.host.querySelector('video')).toBeNull()
    releaseModal()
    await settled()
    expect(b.host.querySelector('video')).toBe(b.element)
    expect(b.state()).toMatchObject({ intent: 'manual', status: 'playing', presented: true })
    releaseModal()
    expect(b.host.querySelector('video')).toBe(b.element)
  })

  it('uses state-preserving DOM moves when available without requesting playback again', async () => {
    const b = fixture()
    b.owner.toggle(source.path)
    await settled()
    const modal = viewport('media-modal')
    const move = vi.fn((element: Node) => { modal.append(element) })
    Object.defineProperty(modal, 'moveBefore', { configurable: true, value: move })
    play.mockClear()
    b.owner.mount(source, modal.id)
    expect(move).toHaveBeenCalledWith(b.element, null)
    expect(play).not.toHaveBeenCalled()
    expect(b.state()).toMatchObject({ intent: 'manual', status: 'playing' })
  })

  it('restores manual playback when a fallback DOM move pauses the retained element', async () => {
    const b = fixture()
    b.owner.toggle(source.path)
    await settled()
    const modal = viewport('media-modal')
    const append = modal.append.bind(modal)
    vi.spyOn(modal, 'append').mockImplementation((...nodes) => { append(...nodes); b.element.pause() })
    b.owner.mount(source, modal.id)
    await settled()
    expect(modal.querySelector('video')).toBe(b.element)
    expect(b.element.paused).toBe(false)
    expect(b.state()).toMatchObject({ intent: 'manual', status: 'playing', presented: true })
  })

  it('falls back to append when a removed viewport disconnects the player before release', async () => {
    const b = fixture()
    b.owner.toggle(source.path)
    await settled()
    const parking = document.body.querySelector<HTMLDivElement>('div[hidden]')!
    const append = parking.append.bind(parking)
    vi.spyOn(parking, 'append').mockImplementation((...nodes) => { append(...nodes); b.element.pause() })
    const move = vi.fn((element: Node) => {
      if (element.isConnected !== parking.isConnected) throw new DOMException('Different connected state', 'HierarchyRequestError')
      parking.append(element)
    })
    Object.defineProperty(parking, 'moveBefore', { configurable: true, value: move })
    b.host.remove()
    expect(b.element.isConnected).toBe(false)
    expect(() => { b.release() }).not.toThrow()
    await settled()
    expect(move).not.toHaveBeenCalled()
    expect(b.element.parentElement).toBe(parking)
    expect(b.state()).toMatchObject({ intent: 'manual', status: 'playing', presented: false })
    expect(load).not.toHaveBeenCalled()
  })

  it('replaces changed source versions and makes earlier release callbacks harmless', () => {
    const b = fixture()
    const modal = viewport('media-modal')
    const changed = { ...source, version: 'v2', url: '/api/media?path=movie&v=2' }
    b.owner.mount(changed, modal.id)
    const replacement = modal.querySelector('video')!
    expect(replacement).not.toBe(b.element)
    expect(b.element.isConnected).toBe(false)
    expect(b.element.hasAttribute('src')).toBe(false)
    b.release()
    expect(replacement.isConnected).toBe(true)
    expect(b.state()).toMatchObject({ presented: true, intent: 'none', status: 'paused' })
  })

  it('releases removed sources and all window resources, including pending play completions', async () => {
    const pending = Promise.withResolvers<undefined>()
    play.mockReturnValueOnce(pending.promise)
    const b = fixture()
    b.owner.toggle(source.path)
    b.owner.reconcile(new Set())
    pending.resolve(undefined)
    await settled()
    expect(b.owner.getSnapshot()).toEqual({})
    expect(b.element.isConnected).toBe(false)
    expect(b.element.hasAttribute('src')).toBe(false)
    b.element.dispatchEvent(new Event('playing'))
    expect(b.owner.getSnapshot()).toEqual({})
    const elementCount = document.body.children.length
    b.owner.dispose()
    expect(document.body.children.length).toBe(elementCount - 1)
    expect(load).toHaveBeenCalledOnce()
    b.owner.dispose()
    expect(() => b.owner.mount(source, b.host.id)).toThrow('disposed')
  })

  it('keeps independent windows separate and requires a connected mount viewport', () => {
    const first = fixture()
    const other = new CanvasMediaPlayback()
    owners.push(other)
    expect(other.getSnapshot()).toEqual({})
    expect(() => other.mount(source, 'missing')).toThrow('not connected')
    other.dispose()
    expect(first.state()).toMatchObject({ presented: true })
    expect(first.element.isConnected).toBe(true)
  })

  it('hides audio elements and delegates fullscreen only to a mounted video', async () => {
    const b = fixture({ ...source, path: '/project/audio.mp3', kind: 'audio', mimeType: 'audio/mpeg' })
    expect(b.element.tagName).toBe('AUDIO')
    expect(b.element.hidden).toBe(true)
    await b.owner.fullscreen(b.value.path)
    await b.owner.fullscreen('/project/missing.mp4')
    const host = viewport('video-fullscreen')
    const release = b.owner.mount(source, host.id)
    const video = host.querySelector('video')!
    await expect(b.owner.fullscreen(source.path)).rejects.toThrow('unavailable')
    const container = document.createElement('section')
    host.before(container)
    container.append(host)
    const fullscreen = vi.fn(() => Promise.resolve())
    Object.defineProperty(container, 'requestFullscreen', { configurable: true, value: fullscreen })
    const videoFullscreen = vi.fn(() => Promise.resolve())
    Object.defineProperty(video, 'requestFullscreen', { configurable: true, value: videoFullscreen })
    await b.owner.fullscreen(source.path)
    expect(fullscreen).toHaveBeenCalledOnce()
    expect(videoFullscreen).not.toHaveBeenCalled()
    fullscreen.mockRejectedValueOnce(new Error('Denied'))
    await expect(b.owner.fullscreen(source.path)).rejects.toThrow('Denied')
    release()
    await expect(b.owner.fullscreen(source.path)).rejects.toThrow('presented viewport')
  })
})
