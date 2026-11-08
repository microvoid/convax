import { Module, type DynamicModule } from '@nestjs/common'
import { DEFAULT_CLIENT_NOTICE_CATALOG, prepareClientNoticeCatalog, type ClientNoticeCatalog } from './catalog.js'
import { ClientNoticesController } from './client-notices.controller.js'
import { CLIENT_NOTICE_CATALOG, ClientNoticesService } from './client-notices.service.js'

@Module({})
export class ClientNoticesModule {
  /** Own a validated immutable catalog for the lifetime of this Nest application. */
  static register(catalog: ClientNoticeCatalog = DEFAULT_CLIENT_NOTICE_CATALOG): DynamicModule {
    return { module: ClientNoticesModule, controllers: [ClientNoticesController], providers: [
      { provide: CLIENT_NOTICE_CATALOG, useValue: prepareClientNoticeCatalog(catalog) }, ClientNoticesService,
    ] }
  }
}
