/** Playback controls remain reachable when a manually playing card is not visible. */
import { CirclePause } from 'lucide-react'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MediaPreviewInjected } from './media-contract.ts'
import css from './MediaPlaybackDock.module.css'

type DockProps = PropsRuntime<'shell.overlay'> & PropsLocale<'convax'>
  & InjectFace<Pick<MediaPreviewInjected, 'hooks' | 'toggleMedia'>>

/** @param props - Window playback state and its pause action. @returns Controls for retained background media. */
export function MediaPlaybackDock({ useMediaPlayback, toggleMedia, t }: DockProps) {
  const playback = useMediaPlayback(value => value)
  const playing = Object.entries(playback).filter(([, value]) => value.intent === 'manual' && !value.presented
    && (value.status === 'playing' || value.status === 'starting'))
  if (playing.length === 0) return null
  return <aside className={css.dock} aria-label={t('media.background')}>
    {playing.map(([path]) => <div key={path} className={css.player}>
      <Tooltip label={path} side="top" portal><span className={css.name}>{path.split(/[\\/]/).at(-1) ?? path}</span></Tooltip>
      <Button size="sm" aria-label={t('media.pauseName', { name: path.split(/[\\/]/).at(-1) ?? path })}
        onClick={() => { toggleMedia(path) }}><CirclePause size={16} aria-hidden /></Button>
    </div>)}
  </aside>
}
