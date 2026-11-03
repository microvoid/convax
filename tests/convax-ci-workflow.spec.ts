/** Public Convax validation stays keyless while upstream integrations require opt-in. */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface Job {
  if?: string | boolean
  'runs-on'?: string
  steps?: { name?: string; run?: string; uses?: string }[]
}
interface Workflow {
  on: Record<string, unknown>
  permissions?: Record<string, string>
  env?: Record<string, string>
  jobs: Record<string, Job>
}
const directory = resolve(import.meta.dirname, '../.github/workflows')
const inheritedDirectory = resolve(import.meta.dirname, '../libs/dsh/.github/workflows')
const automatic = new Set(['push', 'pull_request', 'pull_request_target', 'pull_request_review', 'issues', 'issue_comment', 'workflow_run', 'schedule'])

function workflow(name: string, source = directory): Workflow {
  return load(readFileSync(resolve(source, name), 'utf8')) as Workflow
}
function enabled(job: Job, event: string, optIn = '', repository = 'microvoid/convax'): boolean {
  if (typeof job.if === 'boolean') return job.if
  if (job.if === undefined) return true
  const source = job.if.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, '')
  const result: unknown = runInNewContext(source, {
    github: { repository, event_name: event, ref: 'refs/heads/main' },
    vars: { CONVAX_ENABLE_UPSTREAM_AUTOMATION: optIn },
    cancelled: () => false, always: () => true,
  }, { timeout: 1000 })
  if (typeof result !== 'boolean') throw new TypeError('A workflow job condition must evaluate to a boolean')
  return result
}

describe('Convax repository workflows', () => {
  it('runs public keyless validation on main pushes and pull requests', () => {
    expect(existsSync(resolve(directory, 'convax-ci.yml'))).toBe(true)
    const ci = workflow('convax-ci.yml')
    expect(ci.on).toEqual({ push: { branches: ['main'] }, pull_request: null, workflow_dispatch: null })
    expect(ci.permissions).toEqual({ contents: 'read' })
    expect(ci.env).toMatchObject({ DSH_TELEMETRY_DISABLED: '1', DSH_SNAPSHOT: 'replay' })
    expect(ci.jobs.linux?.['runs-on']).toBe('ubuntu-24.04')
    expect(ci.jobs.windows?.['runs-on']).toBe('windows-2025')
    const commands = ci.jobs.linux?.steps?.map(step => step.run ?? '').join('\n') ?? ''
    expect(commands).toContain('pnpm run build')
    expect(commands).toContain('pnpm run lint')
    expect(commands).toContain('pnpm run test:workspace')
    expect(commands).toContain('packages/plugin-host/tests')
    expect(commands).toContain('packages/plugin-renderer/tests')
    expect(commands).toContain('convax-canvas-directories.e2e.ts')
    expect(commands).toContain('convax-window-mirror.e2e.ts')
    expect(commands).toContain('convax-activity.e2e.ts')
    expect(commands).toContain('convax-card-resize.e2e.ts')
    expect(commands).toContain('libs/dsh/scripts/prepare-ci-bubblewrap.sh')
    expect(commands).toContain('tests/workspace-resolution.client.spec.ts')
    expect(JSON.stringify(ci)).not.toMatch(/secrets\.|publish|wrangler|self-hosted|blacksmith/)
  })

  it('keeps every inherited automatic job off in Convax without repository opt-in', () => {
    expect(readdirSync(directory).filter(name => name.endsWith('.yml')).sort()).toEqual(['convax-ci.yml'])
    const inherited = readdirSync(inheritedDirectory).filter(name => name.endsWith('.yml') && name !== 'convax-ci.yml')
    for (const name of inherited) {
      const definition = workflow(name, inheritedDirectory)
      if (!Object.keys(definition.on).some(event => automatic.has(event))) continue
      for (const [id, job] of Object.entries(definition.jobs)) {
        for (const event of ['push', 'pull_request', 'schedule', 'issues', 'issue_comment', 'workflow_run']) {
          expect(enabled(job, event), `${name}:${id} must require opt-in for ${event}`).toBe(false)
        }
      }
    }
  })

  it('retains explicit real-API and deployment opt-in without weakening existing event checks', () => {
    const e2e = workflow('e2e.yml', inheritedDirectory).jobs.e2e!
    expect(enabled(e2e, 'push')).toBe(false)
    expect(enabled(e2e, 'push', 'true')).toBe(true)
    expect(enabled(e2e, 'workflow_dispatch')).toBe(true)
    expect(enabled(e2e, 'push', '', 'deepseek-harness/deepseek-harness')).toBe(true)
    const preview = workflow('build-preview-cloudflare.yml', inheritedDirectory).jobs.preview!
    expect(enabled(preview, 'pull_request')).toBe(false)
    expect(enabled(preview, 'pull_request', 'true')).toBe(true)
  })
})
