/** Stored thread requests preserve explicit creation presets and inherited fork modes. */
import { describe, expect, it } from 'vitest'
import { threadRequestSchema } from '../src/schema.ts'

const base = { canvasId: 'canvas', nodeId: 'chat', expectedRevision: 2, operationId: 'thread' }

describe('Convax thread request validation', () => {
  it('preserves a chosen creation preset and accepts existing default requests', () => {
    const selected = { ...base, kind: 'create', cwd: '/project', agentPreset: 'plan' }
    expect(threadRequestSchema.parse(selected)).toEqual(selected)
    const existing = { ...base, kind: 'create' }
    expect(threadRequestSchema.parse(existing)).toEqual(existing)
  })

  it.each(['', 2, null])('rejects an invalid creation preset %s', (agentPreset) => {
    expect(threadRequestSchema.safeParse({ ...base, kind: 'create', agentPreset }).success).toBe(false)
  })

  it('rejects a fork preset override and preserves a plain source-bound fork', () => {
    const fork = { ...base, kind: 'fork', sourceSessionId: 'source', atSeq: 4 }
    expect(threadRequestSchema.parse(fork)).toEqual(fork)
    expect(threadRequestSchema.safeParse({ ...fork, agentPreset: 'plan' }).success).toBe(false)
  })
})
