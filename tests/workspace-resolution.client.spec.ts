/** Source imports remain local across the Convax and retained DSH workspaces. */
import { dirname, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { resizeResource as throughAlias } from '@deepseek-ai/dsh-convax-plugin-renderer/src/client/resource-size.ts'
import { resizeResource as throughPath } from '../packages/plugin-renderer/src/client/resource-size.ts'

const root = resolve(import.meta.dirname, '..')
const configuration = resolve(root, 'libs/dsh/tsconfig.base.json')

function sourceResolution(specifier: string): string | undefined {
  const loaded = ts.readConfigFile(configuration, path => ts.sys.readFile(path))
  if (loaded.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'))
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(configuration))
  return ts.resolveModuleName(specifier, resolve(root, 'tests/workspace-resolution.client.spec.ts'), parsed.options, ts.sys)
    .resolvedModule?.resolvedFileName
}

describe('Monorepo source resolution', () => {
  it.each([
    ['@deepseek-ai/dsh-convax-plugin-host', 'packages/plugin-host/src/index.ts'],
    ['@deepseek-ai/dsh-convax-plugin-host/types', 'packages/plugin-host/src/types.ts'],
    ['@deepseek-ai/dsh-convax-plugin-renderer/client', 'packages/plugin-renderer/src/client/index.ts'],
    ['@deepseek-ai/dsh-session', 'libs/dsh/packages/core/session/src/index.ts'],
  ])('resolves %s from its owning source workspace', (specifier, source) => {
    expect(sourceResolution(specifier)).toBe(resolve(root, source))
  })

  it('loads the same renderer module through its package alias and source path', () => {
    expect(throughAlias).toBe(throughPath)
    expect(throughAlias({ width: 320, height: 240 }, 40, 20, 0.5)).toEqual({ width: 400, height: 280 })
  })
})
