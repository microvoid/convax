/** Built-in Creation contributes one workbench node; native Chat and resource displays remain owned elsewhere. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { CanvasNodeId, CanvasNodeTypeId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { CreationRemote } from '@deepseek-ai/dsh-convax-plugin-creation-host/types'
import contribution from '@deepseek-ai/dsh-convax-plugin-creation-host/remote'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { CanvasCreationContext } from '@deepseek-ai/dsh-convax-plugin-renderer/client'
import type {} from '@deepseek-ai/dsh-convax-plugin-renderer/client'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { PanelsTopLeft } from 'lucide-react'
import { WorkbenchNode, Workbench, type WorkbenchInjected } from './Workbench.tsx'
import { CreationWorkbenches } from './workbenches.ts'
import { NS, dictionaries } from './locales.ts'

export { CreationWorkbenches } from './workbenches.ts'
export { WorkbenchNode, Workbench } from './Workbench.tsx'

/** Required Client services; execution and credentials live in the paired Host. */
export const inject = ['convaxRenderer', 'remote', 'slots', 'locale']

async function unwrap<T>(request: Promise<RemoteResult<T>>): Promise<T> {
  const result = await request
  if (!result.ok) throw result.error
  return result.value
}

/** One creation action owns its node defaults; graph commands keep their ordinary transactional owner. */
class WorkbenchCreation {
  constructor(private readonly title: () => string) {}
  create(context: CanvasCreationContext): void {
    void context.command({ kind: 'add-node', node: {
      id: randomUUID() as CanvasNodeId, typeId: 'convax.creation' as CanvasNodeTypeId,
      dataVersion: 1, revision: 0, data: { title: this.title(), routes: {} }, position: context.position,
    } })
  }
}

/** Register the workbench and retain its settings state for this Client plugin lifetime. */
export async function apply(ctx: Context): Promise<void> {
  await ctx.effect(async () => await ctx.remote.$mount(contribution), 'convax creation: Remote contribution')
  ctx.inject(['remote.convaxCreation'], (scope) => {
    const service = scope.remote.convaxCreation
    const remote: CreationRemote = {
      describeWorkbench: ref => unwrap(service.describeWorkbench(ref)),
      configureWorkbench: request => unwrap(service.configureWorkbench(request)),
      listProviders: () => unwrap(service.listProviders()),
      listConnections: ref => unwrap(service.listConnections(ref)),
      inspectConnection: (ref, connectionId) => unwrap(service.inspectConnection(ref, connectionId)),
      saveConnection: request => unwrap(service.saveConnection(request)),
      connectAndApply: request => unwrap(service.connectAndApply(request)),
      prepareConnection: request => unwrap(service.prepareConnection(request)),
      installProvider: (ref, providerId) => unwrap(service.installProvider(ref, providerId)),
      installationStatus: (ref, providerId) => unwrap(service.installationStatus(ref, providerId)),
      beginAuthorization: input => unwrap(service.beginAuthorization(input)),
      authorizationStatus: input => unwrap(service.authorizationStatus(input)),
      listProviderCanvases: (input, cursor) => unwrap(service.listProviderCanvases(input, cursor)),
      createProviderCanvas: (input, request) => unwrap(service.createProviderCanvas(input, request)),
      listPendingApprovals: ref => unwrap(service.listPendingApprovals(ref)),
      listWorkbenchJobs: ref => unwrap(service.listWorkbenchJobs(ref)),
      approveGeneration: request => unwrap(service.approveGeneration(request)),
      rejectGeneration: request => unwrap(service.rejectGeneration(request)),
    }
    const renderer = scope.convaxRenderer
    const cards = new CreationWorkbenches(remote, (workspace) => { renderer.acceptWorkspace(workspace) },
      (error) => { scope.logger.warn('Creation workbench operation failed', error) },
      (url) => { window.open(url, '_blank', 'noopener,noreferrer') })
    const observe = (): void => {
      const workspace = renderer.workspace.getSnapshot()
      if (workspace !== undefined) cards.observe(workspace)
    }
    scope.effect(() => renderer.workspace.subscribe(observe), 'convax creation: canvas observation')
    scope.effect(() => () => { cards.dispose() }, 'convax creation: Client lifetime')
    scope.effect(() => scope.locale.register(NS, dictionaries), 'convax creation: dictionaries')
    observe()
    scope.slots.registerFactory({ name: 'convax.creation.workbench', scope: 'root', locale: NS,
      inject: (): WorkbenchInjected => ({
        keyedHooks: { creationWorkbench: id => cards.state(id as CanvasNodeId) },
        openWorkbench: (id) => { cards.open(id) }, closeWorkbench: (id) => { cards.close(id) },
        chooseProvider: (id, choosing) => { cards.choose(id, choosing) },
        changeTitle: (id, title) => { cards.title(id, title) },
        newConnection: (id, provider) => { cards.newConnection(id, provider) },
        editConnection: (id, connection) => { cards.editConnection(id, connection) },
        useConnection: (id, connection) => cards.useConnection(id, connection),
        credentialSource: (id, source) => { cards.credentialSource(id, source) },
        enableKind: (id, kind, enabled) => { cards.enableKind(id, kind, enabled) },
        prepareConnection: id => cards.prepare(id),
        installProvider: id => cards.installProvider(id),
        checkInstallation: id => cards.checkInstallation(id),
        beginAuthorization: id => cards.beginAuthorization(id),
        checkAuthorization: id => cards.checkAuthorization(id),
        openTasks: (id, open) => { cards.tasks(id, open) },
        refreshTasks: id => cards.refreshTasks(id),
        approveBatch: (id, quotes) => cards.approveBatch(id, quotes),
        openModels: (id, kind) => cards.openModels(id, kind),
        connectProvider: (id, kind, providerId) => { cards.connectProvider(id, kind, providerId) },
        closeModels: (id) => { cards.closeModels(id) },
        selectModel: (id, option) => cards.selectModel(id, option),
        newChat: (id, create) => cards.newChat(id, create),
        rejectGeneration: (id, job) => cards.rejectGeneration(id, job),
        refreshForRetry: id => cards.refreshForRetry(id),
        dismissConnection: (id) => { cards.dismissConnection(id) },
        connectionField: (id, field, value) => { cards.connectionField(id, field, value) },
        connectionSetting: (id, field, value) => { cards.connectionSetting(id, field, value) },
        saveConnection: id => cards.saveConnection(id),
        inspectConnection: (id, connection) => cards.inspect(id, connection),
        saveWorkbench: id => cards.save(id),
      }),
    }, Workbench)
    scope.effect(() => renderer.registerNodeRenderer('convax.creation' as CanvasNodeTypeId, {
      dataVersion: 1, component: WorkbenchNode, defaultSize: { width: 360, height: 310 }, dragHandle: '[data-convax-workbench-header]',
    }), 'convax creation: workbench display')
    const t = scope.locale.bind(NS)
    const creation = new WorkbenchCreation(() => t('title'))
    scope.effect(() => renderer.registerCreation({ id: 'creation', label: () => t('title'), icon: PanelsTopLeft,
      connected: false, defaultSize: { width: 360, height: 310 }, create: (context) => { creation.create(context) },
    }), 'convax creation: add menu')
  })
}
