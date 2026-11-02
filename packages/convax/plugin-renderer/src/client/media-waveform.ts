/** Incremental audio decoding retains a fixed waveform instead of a complete decoded recording. */

/** Peak amplitudes across equal time intervals of one complete audio track. */
export interface MediaWaveform {
  readonly duration: number
  readonly peaks: readonly number[]
}

/**
 * Decode versioned HTTP ranges into a fixed-size audio envelope without transcoding.
 * @param url - Authorized media URL supporting byte ranges.
 * @param signal - Closing or replacing the preview cancels network reads and decoding.
 * @returns Real peak amplitudes, with every sample and input released before settlement.
 * @throws When the file has no decodable audio, reading fails, or the caller cancels.
 */
export async function readMediaWaveform(url: string, signal: AbortSignal): Promise<MediaWaveform> {
  signal.throwIfAborted()
  const { decodeMediaWaveform } = await import('./media-decode.ts')
  signal.throwIfAborted()
  return decodeMediaWaveform(url, signal)
}
