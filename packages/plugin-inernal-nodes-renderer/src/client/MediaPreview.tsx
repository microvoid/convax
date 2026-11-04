/** Card-local media controls attach a window-owned player without owning its playback lifetime. */
import { CirclePause, CirclePlay, FolderOpen, Maximize2, RefreshCw, Volume2 } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { Button, Tooltip, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MediaPlaybackState, MediaPreviewProps, MediaSource } from './media-contract.ts'
import { MediaMetadata } from './MediaMetadata.tsx'
import { readMediaWaveform, type MediaWaveform } from './media-waveform.ts'
import { resourceAddress } from '@deepseek-ai/dsh-convax-plugin-renderer/client'
import css from './MediaPreview.module.css'

const EMPTY_PLAYBACK: MediaPlaybackState = {
  intent: 'none', status: 'paused', currentTime: 0, duration: 0, volume: 1, autoplayBlocked: false, presented: false,
}

/** @param props - Framework resource, playback and localized control seats. @returns An inline media preview. */
export function MediaPreview(props: MediaPreviewProps) {
  return props.presentation === 'metadata' ? <MediaMetadata {...props} /> : <MediaPlayerResource {...props} />
}

function MediaPlayerResource(props: MediaPreviewProps) {
  const [attempt, setAttempt] = useState(0)
  const resource = props.useResource<'convax-media'>(`${resourceAddress('convax-media', props.path)}?attempt=${attempt}`)
  const failed = resource.status === 'failed' || resource.status === 'none'
  const compact = props.presentation === 'compact'
  return <section className={`${css.root} nodrag nopan`} data-convax-media-preview="" data-presentation={props.presentation}>
    {resource.value === undefined && resource.status === 'loading' && <div className={css.status}
      role="status" aria-label={props.t('media.loading')}><span className={css.spinner} aria-hidden="true" /></div>}
    {failed && (compact ? <Tooltip label={`${props.t('media.failed')} · ${props.t('workspace.retry')}`} portal>
      <Button size="sm" className={css.compactAction} aria-label={props.t('workspace.retry')}
        onClick={() => { setAttempt(value => value + 1) }}><RefreshCw size={16} aria-hidden />
        <span className={css.waveformMessage} role="alert">{props.t('media.failed')}</span>
      </Button>
    </Tooltip> : <div className={resource.value === undefined ? css.status : css.notice} role="alert">
      <span>{props.t('media.failed')}</span>
      <Button size="sm" onClick={() => { setAttempt(value => value + 1) }}>{props.t('workspace.retry')}</Button>
    </div>)}
    {resource.value !== undefined && <LoadedMedia key={resource.value.path} {...props} source={resource.value} />}
  </section>
}

function LoadedMedia(props: MediaPreviewProps & { readonly source: MediaSource }) {
  const { source, mountMedia, hoverMedia, toggleMedia, seekMedia, setMediaVolume, fullscreenMedia, openSystem, t } = props
  const { path, url, version, kind, mimeType } = source
  const viewportId = useId()
  const playButton = useRef<HTMLButtonElement>(null)
  const playback = props.useMediaPlayback(state => state[source.path]) ?? EMPTY_PLAYBACK
  const [actionFailure, setActionFailure] = useState<'open' | 'fullscreen' | null>(null)
  const [opening, setOpening] = useState(false)
  // Removing a playing element pauses it; layout cleanup parks it before React removes the viewport.
  useLayoutEffect(() => {
    const release = mountMedia({ path, url, version, kind, mimeType }, viewportId)
    return () => { hoverMedia(path, false); release() }
  }, [path, url, version, kind, mimeType, viewportId, mountMedia, hoverMedia])
  const duration = Number.isFinite(playback.duration) ? Math.max(0, playback.duration) : 0
  const position = Math.min(duration, Math.max(0, playback.currentTime))
  const playing = playback.status === 'playing' || playback.status === 'starting'
  const canPause = playback.intent === 'manual' && playing
  const playLabel = canPause ? 'media.pause' : playing ? 'media.keepPlaying' : 'media.play'
  const unsupported = playback.failure === 'unsupported'
  const positionText = t('media.position', { current: mediaTime(position), duration: mediaTime(duration) })
  const systemOpen = async (): Promise<void> => {
    setActionFailure(null)
    setOpening(true)
    try { await openSystem(source.path) }
    catch (_openFailure) { setActionFailure('open') }
    finally { setOpening(false) }
  }
  const fullscreen = (): void => {
    setActionFailure(null)
    void fullscreenMedia(source.path).catch((_fullscreenFailure: unknown) => { setActionFailure('fullscreen') })
  }
  const video = source.kind === 'video'
  const compact = !video && props.presentation === 'compact'
  const transport = <Tooltip label={compact && playback.autoplayBlocked ? `${t('media.autoplayBlocked')} · ${t(playLabel)}` : t(playLabel)} portal>
    <Button ref={playButton} size="sm" className={video ? css.videoIconButton : css.audioPlay} aria-label={t(playLabel)}
      disabled={unsupported} onClick={() => { toggleMedia(source.path) }}>
      {canPause ? <CirclePause size={16} aria-hidden /> : <CirclePlay size={16} aria-hidden />}
    </Button>
  </Tooltip>
  return <div className={css.player} data-kind={source.kind} data-compact={compact || undefined}
    onPointerEnter={(event) => { if (event.pointerType !== 'touch') hoverMedia(source.path, true) }}
    onPointerLeave={(event) => { if (event.pointerType !== 'touch') hoverMedia(source.path, false) }}>
    <div id={viewportId} className={css.viewport} data-kind={source.kind} />
    {playback.status === 'starting' && video && <span className={css.pending} role="status" aria-label={t('media.loading')}>
      <span className={css.spinner} aria-hidden="true" />
    </span>}
    {!compact && <div className={video ? css.videoNotices : css.audioNotices}>
      {playback.autoplayBlocked && <p className={css.notice} role="status">{t('media.autoplayBlocked')}</p>}
      {playback.status === 'failed' && <div className={css.notice} role="alert">
        <span>{t(unsupported ? 'media.unsupported' : 'media.failed')}</span>
        <Button size="sm" disabled={opening} onClick={() => { void systemOpen() }}>{t('media.openSystem')}</Button>
      </div>}
      {actionFailure !== null && <p className={css.notice} role="alert">
        {t(actionFailure === 'open' ? 'media.openFailed' : 'media.fullscreenFailed')}
      </p>}
    </div>}
    {video && !playing && playback.status !== 'failed' && <Tooltip label={t('media.playVideo')} portal>
      <Button size="sm" className={css.centerPlay} aria-label={t('media.playVideo')}
        data-convax-video-play="" onClick={(event) => {
          toggleMedia(source.path)
          if (event.detail === 0) playButton.current?.focus({ preventScroll: true })
        }}><CirclePlay size={28} aria-hidden /></Button>
    </Tooltip>}
    {video ? <div className={css.videoControls} role="group" aria-label={t('media.controls')} data-convax-video-controls="">
      {transport}
      <span className={css.videoTime}>{mediaTime(position)}</span>
      <input className={css.videoSeek} type="range" min="0" max={duration || 1} step="0.01" value={position}
        style={{ '--dsh-media-position': `${duration > 0 ? position / duration * 100 : 0}%` } as CSSProperties}
        aria-label={t('media.seek')} aria-valuetext={positionText} disabled={duration === 0 || unsupported}
        onChange={(event) => { seekMedia(source.path, event.currentTarget.valueAsNumber) }} />
      <span className={css.videoTime}>{mediaTime(duration)}</span>
      <MediaVolume video volume={playback.volume} onChange={(volume) => { setMediaVolume(source.path, volume) }} t={t} />
      <Tooltip label={t('media.fullscreen')} portal>
        <Button size="sm" className={css.videoIconButton} aria-label={t('media.fullscreen')}
          onClick={fullscreen}><Maximize2 size={16} aria-hidden /></Button>
      </Tooltip>
    </div> : <div className={css.audioControls} role="group" aria-label={t('media.controls')} data-convax-audio-controls="">
      {compact && playback.status === 'failed' ? <Tooltip
        label={`${t(actionFailure === 'open' ? 'media.openFailed' : unsupported ? 'media.unsupported' : 'media.failed')} · ${t('media.openSystem')}`} portal>
        <Button size="sm" className={css.compactAction} disabled={opening} aria-label={t('media.openSystem')}
          onClick={() => { void systemOpen() }}><FolderOpen size={16} aria-hidden />
          <span className={css.waveformMessage} role="alert">{t(actionFailure === 'open' ? 'media.openFailed' : unsupported ? 'media.unsupported' : 'media.failed')}</span>
        </Button>
      </Tooltip> : transport}
      {compact ? <span className={css.time}>{positionText}</span> : <>
        <div className={css.audioTimeline}>
          {playback.status !== 'failed' && <AudioWaveform source={source} position={position} duration={duration} t={t}
            seek={(seconds) => { seekMedia(source.path, seconds) }} />}
          <div className={css.audioTimes} aria-hidden="true"><span>{mediaTime(position)}</span><span>{mediaTime(duration)}</span></div>
        </div>
        <MediaVolume video={false} volume={playback.volume} onChange={(volume) => { setMediaVolume(source.path, volume) }} t={t} />
      </>}
    </div>}
  </div>
}

function MediaVolume({ video, volume, onChange, t }: {
  readonly video: boolean
  readonly volume: number
  readonly onChange: (volume: number) => void
  readonly t: MediaPreviewProps['t']
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const slider = useRef<HTMLInputElement>(null)
  const id = useId()
  useDismissOnOutsidePointer(root, open, setOpen)
  useEffect(() => { if (open) slider.current?.focus({ preventScroll: true }) }, [open])
  return <div ref={root} className={video ? css.videoVolume : css.audioVolume}
    data-convax-video-volume={video ? '' : undefined} data-convax-audio-volume={video ? undefined : ''} data-open={open || undefined}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}
    onKeyDown={(event) => {
      if (event.key !== 'Escape' || !open) return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      trigger.current?.focus({ preventScroll: true })
    }}>
    <Tooltip label={t('media.volume')} portal>
      <Button ref={trigger} size="sm" className={video ? css.videoIconButton : css.audioVolumeButton} aria-label={t('media.volume')}
        aria-expanded={open} aria-controls={id} onClick={() => { setOpen(value => !value) }}>
        <Volume2 size={16} aria-hidden />
      </Button>
    </Tooltip>
    {open && <div id={id} className={video ? css.volumePopover : css.audioVolumePopover} role="group" aria-label={t('media.volume')}>
      <input ref={slider} className={css.videoRange} type="range" min="0" max="1" step="0.01" value={volume}
        style={{ '--dsh-media-position': `${volume * 100}%` } as CSSProperties} aria-label={t('media.volume')}
        onChange={(event) => { onChange(event.currentTarget.valueAsNumber) }} />
    </div>}
  </div>
}

function AudioWaveform({ source, position, duration, seek, t }: {
  readonly source: MediaSource
  readonly position: number
  readonly duration: number
  readonly seek: (seconds: number) => void
  readonly t: MediaPreviewProps['t']
}) {
  const { path, url, version } = source
  const identity = JSON.stringify([path, url, version])
  const [result, setResult] = useState<{ readonly identity: string; readonly waveform: MediaWaveform | null }>()
  const gesture = useRef<{ readonly pointerId: number; readonly element: HTMLDivElement } | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    void readMediaWaveform(url, controller.signal).then(
      (waveform) => { if (!controller.signal.aborted) setResult({ identity, waveform }) },
      (_waveformFailure: unknown) => { if (!controller.signal.aborted) setResult({ identity, waveform: null }) },
    )
    return () => { controller.abort() }
  }, [identity, url])
  useEffect(() => () => {
    const active = gesture.current
    gesture.current = null
    if (active?.element.hasPointerCapture(active.pointerId)) active.element.releasePointerCapture(active.pointerId)
  }, [identity])
  const waveform = result?.identity === identity ? result.waveform : undefined
  const limit = duration || waveform?.duration || 0
  const value = Math.min(limit, Math.max(0, position))
  const percent = limit > 0 ? value / limit * 100 : 0
  const seekAt = (element: HTMLDivElement, clientX: number): void => {
    const bounds = element.getBoundingClientRect()
    if (bounds.width > 0 && limit > 0) seek(Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width)) * limit)
  }
  const finish = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean): void => {
    const active = gesture.current
    if (active?.pointerId !== event.pointerId) return
    gesture.current = null
    if (commit) seekAt(event.currentTarget, event.clientX)
    if (active.element.hasPointerCapture(active.pointerId)) active.element.releasePointerCapture(active.pointerId)
  }
  return <Tooltip label={t(waveform === null ? 'media.waveformUnavailable' : 'media.seek')} portal>
    <div className={css.waveform} role="slider" tabIndex={0} aria-label={t(waveform ? 'media.waveform' : 'media.seek')}
      aria-disabled={limit === 0 || undefined} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={value}
      aria-valuetext={t('media.position', { current: mediaTime(value), duration: mediaTime(limit) })}
      onPointerDown={(event) => {
        if (event.button !== 0 || gesture.current !== null || limit === 0) return
        event.preventDefault()
        event.stopPropagation()
        event.currentTarget.focus({ preventScroll: true })
        event.currentTarget.setPointerCapture(event.pointerId)
        gesture.current = { pointerId: event.pointerId, element: event.currentTarget }
        seekAt(event.currentTarget, event.clientX)
      }}
      onPointerMove={(event) => {
        if (gesture.current?.pointerId !== event.pointerId) return
        event.preventDefault()
        event.stopPropagation()
        seekAt(event.currentTarget, event.clientX)
      }}
      onPointerUp={(event) => { finish(event, true) }}
      onPointerCancel={(event) => { finish(event, false) }}
      onLostPointerCapture={(event) => { finish(event, false) }}
      onClick={(event) => { if (event.detail === 0) seekAt(event.currentTarget, event.clientX) }}
      onKeyDown={(event) => {
        if (limit === 0) return
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? limit
          : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? position - 5
            : event.key === 'ArrowRight' || event.key === 'ArrowUp' ? position + 5 : undefined
        if (next === undefined) return
        event.preventDefault()
        event.stopPropagation()
        seek(Math.max(0, Math.min(limit, next)))
      }}>
      {waveform ? <svg viewBox={`0 0 ${waveform.peaks.length * 4} 64`} preserveAspectRatio="none" aria-hidden="true">
        {waveform.peaks.map((peak, index) => <line key={index} x1={index * 4 + 2} x2={index * 4 + 2}
          y1={32 - peak * 30} y2={32 + peak * 30}
          className={index / waveform.peaks.length * limit <= value ? css.played : undefined} />)}
      </svg> : <span className={css.audioSeekTrack} aria-hidden="true"><span style={{ width: `${percent}%` }} /></span>}
      <span className={css.waveformPlayhead} aria-hidden="true" style={{ left: `${percent}%` }} />
      {waveform === undefined && <span className={css.waveformStatus} role="status" aria-label={t('media.waveformLoading')}>
        <span className={css.spinner} aria-hidden="true" />
      </span>}
      {waveform === null && <span className={css.waveformMessage} role="status">{t('media.waveformUnavailable')}</span>}
    </div></Tooltip>
}

function mediaTime(seconds: number): string {
  const total = Math.floor(seconds)
  const minutes = Math.floor(total / 60)
  return `${minutes}:${String(total % 60).padStart(2, '0')}`
}
