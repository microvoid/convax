/** Verify the deployed API against its public schemas and preserve website route ownership. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'

const requireContracts = createRequire(new URL('../packages/api-contracts/package.json', import.meta.url))
const Ajv2020 = requireContracts('ajv/dist/2020.js').default
const schemaDirectory = new URL('../packages/api-contracts/schemas/', import.meta.url)
const validator = new Ajv2020({ strict: true })
validator.addFormat('date-time', value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
  && Number.isFinite(Date.parse(value)))
for (const filename of await readdir(schemaDirectory)) {
  if (!filename.endsWith('.json')) continue
  validator.addSchema(JSON.parse(await readFile(new URL(filename, schemaDirectory), 'utf8')))
}

const base = new URL('https://microvoid.io/convax/api/')
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const metadata = new URLSearchParams({ appVersion: version, platform: 'darwin', arch: 'arm64', channel: 'latest', locale: 'zh-CN' })
const headers = { Accept: 'application/json', 'X-Installation-Id': randomUUID() }

async function jsonEndpoint(path, schema, status = 200, init = {}) {
  const response = await fetch(new URL(path, base), {
    headers, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000), ...init,
  })
  assert.equal(response.status, status, `${path} returned HTTP ${response.status}`)
  assert.equal(response.headers.get('cache-control'), 'no-store', `${path} must not cache metadata`)
  const payload = await response.json()
  const validate = validator.getSchema(`https://schemas.microvoid.io/convax/${schema}.json`)
  assert.ok(validate, `Missing response schema ${schema}`)
  assert.ok(validate(payload), `${path} does not match ${schema}: ${validator.errorsText(validate.errors)}`)
  return payload
}

async function smoke() {
  await jsonEndpoint('health', 'health-response')
  await Promise.all([
    jsonEndpoint(`v1/client/policy?${metadata}`, 'client-policy-response'),
    jsonEndpoint(`v1/client/guidance?${metadata}`, 'client-guidance-response'),
  ])
  const rejected = await jsonEndpoint('v1/client/policy', 'error-response', 400, { headers: { Accept: 'application/json' } })
  assert.equal(rejected.error.code, 'bad_request')

  const release = await fetch(new URL('release?source=api-deploy-smoke', base), {
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  })
  const releaseBody = await release.json()
  // Public GitHub availability may vary; both outcomes must still belong to the homepage endpoint.
  assert.ok(release.status === 200 ? ['ready', 'pending'].includes(releaseBody.status)
    : release.status === 503 && releaseBody.status === 'unavailable', 'The homepage release route was shadowed')
  assert.match(releaseBody.releaseUrl, /^https:\/\/github\.com\/microvoid\/convax\/releases(?:\/tag\/[^/?#]+)?$/u)

  const homepage = await fetch(new URL('/convax/', base), { redirect: 'error', signal: AbortSignal.timeout(15_000) })
  assert.equal(homepage.status, 200, 'The Convax homepage must remain available')
  assert.match(homepage.headers.get('content-type') ?? '', /^text\/html/u)
  await homepage.body?.cancel()
}

for (let attempt = 1; ; attempt++) {
  try {
    await smoke()
    console.log(`Verified ${base.href}: health, policy, guidance, invalid requests, release and homepage`)
    break
  } catch (error) {
    if (attempt === 3) throw error
    console.warn(`Public deployment check ${attempt}/3 failed: ${error.message}; retrying in 5 seconds`)
    await delay(5000)
  }
}
