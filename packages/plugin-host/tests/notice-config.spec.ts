/** Unconfigured notice delivery must not make the existing Convax profile require a cloud API. */
import { describe, expect, it } from 'vitest'
import schema from '@deepseek-ai/schemastery'
import { Config } from '../src/index.ts'

function parse(input: unknown): Config { return schema.resolve(input, Config, {})[0] as Config }

describe('Convax notice deployment configuration', () => {
  it('keeps the shipped profile valid without a notice source', () => {
    expect(parse({ databasePath: '/tmp/convax-config-only.sqlite' }).notices).toBeUndefined()
  })

  it('requires explicit product and endpoint identity before enabling delivery', () => {
    expect(() => parse({ databasePath: '/tmp/convax-config-only.sqlite', notices: {} })).toThrow()
    expect(parse({ databasePath: '/tmp/convax-config-only.sqlite', notices: {
      origin: 'https://api.example.test', appVersion: '0.1.0', platform: 'darwin', arch: 'arm64',
    } }).notices).toMatchObject({ channel: 'latest', idleMs: 3000, leaseMs: 30000, maxModalPerLaunch: 1 })
  })
})
