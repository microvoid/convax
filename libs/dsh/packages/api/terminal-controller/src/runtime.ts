/** User-terminal ownership shared by native Sessions and explicitly owned application resources. */
import type { Context } from '@deepseek-ai/cordis'
import { RemoteError, type RemoteUplinkWindow } from '@deepseek-ai/dsh-typert-protocol'
import { discoverShells, resolveShell } from './shells.ts'
import { BrowserTerminal } from './terminal.ts'
import { TerminalRetention } from './retention.ts'
import type { Config } from './index.ts'
import type { TerminalCreateRequest, TerminalEnvironment, TerminalFrame, TerminalInput, TerminalRetentionFrame, TerminalShell, WebTerminalId, WebTerminalInfo } from './types.ts'

/** Execution providers and directory resolution supplied by the resource that owns the shell. */
export interface UserTerminalExecution {
  readonly subprocess: Context['subprocess']
  /** Resolve and validate the directory immediately before allocating a process. */
  readonly ensureCwd: (signal: AbortSignal) => Promise<string>
  /** Owner metadata passed to the process without granting additional permissions. */
  readonly env: Readonly<Record<string, string>>
}

interface TerminalAllocation {
  readonly info: WebTerminalInfo
  readonly cleanup: TerminalRetention
}

/** Owns allocation, screen recovery and complete process cleanup independently of all views. */
export class UserTerminalOwner {
  private readonly lifetime = new AbortController()
  private readonly closedIds = new Set<WebTerminalId>()
  private readonly terminals = new Map<WebTerminalId, BrowserTerminal>()
  private readonly pending = new Map<WebTerminalId, Promise<BrowserTerminal>>()
  private readonly allocations = new Map<WebTerminalId, TerminalAllocation>()
  private cleanup: Promise<void> | undefined

  /**
   * @param config - Shared terminal limits and unattended retention policy.
   * @param execution - Current execution providers for the explicit resource owner.
   * @param failed - Reports background cleanup failures to the owning plugin.
   */
  constructor(
    private readonly config: Config,
    private readonly execution: () => UserTerminalExecution,
    private readonly failed: (error: unknown) => void,
  ) {}

  /**
   * Read limits without validating existing processes.
   * @param cwd - Current owner directory.
   * @returns Terminal limits and the displayed directory.
   */
  environment(cwd: string): TerminalEnvironment {
    return { cwd, maxInputBytes: this.config.maxInputBytes, maxBufferedBytes: this.config.maxBufferedBytes,
      maxCols: this.config.maxCols, maxRows: this.config.maxRows, scrollback: this.config.scrollback }
  }

  /**
   * Discover shells in the owner's execution environment.
   * @param signal - Discovery cancellation.
   * @returns Installed shell choices.
   */
  shells(signal: AbortSignal): Promise<TerminalShell[]> {
    signal.throwIfAborted()
    return discoverShells(this.execution().subprocess, this.config.shell, this.config.shellCandidates, signal)
  }

  /**
   * Read retained metadata without starting processes or resolving providers.
   * @returns Retained terminal metadata.
   */
  list(): WebTerminalInfo[] {
    return [...this.terminals.values(), ...this.allocations.values()].map(terminal => terminal.info)
  }

  /**
   * Allocate exactly once for an open identity; closed identities cannot be recreated.
   * @param request - Terminal identity, shell selection and initial dimensions.
   * @param signal - Cancellation of unpublished allocation.
   * @returns Metadata for the existing or newly committed terminal.
   */
  async create(request: TerminalCreateRequest, signal: AbortSignal): Promise<WebTerminalInfo> {
    this.lifetime.signal.throwIfAborted()
    if (!/^[\w-]{1,128}$/u.test(request.id)) throw new Error('Invalid terminal identity')
    this.dimensions(request.cols, request.rows)
    this.requireOpen(request.id)
    const existing = this.terminals.get(request.id)
    if (existing !== undefined) return existing.info
    const pending = this.pending.get(request.id)
    if (pending !== undefined) {
      const terminal = await pending
      this.requireOpen(request.id)
      return terminal.info
    }
    if (new Set([...this.terminals.keys(), ...this.pending.keys(), ...this.allocations.keys()]).size >= this.config.maxTerminals) {
      throw new RemoteError('terminal/limit-reached', 'Terminal owner limit reached', { limit: this.config.maxTerminals })
    }
    const allocation = this.spawn(request, AbortSignal.any([signal, this.lifetime.signal]))
    this.pending.set(request.id, allocation)
    try {
      const terminal = await allocation
      this.terminals.set(request.id, terminal)
      this.allocations.delete(request.id)
      terminal.monitor(this.config, () => { this.closedIds.add(request.id) }, () => { this.terminals.delete(request.id) }, this.failed)
      this.requireOpen(request.id)
      return terminal.info
    } finally { this.pending.delete(request.id) }
  }

  /**
   * Retain one existing process without taking screen input control.
   * @param id - Retained terminal identity.
   * @param signal - Hold lifetime.
   * @returns Acknowledgement followed by the hold's open lifetime stream.
   */
  retain(id: WebTerminalId, signal: AbortSignal): AsyncIterable<TerminalRetentionFrame> {
    const terminal = this.terminals.get(id)
    if (terminal === undefined || this.closedIds.has(id) || this.lifetime.signal.aborted) {
      throw new RemoteError('terminal/unavailable', 'Terminal is closing or unavailable', {})
    }
    return terminal.retain(signal)
  }

  /**
   * Attach to a retained process with exclusive input and resize control.
   * @param id - Retained terminal identity.
   * @param input - Ordered commands carried by the caller's Remote invocation.
   * @param signal - Attachment cancellation, which leaves the process alive.
   * @param inputWindow - Complete-frame capacity advertised by the carrier.
   * @returns Screen recovery and subsequent output, state and command acknowledgements.
   */
  attach(id: WebTerminalId, input: AsyncIterable<TerminalInput>, signal: AbortSignal,
    inputWindow?: RemoteUplinkWindow): AsyncIterable<TerminalFrame> {
    return this.terminal(id).attach(input, this.config, signal, inputWindow)
  }

  /**
   * Rename a retained terminal.
   * @param id - Retained terminal identity.
   * @param title - Nonempty display name.
   */
  rename(id: WebTerminalId, title: string): void {
    if (title.trim().length === 0 || title.length > 120) throw new Error('Terminal title must contain 1–120 characters')
    this.terminal(id).rename(title.trim())
  }

  /**
   * Close an identity before waiting for allocation and process termination; failures remain owned for retry.
   * @param id - Identity to close, including a pending allocation.
   * @returns After provider cleanup and final output drainage complete.
   */
  async close(id: WebTerminalId): Promise<void> {
    this.closedIds.add(id)
    await this.pending.get(id)?.catch(() => { /* Creation reports its failure; close owns any partial allocation. */ })
    const terminal = this.terminals.get(id)
    if (terminal !== undefined) {
      await terminal.close()
      this.terminals.delete(id)
    } else {
      const allocation = this.allocations.get(id)
      if (allocation === undefined) return
      await allocation.cleanup.close()
      this.allocations.delete(id)
    }
  }

  /**
   * Stop admission and drain owned allocations, processes and monitors.
   * @returns After owned resources are quiescent.
   */
  dispose(): Promise<void> {
    if (this.cleanup !== undefined) return this.cleanup
    this.lifetime.abort(new Error('Terminal owner disposed'))
    this.cleanup = (async () => {
      await Promise.allSettled(this.pending.values())
      const results = await Promise.allSettled([
        ...[...this.terminals.values()].map(terminal => terminal.dispose()),
        ...[...this.allocations.values()].map(allocation => allocation.cleanup.dispose()),
      ])
      const errors = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
      if (errors.length > 0) throw new AggregateError(errors, 'Terminal owner cleanup failed')
      this.terminals.clear()
      this.allocations.clear()
    })().catch((error: unknown) => { this.cleanup = undefined; throw error })
    return this.cleanup
  }

  private terminal(id: WebTerminalId): BrowserTerminal {
    const terminal = this.terminals.get(id)
    if (terminal === undefined) throw new RemoteError('terminal/unavailable', 'Terminal no longer exists in this owner', {})
    this.requireOpen(id)
    return terminal
  }

  private requireOpen(id: WebTerminalId): void {
    if (this.closedIds.has(id)) throw new RemoteError('terminal/unavailable', 'Terminal was closed in this owner', {})
  }

  private dimensions(cols: number, rows: number): void {
    if (!Number.isSafeInteger(cols) || cols < 2 || cols > this.config.maxCols
      || !Number.isSafeInteger(rows) || rows < 1 || rows > this.config.maxRows) throw new Error('Terminal dimensions exceed the configured limits')
  }

  private async spawn(request: TerminalCreateRequest, signal: AbortSignal): Promise<BrowserTerminal> {
    const { subprocess, ensureCwd, env } = this.execution()
    const cwd = await ensureCwd(signal)
    const shell = request.shellPath === undefined
      ? await resolveShell(subprocess, this.config.shell, signal)
      : (await this.shells(signal)).find(candidate => candidate.path === request.shellPath)
    if (shell === undefined) throw new Error('Selected shell is not available in this execution environment')
    const handle = await subprocess.spawnTerminal({
      argv: [shell.path, ...shell.args], cwd, cols: request.cols, rows: request.rows,
      terminalType: 'xterm-256color', env: { ...env }, shellActivity: true, graceMs: this.config.disposeGraceMs, signal,
    })
    const info: WebTerminalInfo = { id: request.id, shell, title: shell.name, cwd,
      cols: request.cols, rows: request.rows, state: 'running', exitCode: null }
    try {
      signal.throwIfAborted()
      return new BrowserTerminal(handle, info, this.config.scrollback, this.config.maxBufferedBytes)
    } catch (error) {
      const cleanup = new TerminalRetention(this.config, handle.inspectActivity.bind(handle), async () => {
        this.closedIds.add(request.id)
        await handle.terminate()
        this.allocations.delete(request.id)
      }, this.failed)
      this.allocations.set(request.id, {
        info: { ...info, state: 'failed', error: error instanceof Error ? error.message : String(error) }, cleanup,
      })
      try { await cleanup.close() }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Terminal allocation cleanup failed') }
      throw error
    }
  }
}
