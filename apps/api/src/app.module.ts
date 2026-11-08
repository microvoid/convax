import { Module, type DynamicModule } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'
import { ApiExceptionFilter } from './common/api-exception.filter.js'
import { HealthModule } from './health/health.module.js'
import type { ClientNoticeCatalog } from './client-notices/catalog.js'
import { ClientNoticesModule } from './client-notices/client-notices.module.js'

@Module({
  imports: [HealthModule],
  providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
})
export class AppModule {
  static register(catalog?: ClientNoticeCatalog): DynamicModule {
    return { module: AppModule, imports: [ClientNoticesModule.register(catalog)] }
  }
}
