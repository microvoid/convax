import { Injectable } from '@nestjs/common'

@Injectable()
export class HealthService {
  status(): { status: 'ok'; service: 'convax-api' } {
    return { status: 'ok', service: 'convax-api' }
  }
}
