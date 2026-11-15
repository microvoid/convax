/** Exercise local Desktop packing and the official-release rejection through their real entry points. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { resolveClientBuildEnvironment, writeClientBuildRecord } from '../../../scripts/client-build-environment.ts'
import { runGate } from '../../../scripts/run-gates.ts'
import { COVERAGE_TEST_TIMEOUT_ENV, coverageTestTimeoutOptions } from '../../../scripts/coverage-partitions.ts'
import { removeFixtureSafely } from '../../../scripts/test-fixture-cleanup.ts'
import { packedIdentity, packedManifest, PUBLISH_ORDER_FILE } from '../../../scripts/release/tarball.ts'

const require = createRequire(import.meta.url)
const pnpmEntry = join(dirname(require.resolve('pnpm')), 'bin/pnpm.cjs')
const tsxHook = pathToFileURL(require.resolve('tsx/esm')).href
const roots: string[] = []
const metadata = { DSH_CLIENT_COMMIT_HASH: 'abcdef0', DSH_CLIENT_VERSION: '1.2.3' }
const testTimeout = Math.max(120_000, coverageTestTimeoutOptions(process.env[COVERAGE_TEST_TIMEOUT_ENV]).testTimeout ?? 0)
const activeRuns = new Map<AbortController, ReturnType<typeof runGate>>()

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-local-desktop-pack-'))
  roots.push(root)
  return root
}

function writeFixture(root: string, profile: 'local' | 'official', dshWorkspacePackages?: readonly string[]): void {
  write(root, 'package.json', JSON.stringify({ name: 'desktop-pack-fixture', version: '1.2.3', private: true, dshWorkspacePackages }))
  write(root, 'packages/client/probe/package.json', JSON.stringify({
    name: '@deepseek-ai/dsh-probe', version: '1.2.3', files: ['lib', 'src'],
  }))
  write(root, 'packages/client/probe/lib/index.js', 'export const probe = true\n')
  write(root, 'packages/client/probe/lib/client.js', 'export const client = true\n')
  write(root, 'apps/web/dist/index.html', '<title>DSH Local Build</title>\n')
  writeClientBuildRecord(root, resolveClientBuildEnvironment(metadata, profile))
}

function fixture(profile: 'local' | 'official' = 'local'): string {
  const root = fixtureRoot()
  write(root, 'pnpm-workspace.yaml', 'packages:\n  - packages/*/*\n')
  writeFixture(root, profile)
  return root
}

async function pack(root: string, release = false, extra: string[] = [], product?: 'convax') {
  const script = release
    ? resolve(import.meta.dirname, '../../../scripts/release/pack.ts')
    : resolve(import.meta.dirname, '../scripts/pack-local-packages.ts')
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, 90_000)
  try {
    const pending = runGate({
      id: 'desktop-pack-fixture', label: 'Desktop packing', displayCommand: script,
      command: process.execPath,
      args: [pnpmEntry, '--dir', root, 'exec', process.execPath, '--import', tsxHook, script,
        ...(release ? ['--family', 'dsh'] : []), '--out', 'packed', '--concurrency', '2', ...extra],
      env: { npm_execpath: pnpmEntry, DSH_CLIENT_COMMIT_HASH: metadata.DSH_CLIENT_COMMIT_HASH, DSH_DESKTOP_PRODUCT: product },
    }, controller.signal)
    activeRuns.set(controller, pending)
    const result = await pending
    expect(result.error).toBeUndefined()
    expect(result.aborted).toBe(false)
    expect(result.signalCode).toBeNull()
    return { code: result.exitCode, output: result.output.map(chunk => chunk.text).join('') }
  } finally {
    clearTimeout(timer)
    activeRuns.delete(controller)
  }
}

afterEach(async () => {
  for (const controller of activeRuns.keys()) controller.abort()
  await Promise.all(activeRuns.values())
  for (const root of roots.splice(0)) removeFixtureSafely(root)
}, testTimeout)

it('packs local client artifacts without a release publication record', async () => {
  const root = fixture()
  const result = await pack(root)
  expect(result.code, result.output).toBe(0)
  expect(readdirSync(join(root, 'packed'))).toEqual(['deepseek-ai-dsh-probe-1.2.3.tgz'])
  expect(packedIdentity(join(root, 'packed/deepseek-ai-dsh-probe-1.2.3.tgz')))
    .toEqual({ name: '@deepseek-ai/dsh-probe', version: '1.2.3' })
  expect(existsSync(join(root, 'packed', PUBLISH_ORDER_FILE))).toBe(false)
}, testTimeout)

it('packs the declared Convax workspace packages and resolves their local dependencies', async () => {
  const workspace = fixtureRoot()
  const root = join(workspace, 'libs', 'dsh')
  const host = '@deepseek-ai/dsh-convax-plugin-creation-host'
  const renderer = '@deepseek-ai/dsh-convax-plugin-renderer'
  const plugins = ['host', 'renderer', 'inernal-nodes-host', 'inernal-nodes-renderer', 'creation-host', 'creation-renderer']
  write(workspace, 'package.json', JSON.stringify({ name: 'convax-pack-fixture', private: true }))
  write(workspace, 'pnpm-workspace.yaml', 'packages:\n  - libs/dsh/packages/*/*\n  - packages/*\n')
  for (const plugin of plugins) {
    write(workspace, `packages/plugin-${plugin}/package.json`, JSON.stringify({
      name: `@deepseek-ai/dsh-convax-plugin-${plugin}`, version: '1.2.3',
      ...(plugin === 'renderer' ? { dependencies: { [host]: 'workspace:*' } } : {}),
    }))
  }
  write(workspace, 'packages/unlisted/package.json', JSON.stringify({ name: '@fixture/unlisted', version: '1.2.3' }))
  writeFixture(root, 'local', ['../../packages/plugin-*'])

  const result = await pack(root, false, [], 'convax')
  expect(result.code, result.output).toBe(0)
  const packed = join(root, 'packed')
  const pluginTarballs = plugins.map(plugin => `deepseek-ai-dsh-convax-plugin-${plugin}-1.2.3.tgz`)
  expect(readdirSync(packed).sort()).toEqual([...pluginTarballs, 'deepseek-ai-dsh-probe-1.2.3.tgz'].sort())
  const manifest = packedManifest(join(packed, 'deepseek-ai-dsh-convax-plugin-renderer-1.2.3.tgz'))
  expect(manifest).toMatchObject({ name: renderer, dependencies: { [host]: '1.2.3' } })
}, testTimeout)

it.each(['official', 'stale', 'missing'] as const)('rejects %s client artifacts before replacing local packages', async (kind) => {
  const root = fixture(kind === 'official' ? 'official' : 'local')
  if (kind === 'stale') write(root, 'packages/client/probe/lib/client.js', 'export const changed = true\n')
  if (kind === 'missing') unlinkSync(join(root, '.dsh-build/client-build-environment.json'))
  write(root, 'packed/retained.txt', 'previous output\n')
  const result = await pack(root)
  expect(result.code).not.toBe(0)
  expect(result.output).toMatch(kind === 'official' ? /DSH_CLIENT_BUILD_PROFILE/ : kind === 'stale' ? /artifacts differ/ : /client build record/)
  expect(readFileSync(join(root, 'packed/retained.txt'), 'utf8')).toBe('previous output\n')
}, testTimeout)

it('rejects local client artifacts in the release packing command', async () => {
  const root = fixture()
  const result = await pack(root, true)
  expect(result.code).not.toBe(0)
  expect(result.output).toMatch(/DSH_CLIENT_BUILD_PROFILE/)
  expect(existsSync(join(root, 'packed'))).toBe(false)
}, testTimeout)

it('validates local tarball contents before reporting success', async () => {
  const root = fixture()
  write(root, 'packages/client/probe/src/index.ts', 'export const source = true\n')
  const result = await pack(root)
  expect(result.code).not.toBe(0)
  expect(result.output).toContain('publishes source file package/src/index.ts')
}, testTimeout)

it('rejects an invalid local pack concurrency before replacing packages', async () => {
  const root = fixture()
  const result = await pack(root, false, ['--concurrency', '0'])
  expect(result.code).not.toBe(0)
  expect(result.output).toContain('--concurrency must be a positive integer')
  expect(existsSync(join(root, 'packed'))).toBe(false)
}, testTimeout)
