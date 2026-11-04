/** Saved node formats remain compatible while their providers become ordinary plugins. */
import { describe, expect, it } from 'vitest'
import type { CanvasNodeDefinition } from '@deepseek-ai/dsh-convax-plugin-host'
import { registerDefaultNodes } from '../src/definitions.ts'

function definitions(): Map<string, CanvasNodeDefinition> {
  const result = new Map<string, CanvasNodeDefinition>()
  registerDefaultNodes((definition) => { result.set(definition.id, definition) })
  return result
}

describe('Default node provider formats', () => {
  it('keeps all four saved identities and payload versions with explicit capabilities', () => {
    const nodes = definitions()
    expect([...nodes.keys()].sort()).toEqual(['convax.chat', 'convax.file', 'convax.folder', 'convax.window'])
    for (const node of nodes.values()) expect(node.dataVersion).toBe(1)
    expect(nodes.get('convax.file')?.capabilities).toEqual({ resourceKind: 'file' })
    expect(nodes.get('convax.folder')?.capabilities).toEqual({ resourceKind: 'folder' })
    expect(nodes.get('convax.chat')?.capabilities).toEqual({ sessions: true })
  })

  it('retains existing file descriptions and extension fields without copying source contents', () => {
    const node = definitions().get('convax.file')!
    const saved = { path: '/project/report.txt', description: 'Existing delivery', custom: { retained: true } }
    expect(node.parse(saved)).toEqual(saved)
    expect(() => node.parse({ path: '' })).toThrow()
  })

  it('rejects serialized native window handles and keeps only the explicit selection identity', () => {
    const node = definitions().get('convax.window')!
    const saved = { bindingId: 'c25f3774-0691-4ba7-bb2d-55df139be385', name: 'Selected window' }
    expect(node.parse(saved)).toEqual(saved)
    expect(() => node.parse({ ...saved, processId: 123 })).toThrow()
    expect(() => node.parse({ bindingId: 'not-a-selection', name: 'Window' })).toThrow()
  })

  it('requires an absolute Session directory and preserves generated Chat name semantics', () => {
    const node = definitions().get('convax.chat')!
    expect(node.parse({ title: ' Chat ', cwd: '/project', defaultTitle: true }))
      .toEqual({ title: 'Chat', cwd: '/project', defaultTitle: true })
    expect(() => node.parse({ title: 'Chat', cwd: 'relative-directory' })).toThrow()
    expect(() => node.parse({ title: ' ', cwd: '/project' })).toThrow()
  })
})
