/** Compact native media facts share the existing player owner's observable. */
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MediaPreviewProps } from './media-contract.ts'
import { resourceAddress } from './resources.ts'
import css from './MediaMetadata.module.css'

/**
 * Read retained metadata without creating a second media element.
 * @param props - Source identity, localized fallback and framework playback seat.
 * @returns Resolution and duration, or the file metadata before native metadata arrives.
 */
export function MediaMetadata({ path, metadataFallback = '', useResource, useMediaPlayback, t }: MediaPreviewProps) {
  const resource = useResource<'convax-media'>(`${resourceAddress('convax-media', path)}?attempt=0`)
  const playback = useMediaPlayback(state => state[resource.value?.path ?? path])
  const width = playback?.videoWidth ?? 0
  const height = playback?.videoHeight ?? 0
  const resolution = width > 0 && height > 0 ? t('media.resolution', { width, height }) : ''
  const seconds = playback?.duration ?? 0
  const duration = seconds > 0 ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds) % 60).padStart(2, '0')}` : ''
  const label = resolution && duration ? t('media.metadata', { resolution, duration }) : resolution || duration || metadataFallback
  const details = metadataFallback && label !== metadataFallback ? `${metadataFallback} · ${label}` : label
  return <Tooltip label={details} portal><span className={css.metadata} tabIndex={0} data-convax-media-metadata="">{label}</span></Tooltip>
}
