/** Execute release guards and publication against GitHub's tag and release contracts without network access. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
  corruptChecksum?: boolean
  moveTagAfterUpload?: boolean
}

const repository = 'microvoid/convax'
const commit = 'a'.repeat(40)
const tagObject = 'b'.repeat(40)
const mainCommit = 'c'.repeat(40)
const tag = 'v0.1.0'
const filename = 'convax-0.1.0-mac-arm64.dmg'
const installer = 'Signed installer fixture\n'
const installerDigest = createHash('sha256').update(installer).digest('hex')
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
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs')
const { createHash } = require('node:crypto')
const args = process.argv.slice(2)
appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(args) + '\\n')
const [command, path, ...flags] = args
const repo = 'repos/' + process.env.GITHUB_REPOSITORY
const tag = process.env.RELEASE_TAG
const statePath = process.env.FIXTURE_RELEASE
const release = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null
if (command === 'release') {
  const operation = path
  if (flags[0] !== tag) throw new Error('Unexpected release tag')
  if (operation === 'view') {
    if (!release) { console.error('release not found'); process.exit(1) }
    console.log(JSON.stringify(release))
  } else if (operation === 'create') {
    const target = flags[flags.indexOf('--target') + 1]
    // GitHub requires Workflows:write for an older target with different workflows, even when its tag exists.
    if (target !== 'main') {
      console.error('HTTP 403: Resource not accessible by integration')
      process.exit(1)
    }
    if (!flags.includes('--verify-tag') || !flags.includes('--draft')) throw new Error('Unverified release creation')
    writeFileSync(statePath, JSON.stringify({
      isDraft: true, body: flags[flags.indexOf('--notes') + 1], assets: [], target,
    }))
  } else if (operation === 'upload') {
    if (!release?.isDraft) throw new Error('Uploads require a draft')
    const name = flags[1]
    const digest = 'sha256:' + createHash('sha256').update(readFileSync(name)).digest('hex')
    release.assets.push({ name, state: 'uploaded', digest })
    writeFileSync(statePath, JSON.stringify(release))
  } else if (operation === 'edit') {
    if (!release?.isDraft || !flags.includes('--verify-tag') || !flags.includes('--draft=false')) {
      throw new Error('Unexpected release edit')
    }
    release.isDraft = false
    writeFileSync(statePath, JSON.stringify(release))
  } else throw new Error('Unexpected release operation: ' + operation)
  process.exit(0)
}
const resolvedCommit = process.env.FIXTURE_MOVE_AFTER_UPLOAD === '1' && release?.assets.length === 2
  ? '${'d'.repeat(40)}' : process.env.FIXTURE_COMMIT
const requests = [
  [repo + '/commits/refs%2Ftags%2F' + tag, ['--jq', '.sha'], resolvedCommit],
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
const value = JSON.parse(input)
if (JSON.stringify(flags) === JSON.stringify(['--exit-status', '--raw-output', '.version'])) {
  if (typeof value.version !== 'string') process.exit(4)
  console.log(value.version)
} else if (JSON.stringify(flags) === JSON.stringify(['-r', '.assets[] | select(.state == "uploaded") | .name + " " + .digest'])) {
  for (const asset of value.assets.filter(asset => asset.state === 'uploaded')) console.log(asset.name + ' ' + asset.digest)
} else if (JSON.stringify(flags) === JSON.stringify(['-e', '.isDraft == false'])) {
  process.exit(value.isDraft === false ? 0 : 1)
} else if (flags[0] === '-e' && flags[1] === '--arg' && flags[2] === 'marker'
  && flags[4] === '.body | startswith($marker)') {
  process.exit(value.body.startsWith(flags[3]) ? 0 : 1)
} else if (flags[0] === '-e' && flags[1] === '--arg' && flags[2] === 'asset'
  && flags[4] === 'any(.assets[]; .name == $asset and .state == "starter")') {
  process.exit(value.assets.some(asset => asset.name === flags[3] && asset.state === 'starter') ? 0 : 1)
} else throw new Error('Unexpected jq arguments: ' + JSON.stringify(flags))
`
// The publishing job uses GNU sha256sum; macOS tests calculate the same output through Node.
const sha256Stub = `#!${process.execPath}
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
for (const name of process.argv.slice(2)) {
  console.log(createHash('sha256').update(readFileSync(name)).digest('hex') + '  ' + name)
}
`

async function execute(script: string, options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'convax-release-guard-'))
  try {
    const outputPath = join(directory, 'output')
    const callsPath = join(directory, 'calls')
    const releasePath = join(directory, 'release.json')
    const scriptPath = join(directory, 'guard.sh')
    await writeFile(scriptPath, script)
    await writeFile(join(directory, filename), installer)
    await writeFile(join(directory, `${filename}.sha256`), `${options.corruptChecksum ? '0'.repeat(64) : installerDigest}  ${filename}\n`)
    for (const [name, stub] of [['gh', ghStub], ['jq', jqStub], ['sha256sum', sha256Stub]] as const) {
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
        RELEASE_VERSION: '0.1.0',
        FIXTURE_CALLS: callsPath,
        FIXTURE_RELEASE: releasePath,
        FIXTURE_MOVE_AFTER_UPLOAD: options.moveTagAfterUpload ? '1' : '0',
        FIXTURE_COMMIT: options.commit ?? commit,
        FIXTURE_VERSION: options.version ?? '0.1.0',
        FIXTURE_ANCESTRY: options.ancestry ?? 'ahead',
      },
    })
    expect(result.error, 'The shell fixture must complete without a process error or timeout').toBeUndefined()
    expect(result.signal, 'A signal must not masquerade as a guard rejection').toBeNull()
    const release: unknown = existsSync(releasePath) ? JSON.parse(readFileSync(releasePath, 'utf8')) : null
    return {
      status: result.status,
      stderr: result.stderr,
      output: existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '',
      calls: existsSync(callsPath) ? readFileSync(callsPath, 'utf8') : '',
      release,
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

  it('publishes the verified installer and checksum using the existing signed tag and main release target', async () => {
    const result = await execute(publish)
    expect(result.status, result.stderr).toBe(0)
    expect(result.release).toEqual({
      isDraft: false,
      body: '<!-- convax-tag-release -->',
      target: 'main',
      assets: [
        { name: filename, state: 'uploaded', digest: `sha256:${installerDigest}` },
        { name: `${filename}.sha256`, state: 'uploaded', digest: `sha256:${createHash('sha256').update(`${installerDigest}  ${filename}\n`).digest('hex')}` },
      ],
    })
    expect(result.calls.split('\n').filter(line => line.includes('/commits/refs%2Ftags%2F'))).toHaveLength(2)
  })

  it('reproduces the workflow permission failure when release creation targets the older signed commit', async () => {
    const result = await execute(publish.replace('--target main', '--target "$RELEASE_COMMIT"'))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('HTTP 403: Resource not accessible by integration')
    expect(result.release).toBeNull()
  })

  it('rejects a corrupted installer checksum before accessing GitHub Releases', async () => {
    const result = await execute(publish, { corruptChecksum: true })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('The downloaded installer does not match its SHA-256 file.')
    expect(result.calls).toBe('')
    expect(result.release).toBeNull()
  })

  it('keeps uploaded assets in a draft if the signed tag moves before publication', async () => {
    const result = await execute(publish, { moveTagAfterUpload: true })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Release tag no longer points to the signed commit.')
    expect(result.release).toMatchObject({ isDraft: true, assets: [{ name: filename }, { name: `${filename}.sha256` }] })
    expect(result.calls).not.toContain('["release","edit"')
  })
})
