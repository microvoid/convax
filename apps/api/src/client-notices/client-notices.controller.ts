import { BadRequestException, Controller, Get, Header, Headers, Query } from '@nestjs/common'
import { isUUID } from 'class-validator'
import { ClientNoticeMetadataDto } from './client-metadata.dto.js'
import { ClientNoticesService } from './client-notices.service.js'

function installation(value: unknown): void {
  if (typeof value !== 'string' || !isUUID(value)) throw new BadRequestException('Installation identifier must be a UUID')
}

/** Public client metadata; bearer credentials are neither consumed nor interpreted as an account. */
@Controller('api/v1/client')
export class ClientNoticesController {
  constructor(private readonly notices: ClientNoticesService) {}

  @Get('policy')
  @Header('Cache-Control', 'no-store')
  policy(@Query() client: ClientNoticeMetadataDto, @Headers('x-installation-id') installationId: string | undefined) {
    installation(installationId)
    return this.notices.policy(client)
  }

  @Get('guidance')
  @Header('Cache-Control', 'no-store')
  guidance(@Query() client: ClientNoticeMetadataDto, @Headers('x-installation-id') installationId: string | undefined) {
    installation(installationId)
    return this.notices.guidance(client)
  }
}
