/** Window-retained native players; preview occurrences attach only JSON-addressed viewports. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { MediaPlaybackState, MediaSource } from './media-contract.ts'

interface MediaSeat { readonly host: HTMLElement }
interface Player {
  readonly source: MediaSource
  readonly element: HTMLMediaElement
  readonly seats: MediaSeat[]
  listeners: ReadonlyArray<readonly [string, EventListener]>
  state: MediaPlaybackState
  generation: number
  hovered: boolean
  suppressHover: boolean
  restoreTime: number | undefined
  moving: boolean
}

type MovingHost = HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void }

function finite(value: number, fallback = 0): number { return Number.isFinite(value) ? Math.max(0, value) : fallback }
function bounded(value: number, maximum: number): number { return Math.min(finite(value), maximum) }

/** One window's players survive preview folding and canvas navigation until their sources are removed. */
export class CanvasMediaPlayback {
  private readonly state = createSnapshotStore<Readonly<Record<string, MediaPlaybackState>>>({})
  private readonly players = new Map<string, Player>()
  private readonly dormant = new Map<string, { source: MediaSource; state: MediaPlaybackState }>()
  private readonly parking = document.createElement('div')
  private disposed = false

  /**
   * Read detached playback facts for framework-generated hooks.
   * @returns The latest immutable-by-owner snapshot.
   */
  readonly getSnapshot = (): Readonly<Record<string, MediaPlaybackState>> => this.state.getSnapshot()
  /**
   * Subscribe to detached playback facts.
   * @param listener - State observer.
   * @returns Observer release.
   */
  readonly subscribe = (listener: () => void): (() => void) => this.state.subscribe(listener)

  constructor() {
    this.parking.hidden = true
    this.parking.setAttribute('aria-hidden', 'true')
    document.body.append(this.parking)
  }

  /**
   * Attach a source to a committed viewport, temporarily replacing its prior presentation.
   * @param source - Versioned source identity shared by inline and modal previews.
   * @param viewportId - Connected document element id owned by the preview occurrence.
   * @returns Release this occurrence and restore the preceding connected viewport or parking host.
   */
  mount(source: MediaSource, viewportId: string): () => void {
    if (this.disposed) throw new Error('Media playback owner is disposed')
    const host = document.getElementById(viewportId)
    if (host === null || !host.isConnected) throw new Error(`Media viewport is not connected: ${viewportId}`)
    let player = this.players.get(source.path)
    if (player !== undefined && (player.source.version !== source.version || player.source.url !== source.url
      || player.source.kind !== source.kind)) {
      this.releasePlayer(player)
      this.players.delete(source.path)
      player = undefined
    }
    if (player === undefined) {
      const checkpoint = this.dormant.get(source.path)
      const restored = checkpoint?.source.version === source.version && checkpoint.source.kind === source.kind
        ? checkpoint.state : undefined
      this.dormant.delete(source.path)
      player = this.createPlayer(source, restored)
      this.players.set(source.path, player)
    }
    const held = player
    this.hover(source.path, false)
    const seat = { host }
    held.seats.push(seat)
    this.present(held)
    let released = false
    return () => {
      if (released || this.players.get(source.path) !== held) return
      released = true
      const index = held.seats.indexOf(seat)
      const wasPresented = held.element.parentElement === seat.host
        || held.seats.findLast(heldSeat => heldSeat.host.isConnected) === seat
      held.seats.splice(index, 1)
      if (wasPresented) this.hover(source.path, false)
      if (this.players.get(source.path) !== held || this.retire(held)) return
      this.present(held)
    }
  }

  /**
   * Preview playback follows the pointer until explicitly latched by the user.
   * @param path - Mounted source path.
   * @param hovered - Whether the presented occurrence contains the pointer.
   */
  hover(path: string, hovered: boolean): void {
    const player = this.players.get(path)
    if (player === undefined || player.hovered === hovered) return
    player.hovered = hovered
    if (!hovered) {
      player.suppressHover = false
      if (player.state.intent === 'hover') this.pause(player)
    } else if (!player.suppressHover && player.state.intent === 'none' && player.state.status !== 'failed') {
      this.start(player, 'hover')
    }
  }

  /**
   * Latch a hover preview into manual playback, or pause an already manually playing source.
   * @param path - Mounted source path.
   */
  toggle(path: string): void {
    const player = this.players.get(path)
    if (player === undefined) return
    if (player.state.intent === 'manual' && (player.state.status === 'playing' || player.state.status === 'starting')) {
      player.suppressHover = player.hovered
      this.pause(player)
    } else this.start(player, 'manual')
  }

  /**
   * Seek without changing playback intent; unknown durations leave the position unchanged.
   * @param path - Mounted source path.
   * @param seconds - Requested position, clamped to the finite duration.
   */
  seek(path: string, seconds: number): void {
    const player = this.players.get(path)
    if (player === undefined || player.state.duration === 0 || !Number.isFinite(seconds)) return
    const position = bounded(seconds, player.state.duration)
    if (player.restoreTime !== undefined) {
      player.restoreTime = position
      this.update(player, { currentTime: position })
      return
    }
    player.element.currentTime = position
    this.facts(player)
  }

  /**
   * Set the native player's volume without changing playback intent.
   * @param path - Mounted source path.
   * @param volume - Requested volume, clamped to zero through one; nonfinite values are ignored.
   */
  volume(path: string, volume: number): void {
    const player = this.players.get(path)
    if (player === undefined || !Number.isFinite(volume)) return
    player.element.volume = bounded(volume, 1)
    this.facts(player)
  }

  /**
   * Request fullscreen for the presented video and its sibling controls.
   * @param path - Mounted video source path; absent or audio sources do nothing.
   * @returns Native fullscreen completion; unsupported or denied requests reject to the caller.
   */
  async fullscreen(path: string): Promise<void> {
    const player = this.players.get(path)
    if (player === undefined) {
      if (this.dormant.get(path)?.source.kind === 'video') throw new Error('Media fullscreen requires a presented viewport')
      return
    }
    if (player.source.kind !== 'video') return
    const target = player.seats.findLast(seat => seat.host.isConnected)?.host.parentElement
    if (target === undefined || target === null) throw new Error('Media fullscreen requires a presented viewport')
    if (typeof target.requestFullscreen !== 'function') throw new Error('Media fullscreen is unavailable')
    await target.requestFullscreen()
  }

  /**
   * Dispose sources removed from the window's canvas and modal resources.
   * @param paths - Source paths still owned by this window.
   */
  reconcile(paths: ReadonlySet<string>): void {
    for (const [path, player] of this.players) {
      if (paths.has(path)) continue
      this.releasePlayer(player)
      this.players.delete(path)
    }
    for (const path of this.dormant.keys()) if (!paths.has(path)) this.dormant.delete(path)
    this.publish()
  }

  /** Stop all playback, detach listeners and remove the connected parking host. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const player of this.players.values()) this.releasePlayer(player)
    this.players.clear()
    this.dormant.clear()
    this.parking.remove()
    this.publish()
  }

  private createPlayer(source: MediaSource, restored: MediaPlaybackState | undefined): Player {
    const element = document.createElement(source.kind)
    element.controls = false
    element.preload = 'metadata'
    element.hidden = source.kind === 'audio'
    element.style.width = '100%'
    element.style.height = '100%'
    element.style.objectFit = 'contain'
    element.style.display = source.kind === 'audio' ? 'none' : 'block'
    if (element instanceof HTMLVideoElement) element.playsInline = true
    const state: MediaPlaybackState = {
      intent: 'none', status: 'paused', currentTime: 0, duration: 0, volume: 1, autoplayBlocked: false, presented: false,
      ...source.kind === 'video' ? { videoWidth: 0, videoHeight: 0 } : {},
      ...restored,
    }
    element.volume = state.volume
    const player: Player = {
      source, element, seats: [], listeners: [], state, generation: 0, hovered: false, suppressHover: false,
      restoreTime: restored?.currentTime, moving: false,
    }
    const listeners: Array<readonly [string, EventListener]> = [
      ...['loadedmetadata', 'durationchange', 'timeupdate', 'volumechange', 'resize'].map(name => [name, () => { this.facts(player) }] as const),
      ['playing', () => {
        if (player.state.intent === 'none') { element.pause(); return }
        this.update(player, { status: 'playing' })
      }],
      ['pause', () => {
        if (element.paused && player.state.status !== 'ended' && player.state.status !== 'failed') {
          this.update(player, { status: 'paused' })
          if (player.state.intent === 'manual' && !player.moving) this.retire(player)
        }
      }],
      ['ended', () => {
        player.generation += 1
        player.suppressHover = player.hovered
        this.facts(player)
        this.update(player, { intent: 'none', status: 'ended' })
        this.retire(player)
      }],
      ['error', () => {
        player.generation += 1
        element.pause()
        this.update(player, { intent: 'none', status: 'failed', failure: element.error?.code === 4 ? 'unsupported' : 'playback' })
        this.retire(player)
      }],
    ]
    for (const [name, listener] of listeners) element.addEventListener(name, listener)
    player.listeners = listeners
    this.parking.append(element)
    element.src = source.url
    return player
  }

  private present(player: Player): void {
    const host = player.seats.findLast(seat => seat.host.isConnected)?.host
    this.update(player, { presented: host !== undefined })
    const target = host ?? this.parking
    if (player.element.parentElement === target) return
    const moving = target as MovingHost
    if (typeof moving.moveBefore === 'function' && target.ownerDocument === player.element.ownerDocument
      && target.isConnected === player.element.isConnected) moving.moveBefore(player.element, null)
    else {
      const intent = player.state.intent
      player.moving = true
      try { target.append(player.element) } finally { player.moving = false }
      if (intent !== 'none') this.start(player, intent)
    }
  }

  private start(player: Player, intent: 'hover' | 'manual'): void {
    const generation = ++player.generation
    const restart = player.state.status === 'ended'
    if (restart) {
      if (player.restoreTime === undefined) player.element.currentTime = 0
      else player.restoreTime = 0
    }
    const { failure: _failure, ...state } = player.state
    player.state = { ...state, intent, status: 'starting', currentTime: restart ? 0 : state.currentTime, autoplayBlocked: false }
    this.publish()
    void player.element.play().then(() => {
      if (this.players.get(player.source.path) !== player || player.generation !== generation) {
        if (this.players.get(player.source.path) !== player || player.state.intent === 'none') player.element.pause()
        return
      }
      this.update(player, { status: 'playing' })
    }, () => {
      if (this.players.get(player.source.path) !== player || player.generation !== generation) return
      if (intent === 'hover') {
        this.update(player, { intent: 'none', status: 'paused', autoplayBlocked: true })
      } else this.update(player, { intent: 'none', status: 'failed', failure: 'playback' })
      this.retire(player)
    })
  }

  private pause(player: Player): void {
    player.generation += 1
    this.update(player, { intent: 'none', status: 'paused' })
    player.element.pause()
    this.facts(player)
    this.retire(player)
  }

  private facts(player: Player): void {
    const duration = finite(player.element.duration)
    const dimensions = player.element instanceof HTMLVideoElement
      ? { videoWidth: finite(player.element.videoWidth), videoHeight: finite(player.element.videoHeight) } : {}
    if (player.restoreTime !== undefined) {
      if (duration === 0) { this.update(player, { volume: bounded(player.element.volume, 1), ...dimensions }); return }
      player.element.currentTime = bounded(player.restoreTime, duration)
      player.restoreTime = undefined
    }
    this.update(player, {
      duration, currentTime: duration === 0 ? 0 : bounded(player.element.currentTime, duration), volume: bounded(player.element.volume, 1),
      ...dimensions,
    })
  }

  private update(player: Player, patch: Partial<MediaPlaybackState>): void {
    if (Object.entries(patch).every(([key, value]) => player.state[key as keyof MediaPlaybackState] === value)) return
    player.state = { ...player.state, ...patch }
    this.publish()
  }

  private publish(): void {
    this.state.set(Object.fromEntries([...this.dormant, ...this.players].map(([path, player]) => [path, player.state])))
  }

  private retire(player: Player): boolean {
    if (this.players.get(player.source.path) !== player || player.seats.some(seat => seat.host.isConnected)) return false
    if (player.state.intent === 'manual' && (player.state.status === 'playing' || player.state.status === 'starting')) return false
    const state: MediaPlaybackState = {
      intent: 'none', status: player.state.status === 'ended' ? 'ended' : 'paused',
      currentTime: player.state.currentTime, duration: player.state.duration, volume: player.state.volume,
      autoplayBlocked: false, presented: false,
      ...player.state.videoWidth === undefined ? {} : { videoWidth: player.state.videoWidth },
      ...player.state.videoHeight === undefined ? {} : { videoHeight: player.state.videoHeight },
    }
    this.releasePlayer(player)
    this.players.delete(player.source.path)
    this.dormant.set(player.source.path, { source: player.source, state })
    this.publish()
    return true
  }

  private releasePlayer(player: Player): void {
    player.generation += 1
    player.state = { ...player.state, intent: 'none' }
    for (const [name, listener] of player.listeners) player.element.removeEventListener(name, listener)
    player.element.pause()
    player.element.removeAttribute('src')
    player.element.load()
    player.element.remove()
  }
}
