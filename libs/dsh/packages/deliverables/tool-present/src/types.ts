/** Durable file deliveries produced by the present tool. */
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'

/** A declared filesystem file whose current contents remain at its source path. */
export interface PresentedFile {
  /** Original absolute path or path relative to the Session working directory. */
  path: string
  /** Optional description supplied by the model. */
  description?: string
}

/** Host-owned delivery to the original tool invocation, including completed turns. */
export interface PublishDeliverables {
  /** Stable key scoped to this Session; retries must retain the entire payload. */
  deliveryKey: string
  /** Captured from the real generating invocation, never from model arguments. */
  origin: { sessionId: SessionId; turn: number; callId: ToolCallId }
  /** Existing absolute filesystem paths; bytes remain at these paths. */
  files: readonly PresentedFile[]
}

/** Durable declaration receipt; canvas projection may complete afterwards. */
export interface DeliveryReceipt {
  sessionId: SessionId
  eventSeq: SessionSeq
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Durable Host publication, including a Session that has no live Agent.
     * @param sessionId - Session whose declaration was flushed.
     * @param eventSeq - Stable declaration position; retries may announce it again.
     * @mode emit
     */
    'deliverables/published'(sessionId: SessionId, eventSeq: SessionSeq): void
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Validated Host file declaration; successful present results and background deliveries share this event. */
    'deliverables/presented': { turn: number; callId: ToolCallId; files: PresentedFile[]; deliveryKey?: string }
  }
}
