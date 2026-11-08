/** Bounded installation-local notice records, separate from canvas database migrations. */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import z from 'zod'

/** Maximum campaign identities retained in one local history document. */
export const NOTICE_HISTORY_LIMIT = 1024
const maximumBytes = 1024 * 1024

const recordSchema = z.object({
  impressions: z.number().int().nonnegative(),
  lastShownAt: z.number().nonnegative().nullable(),
  dismissed: z.boolean(),
  snoozedUntil: z.number().nonnegative().nullable(),
  updatedAt: z.number().nonnegative(),
}).strict()
const historySchema = z.object({
  version: z.literal(1),
  installationId: z.uuid(),
  lastModalShownAt: z.number().nonnegative().nullable(),
  records: z.record(z.string().min(1).max(512), recordSchema)
    .refine(records => Object.keys(records).length <= NOTICE_HISTORY_LIMIT, 'Too many notice history records'),
}).strict()

/** Local outcomes used for stable-ID deduplication and reminder timing. */
export type NoticeHistoryRecord = z.infer<typeof recordSchema>
/** Installation identity and committed display history. */
export type NoticeHistory = z.infer<typeof historySchema>

/** Synchronous persistence makes the single Host's grant and commit operations atomic. */
export interface NoticePersistence {
  /** Return validated committed history, initializing a missing installation when needed. */
  load(): NoticeHistory
  /** Replace the complete history or throw before the caller publishes its new state. */
  save(history: NoticeHistory): void
}

/** Owns one bounded JSON file; malformed existing data is never overwritten during load. */
export class NoticeFilePersistence implements NoticePersistence {
  /** @param path - Installation-owned history file, outside the canvas SQLite database. */
  constructor(private readonly path: string) {}

  /** @returns Validated history; a new installation identity is durably created once. */
  load(): NoticeHistory {
    let bytes: Buffer
    try {
      if (statSync(this.path).size > maximumBytes) throw new Error('Convax notice history exceeds its size limit')
      bytes = readFileSync(this.path)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      const history: NoticeHistory = { version: 1, installationId: randomUUID(), lastModalShownAt: null, records: {} }
      this.save(history)
      return history
    }
    if (bytes.byteLength > maximumBytes) throw new Error('Convax notice history exceeds its size limit')
    return historySchema.parse(JSON.parse(bytes.toString('utf8')))
  }

  /** @param history - Complete next state; failed writes preserve the preceding document. */
  save(history: NoticeHistory): void {
    const text = JSON.stringify(historySchema.parse(history)) + '\n'
    if (Buffer.byteLength(text) > maximumBytes) throw new Error('Convax notice history exceeds its size limit')
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 })
      renameSync(temporary, this.path)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
}
