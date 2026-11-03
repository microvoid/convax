/** Window-local canvas and Chat preferences; canvas documents remain Host-owned. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { CanvasCommandRequest, CanvasId, CanvasNodeId, CanvasOperationId, CanvasThreadRequest } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Viewport } from '@xyflow/react'
import type { ChatSize } from './chat-size.ts'
import type { ResourceSize } from './resource-size.ts'
import type { CanvasInputMode } from './input-mode.ts'
import { orderedChatThreads } from './thread-order.ts'
import type { CanvasChatPresentation } from './props.ts'

/** Window-local expansion and preview dimensions for one resource node. */
export interface ResourceView {
  expanded: boolean
  width?: number
  height?: number
}

/** Local operation identities and resource preferences needed when history restores deleted nodes. */
export interface CanvasWindowHistory {
  undo: CanvasOperationId[]
  redo: CanvasOperationId[]
  resourceViews: Record<string, Record<string, ResourceView>>
}

type ViewState = {
  tabs: CanvasId[]
  activeCanvasId: CanvasId | null
  closedTabs: CanvasId[]
  directory: string
  viewports: Record<string, Viewport>
  inputMode?: CanvasInputMode
  resourceViews?: Record<string, ResourceView>
  deletionAttempts?: Record<string, CanvasCommandRequest>
  threadFocus?: { nodeId: CanvasNodeId; sessionId: SessionId }
  histories?: Record<string, CanvasWindowHistory>
}

type ViewActions = {
  open: (draft: ViewState, id: CanvasId) => void
  close: (draft: ViewState, id: CanvasId) => void
  moveTab: (draft: ViewState, id: CanvasId, targetId: CanvasId, side: 'before' | 'after') => void
  reconcile: (draft: ViewState, ids: readonly CanvasId[], nodeIds?: readonly CanvasNodeId[]) => void
  browse: (draft: ViewState, path: string) => void
  setViewport: (draft: ViewState, id: CanvasId, viewport: Viewport) => void
  setInputMode: (draft: ViewState, mode: CanvasInputMode) => void
  setResourceExpanded: (draft: ViewState, nodeId: CanvasNodeId, expanded: boolean) => void
  setResourcePreviewSize: (draft: ViewState, nodeId: CanvasNodeId, size: ResourceSize) => void
  copyResourceView: (draft: ViewState, nodeId: CanvasNodeId, view: ResourceView) => void
  stageDeletion: (draft: ViewState, request: CanvasCommandRequest) => void
  finishDeletion: (draft: ViewState, operationId: CanvasOperationId) => void
  focusThread: (draft: ViewState, canvasId: CanvasId, nodeId: CanvasNodeId, sessionId: SessionId) => void
  consumeThreadFocus: (draft: ViewState, nodeId: CanvasNodeId, sessionId: SessionId) => void
  recordHistory: (draft: ViewState, canvasId: CanvasId, operationId: CanvasOperationId,
    removed: Readonly<Record<string, ResourceView>>) => void
  replayHistory: (draft: ViewState, canvasId: CanvasId, operationId: CanvasOperationId, direction: 'undo' | 'redo', removed: Readonly<Record<string, ResourceView>>) => void
}

/**
 * Declare persisted window preferences independently of durable canvas records.
 * @returns a handle instantiated by the Slot renderer.
 */
export function createCanvasViewStore(): EngineStoreHandle<ViewState, ViewActions> {
  return defineStore({
    init: (): ViewState => ({
      tabs: [], activeCanvasId: null, closedTabs: [], directory: '',
      viewports: {},
    }),
    persist: 'convax.canvas.view.v1',
    actions: {
      open: (draft, id: CanvasId) => {
        if (!draft.tabs.includes(id)) draft.tabs.push(id)
        draft.activeCanvasId = id
        draft.closedTabs = draft.closedTabs.filter(closed => closed !== id)
      },
      close: (draft, id: CanvasId) => {
        const index = draft.tabs.indexOf(id)
        if (index < 0) return
        draft.tabs.splice(index, 1)
        draft.closedTabs = [...draft.closedTabs.filter(closed => closed !== id), id]
        if (draft.activeCanvasId === id) {
          draft.activeCanvasId = draft.tabs[Math.min(index, draft.tabs.length - 1)] ?? null
        }
      },
      moveTab: (draft, id: CanvasId, targetId: CanvasId, side: 'before' | 'after') => {
        const source = draft.tabs.indexOf(id)
        const target = draft.tabs.indexOf(targetId)
        if (source < 0 || target < 0 || source === target) return
        const insertion = target + (side === 'after' ? 1 : 0)
        const destination = insertion - (source < insertion ? 1 : 0)
        if (destination === source) return
        draft.tabs.splice(source, 1)
        draft.tabs.splice(destination, 0, id)
      },
      reconcile: (draft, ids: readonly CanvasId[], nodeIds?: readonly CanvasNodeId[]) => {
        const live = new Set(ids)
        draft.tabs = draft.tabs.filter(id => live.has(id))
        draft.closedTabs = draft.closedTabs.filter(id => live.has(id))
        draft.viewports = Object.fromEntries(Object.entries(draft.viewports).filter(([id]) => live.has(id as CanvasId)))
        if (draft.histories !== undefined) {
          draft.histories = Object.fromEntries(Object.entries(draft.histories).filter(([id]) => live.has(id as CanvasId)))
        }
        if (nodeIds !== undefined && draft.resourceViews !== undefined) {
          const nodes = new Set<string>(nodeIds)
          draft.resourceViews = Object.fromEntries(Object.entries(draft.resourceViews).filter(([id]) => nodes.has(id)))
        }
        if (draft.activeCanvasId !== null && !live.has(draft.activeCanvasId)) {
          draft.activeCanvasId = draft.tabs[0] ?? null
        }
      },
      browse: (draft, path: string) => { draft.directory = path },
      setViewport: (draft, id: CanvasId, viewport: Viewport) => { draft.viewports[id] = viewport },
      setInputMode: (draft, mode: CanvasInputMode) => { draft.inputMode = mode },
      setResourceExpanded: (draft, nodeId: CanvasNodeId, expanded: boolean) => {
        const view = (draft.resourceViews ??= {})[nodeId] ??= { expanded: false }
        view.expanded = expanded
      },
      setResourcePreviewSize: (draft, nodeId: CanvasNodeId, size: ResourceSize) => {
        const view = (draft.resourceViews ??= {})[nodeId] ??= { expanded: false }
        view.width = size.width
        view.height = size.height
      },
      copyResourceView: (draft, nodeId: CanvasNodeId, view: ResourceView) => {
        (draft.resourceViews ??= {})[nodeId] = { ...view }
      },
      stageDeletion: (draft, request: CanvasCommandRequest) => { (draft.deletionAttempts ??= {})[request.operationId] = request },
      finishDeletion: (draft, operationId: CanvasOperationId) => {
        draft.deletionAttempts = Object.fromEntries(Object.entries(draft.deletionAttempts ?? {}).filter(([id]) => id !== operationId))
      },
      focusThread: (draft, canvasId: CanvasId, nodeId: CanvasNodeId, sessionId: SessionId) => {
        if (!draft.tabs.includes(canvasId)) draft.tabs.push(canvasId)
        draft.activeCanvasId = canvasId
        draft.closedTabs = draft.closedTabs.filter(id => id !== canvasId)
        draft.threadFocus = { nodeId, sessionId }
      },
      consumeThreadFocus: (draft, nodeId: CanvasNodeId, sessionId: SessionId) => {
        if (draft.threadFocus?.nodeId === nodeId && draft.threadFocus.sessionId === sessionId) delete draft.threadFocus
      },
      recordHistory: (draft, canvasId: CanvasId, operationId: CanvasOperationId, removed: Readonly<Record<string, ResourceView>>) => {
        const history = (draft.histories ??= {})[canvasId] ??= { undo: [], redo: [], resourceViews: {} }
        if (history.undo.includes(operationId) || history.redo.includes(operationId)) return
        history.undo.push(operationId)
        history.redo = []
        if (Object.keys(removed).length > 0) history.resourceViews[operationId] = structuredClone(removed)
        const retained = new Set<string>(history.undo)
        history.resourceViews = Object.fromEntries(Object.entries(history.resourceViews).filter(([id]) => retained.has(id)))
      },
      replayHistory: (draft, canvasId: CanvasId, operationId: CanvasOperationId, direction: 'undo' | 'redo', removed: Readonly<Record<string, ResourceView>>) => {
        const history = draft.histories?.[canvasId]
        if (history === undefined || history[direction].at(-1) !== operationId) return
        history[direction].pop()
        history[direction === 'undo' ? 'redo' : 'undo'].push(operationId)
        if (Object.keys(removed).length > 0) {
          history.resourceViews[operationId] = { ...history.resourceViews[operationId], ...structuredClone(removed) }
        }
      },
    },
  })
}

type ChatViewState = {
  selectedThreads: Record<string, SessionId>
  threadAttempts: Record<string, CanvasThreadRequest>
  visitedThreads?: Record<string, SessionId[]>
  threadOrders?: Record<string, SessionId[]>
  collapsedChats?: Record<string, boolean>
  sizes?: Record<string, ChatSize>
  /** Tool panel widths are shared by a Chat's threads and retained separately for each display mode. */
  toolWidths?: Record<string, { normal?: number; fullscreen?: number }>
}

type ChatViewActions = {
  selectThread: (draft: ChatViewState, nodeId: CanvasNodeId, sessionId: SessionId) => void
  moveThread: (draft: ChatViewState, nodeId: CanvasNodeId, liveIds: readonly SessionId[], sessionId: SessionId, targetId: SessionId, side: 'before' | 'after') => void
  stageThread: (draft: ChatViewState, nodeId: CanvasNodeId, request: CanvasThreadRequest) => void
  finishThread: (draft: ChatViewState, nodeId: CanvasNodeId, operationId: CanvasOperationId, sessionId: SessionId) => void
  clearThreadAttempt: (draft: ChatViewState, nodeId: CanvasNodeId, operationId: CanvasOperationId) => void
  setCollapsed: (draft: ChatViewState, nodeId: CanvasNodeId, collapsed: boolean) => void
  setSize: (draft: ChatViewState, nodeId: CanvasNodeId, size: ChatSize) => void
  setToolWidth: (draft: ChatViewState, nodeId: CanvasNodeId, width: number, fullscreen: boolean) => void
  copyPresentation: (draft: ChatViewState, nodeId: CanvasNodeId, presentation: CanvasChatPresentation) => void
}

/**
 * Persist Chat dimensions, tool widths, thread navigation, and unresolved creation identities independently of canvas cameras.
 * @returns A window-owned Chat navigation store declaration.
 */
export function createChatViewStore(): EngineStoreHandle<ChatViewState, ChatViewActions> {
  return defineStore({
    init: (): ChatViewState => ({ selectedThreads: {}, threadAttempts: {} }),
    persist: 'convax.chat.view.v1',
    actions: {
      selectThread: (draft, nodeId: CanvasNodeId, sessionId: SessionId) => {
        draft.selectedThreads[nodeId] = sessionId
        const visited = (draft.visitedThreads ??= {})[nodeId] ??= []
        if (!visited.includes(sessionId)) visited.push(sessionId)
      },
      moveThread: (draft, nodeId: CanvasNodeId, liveIds: readonly SessionId[], sessionId: SessionId, targetId: SessionId, side: 'before' | 'after') => {
        const ids = orderedChatThreads(liveIds.map(id => ({ sessionId: id })), draft.threadOrders?.[nodeId]).map(thread => thread.sessionId)
        const source = ids.indexOf(sessionId)
        const target = ids.indexOf(targetId)
        if (source < 0 || target < 0 || source === target) return
        const insertion = target + (side === 'after' ? 1 : 0)
        const destination = insertion - (source < insertion ? 1 : 0)
        if (source === destination) return
        ids.splice(source, 1)
        ids.splice(destination, 0, sessionId)
        const orders = draft.threadOrders ??= {}
        orders[nodeId] = ids
      },
      stageThread: (draft, nodeId: CanvasNodeId, request: CanvasThreadRequest) => { draft.threadAttempts[nodeId] = request },
      clearThreadAttempt: (draft, nodeId: CanvasNodeId, operationId: CanvasOperationId) => {
        if (draft.threadAttempts[nodeId]?.operationId !== operationId) return
        draft.threadAttempts = Object.fromEntries(Object.entries(draft.threadAttempts).filter(([id]) => id !== nodeId))
      },
      finishThread: (draft, nodeId: CanvasNodeId, operationId: CanvasOperationId, sessionId: SessionId) => {
        if (draft.threadAttempts[nodeId]?.operationId !== operationId) return
        draft.threadAttempts = Object.fromEntries(Object.entries(draft.threadAttempts).filter(([id]) => id !== nodeId))
        draft.selectedThreads[nodeId] = sessionId
        const visited = (draft.visitedThreads ??= {})[nodeId] ??= []
        if (!visited.includes(sessionId)) visited.push(sessionId)
      },
      setCollapsed: (draft, nodeId: CanvasNodeId, collapsed: boolean) => { (draft.collapsedChats ??= {})[nodeId] = collapsed },
      setSize: (draft, nodeId: CanvasNodeId, size: ChatSize) => { (draft.sizes ??= {})[nodeId] = size },
      setToolWidth: (draft, nodeId: CanvasNodeId, width: number, fullscreen: boolean) => {
        const widths = (draft.toolWidths ??= {})[nodeId] ??= {}
        widths[fullscreen ? 'fullscreen' : 'normal'] = width
      },
      copyPresentation: (draft, nodeId: CanvasNodeId, presentation: CanvasChatPresentation) => {
        (draft.collapsedChats ??= {})[nodeId] = presentation.collapsed
        if (presentation.size === undefined) delete draft.sizes?.[nodeId]
        else (draft.sizes ??= {})[nodeId] = { ...presentation.size }
        if (presentation.toolWidths === undefined) delete draft.toolWidths?.[nodeId]
        else (draft.toolWidths ??= {})[nodeId] = { ...presentation.toolWidths }
      },
    },
  })
}
