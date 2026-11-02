/** Ranged audio decoding lives in a self-contained lazy client chunk. */
import { Input, UrlSource, ALL_FORMATS, AudioSampleSink, type AudioSample } from 'mediabunny'
import type { MediaWaveform } from './media-waveform.ts'

/**
 * Decode an audio track into real time-aligned peak bins without retaining the recording.
 * @param url - Authorized media URL supporting byte ranges.
 * @param signal - Preview lifetime; cancellation closes active reads and decoders.
 * @returns Complete peak bins after every decoded sample and input is released.
 */
export async function decodeMediaWaveform(url: string, signal: AbortSignal): Promise<MediaWaveform> {
  signal.throwIfAborted()
  const input = new Input({ formats: ALL_FORMATS, source: new UrlSource(url, {
    getRetryDelay: () => null,
  }) })
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    input.dispose()
  }
  signal.addEventListener('abort', dispose, { once: true })
  try {
    const track = await input.getPrimaryAudioTrack()
    signal.throwIfAborted()
    if (track === null || !await track.canDecode()) throw new Error('No decodable audio track')
    signal.throwIfAborted()
    const duration = await track.computeDuration()
    signal.throwIfAborted()
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Audio duration is unavailable')
    const peaks = Array<number>(96).fill(0)
    const scratch = new Float32Array(4096)
    const sink = new AudioSampleSink(track)
    let received = false
    for await (const sample of sink.samples(0, duration)) {
      try {
        signal.throwIfAborted()
        received ||= sample.numberOfFrames > 0
        accumulateSample(sample, duration, peaks, scratch)
      } finally { sample.close() }
    }
    signal.throwIfAborted()
    if (!received) throw new Error('Audio samples are unavailable')
    return { duration, peaks }
  } catch (error) {
    signal.throwIfAborted()
    throw error
  } finally {
    signal.removeEventListener('abort', dispose)
    dispose()
  }
}

function accumulateSample(sample: AudioSample, duration: number, peaks: number[], scratch: Float32Array): void {
  for (let channel = 0; channel < sample.numberOfChannels; channel++) {
    for (let offset = 0; offset < sample.numberOfFrames; offset += scratch.length) {
      const count = Math.min(scratch.length, sample.numberOfFrames - offset)
      sample.copyTo(scratch.subarray(0, count), { format: 'f32-planar', planeIndex: channel,
        frameOffset: offset, frameCount: count })
      for (let frame = 0; frame < count; frame++) {
        const time = sample.timestamp + (offset + frame) / sample.sampleRate
        if (time < 0 || time >= duration) continue
        const index = Math.floor(time / duration * peaks.length)
        const amplitude = Math.abs(scratch[frame] ?? 0)
        if (Number.isFinite(amplitude)) peaks[index] = Math.max(peaks[index] ?? 0, Math.min(1, amplitude))
      }
    }
  }
}
