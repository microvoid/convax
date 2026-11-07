/** Session-owned user terminals with the execution environment's system-user permissions. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-working-directory'
import { Remote, RemoteError, TypertRemoteService, type RemoteStream } from '@deepseek-ai/dsh-typert-protocol'
import { UserTerminalOwner, type UserTerminalExecution } from './runtime.ts'
export { UserTerminalOwner } from './runtime.ts'
export type { UserTerminalExecution } from './runtime.ts'
import type {
  TerminalShell, TerminalInput, TerminalCreateRequest, TerminalEnvironment, TerminalFrame, TerminalRetentionFrame,
  WebTerminalId, WebTerminalInfo,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Interactive user terminals, separate from the Agent terminal tool registry. */
    terminalController: TerminalController
  }
}

/** Deployment limits and an optional shell profile. */
export interface Config {
  /** Explicit shell profile; omission uses the execution environment's default shell. */
  readonly shell?: {
    /** Executable path or PATH name, verified by the subprocess provider. */
    path: string
    /** User-visible profile name. */
    name: string
    /** Arguments passed to the interactive shell. */
    args: string[]
  } | undefined
  /** Executable names or paths checked for the new-terminal shell selector. */
  readonly shellCandidates: string[]
  /** Maximum retained terminals and pending allocations per Session. */
  readonly maxTerminals: number
  /** Maximum terminal width in columns. */
  readonly maxCols: number
  /** Maximum terminal height in rows. */
  readonly maxRows: number
  /** Screen history rows retained for reconnecting clients. */
  readonly scrollback: number
  /** Maximum queued UTF-8 frame bytes per output follower and in the Client input buffer. */
  readonly maxBufferedBytes: number
  /** Maximum raw UTF-8 bytes per input command and across unacknowledged Client input. */
  readonly maxInputBytes: number
  /** Provider process-termination grace period in milliseconds. */
  readonly disposeGraceMs: number
  /** Continuous confirmed idle time without window holds before reclamation; zero disables reclamation. */
  readonly unattendedTimeoutMs: number
  /** Interval between unattended shell and process observations. */
  readonly activityPollIntervalMs: number
  /** Delay before retrying failed owned terminal cleanup. */
  readonly cleanupRetryMs: number
}

/** Typed Remote control of transient Session-owned terminal processes. */
export class TerminalController extends TypertRemoteService {
  static inject = ['subprocess', 'sandboxPolicy', 'workingDirectory', 'typert']
  static Config: z<Config> = z.object({
    shell: z.union([z.object({
      path: z.string().required(), name: z.string().required(), args: z.array(z.string()).default([]),
    }), z.const(undefined)]),
    shellCandidates: z.array(z.string().min(1)).default(['zsh', 'bash', 'fish', 'pwsh', 'powershell', 'cmd']),
    maxTerminals: z.number().step(1).min(1).default(8),
    maxCols: z.number().step(1).min(2).default(500),
    maxRows: z.number().step(1).min(1).default(200),
    scrollback: z.number().step(1).min(0).default(1000),
    maxBufferedBytes: z.number().step(1).min(1024).default(2 * 1024 * 1024),
    maxInputBytes: z.number().step(1).min(1).default(64 * 1024),
    disposeGraceMs: z.number().step(1).min(1).default(1000),
    unattendedTimeoutMs: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(7_200_000),
    activityPollIntervalMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(30_000),
    cleanupRetryMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(60_000),
  })

  private readonly owners = new Map<SessionId, UserTerminalOwner>()
  private readonly lifetime = new AbortController()

  /**
   * @param ctx - Host context carrying typed Remote and execution providers.
   * @param config - validated terminal limits and optional shell profile.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'terminalController', { namespace: 'terminal' })
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('Terminal controller disposed'))
      const results = await Promise.allSettled([...this.owners].map(([id, owner]) => this.disposeOwner(id, owner)))
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
      if (errors.length > 0) throw new AggregateError(errors, 'Browser terminal cleanup failed')
    }, 'terminal-controller.processes')
  }

  /**
   * Read the Session's current directory and terminal limits without filesystem validation or shell lookup.
   * @param agent - Session owner supplied by the Gateway.
   * @param signal - request cancellation.
   * @returns the logged current directory and terminal limits; retained terminals keep their own process directories.
   */
  @Remote
  environment(agent: Agent, signal: AbortSignal): TerminalEnvironment {
    signal.throwIfAborted()
    const { workingDirectory } = this.execution(agent)
    return { cwd: workingDirectory.get(agent.session),
      maxInputBytes: this.config.maxInputBytes, maxBufferedBytes: this.config.maxBufferedBytes, maxCols: this.config.maxCols,
      maxRows: this.config.maxRows, scrollback: this.config.scrollback }
  }

  /**
   * Discover installed shells in the Session's execution environment.
   * @param agent - Session owner supplied by the Gateway.
   * @param signal - request cancellation.
   * @returns verified profiles, with the configured or system default first.
   */
  @Remote
  shells(agent: Agent, signal: AbortSignal): Promise<TerminalShell[]> {
    signal.throwIfAborted()
    return this.owner(agent).shells(signal)
  }

  /**
   * List retained terminals without resolving or activating an Agent.
   * @param sessionId - displayed Session identity, including offline history.
   * @returns terminals retained for this Host lifetime.
   */
  @Remote
  list(sessionId: SessionId): WebTerminalInfo[] {
    const owner = this.owners.get(sessionId)
    if (owner === undefined) return []
    return owner.list()
  }

  /**
   * Allocate a user shell once for a caller-generated identity, without Agent sandbox or approval restrictions.
   * @param agent - Session owner supplied by the Gateway.
   * @param request - initial dimensions and idempotency identity.
   * @param signal - allocation cancellation; committed terminals survive disconnection.
   * @returns the existing or newly committed terminal.
   */
  @Remote
  async create(agent: Agent, request: TerminalCreateRequest, signal: AbortSignal): Promise<WebTerminalInfo> {
    this.lifetime.signal.throwIfAborted()
    return this.owner(agent).create(request, signal)
  }

  /**
   * Retain an existing terminal for a window without activating its Agent or taking input control.
   * @param sessionId - owning Session identity, including an inactive saved layout.
   * @param id - retained Host terminal identity.
   * @param signal - physical Remote stream cancellation.
   * @returns a hold acknowledgement followed by an open lifetime stream.
   */
  @Remote({ mode: 'stream' })
  retain(sessionId: SessionId, id: WebTerminalId, signal: AbortSignal): AsyncIterable<TerminalRetentionFrame> {
    const owner = this.owners.get(sessionId)
    if (owner === undefined) throw new RemoteError('terminal/unavailable', 'Terminal is closing or unavailable', {})
    return owner.retain(id, signal)
  }

  /**
   * Attach terminal input and output to one physical Remote stream.
   * @param agent - Session owner supplied by the Gateway.
   * @param id - terminal identity.
   * @param signal - attachment cancellation; the process remains alive and input is never replayed.
   * @returns screen recovery, output, writable state and provider-acceptance acknowledgements.
   */
  @Remote({ mode: 'stream' })
  attach(agent: Agent, id: WebTerminalId, signal: AbortSignal): RemoteStream<TerminalFrame, TerminalInput> {
    const invocation = this.ctx.invocation
    if (invocation === undefined) throw new Error('Terminal attachment requires a Remote invocation')
    return this.owner(agent).attach(id, invocation.uplink<TerminalInput>(), signal, invocation.uplinkWindow)
  }

  /**
   * Rename a terminal without changing its shell.
   * @param agent - Session owner supplied by the Gateway.
   * @param id - terminal identity.
   * @param title - nonempty display title, at most 120 characters.
   */
  @Remote
  rename(agent: Agent, id: WebTerminalId, title: string): void {
    this.owner(agent).rename(id, title)
  }

  /**
   * Close an identity to future creation and kill its process range; repeated closes succeed.
   * @param agent - Session owner supplied by the Gateway.
   * @param id - terminal identity.
   * @returns after provider cleanup succeeds. A failure retains the terminal for retry.
   */
  @Remote
  async close(agent: Agent, id: WebTerminalId): Promise<void> {
    await this.owner(agent).close(id)
  }

  /**
   * Construct a view-independent terminal owner for an application resource.
   * The caller owns disposal; zero unattendedTimeoutMs retains processes until explicit resource cleanup.
   * @param execution - Provider and validated directory resolver for this resource.
   * @param unattendedTimeoutMs - Owner retention interval, or zero for resource-owned retention.
   * @returns A new owner using the controller's shell and screen configuration.
   */
  createOwner(execution: () => UserTerminalExecution, unattendedTimeoutMs: number): UserTerminalOwner {
    return new UserTerminalOwner({ ...this.config, unattendedTimeoutMs }, execution,
      (error) => { this.ctx.logger.error('Browser terminal cleanup failed', error) })
  }

  private owner(agent: Agent): UserTerminalOwner {
    let owner = this.owners.get(agent.id)
    if (owner === undefined) {
      owner = this.createOwner(() => {
        const { subprocess, workingDirectory } = this.execution(agent)
        return { subprocess, ensureCwd: signal => workingDirectory.ensure(agent, signal), env: { DSH_SESSION_ID: agent.id } }
      }, this.config.unattendedTimeoutMs)
      this.owners.set(agent.id, owner)
      const owned = owner
      agent.ctx.effect(() => async () => { await this.disposeOwner(agent.id, owned) }, 'terminal-controller.owner')
    }
    return owner
  }

  private async disposeOwner(id: SessionId, owner: UserTerminalOwner): Promise<void> {
    await owner.dispose()
    this.owners.delete(id)
  }

  private execution(agent: Agent): { subprocess: Context['subprocess']; sandboxPolicy: Context['sandboxPolicy']; workingDirectory: Context['workingDirectory'] } {
    // The Agent context selects execution providers but does not inject consumer services.
    const subprocess = agent.ctx.get('subprocess')
    const sandboxPolicy = agent.ctx.get('sandboxPolicy')
    if (subprocess === undefined || sandboxPolicy === undefined) throw new Error('The Session execution environment requires subprocess and sandbox policy providers')
    const workingDirectory = agent.ctx.get('workingDirectory')
    if (workingDirectory === undefined) throw new Error('The Session execution environment requires a working-directory provider')
    return { subprocess, sandboxPolicy, workingDirectory }
  }

}

/** Browser terminal service plugin. */
export default TerminalController
