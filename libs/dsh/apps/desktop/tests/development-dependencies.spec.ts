/** Source Desktop dependency lookup across standalone and retained workspaces. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { developmentDependencyDirectory } from '../scripts/development-dependencies.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'desktop-source-dependencies-'))
  roots.push(root)
  return root
}

describe('source Desktop dependencies', () => {
  it('finds the enclosing installation from a retained DSH source root', () => {
    const root = fixture()
    const source = join(root, 'libs/dsh/apps/desktop/scripts')
    const dependencies = join(root, 'node_modules/.pnpm/node_modules')
    mkdirSync(source, { recursive: true })
    mkdirSync(dependencies, { recursive: true })
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: [libs/dsh/apps/*]\n')
    writeFileSync(join(root, 'libs/dsh/package.json'), '{"private":true}\n')
    expect(developmentDependencyDirectory(source)).toBe(dependencies)
  })

  it('requires dependencies in the nearest workspace', () => {
    const root = fixture()
    const nested = join(root, 'nested')
    mkdirSync(join(root, 'node_modules/.pnpm/node_modules'), { recursive: true })
    mkdirSync(nested)
    for (const directory of [root, nested]) writeFileSync(join(directory, 'pnpm-workspace.yaml'), 'packages: []\n')
    expect(() => developmentDependencyDirectory(nested)).toThrow(`run pnpm install in ${nested}`)
  })

  it('reports a source directory outside a pnpm workspace', () => {
    const root = fixture()
    expect(() => developmentDependencyDirectory(root)).toThrow('no pnpm workspace above')
  })
})
