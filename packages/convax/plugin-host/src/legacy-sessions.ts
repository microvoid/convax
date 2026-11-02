/** Validate the predecessor Session ledger before merging its reservations into Convax. */
import { isAbsolute, normalize } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { threadRequestSchema } from './schema.ts'
import type { CanvasThreadIntent, CanvasSessionReservation } from './coordination-repository.ts'
import type { CanvasOperationId } from './types.ts'

const legacyRequest = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('create'), cwd: z.string(), agentPreset: z.string().optional() }),
  z.strictObject({ kind: z.literal('fork'), sessionId: z.string(), atSeq: z.number().int().nonnegative().optional() }),
])
const legacyOperation = z.strictObject({
  request: legacyRequest, phase: z.enum(['reserved', 'completed']),
  sessionId: z.string().min(1).transform(SessionId), createdAt: z.number().int().nonnegative(),
  cwd: z.string().refine(isAbsolute, 'Session directory must be absolute'),
  agentPreset: z.string().optional(), boundary: z.number().int().nonnegative().optional(),
}).superRefine((value, ctx) => {
  if ((value.request.kind === 'fork') !== (value.boundary !== undefined)) ctx.addIssue({ code: 'custom', message: 'Only a fork carries an inherited boundary' })
})

/**
 * Merge only matching requests; unmatched predecessor records remain in their recovery file.
 * @param threads - Current detached Convax intentions.
 * @param rows - Read-only predecessor key/value rows.
 * @returns Enriched intentions and unmatched identities for an explicit startup report.
 */
export function mergeLegacySessions(threads: readonly [CanvasOperationId, CanvasThreadIntent][], rows: readonly [string, string][]): {
  threads: [CanvasOperationId, CanvasThreadIntent][]
  unmatched: string[]
} {
  const merged = new Map(threads)
  const unmatched: string[] = []
  for (const [id, json] of rows) {
    if (id.length === 0) throw new Error('Legacy Session operation has an empty identity')
    const legacy = legacyOperation.parse(JSON.parse(json))
    const operationId = id as CanvasOperationId
    const intent = merged.get(operationId)
    if (intent === undefined) { unmatched.push(id); continue }
    const request = threadRequestSchema.parse(JSON.parse(intent.request))
    const expected = request.kind === 'create'
      ? { kind: request.kind, cwd: normalize(intent.cwd),
        ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }) }
      : { kind: request.kind, sessionId: request.sourceSessionId, ...(request.atSeq === undefined ? {} : { atSeq: request.atSeq }) }
    if (!isDeepStrictEqual(expected, legacy.request)) throw new Error(`Legacy Session operation ${id} belongs to another request`)
    if (intent.sessionId !== null && intent.sessionId !== legacy.sessionId) throw new Error(`Legacy Session operation ${id} has a different bound Session`)
    const session: CanvasSessionReservation = {
      phase: legacy.phase, sessionId: legacy.sessionId, createdAt: legacy.createdAt, cwd: legacy.cwd,
      ...(legacy.agentPreset === undefined ? {} : { agentPreset: legacy.agentPreset }),
      ...(legacy.boundary === undefined ? {} : { boundary: legacy.boundary }),
    }
    if (intent.session !== undefined && !isDeepStrictEqual(intent.session, session)) throw new Error(`Legacy Session operation ${id} conflicts with its owned reservation`)
    merged.set(operationId, { ...intent, session })
  }
  return { threads: [...merged], unmatched }
}
