/** Full-window canvas navigation, resource intake, and file preview. */
import { Clock3, Ellipsis, Plus } from 'lucide-react'
import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button, Input, Menu, Modal, Toast, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  CanvasCommand, CanvasCommandRequest, CanvasConnection, CanvasConnectionId, CanvasDocument, CanvasId, CanvasNodeId,
  CanvasOperationId, CanvasPoint, CanvasResource, CanvasWorkspace,
  CanvasWindowBindingId,
} from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { CanvasConnectionOrigin, WorkspaceProps } from './props.ts'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { DroppedResource } from './CanvasGraph.tsx'
import { nextResourcePosition, RESOURCE_CARD_GAP, RESOURCE_CARD_WIDTH } from './placement.ts'
import css from './Workspace.module.css'
import { CanvasTabs } from './CanvasTabs.tsx'
import { canvasDisplayTitle } from './localized-content.ts'
import { CanvasManager } from './CanvasManager.tsx'
import { recordsCanvasHistory, removedResourceViews, restoredResourceViews } from './canvas-history.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DesktopWindowSourceId } from '@deepseek-ai/dsh-util-desktop-capture'
import type {} from '@deepseek-ai/dsh-client-ui-schedule/client'
import { ActivityMenu } from './ActivityMenu.tsx'
import type { CanvasRendererSnapshot } from './contributions.ts'

const EMPTY_NODE_PLUGINS: CanvasRendererSnapshot = { definitions: {}, creations: [], actions: {} }
const emptySnapshot = (): CanvasRendererSnapshot => EMPTY_NODE_PLUGINS
const subscribeEmpty = (): (() => void) => () => {}

interface ImportNotice {
  added: number
  total: number
  issues: { id: string; name: string; reason: 'path' | 'resource' | 'unconfirmed' }[]
}

interface DirectoryRequest {
  id: number
  promise: Promise<string | null>
  resolve: (path: string | null) => void
  reject: (error: Error) => void
}

type CapturedInput = Parameters<WorkspaceProps['insertInputs']>[2][number]
type CapturedTarget = Pick<CapturedInput, 'nodeId' | 'sessionId'>

function createdConnection(nodeId: CanvasNodeId, origin: CanvasConnectionOrigin): CanvasConnection {
  return {
    id: randomUUID() as CanvasConnectionId,
    source: origin.direction === 'output' ? origin.nodeId : nodeId,
    sourcePort: origin.direction === 'output' ? origin.portId : 'output',
    target: origin.direction === 'input' ? origin.nodeId : nodeId,
    targetPort: origin.direction === 'input' ? origin.portId : 'input',
    purpose: 'input',
  }
}

function Preview({ path, renderFactorySlot, t, close }: {
  readonly path: string
  readonly useResource: WorkspaceProps['useResource']
  readonly renderFactorySlot: WorkspaceProps['renderFactorySlot']
  readonly t: WorkspaceProps['t']
  readonly close: () => void
}) {
  return (
    <Modal open onClose={close} title={path.split(/[\\/]/).at(-1) ?? path} closeLabel={t('files.preview.close')}
      className={`${css.preview}`}>
      <div className={css.previewBody}>
        {renderFactorySlot('convax.resource.preview', { path })}
      </div>
    </Modal>
  )
}

/** Render the full workspace through its single declared shell Slot. */
export function ConvaxWorkspace(props: WorkspaceProps) {
  const plugins = useSyncExternalStore(props.nodePlugins?.subscribe ?? subscribeEmpty, props.nodePlugins?.getSnapshot ?? emptySnapshot)
  props = { ...props, ...plugins.actions }
  const { t, useResource, useStore, actions, execute, describe, refresh } = props
  const view = useStore(value => value)
  const latestView = useRef(view)
  latestView.current = view
  const snapshot = useResource<'convax-workspace'>('dsh-resource://convax-workspace/current')
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [pendingKind, setPendingKind] = useState<'mutation' | 'history' | null>(null)
  const busy = pendingKind !== null
  const historyPending = pendingKind === 'history'
  const mutationPending = useRef(false)
  const [importNotice, setImportNotice] = useState<ImportNotice | null>(null)
  const [toast, setToast] = useState<{
    id: number
    key:
    | 'operation.failed' | 'reference.failed' | 'files.openFailed'
    | 'clipboard.copied' | 'clipboard.copyFailed' | 'clipboard.readFailed' | 'clipboard.invalid' | 'clipboard.changed'
    | 'history.failed'
    | 'automation.failed' | 'automation.canvasRequired'
    | 'chat.directoryFailed'
    | 'activity.unavailable'
    | 'canvas.archived' | 'canvas.unarchived' | 'canvas.duplicated' | 'canvas.purged'
    undoArchive?: CanvasId
  } | null>(null)
  const [menu, setMenu] = useState<'global' | 'canvases' | null>(null)
  const workspaceMenuAnchor = useRef<HTMLButtonElement>(null)
  const [automationOpen, setAutomationOpen] = useState(false)
  const [windowPicker, setWindowPicker] = useState<{ canvasId: CanvasId; position: CanvasPoint; nodeId?: CanvasNodeId } | null>(null)
  const [renaming, setRenaming] = useState<CanvasId | null>(null)
  const [title, setTitle] = useState('')
  const [confirmation, setConfirmation] = useState<CanvasCommandRequest | null>(null)
  const [purge, setPurge] = useState<{ request: CanvasCommandRequest; title: string } | null>(null)
  const directorySequence = useRef(0)
  const mounted = useRef(true)
  const isMounted = (): boolean => mounted.current
  const pendingDirectory = useRef<DirectoryRequest | null>(null)
  const [directoryRequest, setDirectoryRequest] = useState<number | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      const pending = pendingDirectory.current
      pendingDirectory.current = null
      pending?.resolve(null)
    }
  }, [])
  const chooseDirectory = (): Promise<string | null> => {
    if (!mounted.current) return Promise.resolve(null)
    if (pendingDirectory.current !== null) return pendingDirectory.current.promise
    const request = { id: ++directorySequence.current, ...Promise.withResolvers<string | null>() }
    pendingDirectory.current = request
    setDirectoryRequest(request.id)
    return request.promise
  }
  const finishDirectory = (id: number, path: string | null, error?: string): void => {
    const pending = pendingDirectory.current
    if (pending?.id !== id) return
    pendingDirectory.current = null
    setDirectoryRequest(null)
    if (error === undefined) pending.resolve(path)
    else pending.reject(new Error(error))
  }
  const workspace = snapshot.value
  const activity = props.useCanvasActivity(value => value)
  const canvases = workspace?.canvases ?? []
  const active = canvases.find(canvas => canvas.id === view.activeCanvasId && canvas.archived !== true)
  const tabs = view.tabs.flatMap((id) => {
    const canvas = canvases.find(item => item.id === id)
    return canvas === undefined || canvas.archived === true ? [] : [canvas]
  })
  useEffect(() => {
    if (workspace === undefined) return
    for (const canvas of workspace.canvases) {
      if (canvas.archived === true) actions.close(canvas.id)
    }
    actions.reconcile(workspace.canvases.map(canvas => canvas.id), workspace.canvases.flatMap(canvas => canvas.nodes.map(node => node.id)))
  }, [workspace, actions])

  const fail = (): void => { setToast({ id: Date.now(), key: 'operation.failed' }) }
  const captureConnectionTarget = (origin: CanvasConnectionOrigin): CanvasConnectionOrigin =>
    origin.direction !== 'input' || origin.targetSession !== undefined ? origin
      : { ...origin, targetSession: { sessionId: props.captureInput(origin.nodeId) } }
  const connectionTarget = (origin: CanvasConnectionOrigin | undefined): CapturedTarget | undefined => {
    if (origin === undefined) return undefined
    const captured = captureConnectionTarget(origin)
    return captured.targetSession === undefined ? undefined
      : { nodeId: captured.nodeId, sessionId: captured.targetSession.sessionId }
  }
  const insertCommittedInputs = async (
    canvasId: CanvasId, committed: CanvasWorkspace, inputs: readonly CapturedInput[],
  ): Promise<void> => {
    const document = committed.canvases.find(item => item.id === canvasId)
    const chatInputs = inputs.filter(input => committed.chats.some(chat =>
      chat.canvasId === canvasId && chat.nodeId === input.nodeId))
    if (document === undefined || chatInputs.length === 0) return
    try {
      const inserted = await props.insertInputs(canvasId, document.revision, chatInputs)
      if (!inserted) setToast({ id: Date.now(), key: 'reference.failed' })
    } catch (_referenceFailure) { setToast({ id: Date.now(), key: 'reference.failed' }) }
  }
  const runRequest = async (
    request: CanvasCommandRequest, committed?: (document: CanvasDocument | undefined) => void,
    target?: CapturedTarget,
  ): Promise<boolean> => {
    if (mutationPending.current) return false
    mutationPending.current = true
    setPendingKind(request.command.kind === 'history' ? 'history' : 'mutation')
    const before = workspace?.canvases.find(canvas => canvas.id === request.canvasId)
    const beforeViews = latestView.current.resourceViews ?? {}
    if (request.confirmed) actions.stageDeletion(request)
    const connections = request.command.kind === 'add-connection' ? [request.command.connection]
      : request.command.kind === 'add-node' ? request.command.initialConnections ?? [] : []
    const inputs = connections.filter(connection => connection.purpose === 'input').map(connection => ({
      nodeId: connection.target, sourceId: connection.source,
      sessionId: target?.nodeId === connection.target ? target.sessionId : props.captureInput(connection.target),
    }))
    try {
      const result = await execute(request)
      if (!result.ok && result.code === 'confirmation-required') { setConfirmation(request); return false }
      if (!result.ok) {
        if (request.command.kind === 'history') {
          if (result.code === 'operation-pending') actions.stageDeletion(request)
          else actions.finishDeletion(request.operationId)
          setToast({ id: Date.now(), key: 'history.failed' })
        } else {
          if (request.confirmed && result.code !== 'operation-pending') actions.finishDeletion(request.operationId)
          fail()
        }
        return false
      }
      actions.finishDeletion(request.operationId)
      const document = result.workspace.canvases.find(item => item.id === request.canvasId)
      const removedViews = removedResourceViews(before, document, beforeViews)
      const command = request.command
      const savedViews = command.kind === 'history'
        ? latestView.current.histories?.[request.canvasId]?.resourceViews[command.targetOperationId] ?? {} : {}
      actions.reconcile(result.workspace.canvases.map(item => item.id),
        result.workspace.canvases.flatMap(item => item.nodes.map(node => node.id)))
      if (command.kind === 'history') {
        actions.replayHistory(request.canvasId, command.targetOperationId, command.direction, removedViews)
        const restoredViews = restoredResourceViews(before, document, savedViews, latestView.current.resourceViews ?? {})
        for (const [nodeId, resourceView] of Object.entries(restoredViews)) {
          actions.copyResourceView(nodeId as CanvasNodeId, resourceView)
        }
      } else if (recordsCanvasHistory(command)) actions.recordHistory(request.canvasId, request.operationId, removedViews)
      if (command.kind === 'purge') {
        setPurge(current => current?.request.operationId === request.operationId ? null : current)
        setToast({ id: Date.now(), key: 'canvas.purged' })
      }
      committed?.(document)
      await insertCommittedInputs(request.canvasId, result.workspace, inputs)
      return true
    } catch (_operationError) {
      if (request.command.kind === 'history') actions.stageDeletion(request)
      fail()
      return false
    } finally {
      mutationPending.current = false
      setPendingKind(null)
    }
  }
  const run = (
    canvas: Pick<CanvasDocument, 'id' | 'revision'>, command: CanvasCommand,
    committed?: (document: CanvasDocument | undefined) => void,
    target?: CapturedTarget,
  ): Promise<boolean> => runRequest({
    canvasId: canvas.id, expectedRevision: canvas.revision, operationId: randomUUID() as CanvasOperationId, command,
  }, committed, target)
  const replayHistory = (direction: 'undo' | 'redo'): void => {
    if (active === undefined || mutationPending.current) return
    if (Object.values(latestView.current.deletionAttempts ?? {}).some(request => request.canvasId === active.id)) return
    const targetOperationId = latestView.current.histories?.[active.id]?.[direction].at(-1)
    if (targetOperationId === undefined) return
    void run(active, { kind: 'history', targetOperationId, direction })
  }
  const create = async (): Promise<void> => {
    const id = randomUUID() as CanvasId
    if (await run({ id, revision: 0 }, { kind: 'create', title: t('canvas.untitled'), defaultTitle: true })) actions.open(id)
  }
  const rename = (id: CanvasId): void => {
    const canvas = canvases.find(item => item.id === id)
    if (canvas === undefined) return
    setTitle(canvasDisplayTitle(canvas, t))
    setRenaming(id)
  }
  const archive = async (id: CanvasId, archived: boolean): Promise<void> => {
    const canvas = canvases.find(item => item.id === id)
    if (canvas === undefined) return
    if (await run(canvas, { kind: 'set-archived', archived })) {
      if (archived) actions.close(id)
      setToast({ id: Date.now(), key: archived ? 'canvas.archived' : 'canvas.unarchived',
        ...(archived ? { undoArchive: id } : {}) })
    }
  }
  const duplicate = async (id: CanvasId): Promise<void> => {
    const canvas = canvases.find(item => item.id === id)
    if (canvas === undefined) return
    const newCanvasId = randomUUID() as CanvasId
    if (await run(canvas, { kind: 'duplicate', newCanvasId,
      title: t('canvas.copyName', { name: canvasDisplayTitle(canvas, t) }), localizedCopy: true })) {
      const viewport = latestView.current.viewports[id]
      if (viewport !== undefined) actions.setViewport(newCanvasId, viewport)
      actions.open(newCanvasId)
      setMenu(null)
      setToast({ id: Date.now(), key: 'canvas.duplicated' })
    }
  }
  const confirmPurge = (id: CanvasId): void => {
    const canvas = canvases.find(item => item.id === id)
    if (canvas === undefined) return
    setPurge({ title: canvas.title, request: {
      canvasId: id, expectedRevision: canvas.revision, operationId: randomUUID() as CanvasOperationId,
      confirmed: true, command: { kind: 'purge' },
    } })
  }
  const revealThread = async (canvasId: CanvasId, nodeId: CanvasNodeId, sessionId: SessionId, opened?: () => void): Promise<boolean> => {
    const canvas = canvases.find(item => item.id === canvasId)
    const chat = workspace?.chats.find(item => item.canvasId === canvasId && item.nodeId === nodeId)
    if (canvas === undefined || chat === undefined || !chat.threads.some(thread => thread.sessionId === sessionId)) return false
    if (canvas.archived === true && !await run(canvas, { kind: 'set-archived', archived: false })) return false
    actions.focusThread(canvasId, nodeId, sessionId)
    opened?.()
    return true
  }
  const openSource = (path: string): void => {
    void props.revealSource(path).catch((_openFailure: unknown) => {
      setToast({ id: Date.now(), key: 'files.openFailed' })
    })
  }
  const openResource = (resource: CanvasResource): void => {
    if (resource.kind === 'folder') {
      void props.openFolder(resource.path).catch((_openFailure: unknown) => {
        setToast({ id: Date.now(), key: 'files.openFailed' })
      })
    }
    else setPreviewPath(resource.path)
  }
  const addResources = async (
    references: readonly DroppedResource[], position?: CanvasPoint, origin?: CanvasConnectionOrigin,
  ): Promise<void> => {
    if (active === undefined || mutationPending.current || references.length === 0) return
    mutationPending.current = true
    setPendingKind('mutation')
    setImportNotice(null)
    let canvas = active
    let committedWorkspace: CanvasWorkspace | undefined
    const inputs: CapturedInput[] = []
    const targetSessionId = connectionTarget(origin)?.sessionId
    const notice: ImportNotice = { added: 0, total: references.length, issues: [] }
    const report = (name: string, reason: ImportNotice['issues'][number]['reason']): void => {
      notice.issues.push({ id: randomUUID(), name, reason })
    }
    try {
      for (const reference of references) {
        if (reference.path === null) { report(reference.name, 'path'); continue }
        let resource: CanvasResource
        try { resource = await describe(reference.path) }
        catch (_resourceError) { report(reference.name, 'resource'); continue }
        if (resource.kind !== 'file' && resource.kind !== 'folder') {
          report(reference.name, 'resource')
          continue
        }
        try {
          const nodeId = randomUUID() as CanvasNodeId
          const connections = origin === undefined ? [] : [createdConnection(nodeId, origin)]
          const before = canvas
          const request: CanvasCommandRequest = {
            canvasId: canvas.id, expectedRevision: canvas.revision, operationId: randomUUID() as CanvasOperationId,
            command: {
              kind: 'add-node', node: plugins.actions.createResourceNode?.(resource, nodeId,
                position === undefined ? nextResourcePosition(canvas.nodes, plugins.definitions)
                  : { x: position.x + notice.added * (RESOURCE_CARD_WIDTH + RESOURCE_CARD_GAP), y: position.y }) ?? (() => { throw new Error('The resource node plugin is unavailable') })(),
              ...(connections.length === 0 ? {} : { initialConnections: connections }),
            },
          }
          const result = await execute(request)
          if (!result.ok) { report(reference.name, 'unconfirmed'); break }
          const committed = result.workspace.canvases.find(item => item.id === canvas.id)
          if (committed === undefined) { report(reference.name, 'unconfirmed'); break }
          canvas = committed
          actions.recordHistory(request.canvasId, request.operationId,
            removedResourceViews(before, committed, latestView.current.resourceViews ?? {}))
          committedWorkspace = result.workspace
          inputs.push(...connections.map(connection => ({
            nodeId: connection.target, sourceId: connection.source, sessionId: targetSessionId,
          })))
          notice.added += 1
          actions.reconcile(result.workspace.canvases.map(item => item.id),
            result.workspace.canvases.flatMap(item => item.nodes.map(node => node.id)))
          if (canvas.nodes.some(node => node.id === nodeId)) actions.setResourceExpanded(nodeId, true)
        } catch (_operationError) {
          report(reference.name, 'unconfirmed')
          break
        }
      }
      if (committedWorkspace !== undefined) await insertCommittedInputs(canvas.id, committedWorkspace, inputs)
    } finally {
      if (notice.issues.length > 0) setImportNotice(notice)
      mutationPending.current = false
      setPendingKind(null)
    }
  }
  const addProject = async (position: CanvasPoint, origin?: CanvasConnectionOrigin): Promise<void> => {
    const captured = origin === undefined ? undefined : captureConnectionTarget(origin)
    try {
      const path = await chooseDirectory()
      if (path !== null) await addResources([{ name: path, path }], position, captured)
    } catch (_directoryError) { fail() }
  }
  const connectionDirectory = async (origin: CanvasConnectionOrigin | undefined): Promise<string | undefined> => {
    if (origin?.direction !== 'output') return undefined
    const source = active?.nodes.find(node => node.id === origin.nodeId)
    return source === undefined ? undefined : plugins.actions.inputDirectory?.(source)

  }
  const addChat = async (
    directory?: string, folderId?: CanvasNodeId, position?: CanvasPoint, origin?: CanvasConnectionOrigin,
    automation = false,
  ): Promise<void> => {
    if (active === undefined || busy) return
    const target = connectionTarget(origin)
    try {
      const sourceDirectory = directory ?? await connectionDirectory(origin)
      if (!isMounted()) return
      let cwd = sourceDirectory
      if (cwd === undefined) {
        try { cwd = await props.ensureCanvasDirectory(active.id) }
        catch (_directoryError) {
          if (isMounted()) setToast({ id: Date.now(), key: 'chat.directoryFailed' })
          return
        }
      }
      if (!isMounted()) return
      const nodeId = randomUUID() as CanvasNodeId
      const connections = origin === undefined ? [] : [createdConnection(nodeId, origin)]
      if (folderId !== undefined && !connections.some(connection => connection.source === folderId
        && connection.sourcePort === 'output' && connection.target === nodeId && connection.targetPort === 'input')) {
        connections.push(createdConnection(nodeId, { nodeId: folderId, portId: 'output', direction: 'output' }))
      }
      let committed: CanvasDocument | undefined
      const added = await run(active, {
        kind: 'add-node', node: plugins.actions.createChatNode?.(nodeId, cwd, t('chat.untitled'),
          position ?? nextResourcePosition(active.nodes, plugins.definitions)) ?? (() => { throw new Error('The conversation node plugin is unavailable') })(),
        ...(connections.length === 0 ? {} : { initialConnections: connections }),
      }, (document) => { committed = document }, target)
      if (automation && added && committed !== undefined) {
        const result = await props.initializeAutomation({
          canvasId: active.id, nodeId, expectedRevision: committed.revision,
          operationId: randomUUID() as CanvasOperationId, kind: 'create', cwd,
        }, t('automation.prompt'))
        if (!result.ok) { setToast({ id: Date.now(), key: 'automation.failed' }); return }
        actions.focusThread(active.id, nodeId, result.sessionId)
      }
    } catch (_chatCreationError) {
      if (automation) setToast({ id: Date.now(), key: 'automation.failed' })
      else fail()
    }
  }
  const selectWindow = async (sourceId: DesktopWindowSourceId): Promise<boolean> => {
    if (windowPicker === null || props.bindWindow === undefined) return false
    const canvas = workspace?.canvases.find(value => value.id === windowPicker.canvasId)
    if (canvas === undefined) return false
    const nodeId = windowPicker.nodeId ?? randomUUID() as CanvasNodeId
    const bindingId = randomUUID() as CanvasWindowBindingId
    let admitted = false
    try {
      const name = await props.bindWindow(nodeId, bindingId, sourceId)
      if (!mounted.current) return false
      admitted = await run(canvas, windowPicker.nodeId === undefined ? {
        kind: 'add-node', node: plugins.actions.createWindowNode?.(nodeId, bindingId, name, windowPicker.position)
          ?? (() => { throw new Error('The window node plugin is unavailable') })(),
      } : { kind: 'update-node', nodeId, dataVersion: 1, data: { bindingId, name } })
      if (admitted) actions.setResourceExpanded(nodeId, true)
      return admitted
    } finally { if (!admitted) await props.releaseWindow?.(bindingId) }
  }
  const openAutomationSession = async (sessionId: SessionId): Promise<void> => {
    const bound = workspace?.chats.find(chat => chat.threads.some(thread => thread.sessionId === sessionId))
    if (bound !== undefined) {
      await revealThread(bound.canvasId, bound.nodeId, sessionId, () => { setAutomationOpen(false) })
      return
    }
    if (active === undefined) { setToast({ id: Date.now(), key: 'automation.canvasRequired' }); return }
    if (mutationPending.current) return
    mutationPending.current = true
    setPendingKind('mutation')
    try {
      const result = await props.openSession({
        canvasId: active.id, expectedRevision: active.revision, nodeId: randomUUID() as CanvasNodeId,
        sessionId, position: nextResourcePosition(active.nodes, plugins.definitions),
      })
      if (!result.ok) { setToast({ id: Date.now(), key: 'automation.failed' }); return }
      actions.focusThread(result.canvasId, result.nodeId, result.sessionId)
      setAutomationOpen(false)
    } catch (_openFailure) { setToast({ id: Date.now(), key: 'automation.failed' }) }
    finally { mutationPending.current = false; setPendingKind(null) }
  }
  return (
    <section className={css.workspace} data-convax-workspace="">
      {directoryRequest !== null && <Fragment key={directoryRequest}>{props.renderFactorySlot('workspace.directoryPicker', {
        open: true, busy: false,
        onPicked: (path) => { finishDirectory(directoryRequest, path) },
        onCancel: () => { finishDirectory(directoryRequest, null) },
        onError: (message) => { finishDirectory(directoryRequest, null, message) },
      })}</Fragment>}
      {Object.values(view.deletionAttempts ?? {}).map(request => <div key={request.operationId} className={css.notice} role="status">
        {t(request.command.kind === 'history' ? 'history.pending' : request.command.kind === 'purge' ? 'canvas.purgePending' : 'chat.deletePending')}
        <Button size="sm" disabled={busy} onClick={() => { void runRequest(request) }}>{t('workspace.retry')}</Button>
      </div>)}
      <div className={css.body}>
        <main className={css.main}>
          {importNotice !== null && <div className={css.notice} role="alert">
            <p>{t('drop.summary', { added: importNotice.added, total: importNotice.total })}</p>
            <ul>{importNotice.issues.map(issue => <li key={issue.id}>{t(`drop.${issue.reason}`, { name: issue.name })}</li>)}</ul>
            <Button size="sm" onClick={() => { setImportNotice(null) }}>{t('drop.dismiss')}</Button>
          </div>}
          {snapshot.status === 'loading' && workspace === undefined && <div className={css.center}><span className={css.spinner} /></div>}
          {snapshot.status === 'failed' && <div className={css.notice} role="alert">{t('workspace.error')}
            <Button size="sm" onClick={refresh}>{t('workspace.retry')}</Button>
          </div>}
          {active === undefined || workspace === undefined ? (
            <div className={css.empty}>
              <h1>{t('canvas.empty')}</h1>
              <p>{t('workspace.empty')}</p>
              <Button variant="primary" disabled={busy} onClick={() => { void create() }}>{t('canvas.new')}</Button>
            </div>
          ) : (
            <Fragment key={active.id}>{props.renderFactorySlot('convax.graph', {
              document: active, busy, nodeTypes: workspace.nodeTypes, nodeIssues: workspace.nodeIssues,
              rendererDefinitions: plugins.definitions, creations: plugins.creations,
              chats: workspace.chats.filter(chat => chat.canvasId === active.id),
              createChat: (cwd, folderId, position, origin) => { void addChat(cwd, folderId, position, origin) },
              addProject: (position, origin) => { void addProject(position, origin) },
              addWindow: props.windowsAvailable !== true ? undefined : (position, nodeId) => {
                setWindowPicker({ canvasId: active.id, position, ...(nodeId === undefined ? {} : { nodeId }) })
              },
              captureConnectionTarget,
              reportClipboard: (key) => { setToast({ id: Date.now(), key }) },
              history: {
                canUndo: (view.histories?.[active.id]?.undo.length ?? 0) > 0
                  && !Object.values(view.deletionAttempts ?? {}).some(request => request.canvasId === active.id),
                canRedo: (view.histories?.[active.id]?.redo.length ?? 0) > 0
                  && !Object.values(view.deletionAttempts ?? {}).some(request => request.canvasId === active.id),
                pending: historyPending,
              },
              replayHistory,
              threadFocus: view.threadFocus, consumeThreadFocus: actions.consumeThreadFocus,
              viewport: view.viewports[active.id], setViewport: (viewport) => { actions.setViewport(active.id, viewport) },
              inputMode: view.inputMode ?? props.defaultInputMode, setInputMode: actions.setInputMode,
              resourceViews: view.resourceViews ?? {}, setResourceExpanded: actions.setResourceExpanded,
              setResourcePreviewSize: actions.setResourcePreviewSize, applyResourceView: actions.copyResourceView,
              command: command => run(active, command), openResource, openSource,
              resolveFilePath: props.resolveFilePath,
              addResources: (references, position, origin) => { void addResources(references, position, origin) },
            })}</Fragment>
          )}
        </main>
        {previewPath !== null && (
          <Preview key={previewPath} path={previewPath} useResource={useResource}
            renderFactorySlot={props.renderFactorySlot} t={t} close={() => { setPreviewPath(null) }} />
        )}
      </div>
      {windowPicker !== null && props.listWindows !== undefined && props.renderFactorySlot('convax.window.picker', {
        rebind: windowPicker.nodeId !== undefined, list: props.listWindows, select: selectWindow, close: () => { setWindowPicker(null) },
      })}
      {/* Electron applies drag rectangles in DOM order, including clipped canvas controls. */}
      <nav className={css.tabbar} aria-label={t('canvas.all')} data-workspace-titlebar="integrated" data-window-drag="">
        <span className={css.brand}>{t('workspace.title')}</span>
        <div className={css.tabStrip}>
          <CanvasTabs tabs={tabs.map(canvas => ({ ...canvas, title: canvasDisplayTitle(canvas, t) }))} activeId={active?.id} t={t}
            open={(id) => { actions.open(id); setMenu(null) }} close={actions.close} move={actions.moveTab}
            rename={rename} />
          <Tooltip label={t('canvas.new')} side="bottom" portal>
            <Button size="sm" className={css.chromeButton} disabled={busy} aria-label={t('canvas.new')} onClick={() => { void create() }}><Plus size={14} aria-hidden /></Button>
          </Tooltip>
        </div>
        <ActivityMenu items={activity.map(item => ({ ...item,
          title: item.defaultTitle === true ? t('chat.untitled') : item.title,
          canvasTitle: canvasDisplayTitle(canvases.find(canvas => canvas.id === item.canvasId) ?? { title: item.canvasTitle }, t),
        }))} busy={busy} t={t} locale={document.documentElement.lang || 'en'}
        onReadAll={() => { props.markActivityRead(activity.filter(item => item.unread).map(item => item.sessionId)) }}
        onSelect={async (item) => {
          const opened = await revealThread(item.canvasId, item.nodeId, item.sessionId)
          if (opened) props.markActivityRead([item.sessionId])
          else setToast({ id: Date.now(), key: 'activity.unavailable' })
          return opened
        }} />
        <Tooltip label={t('automation.title')} side="bottom" portal>
          <Button size="sm" className={css.automationButton} aria-label={t('automation.open')}
            onClick={() => { setAutomationOpen(true) }}><Clock3 size={14} aria-hidden /><span>{t('automation.open')}</span></Button>
        </Tooltip>
        <CanvasManager anchorRef={workspaceMenuAnchor} canvases={canvases} chats={workspace?.chats ?? []}
          activeId={active?.id} open={menu === 'canvases'}
          busy={busy} t={t} onOpenChange={(open) => { setMenu(open ? 'canvases' : null) }} onSelect={actions.open}
          onRename={rename}
          onArchive={(id, archived) => { void archive(id, archived) }}
          onDuplicate={(id) => { void duplicate(id) }} onDelete={confirmPurge} onCreate={() => { void create() }} />
        <Menu open={menu === 'global'} portal align="end" onClose={() => { setMenu(null) }}
          anchor={<Button ref={workspaceMenuAnchor} size="sm" className={css.chromeButton} aria-label={t('workspace.actions')}
            aria-haspopup={menu === 'canvases' ? 'dialog' : 'menu'} aria-expanded={menu !== null}
            onClick={() => { setMenu(current => current === null ? 'global' : null) }}>
            <Ellipsis size={16} aria-hidden />
          </Button>}
          items={[
            { id: 'canvases', label: t('canvas.all') },
            { type: 'separator', id: 'navigation' },
            { id: 'settings', label: t('workspace.settings') },
            { id: 'plugins', label: t('workspace.plugins') },
          ]} onSelect={(id) => {
            setMenu(null)
            if (id === 'canvases') {
              workspaceMenuAnchor.current?.focus()
              setMenu('canvases')
            }
            else if (id === 'settings') props.openSettings()
            else if (id === 'plugins') props.openPlugins()
          }} />
      </nav>
      <Modal open={automationOpen} onClose={() => { setAutomationOpen(false) }} title={t('automation.title')}
        headless className={`${css.automationDialog}`}>
        <div className={css.automationBody}>{props.renderFactorySlot('schedule.manager', {
          presentation: 'embedded',
          close: { label: t('automation.close'), onClose: () => { setAutomationOpen(false) } },
          onNewTask: () => {
            if (active === undefined) { setToast({ id: Date.now(), key: 'automation.canvasRequired' }); return }
            setAutomationOpen(false)
            void addChat(undefined, undefined, undefined, undefined, true)
          },
          onOpenSession: (sessionId) => { void openAutomationSession(sessionId) },
        })}</div>
      </Modal>
      {toast !== null && <Toast key={toast.id} text={t(toast.key)} onDone={() => { setToast(null) }}
        {...toast.key.startsWith('canvas.') ? { tone: 'success' as const } : {}}
        actions={toast.undoArchive === undefined ? [] : [{ label: t('canvas.undoArchive'), onClick: () => {
          const id = toast.undoArchive
          setToast(null)
          if (id !== undefined) void archive(id, false)
        } }]} />}
      <Modal open={purge !== null} onClose={() => { if (!busy) setPurge(null) }}
        title={t('canvas.purgeTitle', { name: canvasDisplayTitle(workspace?.canvases.find(canvas => canvas.id === purge?.request.canvasId) ?? { title: purge?.title ?? '' }, t) })} closeLabel={t('canvas.cancel')}
        footer={<>
          <Button variant="outline" disabled={busy} onClick={() => { setPurge(null) }}>{t('canvas.cancel')}</Button>
          <Button variant="primary" className={css.dangerButton} disabled={busy} onClick={() => {
            if (purge === null) return
            void runRequest(purge.request)
          }}>{t('canvas.purgeAction')}</Button>
        </>}>
        <p>{t('canvas.purgeDescription')}</p>
        <p>{t('canvas.purgeRetained')}</p>
      </Modal>
      <Modal open={renaming !== null} onClose={() => { setRenaming(null) }}
        title={t('canvas.rename')} closeLabel={t('canvas.cancel')}>
        <form className={css.renameForm} onSubmit={(event) => {
          event.preventDefault()
          const canvas = canvases.find(item => item.id === renaming)
          if (canvas !== undefined && title.trim() !== '') void run(canvas, { kind: 'rename', title: title.trim() }).then((ok) => {
            if (ok) setRenaming(null)
          })
        }}>
          <Input autoFocus aria-label={t('canvas.name')} value={title} onChange={(event) => { setTitle(event.target.value) }} />
          <Button size="sm" type="submit" disabled={busy || title.trim() === ''}>{t('canvas.save')}</Button>
        </form>
      </Modal>
      <Modal open={confirmation !== null} onClose={() => { setConfirmation(null) }}
        title={t('chat.deleteConfirm')} closeLabel={t('canvas.cancel')}
        footer={<>
          <Button variant="outline" onClick={() => { setConfirmation(null) }}>{t('canvas.cancel')}</Button>
          <Button variant="primary" disabled={busy} onClick={() => {
            if (confirmation === null) return
            const pending = confirmation
            setConfirmation(null)
            void runRequest({ ...pending, confirmed: true })
          }}>{t('chat.deleteConfirmAction')}</Button>
        </>}>
        <p>{t('chat.deleteConfirmDescription')}</p>
      </Modal>
    </section>
  )
}
