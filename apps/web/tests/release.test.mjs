/** Public download discovery uses release HTTP links without the shared REST API quota. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { serveRelease } from '../release.mjs'

const releases = 'https://github.com/microvoid/convax/releases'
const latest = `${releases}/latest`
const url = 'https://microvoid.io/convax/api/release'
const tag = 'v0.1.0'
const downloadUrl = `${releases}/download/${tag}/convax-0.1.0-mac-arm64.dmg`

function redirect(location = `${releases}/tag/${tag}`) {
  return new Response(null, { status: 302, headers: { Location: location } })
}

function asset(size = '12345678', status = 200) {
  return new Response(null, { status, headers: size === undefined ? {} : { 'Content-Length': size } })
}

function ready() {
  return { status: 'ready', version: '0.1.0', downloadUrl, releaseUrl: `${releases}/tag/${tag}`, size: 12345678 }
}

function fixture(transport = async request => request === latest ? redirect() : asset(request.endsWith('.sha256') ? '96' : '12345678')) {
  const entries = new Map()
  const calls = []
  const writes = []
  const storage = {
    async open(name) {
      assert.equal(name, 'convax-public-release')
      return {
        async match(request) { return entries.get(request.url)?.clone() },
        async put(request, result) {
          writes.push({ key: request.url, status: result.status, cacheControl: result.headers.get('Cache-Control') })
          entries.set(request.url, result.clone())
        },
      }
    },
  }
  const fetchRelease = async (...args) => {
    calls.push(args)
    return transport(...args)
  }
  return { entries, calls, writes, storage, fetchRelease,
    request: (suffix = '', init) => serveRelease(new Request(`${url}${suffix}`, init), storage, fetchRelease) }
}

test('a stable latest redirect and both uploaded assets expose a verified Apple Silicon download', async () => {
  const f = fixture()
  const result = await f.request()
  assert.equal(result.status, 200)
  assert.deepEqual(await result.json(), ready())
  assert.match(result.headers.get('Content-Type'), /application\/json/u)
  assert.deepEqual(f.writes, [{ key: url, status: 200, cacheControl: 'public, max-age=300' }])
  assert.deepEqual(f.calls.map(([request]) => request), [latest, downloadUrl, `${downloadUrl}.sha256`])
  const signal = f.calls[0][1].signal
  assert.ok(signal instanceof AbortSignal)
  for (const [, options] of f.calls) {
    assert.equal(options.method, 'HEAD')
    assert.deepEqual(options.headers, { 'User-Agent': 'convax-homepage' })
    assert.equal(options.signal, signal, 'All HEAD requests share the same overall deadline')
  }
  assert.equal(f.calls[0][1].redirect, 'manual')
  assert.equal(f.calls[1][1].redirect, 'follow')
  assert.equal(f.calls[2][1].redirect, 'follow')
})

test('installer and checksum HEAD requests start together rather than consuming serial timeouts', { timeout: 1000 }, async () => {
  const both = Promise.withResolvers()
  let started = 0
  const f = fixture(async (request) => {
    if (request === latest) return redirect()
    if (++started === 2) both.resolve()
    await both.promise
    return asset(request.endsWith('.sha256') ? '96' : '12345678')
  })
  assert.deepEqual(await (await f.request()).json(), ready())
})

test('query variants share one cached response and never change the fixed upstream URLs', async () => {
  const f = fixture()
  await f.request('?lang=en')
  const cached = await f.request('?url=https://example.com/private')
  assert.equal((await cached.json()).status, 'ready')
  assert.equal(f.calls.length, 3)
  assert.deepEqual([...f.entries.keys()], [url])
})

test('edge cache hits restore each download state TTL after Cloudflare extends the stored browser header', async () => {
  for (const [body, maxAge] of [[ready(), 300], [{ status: 'pending', releaseUrl: releases }, 60]]) {
    const f = fixture()
    f.entries.set(url, Response.json(body, { headers: { 'Cache-Control': 'public, max-age=14400', Age: '30' } }))
    const result = await f.request()
    assert.equal(result.status, 200)
    assert.deepEqual(await result.json(), body)
    assert.equal(result.headers.get('Cache-Control'), `public, max-age=${maxAge}`)
    assert.equal(result.headers.get('Age'), '30')
    assert.equal(f.calls.length, 0)
    assert.equal(f.writes.length, 0)
  }
})

test('the missing-latest redirect and 404 both remain pending without a fabricated download URL', async () => {
  for (const missing of [() => redirect(releases), () => redirect(`${releases}/`), () => new Response(null, { status: 404 })]) {
    const f = fixture(async () => missing())
    const result = await f.request()
    assert.equal(result.status, 200)
    assert.deepEqual(await result.json(), { status: 'pending', releaseUrl: releases })
    assert.equal(result.headers.get('Cache-Control'), 'public, max-age=60')
    assert.equal((await (await f.request()).json()).status, 'pending')
    assert.equal(f.calls.length, 1)
  }
})

test('prerelease and malformed version tags never generate an installer request', async () => {
  for (const version of ['v0.1.0-rc.1', 'v01.1.0', 'nightly', 'v0.1.0/other']) {
    const f = fixture(async () => redirect(`${releases}/tag/${version}`))
    assert.deepEqual(await (await f.request()).json(), { status: 'pending', releaseUrl: releases })
    assert.equal(f.calls.length, 1)
  }
})

test('missing installer or checksum and invalid asset lengths remain pending', async () => {
  const invalidAssets = [
    () => asset('1', 404),
    () => new Response(null, { status: 200 }),
    () => asset('0'), () => asset('-1'), () => asset('1.5'), () => asset('9007199254740992'),
  ]
  for (const invalid of invalidAssets) {
    for (const missing of [downloadUrl, `${downloadUrl}.sha256`]) {
      const f = fixture(async request => request === latest ? redirect() : request === missing ? invalid() : asset())
      const result = await f.request()
      assert.equal(result.status, 200)
      assert.deepEqual(await result.json(), { status: 'pending', releaseUrl: releases })
    }
  }
})

test('stable build metadata safely encodes both the release link and the exact asset paths', async () => {
  const f = fixture(async request => request === latest ? redirect(`${releases}/tag/v1.2.3%2Bbuild.7`) : asset())
  const result = await (await f.request()).json()
  assert.equal(result.status, 'ready')
  assert.equal(result.version, '1.2.3+build.7')
  assert.equal(result.releaseUrl, `${releases}/tag/v1.2.3%2Bbuild.7`)
  assert.equal(result.downloadUrl, `${releases}/download/v1.2.3%2Bbuild.7/convax-1.2.3%2Bbuild.7-mac-arm64.dmg`)
})

test('untrusted or unexpected latest redirects never turn discovery into an open proxy', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const locations = [
    'http://github.com/microvoid/convax/releases/tag/v0.1.0',
    'https://github.com/another/repo/releases/tag/v0.1.0',
    'https://example.com/microvoid/convax/releases/tag/v0.1.0',
    `https://user:password@github.com/microvoid/convax/releases/tag/v0.1.0`,
    `${releases}/tag/v0.1.0?redirect=elsewhere`, `${releases}/tag/v0.1.0#other`, `${releases}/tag/%zz`,
  ]
  for (const location of locations) {
    const f = fixture(async () => redirect(location))
    const result = await f.request()
    assert.equal(result.status, 503)
    assert.deepEqual(await result.json(), { status: 'unavailable', releaseUrl: releases })
    assert.equal(f.calls.length, 1)
    assert.equal(f.writes.length, 0)
  }
})

test('upstream failures stay retryable, uncached and produce only scoped status diagnostics', async (t) => {
  const warnings = []
  t.mock.method(console, 'warn', (...args) => warnings.push(args))
  const failures = [
    ['release-latest', latest, async () => new Response('private upstream diagnostics', { status: 403 })],
    ['release-latest', latest, async () => new Response('private upstream diagnostics', { status: 500 })],
    ['release-latest', latest, async () => { throw new Error('private transport diagnostics') }],
    ['installer', downloadUrl, async () => new Response(null, { status: 502 })],
    ['checksum', `${downloadUrl}.sha256`, async () => new Response(null, { status: 503 })],
  ]
  for (const [, failedUrl, failure] of failures) {
    let first = true
    const f = fixture(async (request) => {
      if (request === failedUrl && first) { first = false; return failure() }
      return request === latest ? redirect() : asset(request.endsWith('.sha256') ? '96' : '12345678')
    })
    const result = await f.request()
    assert.equal(result.status, 503)
    assert.equal(result.headers.get('Cache-Control'), 'no-store')
    assert.equal(result.headers.get('Retry-After'), '60')
    assert.deepEqual(await result.json(), { status: 'unavailable', releaseUrl: releases })
    assert.equal(f.writes.length, 0)
    assert.equal((await (await f.request()).json()).status, 'ready')
  }
  assert.deepEqual(warnings, [
    ['convax-release-upstream', { stage: 'release-latest', status: 403 }],
    ['convax-release-upstream', { stage: 'release-latest', status: 500 }],
    ['convax-release-failure', { stage: 'release-latest', error: 'Error' }],
    ['convax-release-upstream', { stage: 'installer', status: 502 }],
    ['convax-release-upstream', { stage: 'checksum', status: 503 }],
  ])
})

test('a cache-write failure retains a verified download rather than turning it into an outage', async () => {
  const f = fixture()
  const result = await serveRelease(new Request(url), { async open() {
    return { async match() { return undefined }, async put() { throw new Error('cache temporarily full') } }
  } }, f.fetchRelease)
  assert.equal(result.status, 200)
  assert.equal((await result.json()).status, 'ready')
})

test('unsupported methods cannot start a public GitHub request or touch the edge cache', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
    const f = fixture()
    const result = await f.request('', { method })
    assert.equal(result.status, 405)
    assert.equal(result.headers.get('Allow'), 'GET')
    assert.equal(f.calls.length, 0)
    assert.equal(f.entries.size, 0)
  }
})
