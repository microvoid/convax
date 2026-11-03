/** In-flight and durable retry checks share the serialized request semantics. */
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { sameCanvasRequest } from '../src/request-equality.ts'
import type { CanvasCommandRequest, CanvasId, CanvasNodeId, CanvasOperationId, CanvasThreadRequest } from '../src/types.ts'

const canvasId = brandString<CanvasId>('canvas')
const operationId = brandString<CanvasOperationId>('operation')
const request: CanvasCommandRequest = { canvasId, operationId, expectedRevision: 2, command: { kind: 'rename', title: 'Canvas' } }

describe('serialized Canvas request equality', () => {
  it('matches both durable and captured requests without depending on object field order', () => {
    const reordered: CanvasCommandRequest = { command: { title: 'Canvas', kind: 'rename' }, expectedRevision: 2, operationId, canvasId }
    expect(sameCanvasRequest(request, reordered)).toBe(true)
    expect(sameCanvasRequest(JSON.stringify(request), reordered)).toBe(true)
    expect(sameCanvasRequest(JSON.stringify(reordered), request)).toBe(true)
  })

  it('treats undefined optional fields like their omitted serialized values', () => {
    expect(sameCanvasRequest({ ...request, confirmed: undefined }, request)).toBe(true)
    expect(sameCanvasRequest(JSON.stringify(request), { ...request, confirmed: undefined })).toBe(true)
    expect(sameCanvasRequest(request, { ...request, confirmed: false })).toBe(false)
    const thread: CanvasThreadRequest = { canvasId, operationId, nodeId: brandString<CanvasNodeId>('chat'), expectedRevision: 2, kind: 'create' }
    expect(sameCanvasRequest({ ...thread, cwd: undefined, agentPreset: undefined }, thread)).toBe(true)
    expect(sameCanvasRequest(thread, { ...thread, agentPreset: 'standard' })).toBe(false)
  })

  it('rejects changed targets, revisions, identities, command arguments, and request families', () => {
    for (const changed of [
      { ...request, canvasId: brandString<CanvasId>('other') },
      { ...request, operationId: brandString<CanvasOperationId>('other') },
      { ...request, expectedRevision: 3 },
      { ...request, command: { kind: 'rename', title: 'Changed' } as const },
      { canvasId, operationId, nodeId: brandString<CanvasNodeId>('chat'), expectedRevision: 2, kind: 'create' as const },
    ]) {
      expect(sameCanvasRequest(request, changed)).toBe(false)
      expect(sameCanvasRequest(JSON.stringify(request), changed)).toBe(false)
    }
  })
})
