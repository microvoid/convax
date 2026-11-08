import 'reflect-metadata'
import type { Server } from 'node:http'
import { ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { ExpressAdapter } from '@nestjs/platform-express'
import { AppModule } from './app.module.js'
import type { ClientNoticeCatalog } from './client-notices/catalog.js'

export type { ClientNoticeCatalog, ClientNoticeAudience, ClientGuidanceDeployment, ClientUpdateDeployment } from './client-notices/catalog.js'

/** Explicit deployment content; omitted catalogs select the checked-in empty deployment. */
export interface ConvaxApiOptions {
  readonly clientNotices?: ClientNoticeCatalog
}

export interface ConvaxHttpRuntime {
  readonly server: Server
  close(): Promise<void>
}

/** Initialize an unbound HTTP server; its carrier owns listening and closing. */
export async function startConvaxApi(options: ConvaxApiOptions = {}): Promise<ConvaxHttpRuntime> {
  const application = await NestFactory.create(AppModule.register(options.clientNotices), new ExpressAdapter(), {
    logger: false,
    abortOnError: false,
  })
  try {
    application.useGlobalPipes(new ValidationPipe({
      transform: true, whitelist: true, forbidNonWhitelisted: true,
    }))
    await application.init()
    return {
      server: application.getHttpServer() as Server,
      close: () => application.close(),
    }
  } catch (error) {
    await application.close()
    throw error
  }
}
