/** Repository layout and command wiring for the single pnpm/Turbo workspace. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

test('one workspace discovers the documentation app, Convax packages and retained DSH packages', () => {
  const patterns = workspacePatterns()
  assert.deepEqual(patterns, manifest.workspaces)
  const manifests = globSync(patterns.map(pattern => `${pattern}/package.json`), { cwd: root }).sort()
  assert.ok(manifests.includes('apps/docs/package.json'))
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

test('dependency installation has one root lockfile and no nested workspace', () => {
  const lockfiles = globSync([
    'pnpm-lock.yaml', 'apps/*/pnpm-lock.yaml', 'libs/*/pnpm-lock.yaml', 'packages/*/pnpm-lock.yaml',
  ], { cwd: root })
  assert.deepEqual(lockfiles, ['pnpm-lock.yaml'])
  assert.ok(!existsSync(join(root, 'libs/dsh/pnpm-workspace.yaml')))
  assert.ok(!existsSync(join(root, 'apps/docs/pnpm-workspace.yaml')))
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
  const docs = readJson('apps/docs/package.json')
  const commands = {
    build: ['dsh:build', '@convax/docs#build', '@convax/docs#typecheck'],
    'build:artifacts': ['dsh:build:artifacts', '@convax/docs#build'],
    'build:check': ['dsh:build:check', '@convax/docs#typecheck'],
    typecheck: ['dsh:typecheck', '@convax/docs#typecheck'],
    lint: ['dsh:lint', '@convax/docs#lint:docs'],
    test: ['convax:test'],
    'dev:docs': ['@convax/docs#dev'],
    'build:docs': ['@convax/docs#build'],
    'check:docs': ['@convax/docs#check'],
    'preview:docs': ['@convax/docs#preview'],
  }
  for (const [script, expected] of Object.entries(commands)) {
    const tasks = manifest.scripts[script].match(/^turbo run (.+)$/)?.[1]?.split(' ')
    assert.deepEqual(tasks, expected, `${script} preserves its validation owners`)
    for (const task of tasks) {
      if (task.startsWith('@convax/docs#')) {
        assert.ok(turbo.tasks[task], `${script} has a registered documentation task`)
        assert.equal(typeof docs.scripts[task.split('#')[1]], 'string')
      } else {
        assert.ok(turbo.tasks[`//#${task}`], `${script} has a registered root task`)
        assert.match(manifest.scripts[task], /scripts\/dsh\.mjs/)
      }
    }
  }
  assert.equal(docs.name, '@convax/docs')
  assert.equal(docs.private, true)
  assert.deepEqual(turbo.tasks['@convax/docs#build'].outputs, ['dist/**'])
  assert.deepEqual(turbo.tasks['@convax/docs#build'].inputs, [
    '$TURBO_DEFAULT$', '$TURBO_ROOT$/docs/assets/convax-demos/**',
  ])
  for (const task of ['typecheck', 'lint:docs', 'check']) {
    assert.deepEqual(turbo.tasks[`@convax/docs#${task}`].dependsOn, ['@convax/docs#build'])
  }
  assert.deepEqual(turbo.tasks['@convax/docs#preview'].dependsOn, ['@convax/docs#build'])
  for (const task of ['dev', 'preview']) {
    assert.equal(turbo.tasks[`@convax/docs#${task}`].cache, false)
    assert.equal(turbo.tasks[`@convax/docs#${task}`].persistent, true)
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

test('staged translation hooks retain a linked worktree and its relative alternate index', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'convax-translation-hook-'))
  const checkout = join(fixture, 'checkout')
  const linked = join(fixture, 'linked')
  const hooks = join(fixture, 'hooks')
  const environment = { ...process.env }
  for (const name of Object.keys(environment)) if (name.startsWith('GIT_')) delete environment[name]
  environment.GIT_CONFIG_NOSYSTEM = '1'
  const run = (command, args, cwd, env = environment) => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' })
    assert.equal(result.error, undefined)
    assert.equal(result.signal, null, `${command} was interrupted`)
    return result
  }
  const git = (args, cwd = checkout, env = environment) => {
    const result = run('git', ['-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgsign=false', ...args], cwd, env)
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
    return result
  }
  const sourcePath = 'libs/dsh/docs/guide.md'
  const source = '# Guide\n\nEnglish | [中文](guide.zh.md)\n\nStaged source.\n'
  try {
    mkdirSync(join(checkout, 'scripts'), { recursive: true })
    mkdirSync(join(checkout, 'libs/dsh/scripts'), { recursive: true })
    mkdirSync(join(checkout, 'libs/dsh/docs'), { recursive: true })
    mkdirSync(hooks)
    git(['init', '--quiet'])
    copyFileSync(join(root, 'scripts/check-staged-translations.mjs'), join(checkout, 'scripts/check-staged-translations.mjs'))
    for (const name of ['verify-translation-pairing', 'translation-pairing', 'translation-pairing-git',
      'translation-pairing-record', 'translation-links', 'translation-repository-context', 'markdown']) {
      copyFileSync(join(root, `libs/dsh/scripts/${name}.ts`), join(checkout, `libs/dsh/scripts/${name}.ts`))
    }
    writeFileSync(join(checkout, 'libs/dsh/scripts/translation-pairing.manifest.json'), '{"excluded":[]}\n')
    writeFileSync(join(checkout, sourcePath), source)
    writeFileSync(join(checkout, 'libs/dsh/docs/guide.zh.md'), '# 指南\n\n[English](guide.md) | 中文\n\n暂存正文。\n')
    const dependencyLink = directory => symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir')
    dependencyLink(checkout)
    const record = run(process.execPath, ['--import', 'tsx/esm', 'libs/dsh/scripts/verify-translation-pairing.ts',
      '--write', 'docs/guide.md'], checkout)
    assert.equal(record.status, 0, `${record.stdout}${record.stderr}`)
    git(['add', 'scripts', 'libs'])
    git(['-c', 'user.name=Translation Fixture', '-c', 'user.email=translation@example.test',
      'commit', '--quiet', '-m', 'translation fixture'])
    git(['worktree', 'add', '--quiet', '--detach', linked, 'HEAD'])
    dependencyLink(linked)
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexec node scripts/check-staged-translations.mjs libs/dsh/docs/guide.i18n.yaml\n')
    chmodSync(join(hooks, 'pre-commit'), 0o755)

    // A valid staged pair must survive both Git's worktree hook environment and unrelated unstaged text.
    writeFileSync(join(linked, sourcePath), `${source}\nUnstaged prose.\n`)
    const staged = git(['hook', 'run', 'pre-commit'], linked)
    assert.match(`${staged.stdout}${staged.stderr}`, /1 named staged pair\(s\) consistent/)
    writeFileSync(join(linked, sourcePath), source)
    const alternate = { ...environment, GIT_INDEX_FILE: 'translation-index' }
    git(['read-tree', 'HEAD'], linked, alternate)
    writeFileSync(join(linked, sourcePath), `${source}\nStaged unmatched prose.\n`)
    git(['add', sourcePath], linked)
    writeFileSync(join(linked, sourcePath), source)

    // The default index rejects the drift even though the working copy is now restored.
    const rejected = run('git', ['-c', `core.hooksPath=${hooks}`, 'hook', 'run', 'pre-commit'], linked)
    assert.equal(rejected.status, 1, `${rejected.stdout}${rejected.stderr}`)
    assert.match(`${rejected.stdout}${rejected.stderr}`, /out of sync/)
    const selected = git(['hook', 'run', 'pre-commit'], linked, alternate)
    assert.match(`${selected.stdout}${selected.stderr}`, /1 named staged pair\(s\) consistent/)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
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
