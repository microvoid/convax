import { Rolldown, type UserConfig } from 'tsdown'
import { clientBundle } from '../../client/tsdown.client.ts'

const bundle = clientBundle(import.meta.dirname, ['lib/types/index.js'])
const decoderFile = 'client.media-decode.js'

/** Build the ranged decoder independently so its compiler helpers stay inside its lazy factory. */
export default (options: Parameters<typeof bundle>[0]): UserConfig[] => {
  const configs = bundle(options)
  const browser = configs.find(config => config.platform === 'browser')
  if (browser === undefined) return configs
  const decoder = bundle(options).find(config => config.platform === 'browser')
  if (decoder === undefined) throw new Error('Convax decoder browser configuration is unavailable')
  return [
    ...configs.map(config => config === browser ? {
      ...config,
      plugins: [{
        name: 'convax-lazy-media-decoder',
        resolveId: {
          order: 'pre' as const,
          handler(source: string) {
            return source === './media-decode.ts' || source === './media-decode.js'
              ? { id: `./${decoderFile}`, external: true } : null
          },
        },
        renderChunk(code: string) {
          const call = `import("./${decoderFile}")`
          const transformed = new Rolldown.RolldownMagicString(code)
          for (let index = code.indexOf(call); index >= 0; index = code.indexOf(call, index + call.length)) {
            transformed.overwrite(index, index + call.length, `require.async("./${decoderFile}")`)
          }
          return transformed.hasChanged() ? transformed : null
        },
      }, config.plugins],
    } : config),
    {
      ...decoder,
      name: `${decoder.name}-media-decode`,
      entry: { 'media-decode': options.env?.DSH_BUILD_FACE === 'client'
        ? 'lib/types/client/media-decode.js' : 'src/client/media-decode.ts' },
      outputOptions: {
        ...decoder.outputOptions,
        codeSplitting: false,
        entryFileNames: decoderFile,
        banner: `window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-convax-plugin-renderer", chunk: "${decoderFile}", factory: (require) => {`,
      },
    },
  ]
}
