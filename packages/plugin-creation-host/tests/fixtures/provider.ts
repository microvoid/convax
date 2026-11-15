/** Test-only media Provider; production adapters and credentials are never used. */
import { writeFile } from 'node:fs/promises'
import type { ConnectionInspection, CreationProvider, MediaKind, ProviderCancelResult, ProviderCheckpoint, ProviderDescriptor, ProviderId,
  ProviderOutput, ProviderRequest, ProviderRuntime, ProviderSnapshot } from '../../src/types.ts'

/** Deterministic files exercise each supported container without external APIs. */
export function fixtureMedia(kind: MediaKind): Buffer {
  if (kind === 'image') return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
  if (kind === 'video') {
    // Two black H.264 frames (16 × 16, 0.2 seconds), encoded into an MP4 container.
    return Buffer.from('AAAAHGZ0eXBtcDQyAAAAAWlzb21tcDQxbXA0MgAAAAFtZGF0AAAAAAAAAJ0AAAA6BgUyR1ZK3FxMQz+U78URPNFDqAEAAAMAAQMAAAMAAQIAAeYACwAAAwAAAwAAEKQMA4kkAQ3/////gAAAADIluCAf3gjlTP+CzB6bUkQAUXvbWI96Chke5rmDp9W2soHzYayoY2+o56cAADaAFcM9GAAAABUh4QRftmvQThCQ4oAJBgIMbf+KiVYAAALEbW9vdgAAAGxtdmhkAAAAAOcc80DnHPNAAAACWAAAAHgAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAlB0cmFrAAAAXHRraGQAAAAB5xzzQOcc80AAAAABAAAAAAAAAHgAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAB4AAAAAAABAAAAAAHIbWRpYQAAACBtZGhkAAAAAOcc80DnHPNAAAACWAAAAHhVxAAAAAAAMWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABDb3JlIE1lZGlhIFZpZGVvAAAAAW9taW5mAAAAFHZtaGQAAAABAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAAEvc3RibAAAAKFzdHNkAAAAAAAAAAEAAACRYXZjMQAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAQABAASAAAAEgAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABj//wAAACdhdmNDAWQAC//hAAwnZAALrFZQw3gWYKUBAAQo7jyw/fj4AAAAAApmaWVsAQAAAAAKY2hybQAAAAAAGHN0dHMAAAAAAAAAAQAAAAIAAAA8AAAAFHN0c3MAAAAAAAAAAQAAAAEAAAAOc2R0cAAAAAAgEAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAgAAAAEAAAAcc3RzegAAAAAAAAAAAAAAAgAAAHQAAAAZAAAAFHN0Y28AAAAAAAAAAQAAACw=', 'base64')
  }
  const wav = Buffer.alloc(44 + 160)
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write('data', 36); wav.writeUInt32LE(160, 40)
  return wav
}

export class FixtureCreationProvider implements CreationProvider {
  readonly descriptor: ProviderDescriptor = { id: 'fixture-creation' as ProviderId, title: 'Fixture media', configuration: [] }
  readonly checkpointVersion = 1
  submissions = 0
  reconciliations = 0
  collections = 0
  cancellations = 0
  beforeCollect?: (runtime: ProviderRuntime) => Promise<void>
  async describe(): Promise<ConnectionInspection> {
    return { state: 'ready', capabilities: (['image', 'video', 'audio'] as const).map(kind => ({
      kind, parameterSchema: { type: 'object', additionalProperties: false }, inputs: [], maxOutputs: 1,
    })), submissionRecovery: 'recoverable-resource', cancellation: 'supported' }
  }
  async submit(request: ProviderRequest, runtime: ProviderRuntime): Promise<ProviderSnapshot> {
    this.submissions += 1
    await runtime.checkpoint({ version: 1, data: { task: runtime.operationId } })
    return this.completed(request)
  }
  async reconcile(
    request: ProviderRequest, _checkpoint: ProviderCheckpoint | undefined, _runtime: ProviderRuntime,
  ): Promise<ProviderSnapshot> {
    this.reconciliations += 1
    return this.completed(request)
  }
  async collect(output: ProviderOutput, destination: { path: string }, runtime: ProviderRuntime): Promise<void> {
    this.collections += 1
    await this.beforeCollect?.(runtime)
    await writeFile(destination.path, fixtureMedia(output.kind))
  }
  async cancel(): Promise<ProviderCancelResult> { this.cancellations += 1; return { state: 'confirmed' } }
  private completed(request: ProviderRequest): ProviderSnapshot {
    return { state: 'completed', outputs: [{ outputId: `${request.kind}-output`, kind: request.kind,
      locator: {}, suggestedFilename: `Created ${request.kind}` }] }
  }
}
