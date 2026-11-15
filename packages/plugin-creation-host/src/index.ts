/** Built-in Creation Host: workbenches, media Providers and durable automatic delivery. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { DeliverablePublisher } from '@deepseek-ai/dsh-tool-present'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { join } from 'node:path'
import type { CanvasNodeTypeId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { creationDomain, jsonObject, workbenchData } from './schema.ts'
import { CreationStore } from './store.ts'
import { CreationJobRunner } from './runner.ts'
import { ConvaxCreationHost } from './service.ts'
import { registerCreationTools } from './tools.ts'
import { createBuiltinProviders } from './providers/index.ts'
import { CreationCliInstallations } from './installations.ts'
import { CreationProviderSetup } from './setup.ts'

export { ConvaxCreationHost } from './service.ts'
export type * from './types.ts'
export const name = 'convax-plugin-creation-host'
export const inject = ['convax', 'storageDomain', 'credentials', 'subprocess', 'fs', 'tools', 'agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'systemPrompt']
export interface Config {
  /** Maximum bytes admitted for each reference or generated media file. */
  maxBytes: number
  /** Interval between read-only Provider status queries, in milliseconds. */
  pollMs: number
}
export const Config: z<Config> = z.object({ maxBytes: z.number().default(512 * 1024 * 1024), pollMs: z.number().default(3000) })

/** Mounts only the Creation node; ordinary Chat and file nodes retain their owners. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!Number.isSafeInteger(config.maxBytes) || config.maxBytes < 1 || !Number.isSafeInteger(config.pollMs) || config.pollMs < 1) throw new Error('Creation byte and polling limits must be positive integers')
  const store = new CreationStore(await ctx.storageDomain.open(creationDomain))
  ctx.effect(() => () => store.close(), 'creation: durable records')
  const publisher = new DeliverablePublisher(ctx)
  await publisher.start()
  ctx.effect(() => () => publisher.close(), 'creation: delivery publisher')
  const runner: CreationJobRunner = new CreationJobRunner({ store, publisher, maxBytes: config.maxBytes, pollMs: config.pollMs,
    provider: id => host.provider(id), report: (error) => { ctx.logger.error('Creation task failed', error) } })
  const installations = new CreationCliInstallations({ directory: join(resolveDshHome(), 'creation', 'cli'), subprocess: ctx.subprocess })
  const setup = new CreationProviderSetup({ subprocess: ctx.subprocess, readCredential: () => Promise.resolve(undefined),
    resolveExecutable: (command, env, signal) => installations.resolveExecutable(command, env, signal) })
  const host: ConvaxCreationHost = new ConvaxCreationHost(ctx, store, runner, config.maxBytes, installations, setup)
  ctx.effect(() => () => host.close(), 'creation: Host tasks')
  ctx.effect(() => ctx.convax.registerNodeType({
    id: 'convax.creation' as CanvasNodeTypeId, dataVersion: 1, capabilities: { provides: ['creation'] },
    description: 'Creation workbench providing configured image, video and audio generation to connected Chats.',
    dataSchema: { type: 'object', properties: { title: { type: 'string' }, routes: { type: 'object' } }, required: ['title', 'routes'], additionalProperties: false },
    ports: [{ id: 'output', direction: 'output', valueKind: 'capability' }], parse: data => jsonObject.parse(workbenchData.parse(data)),
  }), 'creation: workbench node')
  const providers = createBuiltinProviders({ subprocess: ctx.subprocess, readCredential: connection => host.readCredential(connection),
    resolveExecutable: (command, env, signal) => installations.resolveExecutable(command, env, signal) })
  for (const provider of providers) {
    ctx.effect(() => host.registerProvider(provider), `creation: ${provider.descriptor.id}`)
  }
  registerCreationTools(ctx, host)
  ctx.effect(() => ctx.systemPrompt.context({ name: 'convax:creation', order: 255, interpolate: false,
    text: ({ agent }) => agent === undefined ? '' : host.runtimeContext(agent.session.id),
  }), 'creation: bound capabilities and outputs')
  runner.recover()
}
