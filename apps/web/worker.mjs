/** Serve demo byte ranges through the edge cache so native video seeking works. */
export default {
  /**
   * Cache complete public MP4 assets, then let Cloudflare apply Range and validators.
   * @param {Request} request - Incoming public asset request.
   * @param {{ ASSETS: { fetch(request: Request): Promise<Response> } }} env - Static asset binding.
   * @returns {Promise<Response>} Native cache response, asset failure, or retryable cache miss.
   */
  async fetch(request, env) {
    const path = new URL(request.url).pathname
    if (request.method !== 'GET' || !path.startsWith('/convax/assets/') || !path.endsWith('.mp4')) {
      return env.ASSETS.fetch(request)
    }
    const cache = await caches.open('convax-demo-media')
    const cached = await cache.match(request)
    if (cached) return cached

    const assetRequest = new Request(request.url)
    const asset = await env.ASSETS.fetch(assetRequest)
    if (asset.status !== 200) return asset
    const response = new Response(asset.body, asset)
    response.headers.set('Cache-Control', 'public, max-age=31536000, immutable')
    response.headers.set('Accept-Ranges', 'bytes')
    await cache.put(assetRequest, response)
    return await cache.match(request) ?? new Response('Video temporarily unavailable', {
      status: 503,
      headers: { 'Retry-After': '1', 'Cache-Control': 'no-store' },
    })
  },
}
