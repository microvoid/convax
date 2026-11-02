// @vitest-environment jsdom
/** Background controls remain available when the player presentation is detached. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MediaPlaybackDock } from '../src/client/MediaPlaybackDock.tsx'
import type { MediaPlaybackState } from '../src/client/media-contract.ts'
import { en, type ConvaxKey } from '../src/client/locales.ts'

afterEach(cleanup)

function fixture(state: MediaPlaybackState) {
  const toggleMedia = vi.fn()
  const props = {
    useMediaPlayback: () => ({ '/project/song.mp3': state }), toggleMedia,
    t: (key: ConvaxKey, values?: Record<string, string | number>) =>
      en[key].replace(/\{(\w+)\}/gu, (_match, name: string) => String(values?.[name] ?? '')),
  } as ComponentProps<typeof MediaPlaybackDock>
  return { props, toggleMedia }
}

const playing: MediaPlaybackState = {
  presented: false, intent: 'manual', status: 'playing', duration: 60, currentTime: 12, volume: 1, autoplayBlocked: false,
}

describe('Retained media controls', () => {
  it('pauses a manually playing source after its card has been hidden', () => {
    const b = fixture(playing)
    render(<MediaPlaybackDock {...b.props} />)
    expect(screen.getByRole('complementary', { name: en['media.background'] })).toBeDefined()
    expect(screen.getByText('song.mp3')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Pause song.mp3' }))
    expect(b.toggleMedia).toHaveBeenCalledExactlyOnceWith('/project/song.mp3')
  })

  it.each([
    { ...playing, presented: true },
    { ...playing, intent: 'hover' as const },
    { ...playing, status: 'paused' as const },
  ])('does not duplicate controls for visible, hover-only, or paused media', (state) => {
    const b = fixture(state)
    render(<MediaPlaybackDock {...b.props} />)
    expect(screen.queryByRole('complementary')).toBeNull()
  })
})
