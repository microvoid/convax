import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { verifyJimengDownload } from '../../src/providers/jimeng-download.ts'
import type { MediaKind, ProviderOutput, ProviderRuntime } from '../../src/types.ts'
import { fixtureMedia } from '../fixtures/provider.ts'

async function fixture(kind: MediaKind) {
  const directory = await mkdtemp(join(tmpdir(), 'convax-jimeng-download-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'output.partial')
  const bytes = fixtureMedia(kind)
  await writeFile(path, bytes)
  const output: ProviderOutput = { outputId: 'resource', kind, locator: { resourceId: 'resource' } }
  const runtime: ProviderRuntime = { operationId: 'operation' as ProviderRuntime['operationId'],
    connection: { id: 'connection' as ProviderRuntime['connection']['id'], providerId: 'jimeng-cli' as ProviderRuntime['connection']['providerId'],
      revision: 1, accountBinding: 'fixture', settings: {} },
    workDirectory: directory, maxBytes: 1024 * 1024, signal: new AbortController().signal, checkpoint: async () => {} }
  const receipt = { resourceId: 'resource', path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  const verify = (patch: Record<string, unknown> = {}) => verifyJimengDownload({ exitCode: 0, stdout: '',
    json: { ok: true, data: { ...receipt, ...patch } } }, output, path, runtime)
  return { verify, output, runtime, path, bytes, receipt }
}

it.each(['image', 'video', 'audio'] as const)('accepts a verified %s resource downloaded by the official CLI', async (kind) => {
  const f = await fixture(kind)
  await expect(f.verify()).resolves.toBeUndefined()
})

it('rejects a receipt for a different resource or destination', async () => {
  const f = await fixture('video')
  await expect(f.verify({ resourceId: 'other' })).rejects.toThrow('different resource or file')
  await expect(f.verify({ path: join(f.runtime.workDirectory, 'another.mp4') })).rejects.toThrow('different resource or file')
})

it('rejects truncated, modified, oversized and mislabeled media even when download exits successfully', async () => {
  const f = await fixture('video')
  await expect(f.verify({ size: f.bytes.length + 1 })).rejects.toThrow('size does not match')
  await expect(f.verify({ sha256: '0'.repeat(64) })).rejects.toThrow('checksum does not match')
  f.runtime.maxBytes = f.bytes.length - 1
  await expect(f.verify()).rejects.toThrow('invalid download integrity receipt')
  f.runtime.maxBytes = 1024 * 1024
  f.output.kind = 'image'
  await expect(f.verify()).rejects.toThrow('different media type')
})

it('rejects HTML error bodies even if their checksum is correct', async () => {
  const f = await fixture('audio')
  const error = Buffer.from('<html>Service unavailable</html>')
  await writeFile(f.path, error)
  await expect(f.verify({ size: error.length, sha256: createHash('sha256').update(error).digest('hex') })).rejects.toThrow('unsupported media')
})
