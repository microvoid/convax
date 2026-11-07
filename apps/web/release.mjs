/** Public installer discovery, kept separate from the homepage and its model-free runtime. */
const repository = 'https://github.com/microvoid/convax'
const releases = `${repository}/releases`
const latest = `${releases}/latest`
const stableTag = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/u

function response(body, status = 200, maxAge = 60) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': status === 200 ? `public, max-age=${maxAge}` : 'no-store',
      ...(status === 503 ? { 'Retry-After': '60' } : {}),
    },
  })
}

function pending() {
  return response({ status: 'pending', releaseUrl: releases })
}

function unavailable() {
  return response({ status: 'unavailable', releaseUrl: releases }, 503)
}

function releaseTarget(location) {
  if (!location) return undefined
  try {
    const url = new URL(location, repository)
    if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash) return undefined
    if (url.pathname === '/microvoid/convax/releases' || url.pathname === '/microvoid/convax/releases/') return null
    const prefix = '/microvoid/convax/releases/tag/'
    if (!url.pathname.startsWith(prefix)) return undefined
    const tag = decodeURIComponent(url.pathname.slice(prefix.length))
    const version = stableTag.exec(tag)?.[1]
    return version ? { tag, version } : null
  } catch {
    return undefined
  }
}

function contentLength(asset) {
  const value = asset.headers.get('Content-Length')
  const size = value && /^[1-9]\d*$/u.test(value) ? Number(value) : 0
  return Number.isSafeInteger(size) && size > 0 ? size : undefined
}

function upstreamFailure(stage, status) {
  console.warn('convax-release-upstream', { stage, status })
  return unavailable()
}

/**
 * Resolve a complete public macOS release without exposing credentials or upstream failures.
 * @param {Request} request - Homepage release-status request.
 * @param {{ open(name: string): Promise<{ match(request: Request): Promise<Response | undefined>, put(request: Request, response: Response): Promise<void> }> }} cacheStorage - Edge cache storage.
 * @param {typeof fetch} fetchRelease - Public GitHub HEAD transport, injectable for offline checks.
 * @returns {Promise<Response>} Ready, pending, or retryable unavailable download state.
 */
export async function serveRelease(request, cacheStorage, fetchRelease = fetch) {
  if (request.method !== 'GET') {
    return new Response(null, { status: 405, headers: { Allow: 'GET', 'Cache-Control': 'no-store' } })
  }
  let stage = 'edge-cache'
  try {
    const cacheUrl = new URL(request.url)
    cacheUrl.search = ''
    const key = new Request(cacheUrl)
    const cache = await cacheStorage.open('convax-public-release')
    const cached = await cache.match(key)
    if (cached) {
      const body = await cached.clone().json()
      if (cached.status !== 200 || (body?.status !== 'ready' && body?.status !== 'pending')) return unavailable()
      const result = new Response(cached.body, cached)
      // Keep download status fresh when a cache hit carries a longer browser TTL.
      result.headers.set('Cache-Control', `public, max-age=${body.status === 'ready' ? 300 : 60}`)
      return result
    }

    const options = { method: 'HEAD', headers: { 'User-Agent': 'convax-homepage' }, signal: AbortSignal.timeout(6000) }
    stage = 'release-latest'
    const upstream = await fetchRelease(latest, { ...options, redirect: 'manual' })
    let result
    if (upstream.status === 404) result = pending()
    else if ([301, 302, 303, 307, 308].includes(upstream.status)) {
      const target = releaseTarget(upstream.headers.get('Location'))
      if (target === undefined) return upstreamFailure('release-redirect', upstream.status)
      if (target === null) result = pending()
      else {
        const name = `convax-${target.version}-mac-arm64.dmg`
        const downloadUrl = `${releases}/download/${encodeURIComponent(target.tag)}/${encodeURIComponent(name)}`
        stage = 'release-assets'
        const [installer, checksum] = await Promise.all([
          fetchRelease(downloadUrl, { ...options, redirect: 'follow' }),
          fetchRelease(`${downloadUrl}.sha256`, { ...options, redirect: 'follow' }),
        ])
        if (installer.status !== 200 && installer.status !== 404) return upstreamFailure('installer', installer.status)
        if (checksum.status !== 200 && checksum.status !== 404) return upstreamFailure('checksum', checksum.status)
        const size = contentLength(installer)
        result = installer.status === 200 && checksum.status === 200 && size !== undefined && contentLength(checksum) !== undefined
          ? response({ status: 'ready', version: target.version, downloadUrl,
            releaseUrl: `${releases}/tag/${encodeURIComponent(target.tag)}`, size }, 200, 300)
          : pending()
      }
    } else {
      return upstreamFailure(stage, upstream.status)
    }
    try {
      await cache.put(key, result.clone())
    } catch {
      // A usable installer remains available when an edge cache write fails.
    }
    return result
  } catch (error) {
    console.warn('convax-release-failure', { stage, error: error instanceof Error ? error.name : 'unknown' })
    return unavailable()
  }
}
