/** Packaged Convax authoring resources delivered through the existing DSH skill provider. */
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import type {} from '@deepseek-ai/dsh-skill'

/**
 * Add the packaged development skill while the existing skill registry is available.
 * @param ctx - Convax Host lifetime; skill and provider effects disappear with it.
 */
export function registerConvaxDevelopment(ctx: Context): void {
  ctx.inject(['skills'], (scope) => {
    scope.plugin(SkillFilesystem, {
      providerName: 'convax-development',
      includeDefaultRoots: false,
      bundledSkillDir: fileURLToPath(new URL('../skills', import.meta.url)),
      watch: false,
    })
  })
}
