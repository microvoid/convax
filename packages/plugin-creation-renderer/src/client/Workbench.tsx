/** The only Creation-specific canvas surface: a workbench and its connection dialog. */
import { ArrowLeft, AudioLines, Check, ChevronDown, ChevronRight, Clapperboard, Image, MessageSquarePlus, PanelsTopLeft, Plus } from 'lucide-react'
import { Button, Input, Menu, Modal, Tooltip, type MenuItem } from '@deepseek-ai/dsh-client-ui-primitives'
import { CardToolbar, NodePorts } from '@deepseek-ai/dsh-convax-plugin-renderer/client'
import type { CanvasNodeOwner, CanvasNodeRendererProps } from '@deepseek-ai/dsh-convax-plugin-renderer/client'
import type { CanvasNodeId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { ConnectionId, JobId, JobState, MediaKind, ProviderDescriptor, ProviderInstallation, ProviderSetupReason, WorkbenchJobView } from '@deepseek-ai/dsh-convax-plugin-creation-host/types'
import type { FactoryComponentPropsOf, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkbenchState } from './workbenches.ts'
import { installationActive } from './installations.ts'
import { authorizationActive } from './authorizations.ts'
import type { DisplayedQuote } from './approvals.ts'
import type { CreationKey } from './locales.ts'
import css from './Workbench.module.css'

/** Commands are owned by the window controller, never by mounted React cards. */
export interface WorkbenchInjected {
  readonly openWorkbench: (id: CanvasNodeId) => void
  readonly closeWorkbench: (id: CanvasNodeId) => void
  readonly chooseProvider: (id: CanvasNodeId, choosing: boolean) => void
  readonly changeTitle: (id: CanvasNodeId, title: string) => void
  readonly newConnection: (id: CanvasNodeId, provider: string) => void
  readonly editConnection: (id: CanvasNodeId, connection: ConnectionId) => void
  readonly useConnection: (id: CanvasNodeId, connection: ConnectionId) => Promise<void>
  readonly dismissConnection: (id: CanvasNodeId) => void
  readonly credentialSource: (id: CanvasNodeId, source: 'key' | 'environment') => void
  readonly enableKind: (id: CanvasNodeId, kind: MediaKind, enabled: boolean) => void
  readonly connectionField: (id: CanvasNodeId, field: 'label' | 'credentialRef' | 'apiKey', value: string) => void
  readonly connectionSetting: (id: CanvasNodeId, key: string, value: string | boolean) => void
  readonly prepareConnection: (id: CanvasNodeId) => Promise<void>
  readonly installProvider: (id: CanvasNodeId) => Promise<void>
  readonly checkInstallation: (id: CanvasNodeId) => Promise<void>
  readonly beginAuthorization: (id: CanvasNodeId) => Promise<void>
  readonly checkAuthorization: (id: CanvasNodeId) => Promise<void>
  readonly openTasks: (id: CanvasNodeId, open: boolean) => void
  readonly refreshTasks: (id: CanvasNodeId) => Promise<void>
  readonly approveBatch: (id: CanvasNodeId, quotes: readonly DisplayedQuote[]) => Promise<void>
  readonly openModels: (id: CanvasNodeId, kind: MediaKind) => Promise<void>
  readonly connectProvider: (id: CanvasNodeId, kind: MediaKind, providerId: string) => void
  readonly closeModels: (id: CanvasNodeId) => void
  readonly selectModel: (id: CanvasNodeId, option: string) => Promise<void>
  readonly newChat: (id: CanvasNodeId, create: () => Promise<void>) => Promise<void>
  readonly rejectGeneration: (id: CanvasNodeId, job: JobId) => Promise<void>
  readonly refreshForRetry: (id: CanvasNodeId) => Promise<void>
  readonly saveConnection: (id: CanvasNodeId) => Promise<void>
  readonly inspectConnection: (id: CanvasNodeId, connection: ConnectionId) => Promise<void>
  readonly saveWorkbench: (id: CanvasNodeId) => Promise<void>
  readonly keyedHooks: { readonly creationWorkbench: (id: string) => HostObservable<WorkbenchState> | undefined }
}

type WorkbenchOwner = Pick<CanvasNodeOwner, 'node' | 'canvasId' | 'ports' | 'selected' | 'busy' | 'remove' | 'focusNode' | 'createConnectedChat'> & {
  canvasT: CanvasNodeRendererProps['t']
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'convax-creation': CreationKey }
  interface SlotFactoryMap {
    /** One workbench with its independently retained modal state. */
    'convax.creation.workbench': { scope: 'root'; locale: 'convax-creation'; props: WorkbenchOwner; inject: WorkbenchInjected }
  }
}

type WorkbenchProps = FactoryComponentPropsOf<'convax.creation.workbench'>
type SettingsProps = WorkbenchProps & { state: WorkbenchState }
type ConfigurationField = NonNullable<ProviderDescriptor['configuration']>[number]
const kinds = ['image', 'video', 'audio'] as const
const icons = { image: Image, video: Clapperboard, audio: AudioLines }

/** Present a new workbench through the same registered node factory as other canvas features. */
export function WorkbenchNode(props: CanvasNodeRendererProps) {
  return props.renderFactorySlot('convax.creation.workbench', { node: props.node, canvasId: props.canvasId, ports: props.ports,
    selected: props.selected, busy: props.busy, remove: props.remove, focusNode: props.focusNode,
    createConnectedChat: props.createConnectedChat, canvasT: props.t })
}

/** Render available services without changing Chat or file presentation. */
export function Workbench(props: WorkbenchProps) {
  const { node, t } = props
  const state = props.useCreationWorkbench(node.id)
  const name = typeof node.data.title === 'string' ? node.data.title : t('title')
  const initial = state?.view === undefined
  const pending = initial && (state === undefined || state.loading)
  const action = initial ? pending ? 'loading' : 'unavailable' : state.connections.length ? 'configure' : 'connectServices'
  return <article className={css.node} data-selected={props.selected || undefined} data-convax-creation={node.id}>
    <CardToolbar nodeId={node.id} name={name} t={props.canvasT} actions={[
      { id: 'zoom', label: props.canvasT('node.focus'), onClick: props.focusNode },
      { id: 'remove', label: t('remove'), onClick: props.remove, disabled: props.busy },
    ]} />
    <NodePorts nodeId={node.id} ports={props.ports} connectable={!props.busy} />
    <header className={css.header} data-convax-workbench-header="">
      <PanelsTopLeft size={16} aria-hidden /><Tooltip label={name}><span className={css.title}>{name}</span></Tooltip>
      <Button size="sm" className="nodrag nopan" disabled={props.busy || pending || state.models?.saving}
        onClick={() => { props.openWorkbench(node.id) }}>{t(action)}</Button>
    </header>
    <div className={css.capabilities}>
      {kinds.map(kind => <WorkbenchModel {...props} state={state} key={kind} kind={kind} />)}
    </div>
    <footer className={`${css.cardActions} nodrag nopan`}>
      <Button variant="primary" size="sm" disabled={props.busy || pending || state.chatPending || props.createConnectedChat === undefined}
        onClick={() => { if (props.createConnectedChat !== undefined) void props.newChat(node.id, props.createConnectedChat) }}>
        <MessageSquarePlus size={15} aria-hidden />{t(state?.chatPending ? 'creatingChat' : 'newChat')}</Button>
      <Button size="sm" onClick={() => { props.openTasks(node.id, true) }}>{t('tasks')}
        {state?.approvals !== undefined && state.approvals.items.length > 0 && ` (${state.approvals.items.length})`}</Button>
    </footer>
    {state?.approvals?.items.some(item => item.state === 'awaiting-approval') && <p className={css.taskHint}>{t('approvalsTitle')}</p>}
    {state?.approvals?.failed && <p className={css.error} role="status">{t('tasksFailed')}</p>}
    {state?.error !== null && !state?.open && state?.error !== undefined && <p className={css.error} role="status">{t(state.error)}</p>}
    {state?.open && <WorkbenchSettings {...props} state={state} />}
    {state?.tasksOpen && <WorkbenchTasks {...props} state={state} />}
  </article>
}

function WorkbenchModel(props: WorkbenchProps & { state: WorkbenchState | undefined; kind: MediaKind }) {
  const { node, state, kind, t } = props
  const Icon = icons[kind]
  const route = state?.view?.data.routes[kind]
  const saved = state?.view?.connections.find(item => item.connection.id === route?.connectionId)
  const capability = saved?.inspection.state === 'ready' ? saved.inspection.capabilities.find(item => item.kind === kind) : undefined
  const initial = state?.view === undefined
  const pending = initial && (state === undefined || state.loading)
  const label = capability?.modelLabel ?? route?.modelId ?? capability?.modelId
    ?? t(initial ? pending ? 'loading' : 'unavailable' : route === undefined ? 'unconfigured' : 'unavailable')
  const selection = state?.models
  const open = selection?.kind === kind
  const current = route === undefined || capability === undefined ? undefined
    : JSON.stringify([route.connectionId, route.modelId ?? capability.modelId])
  const items: MenuItem[] = (selection?.providers ?? []).map(provider => ({
    id: provider.id, label: <span className={css.providerChoice}>{provider.title}<ChevronRight size={14} aria-hidden /></span>,
    disabled: selection?.saving === true,
    submenu: provider.connectionIds.length === 0 ? [{
      id: `connect:${provider.id}`, label: t('connectProvider', { provider: provider.title }),
    }] : selection?.loading ? [{ id: `loading:${provider.id}`, label: t('loading'), disabled: true }]
      : [
        ...provider.options.map(option => ({ id: option.id, disabled: selection?.saving === true,
          label: <span className={css.modelChoice}><span>{option.label}</span>
            {provider.connectionIds.length > 1 && <span className={css.muted}>{option.service}</span>}</span>,
        })),
        ...(provider.options.length === 0 ? [{ id: `empty:${provider.id}`, label: t(provider.failed ? 'modelsFailed' : 'noModels'), disabled: true }] : []),
        { id: `connect:${provider.id}`, label: t('configure'), disabled: selection?.saving === true },
      ],
  }))
  return <div className={css.capability}>
    <span className={css.kind}><Icon size={15} aria-hidden />{t(kind)}</span>
    <Menu open={open} portal align="end" selectedIds={[...(saved === undefined ? [] : [saved.connection.providerId]), ...(current === undefined ? [] : [current])]} items={items}
      className={css.modelMenu} listClassName={css.modelList}
      onClose={() => { props.closeModels(node.id) }}
      onSelect={(option) => {
        if (option.startsWith('connect:')) props.connectProvider(node.id, kind, option.slice('connect:'.length))
        else if (option === 'retry') void props.openModels(node.id, kind)
        else if (option === 'manage') { props.closeModels(node.id); props.openWorkbench(node.id) }
        else void props.selectModel(node.id, option)
      }}
      footer={[
        ...(selection?.error !== undefined ? [{ id: 'retry', label: t('retryCheck') }] : []),
        { id: 'manage', label: t('configure'), disabled: selection?.saving === true },
      ]}
      anchor={<Button size="sm" className={`${css.modelTrigger} nodrag nopan`} disabled={props.busy || pending || selection?.saving}
        aria-label={`${t(modelLabels[kind])}: ${label}`} aria-expanded={open}
        onClick={() => { void props.openModels(node.id, kind) }}>
        <span className={css.modelIdentity}><span>{label}</span>{saved !== undefined && <span className={css.muted}>
          {state?.providers.find(provider => provider.id === saved.connection.providerId)?.title ?? saved.connection.label}
        </span>}</span>
        <ChevronDown size={14} aria-hidden /></Button>}>
      {open && !selection.loading && selection.providers.length === 0 && <p className={css.menuNotice}>{t('emptyConnections')}</p>}
      {open && selection.error !== undefined && <p className={css.menuNotice} role="alert">{t(selection.error)}</p>}
      {open && selection.saving && <p className={css.menuNotice} role="status">{t('changingModel')}</p>}
    </Menu>
  </div>
}

function WorkbenchSettings(props: SettingsProps) {
  const { node, state, t } = props
  const provider = state.providers.find(item => item.id === state.connectionDraft?.providerId)
  const title = provider?.title ?? t(state.choosing ? 'addConnection' : 'title')
  return <Modal open title={title} closeLabel={t('close')} onClose={() => { props.closeWorkbench(node.id) }}
    className={css.modal ?? ''} contentClassName={css.modalContent ?? ''}>
    <div className={`${css.settings} nodrag nopan nowheel`}>
      {state.loading && state.draft === undefined
        ? <div className={css.loading} role="status" aria-label={t('loading')}><span className={css.spinner} /></div>
        : state.connectionDraft !== undefined && provider !== undefined
          ? <ConnectionEditor {...props} provider={provider} />
          : state.choosing ? <ProviderPicker {...props} /> : <WorkbenchManagement {...props} />}
      {state.error !== null && <div className={css.errorSpace}><p className={css.error} role="alert">{t(state.error)}</p>
        {state.issue !== undefined && <details className={css.advanced}><summary>{t('details')}</summary><p className={css.notice}>{state.issue}</p></details>}
        {state.error === 'changed' && <Button size="sm" disabled={state.saving} onClick={() => { void props.refreshForRetry(node.id) }}>{t('refreshWorkbench')}</Button>}
      </div>}
    </div>
  </Modal>
}

function ProviderPicker(props: SettingsProps) {
  const { node, state, t } = props
  return <>
    {state.connections.length > 0 && <Button size="sm" className={css.back} disabled={state.saving}
      onClick={() => { props.chooseProvider(node.id, false) }}><ArrowLeft size={14} aria-hidden />{t('back')}</Button>}
    <div className={css.providers}>
      {state.providers.map(provider => <button type="button" key={provider.id} className={css.provider} disabled={state.loading || state.saving}
        aria-label={provider.title} onClick={() => { props.newConnection(node.id, provider.id) }}>
        <span className={css.providerIdentity}><span>{provider.title}</span><span className={css.muted}>
          {provider.connectionKind !== undefined && <>{t(provider.connectionKind === 'cli' ? 'localCli' : 'modelApi')}{' · '}</>}
          {(provider.supportedKinds ?? []).map(kind => t(kind)).join(' / ')}
        </span></span><ChevronRight size={16} aria-hidden />
      </button>)}
    </div>
    {state.connections.length > 0 && <>
      <div className={css.sectionHeader}><h3>{t('existingConnections')}</h3></div>
      <div className={css.connections}>{state.connections.map(connection => <div className={css.connection} key={connection.id}>
        <span className={css.connectionIdentity}>{connection.label}</span>
        <Button size="sm" disabled={state.saving} onClick={() => { void props.useConnection(node.id, connection.id) }}>{t('useConnection')}</Button>
      </div>)}</div>
    </>}
    <div className={css.footer}><Button disabled={state.saving} onClick={() => { props.closeWorkbench(node.id) }}>{t('cancel')}</Button></div>
  </>
}

function WorkbenchManagement(props: SettingsProps) {
  const { node, state, t } = props
  const disabled = state.saving || state.loading
  return <>
    {state.draft !== undefined && <label className={css.field}><span>{t('name')}</span>
      <Input value={state.draft.title} disabled={disabled}
        onChange={(event) => { props.changeTitle(node.id, event.currentTarget.value) }} /></label>}
    <div className={css.sectionHeader}><h3>{t('connections')}</h3><Button size="sm" disabled={disabled}
      onClick={() => { props.chooseProvider(node.id, true) }}><Plus size={14} aria-hidden />{t('addConnection')}</Button></div>
    <div className={css.connections}>{state.connections.map((connection) => {
      const inspection = state.view?.connections.find(item => item.connection.id === connection.id)?.inspection
      return <div key={connection.id} className={css.connection}>
        <div className={css.connectionIdentity}><span>{connection.label}</span>
          {inspection !== undefined && <span className={css.muted}>{inspection.state === 'ready' ? inspection.capabilities.map(capability => capability.modelLabel ?? capability.modelId).filter(Boolean).join(' / ') || t('ready') : t(setupReasonKeys[inspection.reason])}</span>}
        </div>
        <Button size="sm" disabled={disabled} onClick={() => { props.editConnection(node.id, connection.id) }}>{t('edit')}</Button>
      </div>
    })}</div>
    <footer className={css.footer}><Button disabled={state.saving} onClick={() => { props.closeWorkbench(node.id) }}>{t('cancel')}</Button>
      <Button variant="primary" disabled={disabled || state.draft === undefined} onClick={() => { void props.saveWorkbench(node.id) }}>{t('save')}</Button></footer>
  </>
}

const taskStateKeys: Record<JobState, CreationKey> = {
  queued: 'taskQueued', submitting: 'taskStarting', running: 'taskRunning', reconciling: 'taskChecking',
  'awaiting-approval': 'approvalsTitle', approving: 'taskStarting', materializing: 'taskDownloading', publishing: 'taskPublishing',
  completed: 'taskCompleted', failed: 'taskFailed', cancelled: 'taskCancelled', blocked: 'unavailable',
}

function taskStatus(item: WorkbenchJobView): CreationKey {
  if (item.state === 'completed' && item.outcome === 'none-succeeded') return 'taskFailed'
  if (item.state === 'completed' && item.outcome === 'partially-succeeded') return 'taskPartial'
  return taskStateKeys[item.state]
}

function WorkbenchTasks(props: SettingsProps) {
  const { node, state, t } = props
  const tasks = state.approvals
  const quotes = (tasks?.items ?? []).flatMap(item => item.state === 'awaiting-approval' && item.approval !== undefined
    ? [{ jobId: item.jobId, quoteId: item.approval.quoteId, credits: item.approval.credits }] : [])
  const total = quotes.reduce((sum, quote) => sum + quote.credits, 0)
  return <Modal open title={t('tasksTitle')} closeLabel={t('close')} onClose={() => { props.openTasks(node.id, false) }}
    className={css.modal ?? ''} contentClassName={css.modalContent ?? ''}>
    <div className={`${css.settings} nodrag nopan nowheel`}>
      {quotes.length > 0 && <section className={css.batchSummary} aria-label={t('approvalsTitle')}>
        <div><h3>{t('batchCount', { count: quotes.length })}</h3><p>{t('batchLimit', { credits: total })}</p></div>
        <Button type="button" variant="primary" disabled={tasks?.pending !== undefined}
          onClick={() => { void props.approveBatch(node.id, quotes.map(({ jobId, quoteId }) => ({ jobId, quoteId }))) }}>
          {t(tasks?.pending === 'batch' ? 'taskStarting' : 'approveBatch')}</Button>
      </section>}
      {tasks === undefined && <div className={css.loading} role="status" aria-label={t('loading')}><span className={css.spinner} /></div>}
      {tasks?.items.length === 0 && !tasks.failed && <p className={css.notice}>{t('noTasks')}</p>}
      {tasks?.failed && <div className={css.connection}><p className={css.error} role="alert">{t('tasksFailed')}</p>
        <Button type="button" size="sm" onClick={() => { void props.refreshTasks(node.id) }}>{t('retryCheck')}</Button></div>}
      {tasks?.items.map(item => <article key={item.jobId} className={css.task} data-creation-job={item.jobId}>
        <header className={css.taskHeader}><span className={css.kind}>{t(item.kind)}</span>
          <span className={css.taskStatus} data-state={item.state} role="status">{t(taskStatus(item))}</span></header>
        <p className={css.notice}>{item.prompt}</p>
        {item.state === 'awaiting-approval' && item.approval !== undefined && <div className={css.connection}>
          <span className={css.muted}>{t('approvalLimit', { credits: item.approval.credits })}</span>
          <Button type="button" size="sm" disabled={tasks.pending !== undefined}
            onClick={() => { void props.rejectGeneration(node.id, item.jobId) }}>{t('rejectGeneration')}</Button></div>}
        {item.state === 'completed' && item.outputs.some(output => output.delivery === 'projected') && <p className={css.muted}>{t('taskOnCanvas')}</p>}
        {(item.issues.length > 0 || item.outputs.some(output => output.issues.length > 0)) && <><p className={css.error}>{t('taskNeedsAttention')}</p>
          <details className={css.advanced}><summary>{t('details')}</summary>
            <p className={css.notice}>{[...item.issues, ...item.outputs.flatMap(output => output.issues)].map(issue => issue.message).join('\n')}</p>
          </details></>}
        {tasks.failedJobs.includes(item.jobId) && <p className={css.error} role="alert">{t('approvalFailed')}</p>}
      </article>)}
      <footer className={css.footer}><Button type="button" onClick={() => { props.openTasks(node.id, false) }}>{t('close')}</Button></footer>
    </div>
  </Modal>
}

function settingText(value: unknown): string { return typeof value === 'string' || typeof value === 'number' ? String(value) : '' }

const setupReasonKeys: Record<ProviderSetupReason, CreationKey> = {
  'not-installed': 'installUnsupported', 'not-authorized': 'signInNeeded', 'invalid-configuration': 'setupInvalid',
  unreachable: 'setupUnreachable', 'unsafe-url': 'setupUnsafeUrl', 'provider-unloaded': 'setupUnavailable',
  'authorization-failed': 'authorizationFailed', 'request-conflict': 'setupConflict',
}

const modelLabels: Record<MediaKind, CreationKey> = { image: 'imageModel', video: 'videoModel', audio: 'audioModel' }

function ProviderField(props: SettingsProps & { field: ConfigurationField }) {
  const { node, state, field, t } = props
  const draft = state.connectionDraft
  if (draft === undefined) return null
  const mediaKind = field.mediaKind
  const enabled = mediaKind === undefined || draft.enabledKinds.includes(mediaKind)
  const models = state.preparation?.state === 'ready' ? state.preparation.models.filter(model => model.kind === mediaKind) : []
  const value = enabled ? settingText(draft.settings[field.key]) : ''
  const label = mediaKind === undefined ? field.label : t(modelLabels[mediaKind])
  const required = field.required || (mediaKind !== undefined && state.targetKind === mediaKind)
  const input = field.type === 'boolean'
    ? <input type="checkbox" checked={draft.settings[field.key] === true} disabled={state.saving}
      onChange={(event) => { props.connectionSetting(node.id, field.key, event.currentTarget.checked) }} />
    : models.length > 0 ? <select className={css.select} required={required} disabled={state.saving} value={value}
      onChange={(event) => { props.connectionSetting(node.id, field.key, event.currentTarget.value) }}>
      <option value="">{t(required ? 'selectModel' : 'unconfigured')}</option>
      {value !== '' && !models.some(model => model.id === value) && <option value={value}>{value}</option>}
      {models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
    </select> : <Input type={field.type} required={required} placeholder={field.placeholder ?? (mediaKind === undefined ? undefined : t('modelHint'))}
      disabled={state.saving} value={value}
      onBlur={field.affectsSetup ? () => { void props.prepareConnection(node.id) } : undefined}
      onChange={(event) => { props.connectionSetting(node.id, field.key, event.currentTarget.value) }} />
  if (mediaKind !== undefined) {
    const Icon = icons[mediaKind]
    return <label className={css.modelField}><span className={css.kind}><Icon size={16} aria-hidden />{label}</span>{input}</label>
  }
  return <label className={field.type === 'boolean' ? css.checkboxField : css.field}><span>{label}</span>{input}</label>
}

function AuthorizationStatus(props: SettingsProps) {
  const { state, t } = props
  const observation = state.authorization, status = observation?.status
  if (observation === undefined) return null
  const statusKey: CreationKey | undefined = observation.statusUnavailable ? 'authorizationStatusFailed'
    : status?.state === 'expired' ? 'authorizationExpired' : status?.state === 'rejected' ? 'authorizationRejected'
      : status?.state === 'failed' ? status.reason === undefined ? 'authorizationFailed' : setupReasonKeys[status.reason]
        : status?.state === 'waiting' ? 'authorizationWaiting' : status?.state === 'starting' ? 'authorizing' : undefined
  return <div className={css.installation}>
    {statusKey !== undefined && <p className={css.notice} role="status">{t(statusKey)}</p>}
    {status?.state === 'waiting' && <>
      {status.userCode !== undefined && <p className={css.notice}>{t('authorizationCode')}: <code>{status.userCode}</code></p>}
      {status.expiresAt !== undefined && <p className={css.muted}>{t('authorizationExpiry', { time: new Date(status.expiresAt).toLocaleTimeString() })}</p>}
      <p className={css.muted}>{t('authorizationContinues')}</p>
      {observation.openFailed && <p className={css.notice}>{t('authorizationOpenFailed')}</p>}
    </>}
    {status?.message && <details className={css.advanced}><summary>{t('details')}</summary><p className={css.notice}>{status.message}</p></details>}
  </div>
}

function KeyField(props: SettingsProps) {
  const { node, state, t } = props
  const draft = state.connectionDraft
  if (draft === undefined) return null
  return draft.credentialSource === 'key'
    ? <label className={css.field}><span>{t('apiKey')}</span><Input type="password" autoComplete="new-password" value={draft.apiKey}
      disabled={state.saving} placeholder={t(draft.id === undefined ? 'newApiKeyHint' : 'apiKeyHint')}
      onChange={(event) => { props.connectionField(node.id, 'apiKey', event.currentTarget.value) }}
      onBlur={() => { if (draft.apiKey !== '' || draft.id !== undefined) void props.prepareConnection(node.id) }} /></label>
    : <label className={css.field}><span>{t('credentialRef')}</span><Input required value={draft.credentialRef} disabled={state.saving}
      placeholder={t('credentialHint')} onChange={(event) => { props.connectionField(node.id, 'credentialRef', event.currentTarget.value) }}
      onBlur={() => { if (draft.credentialRef !== '') void props.prepareConnection(node.id) }} /></label>
}

const installationStages: Record<ProviderInstallation['state'], CreationKey> = {
  idle: 'installChecking', checking: 'installChecking', downloading: 'installDownloading', installing: 'installInstalling',
  verifying: 'installVerifying', ready: 'installReady', failed: 'installFailed',
}

function InstallationStatus(props: SettingsProps) {
  const { state, t } = props
  const installation = state.installation
  if (installation === undefined) return null
  if (installation.statusUnavailable) return <p className={css.notice} role="alert">{t('installStatusFailed')}</p>
  if (installation.requestFailed) return <p className={css.notice} role="alert">{t('installRequestFailed')}</p>
  const status = installation.status
  if (status?.state === 'failed') return <div className={css.installation} role="alert">
    <p className={css.notice}>{t('installFailed')}</p>
    {status.message !== undefined && <details className={css.advanced}><summary>{t('details')}</summary><p className={css.muted}>{status.message}</p></details>}
  </div>
  if (status?.state === 'idle' && !installation.pending) return null
  const active = installation.pending || installationActive(status)
  return <div className={css.installation} role="status" aria-live="polite">
    <p className={css.prepared}>
      {active ? <span className={css.spinner} /> : <Check size={16} aria-hidden />}
      {t(status === undefined ? 'installChecking' : installationStages[status.state])}
    </p>
    {status?.state === 'downloading' && <progress className={css.installProgress} aria-label={t('installDownloading')}
      max={status.totalBytes && status.totalBytes > 0 ? status.totalBytes : 1}
      value={status.totalBytes && status.totalBytes > 0 ? Math.min(status.receivedBytes ?? 0, status.totalBytes) : undefined} />}
    {active && <p className={css.muted}>{t('installContinues')}</p>}
  </div>
}

function ConnectionEditor(props: SettingsProps & { provider: ProviderDescriptor }) {
  const { node, state, t, provider } = props
  const draft = state.connectionDraft
  if (draft === undefined) return null
  const installing = state.installation?.pending === true || installationActive(state.installation?.status)
  const unknownInstallation = state.installation?.statusUnavailable === true
  const authorization = state.authorization
  const authorizing = authorization?.pending === true || authorizationActive(authorization?.status)
  const missing = provider.connectionKind === 'cli' && state.preparation?.state === 'unavailable'
    && state.preparation.reason === 'not-installed'
  const blocked = provider.connectionKind === 'cli' && state.preparation?.state === 'unavailable'
    && (state.preparation.reason === 'not-installed' || state.preparation.reason === 'not-authorized')
  const fields = (provider.configuration ?? []).filter(field => !field.managed
    && (state.targetKind === undefined || field.mediaKind === undefined || field.mediaKind === state.targetKind))
  return <form className={css.editor} onSubmit={(event) => { event.preventDefault(); void props.saveConnection(node.id) }}>
    <Button type="button" size="sm" className={css.back} disabled={state.saving} onClick={() => { props.dismissConnection(node.id) }}>
      <ArrowLeft size={14} aria-hidden />{t('back')}
    </Button>
    <InstallationStatus {...props} />
    <AuthorizationStatus {...props} />
    {(provider.unsupportedKinds ?? []).map(capability => <p key={capability.kind} className={css.muted}>
      {t('exportUnavailable', { kind: t(capability.kind) })}
    </p>)}
    {state.preparing && <div className={css.preparing} role="status" aria-label={t('checking')}><span className={css.spinner} /></div>}
    {!state.preparing && state.preparation?.state === 'ready' && <p className={css.prepared}><Check size={16} aria-hidden />{t(provider.connectionKind === 'cli' ? 'localAccountReady' : 'catalogReady')}</p>}
    {!installing && !state.preparing && state.preparation?.state === 'unavailable' && state.issue === undefined && <p className={css.notice} role="status">
      {missing ? t('missingCli', { provider: provider.title }) : t(setupReasonKeys[state.preparation.reason])}
    </p>}
    {missing && !installing && <div className={css.installation}>
      {!provider.installation?.supported && <p className={css.notice}>{t('installUnsupported')}</p>}
      {provider.installation !== undefined && <a className={css.installHelp} href={provider.installation.helpUrl}
        target="_blank" rel="noopener noreferrer">{t('installHelp')}</a>}
    </div>}
    {!blocked && !installing && !unknownInstallation && !authorizing && !authorization?.statusUnavailable && <>
      {provider.usesApiKey && !provider.credentialOptional && <KeyField {...props} />}
      <div className={css.modelFields}>
        {kinds.flatMap(kind => fields.filter(field => field.mediaKind === kind && !field.advanced))
          .map(field => <ProviderField {...props} key={field.key} field={field} />)}
      </div>
      <div className={css.fields}>{fields.filter(field => !field.advanced && field.mediaKind === undefined)
        .map(field => <ProviderField {...props} key={field.key} field={field} />)}</div>
      <p className={css.muted}>{state.targetKind === undefined ? t('applyHint') : t('applyKindHint', { kind: t(state.targetKind) })}</p>
    </>}
    <details className={css.advanced}>
      <summary>{t('advanced')}</summary>
      <div className={css.fields}>
        <label className={css.field}><span>{t('connectionName')}</span><Input value={draft.label} disabled={state.saving}
          onChange={(event) => { props.connectionField(node.id, 'label', event.currentTarget.value) }} /></label>
        {fields.filter(field => field.advanced).map(field => <ProviderField {...props} key={field.key} field={field} />)}
        {provider.usesApiKey && <>
          <label className={css.field}><span>{t('credentialSource')}</span><select className={css.select} value={draft.credentialSource} disabled={state.saving}
            onChange={(event) => { props.credentialSource(node.id, event.currentTarget.value === 'environment' ? 'environment' : 'key') }}>
            <option value="key">{t('keySource')}</option><option value="environment">{t('environmentSource')}</option>
          </select></label>
          {provider.credentialOptional && <><p className={css.muted}>{t('localAccountHint')}</p><KeyField {...props} /></>}
        </>}
        <Button type="button" size="sm" disabled={state.saving || state.preparing || installing || authorizing}
          onClick={(event) => { event.preventDefault(); void props.prepareConnection(node.id) }}>{t('inspect')}</Button>
      </div>
    </details>
    <div className={css.footer}>
      <Button type="button" disabled={state.saving} onClick={() => { props.closeWorkbench(node.id) }}>{t(installing || authorizing ? 'close' : 'cancel')}</Button>
      <ConnectionPrimary {...props} />
    </div>
  </form>
}


function ConnectionPrimary(props: SettingsProps & { provider: ProviderDescriptor }) {
  const { node, state, provider, t } = props
  if (state.preparing) return <Button key="preparing" type="button" variant="primary" disabled>{t('checking')}</Button>
  if (state.installation?.statusUnavailable) return <Button key="check-installation" type="button" variant="primary"
    onClick={(event) => { event.preventDefault(); void props.checkInstallation(node.id) }}>{t('retryCheck')}</Button>
  if (state.installation?.pending || installationActive(state.installation?.status)) {
    return <Button key="installing" type="button" variant="primary" disabled>{t('installInProgress')}</Button>
  }
  const unavailable = state.preparation?.state === 'unavailable' ? state.preparation : undefined
  if (unavailable?.reason === 'not-installed' && provider.installation?.supported) {
    const retry = state.installation?.status?.state === 'failed' || state.installation?.requestFailed === true
    return <Button key="install" type="button" variant="primary"
      onClick={(event) => { event.preventDefault(); void props.installProvider(node.id) }}>
      {t(retry ? 'retryInstallProvider' : 'installProvider', { provider: provider.title })}</Button>
  }
  const authorization = state.authorization
  if (authorization?.statusUnavailable) return <Button key="check-authorization" type="button" variant="primary"
    onClick={(event) => { event.preventDefault(); void props.checkAuthorization(node.id) }}>{t('retryCheck')}</Button>
  if (authorization?.status?.state === 'waiting' && authorization.status.verificationUrl !== undefined) {
    return <a key="open-authorization" className={css.installHelp} href={authorization.status.verificationUrl}
      target="_blank" rel="noopener noreferrer">{t('reopenAuthorization')}</a>
  }
  if (authorization?.pending || authorizationActive(authorization?.status)) {
    return <Button key="authorizing" type="button" variant="primary" disabled>{t('authorizing')}</Button>
  }
  if (provider.authorization && unavailable?.reason === 'not-authorized') {
    const retry = authorization?.status?.state !== undefined && ['expired', 'rejected', 'failed'].includes(authorization.status.state)
    return <Button key="authorize" type="button" variant="primary"
      onClick={(event) => { event.preventDefault(); void props.beginAuthorization(node.id) }}>
      {retry ? t('retryAuthorization') : t('authorizeProvider', { provider: provider.title })}</Button>
  }
  if (provider.connectionKind === 'cli' && (unavailable?.reason === 'not-installed' || unavailable?.reason === 'not-authorized')) {
    return <Button key="check-connection" type="button" variant="primary" disabled={state.saving}
      onClick={(event) => { event.preventDefault(); void props.prepareConnection(node.id) }}>{t('retryCheck')}</Button>
  }
  return <Button key="connect" type="submit" variant="primary" disabled={state.saving}>
    {t(state.saving ? 'connecting' : 'saveConnection')}</Button>
}
