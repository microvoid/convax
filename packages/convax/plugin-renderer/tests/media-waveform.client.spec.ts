/** Incremental waveform analysis closes each sample and the owning ranged input on every exit. */
import { beforeEach, expect, it, vi } from 'vitest'
import { readMediaWaveform } from '../src/client/media-waveform.ts'

interface Sample {
  readonly timestamp: number
  readonly sampleRate: number
  readonly numberOfFrames: number
  readonly numberOfChannels: number
  readonly copyTo: (target: Float32Array, options: { planeIndex: number; frameOffset: number; frameCount: number }) => void
  readonly close: () => void
}

const media = vi.hoisted(() => ({
  track: { canDecode: vi.fn<() => Promise<boolean>>(), computeDuration: vi.fn<() => Promise<number>>() },
  getTrack: vi.fn<() => Promise<object | null>>(),
  dispose: vi.fn(), source: vi.fn(),
  samples: vi.fn<(start: number, end: number) => AsyncGenerator<Sample>>(),
}))

vi.mock('mediabunny', () => ({
  ALL_FORMATS: [],
  Input: class { getPrimaryAudioTrack = media.getTrack; dispose = media.dispose },
  UrlSource: function UrlSource(url: string, options: object) { media.source(url, options) },
  AudioSampleSink: class { samples = media.samples },
}))

beforeEach(() => {
  vi.clearAllMocks()
  media.track.canDecode.mockResolvedValue(true)
  media.track.computeDuration.mockResolvedValue(4)
  media.getTrack.mockResolvedValue(media.track)
  media.samples.mockImplementation(async function* () {})
})

function sample(timestamp: number, channels: readonly number[][], sampleRate = 1): Sample {
  return { timestamp, sampleRate, numberOfFrames: channels[0]?.length ?? 0, numberOfChannels: channels.length,
    copyTo: vi.fn<Sample['copyTo']>((target, options) => {
      target.set(channels[options.planeIndex]?.slice(options.frameOffset, options.frameOffset + options.frameCount) ?? [])
    }), close: vi.fn() }
}

it('accumulates real peaks from every channel into equal time intervals and closes decoded samples', async () => {
  const a = sample(0, [[0.1, -0.4], [0.8, 0.2]])
  const b = sample(2, [[0, -0.6]])
  media.samples.mockImplementation(async function* () { yield a; yield b })
  const result = await readMediaWaveform('/media/track', new AbortController().signal)
  expect(result.duration).toBe(4)
  expect(result.peaks).toHaveLength(96)
  expect(result.peaks[0]).toBeCloseTo(0.8)
  expect(result.peaks[24]).toBeCloseTo(0.4)
  expect(result.peaks[48]).toBe(0)
  expect(result.peaks[72]).toBeCloseTo(0.6)
  expect(a.close).toHaveBeenCalledOnce()
  expect(b.close).toHaveBeenCalledOnce()
  expect(media.dispose).toHaveBeenCalledOnce()
  expect(media.samples).toHaveBeenCalledWith(0, 4)
  const sourceOptions = media.source.mock.calls[0]?.[1] as { getRetryDelay: () => null }
  expect(sourceOptions.getRetryDelay()).toBeNull()
})

it('copies large decoded samples in bounded windows and excludes audio before time zero', async () => {
  const values = Array<number>(5000).fill(0)
  values[0] = 1
  values[4999] = 0.75
  const decoded = sample(-1, [values], 1000)
  media.samples.mockImplementation(async function* () { yield decoded })
  const result = await readMediaWaveform('/media/long', new AbortController().signal)
  expect(result.peaks[0]).toBe(0)
  expect(result.peaks[95]).toBeCloseTo(0.75)
  expect(decoded.copyTo).toHaveBeenCalledTimes(2)
  expect(decoded.close).toHaveBeenCalledOnce()
})

it('excludes non-finite PCM values and clips peak amplitude to the display range', async () => {
  const decoded = sample(0, [[NaN, Infinity, -3]])
  media.samples.mockImplementation(async function* () { yield decoded })
  const result = await readMediaWaveform('/media/pcm', new AbortController().signal)
  expect(result.peaks[0]).toBe(0)
  expect(result.peaks[24]).toBe(0)
  expect(result.peaks[48]).toBe(1)
  expect(decoded.close).toHaveBeenCalledOnce()
})

it('reports an empty audio track instead of fabricating a silent waveform', async () => {
  await expect(readMediaWaveform('/media/empty', new AbortController().signal)).rejects.toThrow('Audio samples are unavailable')
  expect(media.dispose).toHaveBeenCalledOnce()
})

it.each([false, null])('releases input when audio is unavailable: %s', async (available) => {
  if (available === null) media.getTrack.mockResolvedValue(null)
  else media.track.canDecode.mockResolvedValue(false)
  await expect(readMediaWaveform('/media/unsupported', new AbortController().signal)).rejects.toThrow('No decodable audio track')
  expect(media.samples).not.toHaveBeenCalled()
  expect(media.dispose).toHaveBeenCalledOnce()
})

it('cancels a pending metadata read through input disposal without starting a decoder', async () => {
  const entered = Promise.withResolvers<undefined>()
  const pending = Promise.withResolvers<object | null>()
  media.getTrack.mockImplementation(() => { entered.resolve(undefined); return pending.promise })
  const controller = new AbortController()
  const reading = readMediaWaveform('/media/pending', controller.signal)
  const rejection = expect(reading).rejects.toThrow('Cancelled')
  await entered.promise
  controller.abort(new Error('Cancelled'))
  expect(media.dispose).toHaveBeenCalledOnce()
  pending.resolve(media.track)
  await rejection
  expect(media.samples).not.toHaveBeenCalled()
  expect(media.dispose).toHaveBeenCalledOnce()
})

it('closes an outstanding yielded sample and the iterator if cancellation arrives before processing', async () => {
  const controller = new AbortController()
  const decoded = sample(0, [[1]])
  const finished = vi.fn()
  media.samples.mockImplementation(async function* () {
    try { controller.abort(new Error('Cancelled')); yield decoded } finally { finished() }
  })
  await expect(readMediaWaveform('/media/cancel', controller.signal)).rejects.toThrow('Cancelled')
  expect(decoded.close).toHaveBeenCalledOnce()
  expect(decoded.copyTo).not.toHaveBeenCalled()
  expect(finished).toHaveBeenCalledOnce()
  expect(media.dispose).toHaveBeenCalledOnce()
})

it('closes a sample and input when sample conversion fails', async () => {
  const decoded = sample(0, [[1]])
  vi.mocked(decoded.copyTo).mockImplementation(() => { throw new Error('Decode failed') })
  media.samples.mockImplementation(async function* () { yield decoded })
  await expect(readMediaWaveform('/media/error', new AbortController().signal)).rejects.toThrow('Decode failed')
  expect(decoded.close).toHaveBeenCalledOnce()
  expect(media.dispose).toHaveBeenCalledOnce()
})

it('does not open ranged input for an already cancelled preview', async () => {
  const controller = new AbortController()
  controller.abort(new Error('Closed'))
  await expect(readMediaWaveform('/media/closed', controller.signal)).rejects.toThrow('Closed')
  expect(media.source).not.toHaveBeenCalled()
  expect(media.dispose).not.toHaveBeenCalled()
})
