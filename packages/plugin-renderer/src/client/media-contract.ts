/** Window-owned playback and JSON inputs for one media preview occurrence. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'

/** Streamed source identity; a changed version replaces the retained player. */
export interface MediaSource {
  readonly path: string
  readonly url: string
  readonly version: string
  readonly mimeType: string
  readonly kind: 'audio' | 'video'
}

/** Detached playback facts; DOM elements remain private to the window owner. */
export interface MediaPlaybackState {
  readonly presented: boolean
  readonly intent: 'none' | 'hover' | 'manual'
  readonly status: 'paused' | 'starting' | 'playing' | 'ended' | 'failed'
  readonly currentTime: number
  readonly duration: number
  /** Native intrinsic video dimensions; zero until metadata is available. */
  readonly videoWidth?: number
  readonly videoHeight?: number
  readonly volume: number
  readonly autoplayBlocked: boolean
  readonly failure?: 'unsupported' | 'playback'
}

/** Imperative presentation and transport callbacks bound at plugin registration. */
export interface MediaPreviewInjected {
  readonly mountMedia: (source: MediaSource, viewportId: string) => () => void
  readonly hoverMedia: (path: string, hovered: boolean) => void
  readonly toggleMedia: (path: string) => void
  readonly seekMedia: (path: string, seconds: number) => void
  readonly setMediaVolume: (path: string, volume: number) => void
  readonly fullscreenMedia: (path: string) => Promise<void>
  readonly openSystem: (path: string) => Promise<void>
  readonly hooks: { readonly mediaPlayback: ObservableSnapshot<Readonly<Record<string, MediaPlaybackState>>> }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotFactoryMap {
    /** Window-retained native playback with a disposable card or modal presentation. */
    'convax.media.preview': {
      scope: 'root'
      props: {
        readonly path: string
        /** Metadata observes playback; compact retains a player with header-sized audio controls. */
        readonly presentation?: 'player' | 'metadata' | 'compact'
        readonly metadataFallback?: string
      }
      locale: 'convax'
      inject: MediaPreviewInjected
    }
  }
  interface ResourceProtocolMap {
    /** Versioned media URL and metadata; content is read through HTTP byte ranges. */
    'convax-media': MediaSource
  }
}

/** Framework-owned resource, locale, and playback seats for one preview. */
export type MediaPreviewProps = FactoryComponentPropsOf<'convax.media.preview'>
