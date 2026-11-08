import { Controller, Get, Header, Inject } from '@nestjs/common'
import { HealthService } from './health.service.js'

@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  status(): ReturnType<HealthService['status']> {
    return this.health.status()
  }
}
