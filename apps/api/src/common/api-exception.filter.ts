import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common'
import type { Response } from 'express'

/** HTTP errors expose stable categories; internal exception details stay private. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const status = error instanceof HttpException ? error.getStatus() : 500
    const [code, message] = status === 404 ? ['not_found', 'Resource not found']
      : status === 503 ? ['service_unavailable', 'Service temporarily unavailable']
        : status >= 400 && status < 500 ? ['bad_request', 'Request rejected']
          : ['internal_error', 'Internal server error']
    host.switchToHttp().getResponse<Response>()
      .status(status).set('Cache-Control', 'no-store').json({ error: { code, message } })
  }
}
