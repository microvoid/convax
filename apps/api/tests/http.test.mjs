import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import healthSchema from '@convax/api-contracts/schemas/health-response.json' with { type: 'json' }
import errorSchema from '@convax/api-contracts/schemas/error-response.json' with { type: 'json' }
import noticeDefinitions from '@convax/api-contracts/schemas/client-notice-definitions.json' with { type: 'json' }
import policySchema from '@convax/api-contracts/schemas/client-policy-response.json' with { type: 'json' }
import guidanceSchema from '@convax/api-contracts/schemas/client-guidance-response.json' with { type: 'json' }
import { startConvaxApi } from '../dist/main.js'

const installationId = '00000000-0000-4000-8000-000000000001'

function metadata(changes = {}) {
  return new URLSearchParams({ appVersion: '0.1.0', platform: 'darwin', arch: 'arm64', channel: 'latest', locale: 'en', ...changes })
}

function noticeValidator() {
  const validator = new Ajv2020({ strict: true })
  validator.addFormat('date-time', value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    && Number.isFinite(Date.parse(value)))
  validator.addSchema(noticeDefinitions)
  return { policy: validator.compile(policySchema), guidance: validator.compile(guidanceSchema), error: validator.compile(errorSchema) }
}

async function noticeRuntime(context, clientNotices) {
  const runtime = await startConvaxApi(clientNotices === undefined ? {} : { clientNotices })
  context.after(() => runtime.close())
  const listening = once(runtime.server, 'listening')
  runtime.server.listen(0, '127.0.0.1')
  await listening
  const address = runtime.server.address()
  assert.ok(address && typeof address !== 'string')
  return {
    request: (path, query = metadata(), headers = { 'X-Installation-Id': installationId }) =>
      fetch(`http://127.0.0.1:${address.port}/api/v1/client/${path}?${query}`, { headers }),
  }
}

function notice(id, extra = {}) {
  const now = Date.now()
  return { id, revision: '1', kind: 'feature', surface: 'modal', startsAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 86_400_000).toISOString(), requiresCapabilities: ['convax.canvas'],
    frequency: { scope: 'installation', maxImpressions: 1, cooldownSeconds: 86400 },
    content: { title: 'Canvas resources', body: 'Connect a resource to a conversation.' },
    actions: [{ id: 'dismiss', type: 'dismiss', label: 'Got it' }], ...extra }
}

function catalog(extra = {}) {
  return { revision: 'deployment-2', nextCheckAfterSeconds: 60, maintenance: [], guidance: [], ...extra }
}

test('built Nest application serves the health contract and stable route errors', { timeout: 30_000 }, async (context) => {
  const runtime = await startConvaxApi()
  context.after(() => runtime.close())
  const listening = once(runtime.server, 'listening')
  runtime.server.listen(0, '127.0.0.1')
  await listening
  const address = runtime.server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const validator = new Ajv2020({ strict: true })

  const health = await fetch(`${origin}/health`)
  assert.equal(health.status, 200)
  assert.equal(health.headers.get('cache-control'), 'no-store')
  assert.match(health.headers.get('content-type'), /^application\/json/u)
  const validHealth = validator.compile(healthSchema)
  assert.equal(validHealth(await health.json()), true, JSON.stringify(validHealth.errors))

  const missing = await fetch(`${origin}/missing`)
  assert.equal(missing.status, 404)
  assert.equal(missing.headers.get('cache-control'), 'no-store')
  const body = await missing.json()
  const validError = validator.compile(errorSchema)
  assert.equal(validError(body), true, JSON.stringify(validError.errors))
  assert.equal(body.error.code, 'not_found')
})

test('public notice routes serve the explicit default deployment and reject malformed metadata', { timeout: 30_000 }, async (context) => {
  const runtime = await noticeRuntime(context)
  const valid = noticeValidator()
  for (const path of ['policy', 'guidance']) {
    const response = await runtime.request(path)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const body = await response.json()
    assert.equal(valid[path](body), true, JSON.stringify(valid[path].errors))
    assert.equal(body.revision, 'default-1')
    assert.equal(body.nextCheckAfterSeconds, 600)
    if (path === 'policy') assert.deepEqual({ update: body.update, maintenance: body.maintenance }, { update: { required: false }, maintenance: [] })
    else assert.deepEqual(body.items, [])
  }
  const missing = metadata()
  missing.delete('arch')
  const duplicate = metadata()
  duplicate.append('platform', 'web')
  for (const [query, headers] of [
    [metadata({ appVersion: 'not-a-version' })], [metadata({ platform: 'unknown' })], [metadata({ locale: '../user' })],
    [metadata({ unknown: 'field' })], [missing], [duplicate], [metadata(), {}], [metadata(), { 'X-Installation-Id': 'not-a-uuid' }],
  ]) {
    const response = await runtime.request('policy', query, headers)
    assert.equal(response.status, 400)
    const body = await response.json()
    assert.equal(valid.error(body), true, JSON.stringify(valid.error.errors))
    assert.equal(body.error.code, 'bad_request')
  }
})

test('deployment announcements apply time, SemVer and client audience filters without retaining caller mutations', { timeout: 30_000 }, async (context) => {
  const deployed = catalog({ guidance: [
    { notice: notice('targeted'), audience: { minAppVersion: '0.2.0', maxAppVersion: '0.10.0', platforms: ['darwin'],
      arches: ['arm64'], channels: ['latest'], locales: ['en'] } },
    { notice: notice('public-banner', { kind: 'announcement', surface: 'banner' }) },
    { notice: notice('expired', { startsAt: new Date(Date.now() - 120_000).toISOString(), expiresAt: new Date(Date.now() - 60_000).toISOString() }) },
    { notice: notice('future', { startsAt: new Date(Date.now() + 60_000).toISOString() }) },
  ] })
  const runtime = await noticeRuntime(context, deployed)
  deployed.guidance[0].notice.content.title = 'Changed outside the application'
  const valid = noticeValidator()
  const selected = await runtime.request('guidance', metadata({ appVersion: '0.2.0', locale: 'EN' }))
  const body = await selected.json()
  assert.equal(valid.guidance(body), true, JSON.stringify(valid.guidance.errors))
  assert.deepEqual(body.items.map(value => value.id), ['targeted', 'public-banner'])
  assert.equal(body.items[0].content.title, 'Canvas resources')
  assert.equal(body.revision, 'deployment-2')
  for (const changes of [{ appVersion: '0.1.9' }, { appVersion: '0.10.0' }, { platform: 'win32' }, { arch: 'x64' },
    { channel: 'nightly' }, { locale: 'zh-CN' }]) {
    const response = await runtime.request('guidance', metadata({ appVersion: '0.2.0', ...changes }))
    assert.deepEqual((await response.json()).items.map(value => value.id), ['public-banner'])
  }
})

test('explicit available releases drive native update policy while Web receives no native upgrade guidance', { timeout: 30_000 }, async (context) => {
  const update = { minSupportedVersion: '0.2.0',
    release: { id: 'mac-arm64-0.2.1', version: '0.2.1', platform: 'darwin', arch: 'arm64', channel: 'latest', available: true },
    reasonCode: 'support_ended', fallbackPage: 'https://example.test/download' }
  const deployed = catalog({ update, maintenance: [{ id: 'cloud-chat', revision: '1', status: 'active',
    startsAt: new Date(Date.now() - 60_000).toISOString(), estimatedEndsAt: null, affectedCapabilities: ['cloud.chat'],
    title: 'Cloud maintenance', body: 'Local work remains available.' }], guidance: [
    { notice: notice('recommended', { kind: 'upgrade', releaseId: 'mac-arm64-0.2.1',
      actions: [{ id: 'update', type: 'open_update', label: 'Open updater', releaseId: 'mac-arm64-0.2.1' }] }) },
    { notice: notice('public-message', { kind: 'announcement', surface: 'message' }) },
  ] })
  const runtime = await noticeRuntime(context, deployed)
  const valid = noticeValidator()
  const response = await runtime.request('policy', metadata({ appVersion: '0.2.0-rc.1' }))
  const body = await response.json()
  assert.equal(valid.policy(body), true, JSON.stringify(valid.policy.errors))
  assert.equal(body.update.required, true)
  assert.equal(body.update.targetVersion, '0.2.1')
  assert.equal(body.update.fallbackPage, 'https://example.test/download')
  assert.equal(body.maintenance[0].status, 'active')
  for (const changes of [{ platform: 'web' }, { platform: 'win32' }, { arch: 'x64' }, { channel: 'nightly' }, { appVersion: '0.2.0+build.1' }]) {
    const result = await runtime.request('policy', metadata(changes))
    assert.deepEqual((await result.json()).update, { required: false })
  }
  const web = await runtime.request('guidance', metadata({ platform: 'web', arch: 'universal' }))
  const webBody = await web.json()
  assert.equal(valid.guidance(webBody), true, JSON.stringify(valid.guidance.errors))
  assert.deepEqual(webBody.items.map(value => value.id), ['public-message'])
  const native = await runtime.request('guidance')
  assert.deepEqual((await native.json()).items.map(value => value.id), ['recommended', 'public-message'])
  for (const changes of [{ platform: 'win32' }, { arch: 'x64' }, { channel: 'nightly' }, { appVersion: '0.2.1' }]) {
    const filtered = await runtime.request('guidance', metadata(changes))
    assert.deepEqual((await filtered.json()).items.map(value => value.id), ['public-message'])
  }

  const unavailable = await noticeRuntime(context, { ...deployed, update: { ...update, release: { ...update.release, available: false } } })
  assert.deepEqual((await (await unavailable.request('policy')).json()).update, { required: false })
  assert.deepEqual((await (await unavailable.request('guidance')).json()).items.map(value => value.id), ['public-message'])
})

test('unsafe deployment catalogs fail startup instead of publishing a clear or unusable update decision', async () => {
  const update = { minSupportedVersion: '0.2.0',
    release: { id: 'mac-arm64-0.2.1', version: '0.2.1', platform: 'darwin', arch: 'arm64', channel: 'latest', available: true },
    reasonCode: 'support_ended', fallbackPage: 'https://example.test/download' }
  for (const invalid of [
    catalog({ nextCheckAfterSeconds: 0 }), catalog({ update: { ...update, fallbackPage: 'http://example.test/download' } }),
    catalog({ update: { ...update, release: { ...update.release, version: '0.1.0' } } }),
    catalog({ guidance: [{ notice: notice('invalid', { surface: 'coachmark' }) }] }),
    catalog({ guidance: [{ notice: notice('invalid', { blocking: true }) }] }),
  ]) await assert.rejects(startConvaxApi({ clientNotices: invalid }))
})
