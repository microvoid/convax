/** Product-owned installation of audited CLI binaries; remote scripts never execute. */
import { chmod, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { unzipSync } from 'fflate'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { ProviderDescriptor, ProviderId, ProviderInstallation } from './types.ts'

const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024
const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024

interface Distribution {
  executable: string
  version: string
  helpUrl: string
  base: string
  redirectBase?: string
  artifacts: Readonly<Record<string, string>>
  archive: boolean
  verifyArgs: readonly string[]
}

const distributions: Readonly<Record<string, Distribution>> = {
  'jimeng-cli': {
    executable: 'dreamina-canvas', version: '1_0_0_60', archive: false,
    helpUrl: 'https://jimeng.jianying.com/canvas-cli/install.sh',
    base: 'https://jimeng.jianying.com/canvas-cli/install/1_0_0_60/',
    redirectBase: 'https://lf3-lv-buz.vlabstatic.com/obj/image-lvweb-buz/videocut/aigc/dreamina_canvas_cli/1_0_0_60/',
    artifacts: { 'darwin-arm64': 'dreamina-canvas_darwin_arm64', 'darwin-x64': 'dreamina-canvas_darwin_amd64',
      'linux-arm64': 'dreamina-canvas_linux_arm64', 'linux-x64': 'dreamina-canvas_linux_amd64',
      'win32-x64': 'dreamina-canvas_windows_amd64.exe' },
    verifyArgs: ['--format', 'json', 'version'],
  },
  'libtv-cli': {
    executable: 'libtv', version: '1.2.0', archive: true,
    helpUrl: 'https://liblibai-web-static.liblib.cloud/cli/latest/install-libtv-cli.sh',
    base: 'https://liblibai-web-static.liblib.cloud/cli/1.2.0/',
    artifacts: { 'darwin-arm64': 'libtv-macos-arm64.zip', 'darwin-x64': 'libtv-macos-x64.zip',
      'linux-arm64': 'libtv-linux-arm64.zip', 'linux-x64': 'libtv-linux-x64.zip',
      'win32-arm64': 'libtv-windows-arm64.zip', 'win32-x64': 'libtv-windows-amd64.zip' },
    verifyArgs: ['--help'],
  },
}

interface InstallationDependencies {
  directory: string
  subprocess: SubprocessRuntime
  fetch?: typeof fetch
  platform?: NodeJS.Platform
  arch?: string
}

interface InstallationTask {
  controller: AbortController
  promise: Promise<void>
}

/** One Host owns installation progress, retries and cancellation on disposal. */
export class CreationCliInstallations {
  private readonly states = new Map<ProviderId, ProviderInstallation>()
  private readonly active = new Map<ProviderId, InstallationTask>()
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private closed = false

  constructor(private readonly deps: InstallationDependencies) {
    this.platform = deps.platform ?? process.platform
    this.arch = deps.arch ?? process.arch
  }

  descriptor(providerId: ProviderId): ProviderDescriptor['installation'] {
    const distribution = Object.hasOwn(distributions, providerId) ? distributions[providerId] : undefined
    if (distribution === undefined) return undefined
    const supported = distribution.artifacts[`${this.platform}-${this.arch}`] !== undefined
    return { supported, helpUrl: distribution.helpUrl,
      ...(supported ? {} : { reason: 'Automatic installation is not available for this platform. Choose an existing CLI executable.' }) }
  }

  status(providerId: ProviderId): ProviderInstallation {
    return { ...(this.states.get(providerId) ?? { state: 'idle' }) }
  }

  /** Return immediately; repeated clicks join the same Host-owned attempt. */
  start(providerId: ProviderId): ProviderInstallation {
    if (this.closed) throw new Error('CLI installation is unavailable while the Host is closing')
    if (this.active.has(providerId)) return this.status(providerId)
    const distribution = Object.hasOwn(distributions, providerId) ? distributions[providerId] : undefined
    if (distribution === undefined) throw new Error('This Provider does not offer product-managed installation')
    const artifact = distribution.artifacts[`${this.platform}-${this.arch}`]
    if (artifact === undefined) {
      this.states.set(providerId, { state: 'failed', message: 'Automatic installation is not available for this platform.' })
      return this.status(providerId)
    }
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5 * 60_000)])
    this.states.set(providerId, { state: 'checking' })
    const promise = Promise.resolve().then(() => this.install(providerId, distribution, artifact, signal))
      .catch((error: unknown) => {
        this.states.set(providerId, { state: 'failed', message: signal.aborted
          ? 'Installation stopped. Try again.' : error instanceof InstallationFailure ? error.message : 'Could not install the CLI. Try again.' })
      }).finally(() => { this.active.delete(providerId) })
    this.active.set(providerId, { controller, promise })
    return this.status(providerId)
  }

  /** Resolve the same executable for setup checks and actual generation. Explicit custom paths remain authoritative. */
  async resolveExecutable(executable: string, env: Record<string, string>, signal: AbortSignal): Promise<string> {
    try { return await this.deps.subprocess.resolveExecutable(executable, env, signal) }
    catch (error) {
      if (!(error instanceof Error) || error.name !== 'SubprocessExecutableNotFoundError') throw error
      const entry = Object.entries(distributions).find(([, item]) => executable === item.executable
        || this.platform === 'win32' && executable === `${item.executable}.exe`)
      if (entry === undefined) throw error
      const [id, distribution] = entry
      return this.deps.subprocess.resolveExecutable(this.destination(id, distribution), env, signal)
    }
  }

  async close(): Promise<void> {
    this.closed = true
    for (const task of this.active.values()) task.controller.abort()
    await Promise.allSettled([...this.active.values()].map(task => task.promise))
  }

  private destination(providerId: string, distribution: Distribution): string {
    return join(this.deps.directory, providerId, distribution.version, this.filename(distribution))
  }

  private filename(distribution: Distribution): string {
    return `${distribution.executable}${this.platform === 'win32' ? '.exe' : ''}`
  }

  private async install(providerId: ProviderId, distribution: Distribution, artifact: string, signal: AbortSignal): Promise<void> {
    try {
      const existing = await this.resolveExecutable(distribution.executable, {}, signal)
      await this.verify(existing, distribution, signal)
      this.states.set(providerId, { state: 'ready', executable: existing })
      return
    } catch (error) {
      signal.throwIfAborted()
      if (!(error instanceof Error) || error.name !== 'SubprocessExecutableNotFoundError') throw error
    }
    await mkdir(this.deps.directory, { recursive: true, mode: 0o700 })
    const staging = await mkdtemp(join(this.deps.directory, '.install-'))
    try {
      const source = new URL(artifact, distribution.base)
      const allowedUrls = new Set([source.href])
      if (distribution.redirectBase !== undefined) allowedUrls.add(new URL(artifact, distribution.redirectBase).href)
      const archive = await this.download(providerId, source, allowedUrls, signal)
      signal.throwIfAborted()
      this.states.set(providerId, { state: 'installing' })
      const bytes = distribution.archive ? this.extract(archive, this.filename(distribution)) : archive
      this.validateExecutable(bytes)
      const executable = join(staging, this.filename(distribution))
      const file = await open(executable, 'wx', 0o600)
      try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
      await chmod(executable, 0o700)
      this.states.set(providerId, { state: 'verifying' })
      await this.verify(executable, distribution, signal)
      signal.throwIfAborted()
      const destination = this.destination(providerId, distribution)
      await mkdir(join(this.deps.directory, providerId, distribution.version), { recursive: true, mode: 0o700 })
      await rename(executable, destination)
      this.states.set(providerId, { state: 'ready', executable: destination })
    } finally { await rm(staging, { recursive: true, force: true }) }
  }

  private async download(providerId: ProviderId, initial: URL, allowedUrls: ReadonlySet<string>, signal: AbortSignal): Promise<Uint8Array> {
    let url = initial
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      if (!allowedUrls.has(url.href)) throw new InstallationFailure('The download source is not an approved official site.')
      const response = await (this.deps.fetch ?? fetch)(url, { signal, redirect: 'manual' })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel()
        const location = response.headers.get('location')
        if (location === null || redirects === 3) throw new InstallationFailure('The official download returned an invalid redirect.')
        url = new URL(location, url)
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new InstallationFailure(`The official download failed (HTTP ${response.status}). Try again.`)
      }
      const length = Number(response.headers.get('content-length'))
      if (length > MAX_DOWNLOAD_BYTES) { await response.body?.cancel(); throw new InstallationFailure('The CLI download exceeds the size limit.') }
      const totalBytes = Number.isSafeInteger(length) && length > 0 ? length : undefined
      const reader = response.body?.getReader()
      if (reader === undefined) throw new InstallationFailure('The official download was empty.')
      const chunks: Uint8Array[] = []
      let receivedBytes = 0
      // Cancel the reader as well as fetch so disposal also drains a stalled body.
      const cancelReader = () => { void reader.cancel().catch(() => undefined) }
      signal.addEventListener('abort', cancelReader, { once: true })
      this.states.set(providerId, { state: 'downloading', receivedBytes, ...(totalBytes === undefined ? {} : { totalBytes }) })
      try {
        while (true) {
          signal.throwIfAborted()
          const chunk = await reader.read()
          signal.throwIfAborted()
          if (chunk.done) break
          receivedBytes += chunk.value.byteLength
          if (receivedBytes > MAX_DOWNLOAD_BYTES) throw new InstallationFailure('The CLI download exceeds the size limit.')
          chunks.push(chunk.value)
          this.states.set(providerId, { state: 'downloading', receivedBytes, ...(totalBytes === undefined ? {} : { totalBytes }) })
        }
      } finally {
        signal.removeEventListener('abort', cancelReader)
        await reader.cancel().catch(() => undefined)
      }
      if (totalBytes !== undefined && receivedBytes !== totalBytes) throw new InstallationFailure('The CLI download was incomplete. Try again.')
      return Buffer.concat(chunks)
    }
    throw new InstallationFailure('The official download returned too many redirects.')
  }

  private extract(archive: Uint8Array, executable: string): Uint8Array {
    let matched = false
    const files = unzipSync(archive, { filter: (entry) => {
      if (basename(entry.name) !== executable) return false
      if (matched || entry.name.includes('\\') || entry.name.split('/').some(part => part === '..')
        || entry.name.startsWith('/') || entry.originalSize > MAX_EXECUTABLE_BYTES) throw new InstallationFailure('The CLI archive contains an invalid executable.')
      matched = true
      return true
    } })
    const file = Object.values(files)[0]
    if (file === undefined) throw new InstallationFailure('The official archive does not contain the CLI executable.')
    return file
  }

  private validateExecutable(bytes: Uint8Array): void {
    if (bytes.byteLength < 4 || bytes.byteLength > MAX_EXECUTABLE_BYTES) throw new InstallationFailure('The downloaded CLI is empty or exceeds the size limit.')
    const magic = Buffer.from(bytes.buffer, bytes.byteOffset, 4).readUInt32BE(0)
    const valid = this.platform === 'darwin' ? [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)
      : this.platform === 'linux' ? magic === 0x7f454c46 : this.platform === 'win32' && bytes[0] === 0x4d && bytes[1] === 0x5a
    if (!valid) throw new InstallationFailure('The download is not an executable for this platform.')
  }

  private async verify(executable: string, distribution: Distribution, signal: AbortSignal): Promise<void> {
    const resolved = await this.deps.subprocess.resolveExecutable(executable, {}, signal)
    const handle = this.deps.subprocess.spawn({ argv: [resolved, ...distribution.verifyArgs], cwd: dirname(resolved),
      env: {}, signal, graceMs: 2_000, stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 16 * 1024 } } })
    const result = await handle.done
    signal.throwIfAborted()
    const output = handle.collected.stdout?.readFrom(0)
    if (result.exitCode !== 0 || output === undefined || output.lossy || !output.text.trim()) {
      throw new InstallationFailure('The installed CLI could not start. Check the platform and try again.')
    }
  }
}

class InstallationFailure extends Error {}
