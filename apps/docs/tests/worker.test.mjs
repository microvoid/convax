/** Test cache ownership and revalidation without emulating Cloudflare's Range parser. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { serveDemo } from '../worker.mjs'

const url = 'https://microvoid.io/convax/docs/demos/projects-zh.mp4'
const publicCache = 'public, max-age=0, must-revalidate'

function fixture() {
  const calls = { opened: [], matched: [], stored: [], assets: [] }
  const buckets = new Map()
  const storage = { async open(name) {
    calls.opened.push(name)
    if (!buckets.has(name)) buckets.set(name, new Map())
    const entries = buckets.get(name)
    return {
      async match(request) {
        calls.matched.push(request)
        const response = entries.get(request.url)
        return response?.clone()
      },
      async put(request, response) {
        calls.stored.push({ request, response: response.clone() })
        entries.set(request.url, response.clone())
      },
    }
  } }
  const env = {
    CF_VERSION_METADATA: { id: 'version-a' },
    ASSETS: { async fetch(request) {
      calls.assets.push(request)
      return new Response('original-video', { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '14', ETag: '"a"' } })
    } },
  }
  return { calls, storage, env }
}

test('only demo MP4 GET requests use the edge cache', async () => {
  for (const [path, method] of [
    [url, 'HEAD'], [url, 'POST'],
    ['https://microvoid.io/convax/docs/zh/', 'GET'],
    ['https://microvoid.io/convax/docs/demos/preview.gif', 'GET'],
    ['https://microvoid.io/convax/assets/demo.mp4', 'GET'],
  ]) {
    const { calls, storage, env } = fixture()
    const request = new Request(path, { method })
    const response = await serveDemo(request, env, storage)
    assert.equal(await response.text(), 'original-video')
    assert.deepEqual(calls.assets, [request])
    assert.deepEqual(calls.opened, [])
  }
})

test('a cold Range request caches the full asset and passes the original request to native cache lookup', async () => {
  const { calls, storage, env } = fixture()
  const request = new Request(url, { headers: { Range: 'bytes=4-9', 'If-None-Match': '"old"' } })
  const response = await serveDemo(request, env, storage)
  assert.deepEqual(calls.opened, ['convax-docs-demo-version-a'])
  assert.deepEqual(calls.matched, [request, request])
  assert.equal(calls.assets.length, 1)
  assert.equal(calls.assets[0].url, request.url)
  assert.equal(calls.assets[0].headers.get('Range'), null)
  assert.equal(calls.assets[0].headers.get('If-None-Match'), null)
  assert.equal(calls.stored[0].request.headers.get('Range'), null)
  assert.equal(calls.stored[0].response.headers.get('Cache-Control'), 'public, max-age=31536000, immutable')
  assert.equal(calls.stored[0].response.headers.get('Accept-Ranges'), 'bytes')
  assert.equal(await calls.stored[0].response.text(), 'original-video')
  assert.equal(response.headers.get('Cache-Control'), publicCache)
  assert.equal(response.headers.get('ETag'), '"a"')
})

test('a hot native partial response keeps its bytes and headers while requiring browser revalidation', async () => {
  const { calls, env } = fixture()
  const request = new Request(url, { headers: { Range: 'bytes=4-6' } })
  const storage = { async open(name) {
    assert.equal(name, 'convax-docs-demo-version-a')
    return { async match(original) {
      assert.equal(original, request)
      return new Response('abc', { status: 206, headers: {
        'Content-Range': 'bytes 4-6/14', 'Content-Length': '3', 'Cache-Control': 'public, max-age=31536000, immutable',
      } })
    }, async put() { assert.fail('A hot response must not be stored again') } }
  } }
  const response = await serveDemo(request, env, storage)
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('Content-Range'), 'bytes 4-6/14')
  assert.equal(response.headers.get('Content-Length'), '3')
  assert.equal(response.headers.get('Cache-Control'), publicCache)
  assert.equal(await response.text(), 'abc')
  assert.deepEqual(calls.assets, [])
})

test('a new deployment cannot reuse an older file under the same public filename', async () => {
  const { calls, storage, env } = fixture()
  const request = new Request(url)
  assert.equal(await (await serveDemo(request, env, storage)).text(), 'original-video')
  env.CF_VERSION_METADATA.id = 'version-b'
  env.ASSETS.fetch = async request => {
    calls.assets.push(request)
    return new Response('new-video')
  }
  assert.equal(await (await serveDemo(request, env, storage)).text(), 'new-video')
  assert.deepEqual(calls.opened, ['convax-docs-demo-version-a', 'convax-docs-demo-version-b'])
  assert.equal(calls.assets.length, 2)
})

test('missing assets retain their failure and do not enter the success cache', async () => {
  const { calls, storage, env } = fixture()
  env.ASSETS.fetch = async () => new Response('missing', { status: 404 })
  const response = await serveDemo(new Request(url), env, storage)
  assert.equal(response.status, 404)
  assert.equal(await response.text(), 'missing')
  assert.deepEqual(calls.stored, [])
})

test('an unavailable cache after insertion reports a retryable miss instead of serving an unbounded Range body', async () => {
  const { env } = fixture()
  const storage = { async open() { return { async match() {}, async put() {} } } }
  const response = await serveDemo(new Request(url, { headers: { Range: 'bytes=1-2' } }), env, storage)
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('Retry-After'), '1')
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
})
