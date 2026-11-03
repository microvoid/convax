import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectConfigSourceOwnershipViolations } from './verify-config-source-ownership.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('configuration source ownership gate', () => {
  it('checks declared external bundle and preset patches once while leaving unrelated files alone', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-external-config-source-ownership-'))
    roots.push(directory)
    const root = join(directory, 'libs', 'dsh')
    const external = join(directory, 'packages', 'renderer')
    mkdirSync(root, { recursive: true })
    mkdirSync(join(external, 'presets'), { recursive: true })
    writeFileSync(join(external, 'cordis.patch.yml'), 'config:\n  apiKey: !!js process.env.API_KEY\n')
    writeFileSync(join(external, 'presets', 'default.patch.yml'), 'config:\n  baseURL: !!js process.env.ENDPOINT\n')
    writeFileSync(join(external, 'unshipped.yml'), 'config:\n  authToken: !!js process.env.TOKEN\n')
    expect(collectConfigSourceOwnershipViolations(root)).toEqual([])
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      dshWorkspacePackages: ['../../packages/*', '../../packages/renderer'],
    }))

    const failures = collectConfigSourceOwnershipViolations(root)
    expect(failures.map(failure => failure.split(':')[0])).toEqual([
      '../../packages/renderer/cordis.patch.yml', '../../packages/renderer/presets/default.patch.yml',
    ])
    expect(failures.every(failure => failure.includes(':2: inlines a credential or endpoint'))).toBe(true)
  })

  it('rejects inline endpoints in shipped bundle patches', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-config-source-ownership-'))
    roots.push(root)
    const directory = join(root, 'packages/subagent/subagent-claude-code')
    mkdirSync(directory, { recursive: true })
    writeFileSync(
      join(directory, 'cordis.patch.yml'),
      'config:\n  baseURL: !!js process.env.DEEPSEEK_SEARCH_BASE_URL\n',
    )

    expect(collectConfigSourceOwnershipViolations(root)).toEqual([
      'packages/subagent/subagent-claude-code/cordis.patch.yml:2: inlines a credential or endpoint from the environment.'
      + ' The adapter resolves apiKeyEnv through ctx.credentials and the endpoint through the'
      + ' environment snapshot; inlining here bypasses both ladders.',
    ])
  })
})
