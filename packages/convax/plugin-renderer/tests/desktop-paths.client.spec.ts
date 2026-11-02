/** Native path resolution preserves File identity and leaves browser bytes untouched. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hostPathForFile } from '../src/client/desktop-paths.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('hostPathForFile', () => {
  it('distinguishes a served Web page from a native file with no path', () => {
    vi.stubGlobal('__DSH_HOST_PATHS__', undefined)
    const file = new File(['pasted bytes'], 'image.png')
    expect(hostPathForFile(file)).toBeUndefined()
    vi.stubGlobal('__DSH_HOST_PATHS__', { pathFor: () => '' })
    expect(hostPathForFile(file)).toBe('')
    expect(file.size).toBe(12)
  })

  it.each(['folder with spaces', 'notes.txt'])('resolves the original %s File through Desktop', (name) => {
    const file = new File([], name)
    const pathFor = vi.fn((value: File) => value === file ? `/project/${name}` : '')
    vi.stubGlobal('__DSH_HOST_PATHS__', { pathFor })
    expect(hostPathForFile(file)).toBe(`/project/${name}`)
    expect(pathFor).toHaveBeenCalledExactlyOnceWith(file)
  })

  it('preserves resolution failures for the owning view to report', () => {
    const failure = new Error('Native path unavailable')
    vi.stubGlobal('__DSH_HOST_PATHS__', { pathFor: () => { throw failure } })
    expect(() => hostPathForFile(new File([], 'folder'))).toThrow(failure)
  })
})
