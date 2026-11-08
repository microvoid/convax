import 'reflect-metadata'

import { startConvaxApi } from '@convax/api/runtime'
import { httpServerHandler } from 'cloudflare:node'

interface ConvaxApiEnv {
  /** Local schema placeholder; public metadata routes require no production database. */
  readonly CONVAX_DB?: D1Database
}

/** Map the public deployment base to Nest's routes while preserving query and request metadata. */
function apiRequest(request: Request<unknown, IncomingRequestCfProperties>): Request<unknown, IncomingRequestCfProperties> {
  const url = new URL(request.url)
  const base = '/convax/api'
  if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return request
  const path = url.pathname.slice(base.length)
  url.pathname = path === '/health' ? path : `/api${path}`
  return new Request(url, request)
}

/** One isolate owns one Nest runtime; failed startup can be retried on the next request. */
class ConvaxApiWorker implements ExportedHandler<ConvaxApiEnv> {
  private startup: Promise<ExportedHandler<ConvaxApiEnv>> | undefined

  async fetch(
    request: Request<unknown, IncomingRequestCfProperties>, env: ConvaxApiEnv, context: ExecutionContext,
  ): Promise<Response> {
    try {
      const bridge = await this.bridge()
      if (bridge.fetch === undefined) throw new Error('HTTP bridge is unavailable')
      return await bridge.fetch(apiRequest(request), env, context)
    } catch {
      return Response.json({ error: { code: 'service_unavailable', message: 'Service temporarily unavailable' } }, {
        status: 503,
        headers: { 'cache-control': 'no-store' },
      })
    }
  }

  private bridge(): Promise<ExportedHandler<ConvaxApiEnv>> {
    this.startup ??= this.start().catch((error: unknown) => {
      this.startup = undefined
      throw error
    })
    return this.startup
  }

  private async start(): Promise<ExportedHandler<ConvaxApiEnv>> {
    const runtime = await startConvaxApi()
    try {
      return httpServerHandler(runtime.server as Parameters<typeof httpServerHandler>[0])
    } catch (error) {
      await runtime.close()
      throw error
    }
  }
}

export default new ConvaxApiWorker()
