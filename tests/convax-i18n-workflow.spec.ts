/** Locale coverage and keyless browser regression checks run in the public Convax CI. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface Step {
  run?: string
  if?: string | boolean
  'continue-on-error'?: string | boolean
}
interface Workflow {
  env: Record<string, string>
  jobs: { linux: { steps: Step[] } }
}

describe('Convax internationalization CI', () => {
  it('runs locale coverage, gate tests and browser regression without opt-in or ignored failures', () => {
    const ci = load(readFileSync(resolve(import.meta.dirname, '../.github/workflows/convax-ci.yml'), 'utf8')) as Workflow
    const steps = ci.jobs.linux.steps
    const build = steps.findIndex(step => step.run === 'pnpm run build')
    const browser = steps.findIndex(step => step.run?.includes('playwright install --with-deps chromium'))
    expect(build).toBeGreaterThanOrEqual(0)
    expect(browser).toBeGreaterThan(build)
    expect(ci.env.DSH_SNAPSHOT).toBe('replay')
    for (const command of ['pnpm run check:i18n', 'pnpm exec tsc --project scripts/tsconfig.i18n.json',
      'pnpm exec vitest run --config scripts/vitest.i18n.config.ts', 'pnpm run test:i18n:e2e']) {
      const index = steps.findIndex(step => step.run?.split('\n').includes(command))
      expect(index, command).toBeGreaterThan(build)
      const step = steps[index]!
      expect(step.if).toBeUndefined()
      expect([undefined, false]).toContain(step['continue-on-error'])
      if (command === 'pnpm run test:i18n:e2e') expect(index).toBeGreaterThan(browser)
    }
  })
})
