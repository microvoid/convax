/** The optional decoder loads without synchronous sibling-module dependencies. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { build, type UserConfig } from 'tsdown'
import { describe, expect, it } from 'vitest'

type ConfigFactory = (options: Pick<UserConfig, 'env'>) => UserConfig[]

describe('Convax media decoder bundle', () => {
  it('publishes a self-contained lazy factory without splitting compiler helpers', async () => {
    const root = resolve(import.meta.dirname, '..')
    const configPath = new URL('../tsdown.config.ts', import.meta.url).href
    const { default: configs } = await import(configPath) as { default: ConfigFactory }
    const chunks: { fileName: string; code: string }[] = []
    for (const config of configs({ env: {} }).filter(config => config.platform === 'browser')) {
      const builds = await build({
        ...config, cwd: root, config: false, tsconfig: false,
        write: false, clean: false, exports: false, report: false, logLevel: 'silent',
      })
      try {
        for (const bundle of builds) for (const chunk of bundle.chunks) {
          if (chunk.type === 'chunk') chunks.push({ fileName: chunk.fileName, code: chunk.code })
        }
      } finally {
        for (const bundle of builds) await bundle[Symbol.asyncDispose]()
      }
    }
    expect(chunks.map(chunk => chunk.fileName).sort()).toEqual(['client.js', 'client.media-decode.js'])
    const entry = chunks.find(chunk => chunk.fileName === 'client.js')!
    const decoder = chunks.find(chunk => chunk.fileName === 'client.media-decode.js')!
    expect(entry.code.includes('require.async("./client.media-decode.js")')).toBe(true)
    for (const chunk of chunks) {
      const siblingImports = chunk.code.match(/\brequire\(["']\.\/client[^"'/]*\.js["']\)/gu)
      expect(siblingImports, chunk.fileName).toBeNull()
    }
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { files: string[] }
    for (const chunk of chunks) expect(manifest.files).toContain(`lib/${chunk.fileName}`)
    let loaded = false
    runInNewContext(decoder.code, {
      URL, TextEncoder, TextDecoder, AbortController, ReadableStream, Blob, atob, btoa, performance,
      window: { __ModuleLoader__: { load: (registration: {
        chunk: string
        factory: (require: (specifier: string) => never) => { decodeMediaWaveform: unknown }
      }) => {
        expect(registration.chunk).toBe('client.media-decode.js')
        const exports = registration.factory((specifier) => { throw new Error(`Unexpected decoder dependency: ${specifier}`) })
        expect(typeof exports.decodeMediaWaveform).toBe('function')
        loaded = true
      } } },
    })
    expect(loaded).toBe(true)
  })
})
