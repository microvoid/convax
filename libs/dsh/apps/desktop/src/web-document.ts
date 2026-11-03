/** Local Web document and authenticated HTTP forwarding for the application window. */
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon',
}
const BOOT = '<script>globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()</script>'

/**
 * Read an application-owned static asset; the index waits for asynchronous Host injections.
 * @param request - Local application request.
 * @param root - Packaged Web dist directory.
 * @returns Static response, or a missing/invalid path response.
 */
export async function serveWebDocument(request: Request, root: string): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 })
  const url = new URL(request.url)
  let pathname: string
  try { pathname = decodeURIComponent(url.pathname) } catch { return new Response(null, { status: 400 }) }
  const target = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname))
  const directory = resolve(root)
  if (!target.startsWith(directory + sep)) return new Response(null, { status: 403 })
  let body: Buffer
  try { body = await readFile(target) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Response(null, { status: 404 })
    throw error
  }
  const content = pathname === '/' || pathname === '/index.html'
    ? body.toString().replace('<head>', '<head>' + BOOT) : new Uint8Array(body)
  return new Response(request.method === 'HEAD' ? null : content, {
    headers: { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' },
  })
}

/**
 * Exchange the Host launch URL for an authority-bound browser cookie.
 * @param url - Authenticated URL reported by the owned Host process.
 * @returns Cookie header for requests forwarded to that Host.
 */
export async function authenticateWebHost(url: string): Promise<string> {
  const response = await fetch(url, { redirect: 'manual' })
  const cookie = response.headers.get('set-cookie')
  await response.body?.cancel()
  if (response.status !== 303 || cookie === null) throw new Error('Desktop Host authentication failed')
  const end = cookie.indexOf(';')
  return end < 0 ? cookie : cookie.slice(0, end)
}

/**
 * Bind native requests to one authenticated Host activation without a browser cookie jar.
 * @param host - Owned Host URL whose origin is the only allowed destination.
 * @param cookie - Cookie issued by that Host's launch exchange.
 * @returns Fetch transport that supplies the owned cookie and rejects redirects or another origin.
 */
export function authenticatedHostFetch(host: string, cookie: string): (input: string, init?: RequestInit) => Promise<Response> {
  const origin = new URL(host).origin
  return async (input, init) => {
    const target = new URL(input)
    if (target.origin !== origin) throw new Error('Desktop request must target its authenticated Host')
    const headers = new Headers(init?.headers)
    headers.set('cookie', cookie)
    return fetch(target, { ...init, headers, redirect: 'error' })
  }
}

/**
 * Response headers not relayed to the renderer. `set-cookie` would hand the
 * Host's authentication cookie to the page's cookie jar, which the shell owns
 * instead; the rest describe the Node `fetch` connection (its encoding and
 * hop-by-hop transport), which Chromium never sees.
 */
const WITHHELD_RESPONSE_HEADERS = [
  'set-cookie',
  'content-encoding',
  'transfer-encoding', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade', 'proxy-authenticate', 'proxy-authorization',
]

/** Host routes whose responses carry immutable cache headers keyed by a per-process revision. */
const PLUGIN_BUNDLE_PATH = /^\/plugins\//u

/**
 * Forward local application requests to its authenticated Host, preserving streaming and cancellation.
 * Unencoded responses retain their representation length; Node `fetch` decodes encoded bodies,
 * so their original encoded lengths cannot be relayed with the decoded bytes.
 * Plugin bundle responses lose their `cache-control` for `no-store`: the Host marks them immutable
 * under a revision that changes every launch, so Chromium's disk cache would only accumulate bundles
 * no later launch can reuse.
 * @param request - Request from the application origin.
 * @param host - Owned Host URL.
 * @param cookie - Host-issued authentication cookie.
 * @returns Host response without connection-level headers.
 */
export async function forwardWebRequest(request: Request, host: string, cookie: string): Promise<Response> {
  const source = new URL(request.url)
  const origin = request.headers.get('origin')
  if (origin !== null && origin !== 'dsh-app://app') return new Response(null, { status: 403 })
  const target = new URL(host)
  target.pathname = source.pathname
  target.search = source.search
  const headers = new Headers(request.headers)
  for (const name of ['host', 'origin', 'cookie', 'sec-fetch-site']) headers.delete(name)
  headers.set('cookie', cookie)
  const init = { method: request.method, headers, body: request.body, signal: request.signal, duplex: 'half', redirect: 'manual' as const }
  const response = await fetch(target, init)
  const outgoing = new Headers(response.headers)
  const encoding = response.headers.get('content-encoding')?.trim().toLowerCase()
  if (encoding !== undefined && encoding !== 'identity') outgoing.delete('content-length')
  for (const name of WITHHELD_RESPONSE_HEADERS) outgoing.delete(name)
  if (PLUGIN_BUNDLE_PATH.test(source.pathname)) outgoing.set('cache-control', 'no-store')
  return new Response(response.body, { status: response.status, headers: outgoing })
}
