import { Inject, Injectable } from '@nestjs/common'
import { gte, lt } from 'semver'
import type { ClientGuidanceSnapshot, ClientPolicySnapshot } from '@convax/api-contracts/notices'
import type { ClientNoticeAudience, ClientNoticeAudienceContext, ClientNoticeCatalog } from './catalog.js'

export const CLIENT_NOTICE_CATALOG = Symbol('Convax client notice catalog')

/** Read-only product metadata; no invocation bindings, credentials or local installation state are retained. */
@Injectable()
export class ClientNoticesService {
  constructor(@Inject(CLIENT_NOTICE_CATALOG) private readonly catalog: ClientNoticeCatalog) {}

  policy(client: ClientNoticeAudienceContext): ClientPolicySnapshot {
    const deployment = this.catalog.update
    const snapshot = { ...this.snapshot(), maintenance: this.catalog.maintenance }
    if (deployment === undefined || !this.releaseAvailableFor(client) || !lt(client.appVersion, deployment.minSupportedVersion)) {
      return { ...snapshot, update: { required: false } }
    }
    return { ...snapshot, update: { required: true, minSupportedVersion: deployment.minSupportedVersion,
      targetVersion: deployment.release.version, releaseId: deployment.release.id,
      reasonCode: deployment.reasonCode, fallbackPage: deployment.fallbackPage } }
  }

  guidance(client: ClientNoticeAudienceContext): ClientGuidanceSnapshot {
    const now = Date.now()
    return { ...this.snapshot(now), items: this.catalog.guidance
      .filter(value => Date.parse(value.notice.startsAt) <= now && Date.parse(value.notice.expiresAt) > now
        && ((value.notice.kind !== 'upgrade' && !value.notice.actions.some(action => action.type === 'open_update'))
          || this.releaseAvailableFor(client)) && this.matches(value.audience, client))
      .map(value => value.notice) }
  }

  private snapshot(now = Date.now()) {
    return { schemaVersion: 1 as const, revision: this.catalog.revision,
      serverTime: new Date(now).toISOString(), nextCheckAfterSeconds: this.catalog.nextCheckAfterSeconds }
  }

  private releaseAvailableFor(client: ClientNoticeAudienceContext): boolean {
    const release = this.catalog.update?.release
    return client.platform !== 'web' && release !== undefined && release.available
      && client.platform === release.platform && client.arch === release.arch && client.channel === release.channel
      && lt(client.appVersion, release.version)
  }

  private matches(audience: ClientNoticeAudience | undefined, client: ClientNoticeAudienceContext): boolean {
    return audience === undefined || (
      (audience.minAppVersion === undefined || gte(client.appVersion, audience.minAppVersion))
      && (audience.maxAppVersion === undefined || lt(client.appVersion, audience.maxAppVersion))
      && (audience.platforms === undefined || audience.platforms.includes(client.platform))
      && (audience.arches === undefined || audience.arches.includes(client.arch))
      && (audience.channels === undefined || audience.channels.includes(client.channel))
      && (audience.locales === undefined || audience.locales.some(locale => locale.toLowerCase() === client.locale.toLowerCase()))
    )
  }
}
