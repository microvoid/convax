import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authenticatedHostFetch, authenticateWebHost, forwardWebRequest, serveWebDocument } from '../src/web-document.ts'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('serves the Web entry and assets without starting or contacting a Host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-web-'))
  roots.push(root)
  await mkdir(join(root, 'assets'))
  await writeFile(join(root, 'index.html'), '<html><head></head><body><script src="assets/entry.js"></script></body></html>')
  await writeFile(join(root, 'assets/entry.js'), 'globalThis.entryLoaded = true')
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const response = await serveWebDocument(new Request('dsh-app://app/'), root)
  const html = await response.text()
  expect(html.indexOf('Promise.withResolvers()')).toBeLessThan(html.indexOf('assets/entry.js'))
  expect(await (await serveWebDocument(new Request('dsh-app://app/assets/entry.js'), root)).text()).toContain('entryLoaded')
  expect(fetch).not.toHaveBeenCalled()
  expect((await serveWebDocument(new Request('dsh-app://app/%2e%2e%2fprivate'), root)).status).toBe(403)
  expect((await serveWebDocument(new Request('dsh-app://app/missing.js'), root)).status).toBe(404)
})

it('requires the Host authentication exchange and retains only its cookie value', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 303, headers: { 'set-cookie': 'session=owned; HttpOnly; SameSite=Strict' } }))
    .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
  vi.stubGlobal('fetch', fetch)
  expect(await authenticateWebHost('http://127.0.0.1:1234/?token=owned')).toBe('session=owned')
  await expect(authenticateWebHost('http://127.0.0.1:1234/')).rejects.toThrow('authentication failed')
})

it('keeps native requests on their authenticated Host with the activation cookie and request body', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('authenticated'))
  vi.stubGlobal('fetch', fetch)
  const send = authenticatedHostFetch('http://127.0.0.1:1234/?token=fixture', 'session=first-host')
  const controller = new AbortController()
  const response = await send('http://127.0.0.1:1234/api/settings/describe', {
    method: 'POST', headers: { cookie: 'untrusted', 'content-type': 'application/json' },
    body: '{"request":true}', signal: controller.signal, redirect: 'follow',
  })
  const [target, init] = fetch.mock.calls[0]!
  expect(target).toEqual(new URL('http://127.0.0.1:1234/api/settings/describe'))
  expect(new Headers(init?.headers).get('cookie')).toBe('session=first-host')
  expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
  expect(init).toMatchObject({ method: 'POST', body: '{"request":true}', redirect: 'error', signal: controller.signal })
  expect(await response.text()).toBe('authenticated')
})

it('does not transmit a Host cookie to another port, protocol, or hostname', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>()
  vi.stubGlobal('fetch', fetch)
  const send = authenticatedHostFetch('http://127.0.0.1:1234/', 'session=owned')
  for (const target of ['http://127.0.0.1:1235/api/read', 'https://127.0.0.1:1234/api/read', 'http://localhost:1234/api/read']) {
    await expect(send(target)).rejects.toThrow('authenticated Host')
  }
  expect(fetch).not.toHaveBeenCalled()
})

it('retains each native transport cookie when a newer Host activation is authenticated', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response('authenticated'))
  vi.stubGlobal('fetch', fetch)
  const first = authenticatedHostFetch('http://127.0.0.1:1234/', 'session=first')
  const next = authenticatedHostFetch('http://127.0.0.1:1234/', 'session=next')
  await next('http://127.0.0.1:1234/')
  await first('http://127.0.0.1:1234/')
  expect(fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get('cookie')))
    .toEqual(['session=next', 'session=first'])
})

it('forwards upload bytes and cancellation with Host credentials while keeping the response streaming', async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('stream')); controller.close() } })
  const fetch = vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-encoding': 'gzip', 'set-cookie': 'private' } }))
  vi.stubGlobal('fetch', fetch)
  const request = new Request('dsh-app://app/api/upload?name=file', {
    method: 'POST', body: 'upload bytes', headers: { origin: 'dsh-app://app', cookie: 'untrusted' },
  })
  const response = await forwardWebRequest(request, 'http://127.0.0.1:1234/?token=secret', 'session=owned')
  const [target, init] = fetch.mock.calls[0] as [URL, RequestInit]
  expect(target.href).toBe('http://127.0.0.1:1234/api/upload?name=file')
  expect(new Headers(init.headers).get('cookie')).toBe('session=owned')
  expect(new Headers(init.headers).get('origin')).toBeNull()
  expect(init.signal).toBe(request.signal)
  expect(init.body).toBe(request.body)
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(response.headers.get('content-encoding')).toBeNull()
  expect(await response.text()).toBe('stream')
})

it('drops connection-level headers the Host wrote for its own transport', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('body', { headers: {
    'transfer-encoding': 'chunked', connection: 'keep-alive', 'keep-alive': 'timeout=5', trailer: 'x', te: 'trailers',
    'content-type': 'text/plain', 'cache-control': 'no-cache', etag: '"1"',
  } }))
  vi.stubGlobal('fetch', fetch)
  const response = await forwardWebRequest(new Request('dsh-app://app/api/read'), 'http://127.0.0.1:1234/', 'session=owned')
  for (const name of ['transfer-encoding', 'connection', 'keep-alive', 'trailer', 'te']) expect(response.headers.get(name)).toBeNull()
  expect(response.headers.get('content-type')).toBe('text/plain')
  expect(response.headers.get('cache-control')).toBe('no-cache')
  expect(response.headers.get('etag')).toBe('"1"')
})

it.each([
  { method: 'GET', status: 200, encoding: undefined },
  { method: 'GET', status: 206, encoding: undefined },
  { method: 'HEAD', status: 200, encoding: undefined },
  { method: 'GET', status: 200, encoding: 'identity' },
  { method: 'GET', status: 206, encoding: 'identity' },
  { method: 'HEAD', status: 200, encoding: 'IDENTITY' },
])('preserves representation length for $method $status with $encoding encoding', async ({ method, status, encoding }) => {
  const headers = new Headers({ 'content-length': '5', 'accept-ranges': 'bytes' })
  if (encoding !== undefined) headers.set('content-encoding', encoding)
  if (status === 206) headers.set('content-range', 'bytes 5-9/20')
  const fetch = vi.fn().mockResolvedValue(new Response(method === 'HEAD' ? null : 'bytes', { status, headers }))
  vi.stubGlobal('fetch', fetch)
  const request = new Request('dsh-app://app/api/file', { method,
    ...(status === 206 ? { headers: { range: 'bytes=5-9' } } : {}) })
  const response = await forwardWebRequest(request, 'http://127.0.0.1:1234/', 'session=owned')
  expect(response.status).toBe(status)
  expect(response.headers.get('content-length')).toBe('5')
  expect(response.headers.get('content-encoding')).toBeNull()
  expect(response.headers.get('accept-ranges')).toBe('bytes')
  expect(response.headers.get('content-range')).toBe(status === 206 ? 'bytes 5-9/20' : null)
  const [, init] = fetch.mock.calls[0] as [URL, RequestInit]
  expect(new Headers(init.headers).get('range')).toBe(status === 206 ? 'bytes=5-9' : null)
  expect(await response.text()).toBe(method === 'HEAD' ? '' : 'bytes')
})

it.each([
  { method: 'GET', status: 200, encoding: 'gzip' },
  { method: 'GET', status: 206, encoding: 'br' },
  { method: 'HEAD', status: 200, encoding: 'gzip' },
])('withholds encoded length for $method $status with $encoding encoding', async ({ method, status, encoding }) => {
  const headers = new Headers({ 'content-length': '19', 'content-encoding': encoding })
  if (status === 206) headers.set('content-range', 'bytes 0-18/40')
  const fetch = vi.fn().mockResolvedValue(new Response(method === 'HEAD' ? null : 'decoded bytes', { status, headers }))
  vi.stubGlobal('fetch', fetch)
  const response = await forwardWebRequest(new Request('dsh-app://app/api/file', { method }), 'http://127.0.0.1:1234/', 'session=owned')
  expect(response.status).toBe(status)
  expect(response.headers.get('content-encoding')).toBeNull()
  expect(response.headers.get('content-length')).toBeNull()
  expect(response.headers.get('content-range')).toBe(status === 206 ? 'bytes 0-18/40' : null)
  expect(await response.text()).toBe(method === 'HEAD' ? '' : 'decoded bytes')
})

it('propagates renderer cancellation to the forwarded response stream', async () => {
  const cancelled = vi.fn()
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('bytes')) },
    cancel: cancelled,
  })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-length': '10' } })))
  const response = await forwardWebRequest(new Request('dsh-app://app/api/file'), 'http://127.0.0.1:1234/', 'session=owned')
  const reader = response.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('bytes')
  await reader.cancel('preview closed')
  expect(cancelled).toHaveBeenCalledWith('preview closed')
})

it('replaces the immutable cache header of plugin bundles with no-store and leaves other routes alone', async () => {
  const immutable = 'public, max-age=31536000, immutable'
  const fetch = vi.fn().mockImplementation(async () => new Response('js', { headers: { 'cache-control': immutable } }))
  vi.stubGlobal('fetch', fetch)
  const bundle = await forwardWebRequest(new Request('dsh-app://app/plugins/??a/client.js&rev=1'), 'http://127.0.0.1:1234/', 'c')
  expect(bundle.headers.get('cache-control')).toBe('no-store')
  const chunk = await forwardWebRequest(new Request('dsh-app://app/plugins/a/client.x.js?rev=1'), 'http://127.0.0.1:1234/', 'c')
  expect(chunk.headers.get('cache-control')).toBe('no-store')
  const asset = await forwardWebRequest(new Request('dsh-app://app/api/plugins/list'), 'http://127.0.0.1:1234/', 'c')
  expect(asset.headers.get('cache-control')).toBe(immutable)
})

it('refuses another page origin without forwarding its request', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const response = await forwardWebRequest(new Request('dsh-app://app/api/read', { headers: { origin: 'https://other.example' } }), 'http://127.0.0.1:1234/', 'session=owned')
  expect(response.status).toBe(403)
  expect(fetch).not.toHaveBeenCalled()
})
