/** Execute release guards against the GitHub REST tag-reference contract without network access. */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface Workflow {
  jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>
}
interface FixtureOptions {
  tag?: string
  pushedSha?: string
  commit?: string
  version?: string
  ancestry?: string
}

const repository = 'microvoid/convax'
const commit = 'a'.repeat(40)
const tagObject = 'b'.repeat(40)
const mainCommit = 'c'.repeat(40)
const tag = 'v0.1.0'
const workflow = load(readFileSync(resolve(import.meta.dirname, '../.github/workflows/convax-desktop-package.yml'), 'utf8')) as Workflow

function command(job: string, step: string): string {
  const script = workflow.jobs[job]?.steps.find(item => item.name === step)?.run
  if (script === undefined) throw new Error(`Missing release guard: ${job}/${step}`)
  return script
}

const source = command('resolve-signed-source', 'Verify tag and Convax version')
const publish = command('publish-release', 'Publish DMG and SHA-256 to GitHub Releases')
const verifyTag = publish.match(/^verify_tag\(\) \{[\s\S]*?^\}/mu)?.[0]
if (verifyTag === undefined) throw new Error('The publisher must verify the signed tag before publishing')
const publicationGuard = `${verifyTag}\nverify_tag\n`

// These executable stubs admit exact REST requests; an abbreviated tags/v* commit ref reproduces GitHub's 422.
const ghStub = `#!${process.execPath}
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(args) + '\\n')
const [command, path, ...flags] = args
const repo = 'repos/' + process.env.GITHUB_REPOSITORY
const tag = process.env.RELEASE_TAG
const requests = [
  [repo + '/commits/refs%2Ftags%2F' + tag, ['--jq', '.sha'], process.env.FIXTURE_COMMIT],
  [repo + '/git/ref/tags/' + tag, ['--jq', '.object.sha'], '${tagObject}'],
  [repo + '/compare/' + process.env.FIXTURE_COMMIT + '...' + process.env.GITHUB_SHA + '?per_page=1',
    ['--jq', '.status'], process.env.FIXTURE_ANCESTRY],
  [repo + '/contents/package.json?ref=' + process.env.FIXTURE_COMMIT,
    ['--header', 'Accept: application/vnd.github.raw+json'], JSON.stringify({ version: process.env.FIXTURE_VERSION })],
]
const match = requests.find(([expected, options]) => path === expected && JSON.stringify(flags) === JSON.stringify(options))
if (command !== 'api' || !match) {
  console.error(path === repo + '/commits/tags%2F' + tag
    ? 'HTTP 422: No commit found for SHA tags/' + tag
    : 'REST fixture rejected arguments: ' + JSON.stringify(args))
  process.exit(1)
}
console.log(match[2])
`
const jqStub = `#!${process.execPath}
const input = require('node:fs').readFileSync(0, 'utf8')
const flags = process.argv.slice(2)
if (JSON.stringify(flags) !== JSON.stringify(['--exit-status', '--raw-output', '.version'])) process.exit(2)
const version = JSON.parse(input).version
if (typeof version !== 'string') process.exit(4)
console.log(version)
`

async function execute(script: string, options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'convax-release-guard-'))
  try {
    const outputPath = join(directory, 'output')
    const callsPath = join(directory, 'calls')
    const scriptPath = join(directory, 'guard.sh')
    await writeFile(scriptPath, script)
    for (const [name, stub] of [['gh', ghStub], ['jq', jqStub]] as const) {
      const path = join(directory, name)
      await writeFile(path, stub)
      await chmod(path, 0o700)
    }
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', scriptPath], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        PATH: `${directory}${delimiter}${process.env.PATH ?? ''}`,
        GITHUB_REPOSITORY: repository,
        GH_REPO: repository,
        RELEASE_TAG: options.tag ?? tag,
        PUSHED_SHA: options.pushedSha ?? commit,
        GITHUB_SHA: mainCommit,
        GITHUB_OUTPUT: outputPath,
        RELEASE_COMMIT: commit,
        FIXTURE_CALLS: callsPath,
        FIXTURE_COMMIT: options.commit ?? commit,
        FIXTURE_VERSION: options.version ?? '0.1.0',
        FIXTURE_ANCESTRY: options.ancestry ?? 'ahead',
      },
    })
    expect(result.error, 'The shell fixture must complete without a process error or timeout').toBeUndefined()
    expect(result.signal, 'A signal must not masquerade as a guard rejection').toBeNull()
    return {
      status: result.status,
      stderr: result.stderr,
      output: existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '',
      calls: existsSync(callsPath) ? readFileSync(callsPath, 'utf8') : '',
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

// These are Bash guards deployed on Ubuntu/macOS; Windows does not provide the POSIX executable fixture semantics.
describe.skipIf(process.platform === 'win32')('Convax signed release guards', () => {
  it('resolves a fully qualified version tag and emits the immutable build source and package version', async () => {
    const result = await execute(source)
    expect(result.status, result.stderr).toBe(0)
    expect(result.output).toBe(`commit=${commit}\nversion=0.1.0\n`)
    expect(result.calls).toContain(`/commits/refs%2Ftags%2F${tag}`)
  })

  it('accepts the original annotated tag object while building its resolved commit', async () => {
    const result = await execute(source, { pushedSha: tagObject })
    expect(result.status, result.stderr).toBe(0)
    expect(result.output).toBe(`commit=${commit}\nversion=0.1.0\n`)
  })

  it('preserves manual signed builds from main without resolving a release tag', async () => {
    const result = await execute(source, { tag: '', pushedSha: '' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.output).toBe(`commit=${mainCommit}\n`)
    expect(result.calls).toBe('')
  })

  it('rejects a tag that moved after its push before emitting a build source', async () => {
    const result = await execute(source, { commit: 'd'.repeat(40) })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Release tag moved after the push.')
    expect(result.output).toBe('')
  })

  it('rejects a version tag that differs from the tagged workspace version', async () => {
    const result = await execute(source, { version: '0.2.0' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Release tag must match the Convax workspace version.')
    expect(result.output).toBe('')
  })

  it('rejects a tagged commit outside main history', async () => {
    const result = await execute(source, { ancestry: 'diverged' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Release tag must point to a commit on main.')
    expect(result.output).toBe('')
  })

  it('reproduces the REST rejection for the old abbreviated tag reference', async () => {
    const result = await execute(source.replaceAll('/commits/refs%2Ftags%2F', '/commits/tags%2F'))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('HTTP 422: No commit found for SHA tags/v0.1.0')
    expect(result.output).toBe('')
  })

  it('revalidates the fully qualified tag before publishing the signed installer', async () => {
    const result = await execute(publicationGuard)
    expect(result.status, result.stderr).toBe(0)
    expect(result.calls).toContain(`/commits/refs%2Ftags%2F${tag}`)
  })

  it('refuses publication when the release tag no longer points to the signed commit', async () => {
    const result = await execute(publicationGuard, { commit: 'd'.repeat(40) })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Release tag no longer points to the signed commit.')
  })
})
