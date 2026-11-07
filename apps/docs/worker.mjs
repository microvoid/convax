/** Public demo playback uses Cloudflare's cache to preserve native Range semantics. */

/**
 * Serve complete MP4 assets through a deployment-scoped edge cache.
 * @param {Request} request - Public request, including native Range or validator headers.
 * @param {{ ASSETS: { fetch(request: Request): Promise<Response> }, CF_VERSION_METADATA: { id: string } }} env - Assets and deployment metadata bindings.
 * @param {{ open(name: string): Promise<{ match(request: Request): Promise<Response | undefined>, put(request: Request, response: Response): Promise<void> }> }} cacheStorage - Cloudflare cache storage.
 * @returns {Promise<Response>} Asset response with browser revalidation, or the original non-media response.
 */
export async function serveDemo(request, env, cacheStorage) {
  const path = new URL(request.url).pathname
  if (request.method !== 'GET' || !path.startsWith('/convax/docs/demos/') || !path.endsWith('.mp4')) {
    return env.ASSETS.fetch(request)
  }
  const cache = await cacheStorage.open(`convax-docs-demo-${env.CF_VERSION_METADATA.id}`)
  let cached = await cache.match(request)
  if (!cached) {
    const assetRequest = new Request(request.url)
    const asset = await env.ASSETS.fetch(assetRequest)
    if (asset.status !== 200) return asset
    const stored = new Response(asset.body, asset)
    stored.headers.set('Cache-Control', 'public, max-age=31536000, immutable')
    stored.headers.set('Accept-Ranges', 'bytes')
    await cache.put(assetRequest, stored)
    cached = await cache.match(request)
    if (!cached) return new Response('Video temporarily unavailable', {
      status: 503,
      headers: { 'Retry-After': '1', 'Cache-Control': 'no-store' },
    })
  }
  const response = new Response(cached.body, cached)
  response.headers.set('Cache-Control', 'public, max-age=0, must-revalidate')
  return response
}

export default {
  /**
   * Handle public documentation and media requests.
   * @param {Request} request - Incoming request.
   * @param {{ ASSETS: { fetch(request: Request): Promise<Response> }, CF_VERSION_METADATA: { id: string } }} env - Worker bindings.
   * @returns {Promise<Response>} Static response or native cache response.
   */
  fetch(request, env) {
    return serveDemo(request, env, caches)
  },
}
