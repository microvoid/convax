/** Canvas-owned navigation around retained DSH Conversation and native tool surfaces. */
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { CanvasOperationId, CanvasThreadRequest, CanvasThreadResult } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { ChatHeaderProps, ChatProps, ChatResizeControls, ChatSessionProps, ChatThreadProps, ChatToolsProps, ChatViewsProps } from './props.ts'
import { resourceAddress } from './resources.ts'
import css from './ChatCard.module.css'
import { CHAT_CARD_WIDTH } from './placement.ts'
import { ChatResizeHandle } from './ChatResizeHandle.tsx'
import type { ChatSize } from './chat-size.ts'
import { useToolsCardHeight } from './use-tools-card-height.ts'
import { CardToolbar } from './CardToolbar.tsx'
import { DiagnosticDetails } from './DiagnosticDetails.tsx'
import { ThreadTabs } from './ThreadTabs.tsx'
import { orderedChatThreads } from './thread-order.ts'

/**
 * Render the native Conversation flow and its separate composer without duplicate titles.
 * @param props - Session seats and navigation callbacks bound to the owning Chat.
 * @returns The retained flow and composer.
 */
export function ChatSession(props: ChatSessionProps) {
  const container = useRef<HTMLDivElement>(null)
  const session = props.useSession(value => value)
  const conversation = props.useConversation(value => value)
  const summaryBlank = props.useSessions(state => state.byId[props.sessionId]?.blank)
  const active = conversation.activeTargets.size > 0 || (!session.blank && !session.awaitingFirstTurn) || session.running
  const settling = !active && session.openState === 'loading' && summaryBlank !== true
  const hero = !active && !settling
  return <div ref={container} className={css.chatConversation} data-convax-chat-phase={settling ? 'settling' : hero ? 'hero' : 'active'}>
    {props.renderFactorySlot('conversation.content', {
      variant: 'embedded', composerPlacement: 'below', heroBrand: 'hidden', heroWorkspace: 'hidden',
      phase: settling ? 'settling' : hero ? 'hero' : 'active', hero,
      onSelectWorkspace: props.onSelectWorkspace, onFork: props.onFork,
      onNewSessionWithPreset: props.onNewSessionWithPreset,
    })}
    {props.resize !== undefined && <ChatResizeHandle container={container} actions={props.resize}
      label={props.resize.label} help={props.resize.help} />}
  </div>
}

/**
 * Place the selected thread's native tools in its tab row.
 * @param props - Explicit Session seats and native Factory rendering.
 * @returns The native tools toggle.
 */
export function ChatHeader(props: ChatHeaderProps) {
  return <>{props.renderFactorySlot('schedule.session', {})}{props.renderFactorySlot('conversation.header.content', {
    hideChrome: false, presentation: 'toolbar', views: 'hidden', actionsTrigger: 'hidden',
  })}</>
}

/**
 * Render native view choices inside the selected thread's dropdown.
 * @param props - Selected Session seats and the containing menu's dismissal action.
 * @returns Menu rows that keep view selection under the native Conversation owner.
 */
export function ChatViews(props: ChatViewsProps) {
  return props.renderFactorySlot('conversation.views.menu', { onDismiss: props.onDismiss })
}

/**
 * Reuse the native tool pane under the explicitly retained thread.
 * @param props - Selected-thread visibility and native Factory rendering.
 * @returns A normal-flow pane whose native tabs stay mounted while hidden.
 */
export function ChatTools(props: ChatToolsProps) {
  return props.renderFactorySlot('sidebar.right.embedded', {
    width: props.width, fullscreenWidth: props.fullscreenWidth, active: props.active, resize: props.resize,
  })
}

/**
 * Retain one visited thread's native flow, editor and tools across local tab switches.
 * @param props - Stable Session identity and visibility within the owning Chat.
 * @returns Grid cells sharing one Session provider, or the thread's loading failure.
 */
export function ChatThread(props: ChatThreadProps) {
  const resource = props.useResource<'convax-thread'>(resourceAddress('convax-thread', props.sessionId))
  const body = useRef<HTMLDivElement>(null)
  const tools = useRef<HTMLDivElement>(null)
  useToolsCardHeight(body, tools, props.active && !props.collapsed, resource.value !== undefined, props.layoutChanged)
  return <div className={css.chatOccurrence} hidden={!props.active || props.collapsed} data-convax-thread={props.sessionId}>
    {resource.value === undefined ? <div ref={body} className={`${css.chatBody} ${css.chatPendingBody} nodrag nopan`}>
      {resource.status === 'loading' && <div className={css.center}><span className={css.spinner} /></div>}
      {resource.status === 'failed' && <p className={css.notice} role="alert">{props.t('chat.loadFailed')}</p>}
      {props.active && !props.collapsed && props.resize !== undefined && <ChatResizeHandle container={body}
        actions={props.resize} label={props.resize.label} help={props.resize.help} useContainer />}
    </div> : <props.SessionProvider session={resource.value.reference}>
      <div ref={body} className={`${css.chatBody} nodrag nopan`}>
        {props.renderSlot('convax.chat.session', {
          onSelectWorkspace: props.onSelectWorkspace, onFork: props.onFork,
          onNewSessionWithPreset: props.onNewSessionWithPreset,
          ...(props.active && !props.collapsed && props.resize !== undefined ? { resize: props.resize } : {}),
        })}
      </div>
      <div ref={tools} className={`${css.chatToolsHost} nodrag nopan`}>
        {props.renderSlot('convax.chat.tools', { active: props.active && !props.collapsed, ...props.tools })}
      </div>
    </props.SessionProvider>}
  </div>
}

/**
 * Keep Chat identity, thread navigation and graph gestures separate from native conversation state.
 * In-flight creation keeps its placeholder; restored or failed attempts offer recovery.
 * @param props - Durable Chat metadata, window preferences and revision-bound graph actions.
 * @returns A Chat column and its current thread's attached native tool pane.
 */
export function ChatCard(props: ChatProps) {
  const updateNodeInternals = useUpdateNodeInternals()
  const { chat, canvasRevision, t, actions, useStore, createThread, ensureInitialThread, useResource, SessionProvider, renderSlot } = props
  const stored = useStore(state => state.selectedThreads[chat.nodeId])
  const visited = useStore(state => state.visitedThreads?.[chat.nodeId])
  const collapsed = useStore(state => state.collapsedChats?.[chat.nodeId] === true)
  const attempt = useStore(state => state.threadAttempts[chat.nodeId])
  const archived = props.useWorkspaces(state => state.archivedSessionIds)
  const order = useStore(state => state.threadOrders?.[chat.nodeId])
  const threads = orderedChatThreads(chat.threads, order).filter(thread => !archived.includes(thread.sessionId))
  const focus = threads.find(thread => thread.sessionId === props.focusSessionId)?.sessionId
  const first = chat.threads.find(thread => !archived.includes(thread.sessionId))?.sessionId
  const selected = focus ?? threads.find(thread => thread.sessionId === stored)?.sessionId ?? first
  const savedSize = useStore(state => state.sizes?.[chat.nodeId])
  const toolWidths = useStore(state => state.toolWidths?.[chat.nodeId])
  const [sizePreview, setSizePreview] = useState<{ sessionId: SessionId | undefined; size: ChatSize } | null>(null)
  const size = sizePreview !== null && sizePreview.sessionId === selected ? sizePreview.size : savedSize
  const header = useRef<HTMLDivElement>(null)
  const pendingBody = useRef<HTMLDivElement>(null)
  const expandedHeight = useRef(240)
  const headerResource = useResource<'convax-thread'>(resourceAddress('convax-thread', selected ?? ''))
  const mounted = new Set([first, selected, ...visited ?? []])
  useEffect(() => props.bindInput(chat.nodeId, selected), [props.bindInput, chat.nodeId, selected])
  const summaries = props.useSessions(state => state.byId)
  const workspaces = props.useWorkspaces(state => state.items)
  const statuses = props.useSessionStatus(state => state)
  const [busy, setBusy] = useState(false)
  const [restoredOperation] = useState(attempt?.operationId)
  const [failedOperation, setFailedOperation] = useState<CanvasOperationId>()
  const [menu, setMenu] = useState<'thread' | 'settings' | null>(null)
  useEffect(() => { setSizePreview(null); setMenu(null) }, [selected, collapsed])
  const running = useRef(false)
  const initialized = useRef<typeof chat.nodeId>()
  useEffect(() => {
    if (focus === undefined) return
    actions.selectThread(chat.nodeId, focus)
    actions.setCollapsed(chat.nodeId, false)
    props.consumeFocus()
  }, [focus, chat.nodeId, actions, props.consumeFocus])

  const submit = useCallback(async (request: CanvasThreadRequest, initial = false): Promise<boolean> => {
    if (running.current || chat.deleting) return false
    running.current = true
    setBusy(true)
    setFailedOperation(undefined)
    let submitted = request
    const stage = (actual: CanvasThreadRequest): void => {
      submitted = actual
      actions.stageThread(chat.nodeId, actual)
    }
    try {
      let result: CanvasThreadResult
      if (initial) result = await ensureInitialThread(request, stage)
      else {
        stage(request)
        result = await createThread(request)
      }
      if (result.ok) {
        actions.finishThread(chat.nodeId, submitted.operationId, result.sessionId)
        return true
      }
      if (result.code === 'deleting' || result.code === 'not-found') actions.clearThreadAttempt(chat.nodeId, submitted.operationId)
      setFailedOperation(submitted.operationId)
      return false
    } catch (_creationError) { setFailedOperation(submitted.operationId); return false } finally {
      running.current = false
      setBusy(false)
    }
  }, [chat.nodeId, chat.deleting, actions, createThread, ensureInitialThread])
  const fresh = useCallback((directory?: string, agentPreset?: string, initial = false): Promise<boolean> => submit({
    canvasId: chat.canvasId, nodeId: chat.nodeId, expectedRevision: canvasRevision,
    operationId: randomUUID() as CanvasOperationId, kind: 'create', ...(directory === undefined ? {} : { cwd: directory }),
    ...(agentPreset === undefined ? {} : { agentPreset }),
  }, initial), [chat.canvasId, chat.nodeId, canvasRevision, submit])
  useEffect(() => {
    if (selected !== undefined) { initialized.current = undefined; return }
    if (attempt !== undefined || chat.deleting || initialized.current === chat.nodeId) return
    initialized.current = chat.nodeId
    void fresh(undefined, undefined, true)
  }, [chat.nodeId, selected, attempt, chat.deleting, fresh])
  const fork = (sourceSessionId: SessionId, seq?: number): void => {
    if (attempt !== undefined) return
    void submit({
      canvasId: chat.canvasId, nodeId: chat.nodeId, expectedRevision: canvasRevision,
      operationId: randomUUID() as CanvasOperationId, kind: 'fork', sourceSessionId,
      ...(seq === undefined ? {} : { atSeq: seq as SessionSeq }),
    })
  }
  const blocked = busy || chat.deleting || attempt !== undefined
  const unconfirmed = attempt !== undefined && !busy
    && (attempt.operationId === restoredOperation || attempt.operationId === failedOperation)
  const resize: ChatResizeControls = {
    preview: (next) => { setSizePreview(next === null ? null : { sessionId: selected, size: next }) },
    commit: (next) => { actions.setSize(chat.nodeId, next) },
    label: t('chat.resize'), help: t('chat.resizeHelp'),
  }
  return <article className={css.chatNode} data-convax-chat={chat.nodeId} data-collapsed={collapsed || undefined}
    data-resized={size !== undefined || undefined}
    style={{ '--dsh-convax-chat-width': `${size?.width ?? CHAT_CARD_WIDTH}px`,
      ...(size === undefined ? {} : { '--dsh-convax-chat-view-height': `${size.height}px` }) } as CSSProperties}
    onPointerDownCapture={() => { if (selected !== undefined) props.focusSession(selected) }}
    onFocusCapture={() => { if (selected !== undefined) props.focusSession(selected) }}>
    <CardToolbar nodeId={chat.nodeId} name={chat.defaultTitle === true ? t('chat.untitled') : chat.title} t={t} actions={[
      { id: 'zoom', label: t('chat.focus'), onClick: props.focusNode },
      { id: 'remove', label: t('chat.delete'), disabled: busy || chat.deleting, onClick: props.remove },
    ]} />
    <Handle id="input" type="target" position={Position.Left} className={css.handle} />
    <div ref={header} className={css.chatFrameHeader} data-convax-chat-header="">
      <header className={css.threadBar} data-convax-chat-drag="">
        <Tooltip label={t(collapsed ? 'chat.expand' : 'chat.collapse')} portal>
          <Button size="sm" className="nodrag nopan" aria-label={t(collapsed ? 'chat.expand' : 'chat.collapse')}
            aria-expanded={!collapsed} onClick={() => {
              if (!collapsed) {
                const scroll = header.current?.parentElement?.querySelector<HTMLElement>('[data-convax-thread]:not([hidden]) [data-conversation-scroll]')
                expandedHeight.current = size?.height ?? (scroll?.offsetHeight || pendingBody.current?.offsetHeight || 240)
              }
              setMenu(null)
              actions.setCollapsed(chat.nodeId, !collapsed)
            }}>
            {collapsed ? <ChevronRight size={16} aria-hidden /> : <ChevronDown size={16} aria-hidden />}
          </Button>
        </Tooltip>
        <ThreadTabs tabs={threads.map((thread) => {
          const summary = summaries[thread.sessionId]
          const status = statuses.get(thread.sessionId)
          const statusLabel = status?.pendingInteraction ? t('chat.approval') : summary?.running ? t('chat.running') : undefined
          return {
            id: thread.sessionId,
            title: summary?.displayTitle || t('chat.thread', { number: chat.threads.indexOf(thread) + 1 }),
            ...(statusLabel === undefined ? {} : { status: statusLabel }),
          }
        })} activeId={selected} reference={headerResource.value?.reference} t={t}
        SessionProvider={SessionProvider} renderSlot={renderSlot} renderFactorySlot={props.renderFactorySlot}
        menuOpen={menu === 'thread'} setMenuOpen={(open) => { setMenu(current => open ? 'thread' : current === 'thread' ? null : current) }}
        settingsOpen={menu === 'settings'} setSettingsOpen={(open) => { setMenu(current => open ? 'settings' : current === 'settings' ? null : current) }} disabled={blocked}
        select={(sessionId) => {
          actions.selectThread(chat.nodeId, sessionId)
          props.acknowledgeCompletion(sessionId)
          setMenu(null)
        }}
        move={(sessionId, targetId, side) => {
          actions.moveThread(chat.nodeId, chat.threads.map(thread => thread.sessionId), sessionId, targetId, side)
        }}
        fork={fork} create={() => {
          setMenu(null)
          actions.setCollapsed(chat.nodeId, false)
          void fresh()
        }} />
        <div className={`${css.threadActions} nodrag nopan`}>
          <div className={css.chatNativeHeader} hidden={collapsed}>
            {headerResource.value !== undefined && <SessionProvider session={headerResource.value.reference}>
              {renderSlot('convax.chat.header', {})}
            </SessionProvider>}
          </div>
        </div>
      </header>
      <div className={css.chatDetails} hidden={collapsed}>
        {(chat.issue !== null || chat.deleting) && <p className={css.notice} role="status">{t(chat.issue === null ? 'chat.deleting'
          : chat.issueCode === 'thread-create' ? 'chat.createFailed' : chat.issueCode === 'deletion' ? 'chat.deletePending'
            : chat.issueCode === 'delivery' ? 'chat.deliveryFailed' : chat.issueCode === 'chat-unavailable' ? 'chat.unavailable' : 'operation.failed')}</p>}
        {chat.issue !== null && <DiagnosticDetails diagnostic={chat.issue} t={t} />}
        {unconfirmed && <div className={`${css.notice} nodrag nopan`} role={attempt.operationId === failedOperation ? 'alert' : 'status'}>
          {t('chat.unconfirmed')}
          <Button size="sm" disabled={chat.deleting} onClick={() => { void submit(attempt) }}>{t('workspace.retry')}</Button>
        </div>}
      </div>
      {collapsed && <ChatResizeHandle container={header} actions={resize} label={resize.label} help={resize.help}
        useContainer collapsedHeight={size?.height ?? expandedHeight.current} />}
    </div>
    {selected === undefined && <div ref={pendingBody} className={`${css.chatBody} ${css.chatPendingBody} nodrag nopan`} hidden={collapsed}>
      {!unconfirmed && <div className={css.center}><span className={css.spinner} /></div>}
      {!collapsed && <ChatResizeHandle container={pendingBody} actions={resize} label={resize.label} help={resize.help} useContainer />}
    </div>}
    {threads.filter(thread => mounted.has(thread.sessionId)).map(thread => <Fragment key={thread.sessionId}>{props.renderFactorySlot('convax.chat.thread', {
      sessionId: thread.sessionId, active: thread.sessionId === selected, collapsed,
      layoutChanged: () => { updateNodeInternals(chat.nodeId) },
      resize,
      tools: {
        width: toolWidths?.normal ?? 480,
        fullscreenWidth: toolWidths?.fullscreen ?? 960,
        resize: {
          label: t('chat.resizeTools'), help: t('chat.resizeToolsHelp'),
          onCommit: (width, fullscreen) => { actions.setToolWidth(chat.nodeId, width, fullscreen) },
        },
      },
      onSelectWorkspace: async (workspaceId) => {
        const workspace = workspaces.find(item => item.workspaceId === workspaceId)
        if (workspace === undefined || attempt !== undefined) return
        await fresh(workspace.path)
      },
      onFork: (seq) => { fork(thread.sessionId, seq) },
      onNewSessionWithPreset: async (agentPreset) => {
        if (attempt !== undefined || running.current || chat.deleting) throw new Error(t('chat.createFailed'))
        actions.setCollapsed(chat.nodeId, false)
        if (!await fresh(summaries[thread.sessionId]?.cwd, agentPreset)) throw new Error(t('chat.createFailed'))
      },
    })}</Fragment>)}
    <Handle id="output" type="source" position={Position.Right} className={css.handle} />
  </article>
}
