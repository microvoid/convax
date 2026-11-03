/** Effect-owned claims that keep Session tools inside an embedding workspace. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Tracks committed embedded hosts independently of focus and expanded preferences. */
export class EmbeddedSidebarHosts {
  /** Committed Session identities published when the first host mounts or last host leaves. */
  readonly source = createSnapshotStore<readonly SessionId[]>([])
  private readonly claims = new Map<SessionId, number>()

  /**
   * Claim one mounted occurrence until its layout effect releases it.
   * @param sessionId - Session whose native tools render in the workspace.
   * @returns Idempotent release that preserves other occurrences' claims.
   */
  mount(sessionId: SessionId): () => void {
    this.claims.set(sessionId, (this.claims.get(sessionId) ?? 0) + 1)
    this.publish()
    let mounted = true
    return () => {
      if (!mounted) return
      mounted = false
      const count = this.claims.get(sessionId) ?? 0
      if (count <= 1) this.claims.delete(sessionId)
      else this.claims.set(sessionId, count - 1)
      this.publish()
    }
  }

  /**
   * Test whether a committed workspace occurrence owns this Session's presentation.
   * @param sessionId - Session addressed by navigation.
   * @returns Whether its native frame seat must stay absent.
   */
  has(sessionId: SessionId | undefined): boolean {
    return sessionId !== undefined && this.claims.has(sessionId)
  }

  private publish(): void {
    const next = [...this.claims.keys()]
    const current = this.source.getSnapshot()
    if (next.length === current.length && next.every((id, index) => current[index] === id)) return
    this.source.set(next)
  }
}
