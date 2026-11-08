/** Optional deployment settings for Convax-owned notice delivery. */
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import type { ClientNoticeArch, ClientNoticeChannel, ClientNoticePlatform } from '@convax/api-contracts/notices'
import { ClientNoticeApiSource } from './api-source.ts'
import { NoticeCoordinator } from './coordinator.ts'
import { NoticeFilePersistence } from './persistence.ts'
import type { NoticeCoordinatorConfig } from './types.ts'

/** Explicit product identity, trusted destinations and local delivery limits. */
export interface NoticeDeploymentConfig extends NoticeCoordinatorConfig {
  /** HTTPS API base URL or explicit loopback server; bare origins use /api. */
  origin: string
  /** Installed Convax SemVer, independent of the retained DSH package version. */
  appVersion: string
  /** Installed product platform used for server-side delivery selection. */
  platform: ClientNoticePlatform
  /** Installed application architecture. */
  arch: ClientNoticeArch
  /** Release channel selected by this deployment. */
  channel: ClientNoticeChannel
  /** Language requested for remote announcement content. */
  locale: string
  /** Exact HTTPS origins permitted for announcement and fallback download pages. */
  allowedPageOrigins: string[]
  /** Deadline in milliseconds for each independent policy or guidance request. */
  timeoutMs: number
}

/** Validated deployment choices; the enclosing optional property disables HTTP when absent. */
export const noticeDeploymentSchema: schema<NoticeDeploymentConfig> = schema.object({
  origin: schema.string().required(),
  appVersion: schema.string().required(),
  platform: schema.union(['darwin', 'win32', 'linux', 'web']).required(),
  arch: schema.union(['arm64', 'x64', 'universal']).required(),
  channel: schema.union(['latest', 'nightly']).default('latest'),
  locale: schema.string().default('en'),
  allowedPageOrigins: schema.array(schema.string()).default([]),
  timeoutMs: schema.number().step(1).min(1000).max(120000).default(15000),
  idleMs: schema.number().step(1).min(0).max(600000).default(3000),
  pollIntervalMs: schema.number().step(1).min(1000).max(60000).default(5000),
  failureRetryMs: schema.number().step(1).min(1000).max(3600000).default(60000),
  leaseMs: schema.number().step(1).min(3000).max(300000).default(30000),
  modalCooldownMs: schema.number().step(1).min(0).max(2592000000).default(86400000),
  maxModalPerLaunch: schema.number().step(1).min(0).max(10).default(1),
  messageHoldMs: schema.number().step(1).min(3000).max(60000).default(10000),
})

/**
 * Register the independent Remote even when cloud delivery is disabled.
 * @param ctx - Owning Host plugin.
 * @param databasePath - Convax-owned storage location.
 * @param config - Optional configured notice deployment.
 */
export function registerConvaxNotices(ctx: Context, databasePath: string, config?: NoticeDeploymentConfig): void {
  if (config !== undefined && config.leaseMs < config.pollIntervalMs * 3) throw new Error('Convax notice leaseMs must cover at least three renderer poll intervals')
  const persistence = new NoticeFilePersistence(join(dirname(databasePath), 'convax-notices.json'))
  const history = persistence.load()
  const source = config === undefined ? undefined : new ClientNoticeApiSource({ ...config, installationId: history.installationId })
  // An unconfigured source never polls; these local timings only satisfy the inactive Remote's configuration.
  const inactive: NoticeCoordinatorConfig = { idleMs: 0, pollIntervalMs: 5000, failureRetryMs: 60000,
    leaseMs: 30000, modalCooldownMs: 86400000, maxModalPerLaunch: 1, messageHoldMs: 10000 }
  const coordinator = new NoticeCoordinator(ctx, { ...source === undefined ? {} : { source }, persistence, config: config ?? inactive })
  ctx.effect(() => () => coordinator.dispose(), 'convax: notice lifetime')
}
