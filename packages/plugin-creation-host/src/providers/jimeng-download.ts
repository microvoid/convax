/** Validate the official CLI's file receipt before the Host imports generated media. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { inspectMedia } from '../media.ts'
import type { ProviderOutput, ProviderRuntime } from '../types.ts'
import { record, type CliRunner } from './common.ts'

/** Resource download is media-agnostic; the receipt and actual bytes must agree with this task. */
export async function verifyJimengDownload(
  result: Awaited<ReturnType<CliRunner['run']>>, output: ProviderOutput, destination: string, runtime: ProviderRuntime,
): Promise<void> {
  if (result.exitCode !== 0 || result.json?.ok !== true) throw new Error('Jimeng resource download failed; retry the existing output')
  const receipt = record(result.json.data)
  if (receipt.resourceId !== output.locator.resourceId || typeof receipt.path !== 'string'
    || resolve(receipt.path) !== resolve(destination)) throw new Error('Jimeng returned a download receipt for a different resource or file')
  if (typeof receipt.size !== 'number' || !Number.isSafeInteger(receipt.size) || receipt.size <= 0 || receipt.size > runtime.maxBytes
    || typeof receipt.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(receipt.sha256)) throw new Error('Jimeng returned an invalid download integrity receipt')
  const file = await lstat(destination)
  if (!file.isFile() || file.size !== receipt.size) throw new Error('Jimeng downloaded file size does not match its receipt')
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(destination, { signal: runtime.signal })) {
    bytes += (chunk as Buffer).byteLength
    if (bytes > receipt.size || bytes > runtime.maxBytes) throw new Error('Jimeng downloaded file exceeds its declared size')
    hash.update(chunk as Buffer)
  }
  if (bytes !== receipt.size || hash.digest('hex') !== receipt.sha256.toLowerCase()) throw new Error('Jimeng downloaded file checksum does not match its receipt')
  await inspectMedia(destination, runtime.maxBytes, output.kind)
}
