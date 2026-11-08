import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import { unstable_dev } from 'wrangler'

const root = fileURLToPath(new URL('../', import.meta.url))
let worker

before(async () => {
  worker = await unstable_dev(`${root}src/api.ts`, {
    config: `${root}wrangler.jsonc`,
    port: 0,
    inspectorPort: 0,
    envFiles: [],
    local: true,
    persist: false,
    logLevel: 'error',
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
  })
  assert.ok(worker.port > 0)
}, { timeout: 60_000 })

after(async () => {
  if (worker === undefined) return
  const exited = worker.waitUntilExit()
  await worker.stop()
  await exited
})

test('the Worker bridge serves concurrent Nest health requests', { timeout: 60_000 }, async () => {
  const responses = await Promise.all(Array.from({ length: 8 }, () => worker.fetch('/health')))
  for (const response of responses) {
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), { status: 'ok', service: 'convax-api' })
  }
})

test('unknown routes preserve the API error contract through the Worker bridge', { timeout: 60_000 }, async () => {
  const response = await worker.fetch('/missing')
  assert.equal(response.status, 404)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const payload = await response.json()
  assert.equal(payload.error.code, 'not_found')
  assert.equal(typeof payload.error.message, 'string')
})

test('the production API base preserves health, client metadata and validation', { timeout: 60_000 }, async () => {
  const health = await worker.fetch('/convax/api/health')
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), { status: 'ok', service: 'convax-api' })

  const query = new URLSearchParams({ appVersion: '0.1.0', platform: 'darwin', arch: 'arm64', channel: 'latest', locale: 'zh-CN' })
  const init = { headers: { 'X-Installation-Id': 'dd315fe8-8e99-4aeb-bbc6-26f06998136a' } }
  const policy = await worker.fetch(`/convax/api/v1/client/policy?${query}`, init)
  assert.equal(policy.status, 200)
  assert.equal(policy.headers.get('cache-control'), 'no-store')
  const policyBody = await policy.json()
  assert.deepEqual(policyBody.update, { required: false })
  assert.deepEqual(policyBody.maintenance, [])

  const guidance = await worker.fetch(`/convax/api/v1/client/guidance?${query}`, init)
  assert.equal(guidance.status, 200)
  assert.deepEqual((await guidance.json()).items, [])

  const invalid = await worker.fetch(`/convax/api/v1/client/policy?${query}`)
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).error.code, 'bad_request')

  const unknown = await worker.fetch('/convax/api/missing')
  assert.equal(unknown.status, 404)
  assert.equal((await unknown.json()).error.code, 'not_found')
})
