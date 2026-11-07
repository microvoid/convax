/** User-initiated local demo playback, with localized recovery on media failure. */
import { useRef, useState } from 'react'
import { ArrowUpRight, Play, RotateCcw } from 'lucide-react'
import { copy, type Locale } from './copy.ts'
import { media } from './media.ts'

/**
 * Play one localized walkthrough without background downloads or autoplay.
 * @param props - Locale and the project or app walkthrough to present.
 * @returns A video player with its title, runtime, and a direct MP4 recovery link.
 */
export function DemoVideo({ locale, kind }: { locale: Locale; kind: 'projects' | 'apps' }) {
  const c = copy[locale]
  const source = media[locale][kind]
  const video = useRef<HTMLVideoElement>(null)
  const [started, setStarted] = useState(false)
  const [failed, setFailed] = useState(false)

  const play = async () => {
    try {
      await video.current?.play()
    } catch {
      setFailed(true)
    }
  }
  const retry = () => {
    setFailed(false)
    setStarted(false)
    video.current?.load()
  }
  return (
    <figure className={`demo-video demo-${kind}`}>
      <div className="video-frame">
        <video
          ref={video}
          data-demo={kind}
          src={source.src}
          poster={source.poster}
          controls
          playsInline
          preload="none"
          aria-label={c[kind].video}
          onPlay={() => { setStarted(true) }}
          onError={() => { setFailed(true) }}
        >
          {c.video.fallback} <a href={source.src}>{c.video.download}</a>
        </video>
        {!started && !failed && (
          <button className="video-play" aria-label={`${c.video.play}: ${c[kind].video}`} onClick={() => { void play() }}>
            <Play size={25} fill="currentColor" strokeWidth={1.5} />
          </button>
        )}
        {failed && (
          <div className="video-error" role="alert">
            <p>{c.video.error}</p>
            <button className="button button-secondary" onClick={retry}><RotateCcw size={15} />{c.video.retry}</button>
          </div>
        )}
      </div>
      <figcaption>
        <div><span>{c[kind].video}</span><small>{c[kind].caption}</small></div>
        <a href={source.src} target="_blank" rel="noreferrer">{c.video.download}<ArrowUpRight size={14} /></a>
      </figcaption>
    </figure>
  )
}
