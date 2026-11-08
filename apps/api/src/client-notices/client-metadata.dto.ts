import { IsIn, IsSemVer, IsString, Matches, MaxLength, MinLength } from 'class-validator'
import type { ClientNoticeArch, ClientNoticeChannel, ClientNoticePlatform } from '@convax/api-contracts/notices'
import type { ClientNoticeAudienceContext } from './catalog.js'

/** Public product metadata only; installation and query fields do not assert an authenticated account. */
export class ClientNoticeMetadataDto implements ClientNoticeAudienceContext {
  @IsString()
  @IsSemVer()
  @MaxLength(64)
  appVersion!: string

  @IsIn(['darwin', 'win32', 'linux', 'web'])
  platform!: ClientNoticePlatform

  @IsIn(['arm64', 'x64', 'universal'])
  arch!: ClientNoticeArch

  @IsIn(['latest', 'nightly'])
  channel!: ClientNoticeChannel

  @IsString()
  @MinLength(2)
  @MaxLength(35)
  @Matches(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u)
  locale!: string
}
