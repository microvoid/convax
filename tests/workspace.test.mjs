/** Repository layout and command wiring for the single pnpm/Turbo workspace. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, globSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { resolveDesktopLaunch } from '../packages/plugin-renderer/scripts/desktop.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const readJson = path => JSON.parse(readFileSync(join(root, path), 'utf8'))
const manifest = readJson('package.json')

function workspacePatterns() {
  const source = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
  const list = source.match(/^packages:\s*\n((?:[ \t]+[^\n]*\n|\n)*)/m)?.[1]
  assert.ok(list, 'pnpm-workspace.yaml declares its package list')
  return [...list.matchAll(/^\s+-\s+([^\n#]+)\s*$/gm)].map(match => match[1].trim())
}

test('one workspace discovers the flattened Convax packages and retained DSH packages', () => {
  const patterns = workspacePatterns()
  assert.deepEqual(patterns, manifest.workspaces)
  const manifests = globSync(patterns.map(pattern => `${pattern}/package.json`), { cwd: root }).sort()
  assert.ok(manifests.includes('packages/plugin-host/package.json'))
  assert.ok(manifests.includes('packages/plugin-renderer/package.json'))
  assert.ok(manifests.includes('libs/dsh/apps/cli/package.json'))
  assert.ok(manifests.includes('libs/dsh/vendor/cordis/package.json'))
  assert.ok(!manifests.includes('libs/dsh/package.json'))
  const names = manifests.map(path => readJson(path).name)
  assert.equal(new Set(names).size, names.length, 'workspace package names are unique')
  assert.equal(readJson('packages/plugin-host/package.json').name, '@deepseek-ai/dsh-convax-plugin-host')
  assert.equal(readJson('packages/plugin-renderer/package.json').name, '@deepseek-ai/dsh-convax-plugin-renderer')
})

test('dependency installation has one root lockfile and no nested DSH workspace', () => {
  assert.deepEqual(globSync(['pnpm-lock.yaml', 'libs/*/pnpm-lock.yaml', 'packages/*/pnpm-lock.yaml'], { cwd: root }), ['pnpm-lock.yaml'])
  assert.ok(!existsSync(join(root, 'libs/dsh/pnpm-workspace.yaml')))
  assert.match(manifest.packageManager, /^pnpm@/)
  const solution = readJson('tsconfig.json')
  assert.deepEqual(solution.files, [])
  assert.equal(solution.include, undefined)
  assert.deepEqual(solution.references, [
    { path: './libs/dsh/tsconfig.host.json' },
    { path: './libs/dsh/tsconfig.client.json' },
  ])
})

test('the default Convax composition mounts independently switchable node providers and displays', () => {
  const packages = ['plugin-inernal-nodes-host', 'plugin-inernal-nodes-renderer']
  for (const directory of packages) {
    const nodePackage = readJson(`packages/${directory}/package.json`)
    assert.equal(nodePackage.name, `@deepseek-ai/dsh-convax-${directory}`)
    assert.equal(manifest.devDependencies[nodePackage.name], 'workspace:*')
  }
  const schema = yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar' })])
  const patch = yaml.load(readFileSync(join(root, 'packages/plugin-renderer/cordis.patch.yml'), 'utf8'), { schema })
  const rows = patch.flatMap(operation => operation.insert ?? [])
  for (const id of ['convax-host', 'convax-renderer', 'convax-inernal-nodes-host', 'convax-inernal-nodes-renderer']) {
    assert.equal(rows.filter(row => row.id === id).length, 1, `${id} has one independently switchable row`)
  }
  const providers = readJson('packages/plugin-inernal-nodes-host/package.json')
  const displays = readJson('packages/plugin-inernal-nodes-renderer/package.json')
  assert.equal(providers.dsh?.client, undefined, 'Host lifetime does not implicitly activate displays')
  assert.equal(displays.dsh.client.platform, 'web')
  assert.equal(displays.dsh.bundle, undefined, 'Installing node displays does not activate the canvas product bundle')
})

test('Turbo root tasks delegate to registered DSH and Convax commands', () => {
  const turbo = readJson('turbo.json')
  for (const script of ['build', 'build:artifacts', 'build:check', 'typecheck', 'lint', 'test']) {
    const command = manifest.scripts[script]
    const task = command.match(/^turbo run (\S+)$/)?.[1]
    assert.ok(task, `${script} is orchestrated by Turbo`)
    assert.ok(turbo.tasks[`//#${task}`], `${script} has a registered root task`)
    assert.match(manifest.scripts[task], /scripts\/dsh\.mjs/)
  }
  assert.match(manifest.scripts['test:web:built'], /scripts\/dsh\.mjs test:web:built$/)
  assert.match(manifest.scripts.dsh, /libs\/dsh\/apps\/cli\/src\/bin\.ts$/)
})

test('Desktop launches the retained DSH app with outer Convax data paths', () => {
  const packageManager = resolve(root, 'node_modules/pnpm/bin/pnpm.cjs')
  for (const build of [false, true]) {
    const launch = resolveDesktopLaunch(root, { npm_execpath: packageManager }, build)
    assert.equal(launch.cwd, join(root, 'libs', 'dsh'))
    assert.deepEqual(launch.args, [packageManager, 'run', build ? 'dev:desktop' : 'start:desktop'])
    assert.equal(launch.env.DSH_HOME, join(root, '.convax'))
    assert.equal(launch.env.DSH_DESKTOP_USER_DATA_DIR, join(root, '.convax', 'electron-user-data'))
  }
})

test('root hooks retain the DSH commit and merge gates', () => {
  const retained = yaml.load(readFileSync(join(root, 'libs/dsh/lefthook.yml'), 'utf8'))
  const active = yaml.load(readFileSync(join(root, 'lefthook.yml'), 'utf8'))
  for (const hook of ['pre-commit', 'pre-merge-commit', 'pre-push']) {
    assert.deepEqual(active[hook].jobs.map(job => job.name), retained[hook].jobs.map(job => job.name))
  }
  const commit = active['pre-commit'].jobs
  assert.equal(commit.find(job => job.name === 'vendor manifest guard').run, 'bash libs/dsh/scripts/check-vendor-manifest.sh')
  assert.ok(commit.find(job => job.name === 'pi-ai provider metadata').glob.includes('libs/dsh/packages/llm/'))
  for (const hook of ['pre-commit', 'pre-merge-commit']) {
    assert.equal(active[hook].jobs.find(job => job.name === 'archived agent notes').glob, 'libs/dsh/.agents/notes/archived/**')
    assert.equal(active[hook].jobs.find(job => job.name === 'translation pairing (staged records)').run,
      'node scripts/check-staged-translations.mjs {staged_files}')
  }
})


test('full lint enforces typed source and test rules in the flattened packages', () => {
  assert.match(manifest.scripts['dsh:lint'], /--config \.oxlintrc\.json packages scripts tests$/)
  assert.deepEqual(readJson('.oxlintrc.json'), { extends: ['./libs/dsh/.oxlintrc.json'] })
  const name = `lint-workspace-${randomUUID()}`
  const files = [
    `packages/plugin-host/src/${name}.ts`,
    `packages/plugin-host/tests/${name}.spec.ts`,
    `packages/plugin-renderer/src/${name}.ts`,
    `packages/plugin-renderer/tests/${name}.client.spec.ts`,
    `tests/${name}.spec.ts`,
  ]
  const source = [
    'export function probePromise(): Promise<void> {',
    '  return Promise.resolve()',
    '}',
    '',
    'probePromise()',
    "export const maybe = Math.random() > 0.5 ? 'value' : undefined",
    'export const asserted = maybe!',
    'export const quoted = "value"',
    '',
  ].join('\n')
  try {
    for (const file of files) writeFileSync(join(root, file), source)
    const result = spawnSync(process.execPath, [
      '--import', 'tsx/esm', 'libs/dsh/scripts/run-oxlint.ts',
      '--config', '.oxlintrc.json', '--format', 'unix', ...files,
    ], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', OXC_LOG: 'debug', DSH_OXLINT_THREADS: '2' },
      maxBuffer: 4 * 1024 * 1024,
    })
    const output = `${result.stdout}${result.stderr}`.replaceAll('\\', '/')
    assert.equal(result.error, undefined)
    assert.equal(result.status, 1, output)
    for (const file of files) {
      assert.ok(output.includes(`${file}:5:1: Promises must be awaited`), output)
      assert.ok(output.includes(`${file}:8:23: Strings must use singlequote`), output)
    }
    assert.equal(output.match(/typescript\(no-floating-promises\)/g)?.length, files.length, output)
    assert.equal(output.match(/typescript\(no-non-null-assertion\)/g)?.length, 2, output)
    assert.ok(output.includes('Unmatched files: 0'), output)
    const projects = [
      'packages/plugin-host/tsconfig.json',
      'libs/dsh/tsconfig.host.json',
      'packages/plugin-renderer/tsconfig.json',
      'libs/dsh/tsconfig.client.json',
      'tests/tsconfig.json',
    ]
    for (let index = 0; index < files.length; index++) {
      const file = join(root, files[index]).replaceAll('\\', '/')
      const project = join(root, projects[index]).replaceAll('\\', '/')
      assert.ok(output.includes(`Got tsconfig for file ${file}: ${project}`), output)
    }
  } finally {
    for (const file of files) rmSync(join(root, file), { force: true })
  }
})


test('retained DSH website files keep the source lint profile', () => {
  const dshRoot = join(root, 'libs', 'dsh')
  const file = `website/tests/lint-workspace-${randomUUID()}.spec.ts`
  const source = [
    'function deferred<T>(value?: T): { value: T | undefined } {',
    '  return { value }',
    '}',
    '',
    'export const pending = deferred<void>()',
    '',
  ].join('\n')
  try {
    writeFileSync(join(dshRoot, file), source)
    const result = spawnSync(process.execPath, [
      '--import', 'tsx/esm', 'scripts/run-oxlint.ts', '--format', 'unix', file,
    ], {
      cwd: dshRoot, encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', OXC_LOG: 'debug', DSH_OXLINT_THREADS: '2' },
      maxBuffer: 4 * 1024 * 1024,
    })
    const output = `${result.stdout}${result.stderr}`.replaceAll('\\', '/')
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, output)
    const path = join(dshRoot, file).replaceAll('\\', '/')
    const project = join(dshRoot, 'tsconfig.host.json').replaceAll('\\', '/')
    assert.ok(output.includes(`Got tsconfig for file ${path}: ${project}`), output)
  } finally {
    rmSync(join(dshRoot, file), { force: true })
  }
})
