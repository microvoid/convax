/** Session discovery and owned references for mounted Convax Chat threads. */
import type { ISessions, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { resourcePath } from './resources.ts'

function isAborted(signal: AbortSignal): boolean { return signal.aborted }

/**
 * Discover Host-published bindings before opening their shared Session generation.
 * Failed acquisition emits a resource failure and releases any acquired reference.
 * @param sessions - Native DSH catalog and reference owner.
 * @returns Resource provider that releases its visible reference when aborted.
 */
export function createThreadProvider(sessions: ISessions): ResourceProvider<'convax-thread'> {
  return {
    protocol: 'convax-thread',
    async *open(address, { signal }) {
      if (isAborted(signal)) return
      let reference: SessionReference | undefined
      try {
        const sessionId = resourcePath(address) as SessionId
        if (sessions.list.getSnapshot().byId[sessionId] === undefined) {
          await sessions.refresh()
          if (isAborted(signal)) return
          // A shared pull may have started before the Host published this binding.
          if (sessions.list.getSnapshot().byId[sessionId] === undefined) await sessions.refresh()
        }
        if (isAborted(signal)) return
        reference = sessions.retain(sessionId, { source: 'convaxChat', signal })
        await reference.ready
        if (isAborted(signal)) return
        yield { ok: true, value: { reference } }
        await new Promise<void>((resolve) => {
          if (isAborted(signal)) resolve()
          else signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
      } catch (error) {
        if (!isAborted(signal)) yield {
          ok: false,
          error: remoteErrorOf(error) ?? new RemoteError('gateway/internal', 'Convax thread could not be opened', {}),
        }
      } finally { reference?.release() }
    },
  }
}
