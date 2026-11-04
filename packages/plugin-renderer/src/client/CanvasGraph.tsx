/** Controlled graph presentation; Host commands own every durable edit. */
import { Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background, NodeToolbar, Panel, Position, ReactFlow, ReactFlowProvider, ViewportPortal, useStore as useFlowStore,
  type Connection, type Node, type NodeProps, type OnConnectEnd, type ReactFlowInstance, type Viewport,
} from '@xyflow/react'
import { Button, Tooltip, isBehindModal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  CanvasChat, CanvasCommand, CanvasConnectionId, CanvasDocument, CanvasNode, CanvasNodeId, CanvasNodeIssue,
  CanvasNodeTypeInfo, CanvasPoint, CanvasPort, CanvasResource,
} from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { CanvasChatPresentation, CanvasConnectionOrigin, CanvasNodeOwner, WorkspaceProps } from './props.ts'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { NodePlaceholder, type CanvasNodeRendererDefinition } from './node-renderers.tsx'
import type { CanvasCreationDefinition, CanvasCreationContext } from './contributions.ts'
import css from './Workspace.module.css'
import '@xyflow/react/dist/style.css'
import type { CanvasInputMode } from './input-mode.ts'
import { RESOURCE_CARD_WIDTH } from './placement.ts'
import type { ResourceView } from './store.ts'
import type { ResourceSize } from './resource-size.ts'
import { CanvasEdge, type GraphEdge } from './CanvasEdge.tsx'
import { installCanvasWheel } from './canvas-wheel.ts'
import { installCanvasPan } from './canvas-pan.ts'
import { resolveCanvasKeyboardAction } from './canvas-keyboard.ts'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { createCanvasSnapGesture, snapCanvasDrag, type CanvasSnapGesture, type CanvasSnapGuide } from './canvas-snapping.ts'
import { CanvasContextMenu } from './CanvasContextMenu.tsx'
import { canvasContextTargets, ownsNativeCanvasContextMenu } from './canvas-context-menu.ts'
import { ConnectionCreationMenu, ConnectionCreationPreview } from './ConnectionCreationMenu.tsx'
import { connectionDropPoint, isBlankConnectionTarget } from './connection-creation.ts'
import type { CanvasClipboardNotice, CanvasClipboardView } from './canvas-clipboard.ts'
import { useCanvasClipboard } from './use-canvas-clipboard.ts'

type CardData = Omit<CanvasNodeOwner, 'definition' | 'selected'> & {
  definition: CanvasNodeTypeInfo | undefined
  issue: CanvasNodeIssue | undefined
  renderSlot: PropsRenderSlots<'convax.node'>['renderSlot']
  t: WorkspaceProps['t']
}
type GraphNode = Node<CardData, 'convaxNode'>

function NodeCard({ data, selected }: NodeProps<GraphNode>) {
  const { definition, issue, node, renderSlot, t } = data
  const retained = { node, ports: data.ports, remove: data.remove, selected, t,
    setResourcePreviewSize: data.setResourcePreviewSize,
    ...(data.resourcePreviewWidth === undefined ? {} : { resourcePreviewWidth: data.resourcePreviewWidth }),
    ...(data.resourcePreviewHeight === undefined ? {} : { resourcePreviewHeight: data.resourcePreviewHeight }),
  }
  if (definition === undefined) return <NodePlaceholder {...retained} reason="provider" />
  if (issue !== undefined) return <NodePlaceholder {...retained} reason={issue.kind} detail={issue.message} />
  if (definition.dataVersion !== node.dataVersion) return <NodePlaceholder {...retained} reason="incompatible" />
  return renderSlot('convax.node', {
    node, definition, ports: data.ports, selected, busy: data.busy,
    canvasId: data.canvasId, canvasRevision: data.canvasRevision, chat: data.chat,
    remove: data.remove, command: data.command, openResource: data.openResource, openSource: data.openSource, createChat: data.createChat,
    focusSessionId: data.focusSessionId, consumeFocus: data.consumeFocus,
    inputs: data.inputs, focusNode: data.focusNode,
    resourceExpanded: data.resourceExpanded, setResourceExpanded: data.setResourceExpanded,
    ...(data.resourcePreviewHeight === undefined ? {} : { resourcePreviewHeight: data.resourcePreviewHeight }),
    ...(data.resourcePreviewWidth === undefined ? {} : { resourcePreviewWidth: data.resourcePreviewWidth }),
    setResourcePreviewSize: data.setResourcePreviewSize,
    chooseWindow: data.chooseWindow,
  }, { entryKey: node.typeId, fallback: <NodePlaceholder {...retained} reason="renderer" /> })
}

const NODE_TYPES = { convaxNode: NodeCard }
const EDGE_TYPES = { convaxConnection: CanvasEdge }
const RESOURCE_DRAG_TYPE = 'application/x-convax-resource'
const MIN_ZOOM = 0.15
const MAX_ZOOM = 2
const ACTIVITY_NODE_ATTRIBUTES: NonNullable<GraphNode['domAttributes']> & { readonly 'data-convax-activity-highlight': 'true' } = {
  'data-convax-activity-highlight': 'true',
}

/** One dropped reference; a missing native path remains a visible intake failure. */
export interface DroppedResource {
  readonly name: string
  readonly path: string | null
}

function ownsNodeDrop(target: EventTarget): boolean {
  return target instanceof Element && target.closest('[data-convax-input-owner]') !== null
}

function isResourceTransfer(transfer: DataTransfer): boolean {
  return transfer.types.includes(RESOURCE_DRAG_TYPE) || transfer.types.includes('Files')
}

function retainedPorts(document: CanvasDocument, nodeId: CanvasNodeId, definition: CanvasNodeTypeInfo | undefined): CanvasPort[] {
  const ports = [...definition?.ports ?? []]
  const add = (id: string, direction: CanvasPort['direction']): void => {
    if (!ports.some(port => port.id === id && port.direction === direction)) ports.push({ id, direction, valueKind: 'retained' })
  }
  for (const edge of document.connections) {
    if (edge.source === nodeId) add(edge.sourcePort, 'output')
    if (edge.target === nodeId) add(edge.targetPort, 'input')
  }
  return ports
}

/** Graph-specific props retain the parent Slot's framework-made translation seat. */
export interface CanvasGraphProps {
  readonly document: CanvasDocument
  readonly chats: readonly CanvasChat[]
  readonly nodeTypes: readonly CanvasNodeTypeInfo[]
  readonly nodeIssues: readonly CanvasNodeIssue[]
  readonly rendererDefinitions?: Readonly<Record<string, Pick<CanvasNodeRendererDefinition, 'defaultSize' | 'dragHandle' | 'presentation' | 'clipboardData'>>>
  readonly creations?: readonly CanvasCreationDefinition[]
  readonly renderSlot: PropsRenderSlots<'convax.node'>['renderSlot']
  readonly createChat: (cwd?: string, folderId?: CanvasNodeId, position?: CanvasPoint, origin?: CanvasConnectionOrigin) => void
  readonly addProject: (position: CanvasPoint, origin?: CanvasConnectionOrigin) => void
  readonly addWindow?: ((position: CanvasPoint, nodeId?: CanvasNodeId) => void) | undefined
  readonly captureConnectionTarget: (origin: CanvasConnectionOrigin) => CanvasConnectionOrigin
  readonly reportClipboard: (notice: CanvasClipboardNotice) => void
  readonly history: { readonly canUndo: boolean; readonly canRedo: boolean; readonly pending: boolean }
  readonly replayHistory: (direction: 'undo' | 'redo') => void
  readonly chatPresentations: Readonly<Record<string, CanvasChatPresentation>>
  readonly applyChatPresentation: (nodeId: CanvasNodeId, presentation: CanvasChatPresentation) => void
  readonly applyResourceView: (nodeId: CanvasNodeId, view: ResourceView) => void
  readonly threadFocus: { nodeId: CanvasNodeId; sessionId: SessionId } | undefined
  readonly consumeThreadFocus: (nodeId: CanvasNodeId, sessionId: SessionId) => void
  readonly t: WorkspaceProps['t']
  readonly busy: boolean
  readonly viewport: Viewport | undefined
  readonly setViewport: (viewport: Viewport) => void
  readonly inputMode: CanvasInputMode
  readonly setInputMode: (mode: CanvasInputMode) => void
  readonly resourceViews: Readonly<Record<string, ResourceView>>
  readonly setResourceExpanded: (nodeId: CanvasNodeId, expanded: boolean) => void
  readonly setResourcePreviewSize: (nodeId: CanvasNodeId, size: ResourceSize) => void
  readonly command: (command: CanvasCommand) => Promise<boolean>
  readonly openResource: (resource: CanvasResource) => void
  readonly openSource: (path: string) => void
  readonly resolveFilePath: WorkspaceProps['resolveFilePath']
  readonly addResources: (resources: readonly DroppedResource[], position: CanvasPoint, origin?: CanvasConnectionOrigin) => void
}

function CreationDock({ busy, creations, invoke }: {
  readonly busy: boolean
  readonly creations: readonly CanvasCreationDefinition[]
  readonly invoke: (entry: CanvasCreationDefinition, position: CanvasPoint) => void
}) {
  const width = useFlowStore(state => state.width)
  const height = useFlowStore(state => state.height)
  const transform = useFlowStore(state => state.transform)
  return creations.length === 0 ? null : <Panel position="bottom-center" className={`${css.creationDock} nodrag nopan nowheel`}>
    {creations.map((entry) => {
      const size = entry.defaultSize ?? { width: RESOURCE_CARD_WIDTH, height: 140 }
      const position = { x: (width / 2 - transform[0]) / transform[2] - size.width / 2,
        y: (Math.max(24, (height - 112 - size.height * transform[2]) / 2) - transform[1]) / transform[2] }
      const Icon = entry.icon
      return <Button key={entry.id} size="sm" disabled={busy} onClick={() => { invoke(entry, position) }}>
        {Icon !== undefined && <Icon size={16} aria-hidden />}{typeof entry.label === 'string' ? entry.label : entry.label()}
      </Button>
    })}
  </Panel>
}

/**
 * Render a revision-bound document with transient drag positions and connection creation.
 * @param props - Host-owned graph data and window-owned interaction actions.
 * @returns A stable React Flow provider and its controlled canvas.
 */
export function CanvasGraph(props: CanvasGraphProps) {
  return <ReactFlowProvider><CanvasGraphContent {...props} /></ReactFlowProvider>
}

function CanvasGraphContent({
  document, chats, nodeTypes, nodeIssues, rendererDefinitions = {}, creations = [], renderSlot, createChat, threadFocus, consumeThreadFocus,
  t, busy, viewport, setViewport, inputMode, setInputMode, resourceViews, setResourceExpanded, setResourcePreviewSize,
  command, openResource, openSource, resolveFilePath, addResources, addProject, addWindow, captureConnectionTarget, reportClipboard,
  chatPresentations, applyChatPresentation, applyResourceView,
  history, replayHistory,
}: CanvasGraphProps) {
  const cancelNativeConnection = useFlowStore(state => state.cancelConnection)
  const graph = useRef<HTMLDivElement>(null)
  const filePicker = useRef<HTMLInputElement>(null)
  const filePosition = useRef<CanvasPoint>({ x: 80, y: 80 })
  const fileOrigin = useRef<CanvasConnectionOrigin | undefined>(undefined)
  const connectionGesture = useRef<{ readonly origin: CanvasConnectionOrigin; cancelled: boolean } | null>(null)
  const [connectionMenu, setConnectionMenu] = useState<{
    readonly origin: CanvasConnectionOrigin
    readonly screen: CanvasPoint
    readonly world: CanvasPoint
    readonly from: CanvasPoint
    readonly position: Position
  } | null>(null)
  const [contextMenu, setContextMenu] = useState<{
    readonly screen: CanvasPoint
    readonly world: CanvasPoint
    readonly nodeIds: readonly CanvasNodeId[]
  } | null>(null)
  const contextFocus = useRef<HTMLElement | null>(null)
  const cutting = useRef(false)
  const keyboardMutation = useRef(false)
  const pointerDrag = useRef<'active' | 'cancelled' | null>(null)
  const snapping = useRef<{
    readonly anchorId: CanvasNodeId
    readonly geometry: CanvasSnapGesture
    positions: ReadonlyMap<CanvasNodeId, CanvasPoint>
  } | null>(null)
  const [snapGuides, setSnapGuides] = useState<readonly CanvasSnapGuide[]>([])
  const [flow, setFlow] = useState<ReactFlowInstance<GraphNode, GraphEdge> | null>(null)
  const pendingReveal = useRef<CanvasNodeId[] | null>(null)
  const pendingActivityReveal = useRef<{
    canvasId: CanvasDocument['id']
    nodeId: CanvasNodeId
    waitingForExpansion: boolean
  } | null>(null)
  const observedActivity = useRef<CanvasGraphProps['threadFocus']>(undefined)
  const activityCanvas = useRef(document.id)
  const latestPresentations = useRef(chatPresentations)
  latestPresentations.current = chatPresentations
  const [activityHighlight, setActivityHighlight] = useState<CanvasNodeId | null>(null)
  useEffect(() => {
    if (activityHighlight === null) return
    const timer = setTimeout(() => { setActivityHighlight(null) }, 1500)
    return () => { clearTimeout(timer) }
  }, [activityHighlight])
  const [drag, setDrag] = useState<{ revision: number; positions: Record<string, { x: number; y: number }> }>({
    revision: document.revision, positions: {},
  })
  const [selection, setSelection] = useState<string[]>([])
  const [edgeSelection, setEdgeSelection] = useState<string[]>([])
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null)
  const [measurements, setMeasurements] = useState<ReadonlyMap<string, { width: number; height: number }>>(new Map())
  const [zoom, setZoom] = useState(viewport?.zoom ?? 1)
  useEffect(() => {
    const picker = filePicker.current
    if (picker === null) return
    const cancel = (): void => { fileOrigin.current = undefined }
    picker.addEventListener('cancel', cancel)
    return () => { picker.removeEventListener('cancel', cancel) }
  }, [])
  const viewportGesture = useRef(false)
  const persistViewport = useRef(setViewport)
  persistViewport.current = setViewport
  useEffect(() => {
    const root = graph.current
    if (root === null || flow === null) return
    const controls = {
      getViewport: () => flow.getViewport(),
      setViewport: (next: Viewport) => { void flow.setViewport(next) },
      onStart: () => { viewportGesture.current = true },
      onEnd: () => {
        viewportGesture.current = false
        persistViewport.current(flow.getViewport())
      },
    }
    const releaseWheel = installCanvasWheel(root, { ...controls, mode: inputMode, minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM })
    const releasePan = installCanvasPan(root, controls)
    root.setAttribute('data-canvas-gestures-ready', '')
    return () => {
      root.removeAttribute('data-canvas-gestures-ready')
      releaseWheel()
      releasePan()
    }
  }, [flow, inputMode])
  useEffect(() => {
    const retainedIds = new Set<string>(document.nodes.map(node => node.id))
    setMeasurements(current => [...current.keys()].every(id => retainedIds.has(id))
      ? current
      : new Map([...current].filter(([id]) => retainedIds.has(id))))
  }, [document.nodes])
  const inputNodes = useMemo(() => {
    const byId = new Map(document.nodes.map(node => [node.id, node]))
    const incoming = new Map<CanvasNodeId, Map<CanvasNodeId, CanvasNode>>()
    for (const connection of document.connections) {
      if (connection.purpose !== 'input') continue
      const source = byId.get(connection.source)
      if (source === undefined) continue
      let group = incoming.get(connection.target)
      if (group === undefined) { group = new Map(); incoming.set(connection.target, group) }
      group.set(source.id, source)
    }
    return new Map([...incoming].map(([id, sources]) => [id, [...sources.values()]]))
  }, [document])
  const nodes = useMemo((): GraphNode[] => document.nodes.map((node) => {
    const definition = nodeTypes.find(type => type.id === node.typeId)
    const measured = measurements.get(node.id)
    const resourceView = resourceViews[node.id]
    const dragHandle = rendererDefinitions[node.typeId]?.dragHandle
    return {
      id: node.id,
      type: 'convaxNode',
      position: drag.revision === document.revision ? drag.positions[node.id] ?? node.position : node.position,
      selected: selection.includes(node.id),
      ...(activityHighlight === node.id ? {
        className: css.activityReveal,
        domAttributes: ACTIVITY_NODE_ATTRIBUTES,
      } : {}),
      // Controlled nodes retain measured dimensions so updates do not hide mounted editors.
      ...(measured === undefined ? {} : { measured }),
      ...(dragHandle === undefined ? {} : { dragHandle }),
      data: {
        node, definition, ports: retainedPorts(document, node.id, definition),
        issue: nodeIssues.find(issue => issue.canvasId === document.id && issue.nodeId === node.id),
        remove: () => { void command({ kind: 'remove-nodes', nodeIds: [node.id] }) },
        command, openResource, openSource, createChat: (cwd, folderId) => {
          createChat(cwd, folderId, { x: node.position.x + RESOURCE_CARD_WIDTH + 120, y: node.position.y })
        }, busy, t,
        chooseWindow: addWindow === undefined ? undefined : (nodeId) => { addWindow(node.position, nodeId) },
        chat: chats.find(item => item.nodeId === node.id),
        canvasId: document.id, canvasRevision: document.revision, renderSlot,
        focusSessionId: threadFocus?.nodeId === node.id ? threadFocus.sessionId : undefined,
        consumeFocus: () => { if (threadFocus?.nodeId === node.id) consumeThreadFocus(node.id, threadFocus.sessionId) },
        inputs: inputNodes.get(node.id) ?? [],
        resourceExpanded: resourceView?.expanded ?? false,
        setResourceExpanded: (expanded) => { setResourceExpanded(node.id, expanded) },
        ...(resourceView?.height === undefined ? {} : { resourcePreviewHeight: resourceView.height }),
        ...(resourceView?.width === undefined ? {} : { resourcePreviewWidth: resourceView.width }),
        setResourcePreviewSize: (size) => { setResourcePreviewSize(node.id, size) },
        focusNode: () => { void flow?.fitView({ nodes: [{ id: node.id }], padding: 0.2 }) },
      },
    }
  }), [document, nodeTypes, nodeIssues, rendererDefinitions, drag, selection, measurements, t, command, openResource, openSource, chats,
    renderSlot, createChat, threadFocus, consumeThreadFocus, busy, flow, inputNodes,
    resourceViews, setResourceExpanded, setResourcePreviewSize, addWindow, activityHighlight])
  const revealPastedNodes = useCallback((): void => {
    const ids = pendingReveal.current
    if (graph.current === null || flow === null || ids === null
      || !ids.every(id => flow.getNode(id)?.measured?.width !== undefined)) return
    pendingReveal.current = null
    void flow.fitView({ nodes: ids.map(id => ({ id })), padding: 0.2 })
  }, [flow])
  const revealActivityNode = useCallback((): void => {
    const request = pendingActivityReveal.current
    if (flow === null || request === null || request.canvasId !== document.id
      || request.waitingForExpansion || latestPresentations.current[request.nodeId]?.collapsed === true) return
    const target = flow.getNode(request.nodeId)
    if (target?.measured?.width === undefined || target.measured.height === undefined) return
    pendingActivityReveal.current = null
    setActivityHighlight(request.nodeId)
    void flow.fitView({ nodes: [{ id: request.nodeId }], padding: 0.2,
      minZoom: MIN_ZOOM, maxZoom: flow.getZoom(),
      duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 240 })
  }, [flow, document.id])
  useEffect(() => {
    if (activityCanvas.current !== document.id) {
      activityCanvas.current = document.id
      pendingActivityReveal.current = null
      observedActivity.current = undefined
      setActivityHighlight(null)
    }
    if (threadFocus !== undefined && observedActivity.current !== threadFocus
      && document.nodes.some(node => node.id === threadFocus.nodeId)) {
      pendingActivityReveal.current = { canvasId: document.id, nodeId: threadFocus.nodeId,
        waitingForExpansion: latestPresentations.current[threadFocus.nodeId]?.collapsed === true }
    }
    const pending = pendingActivityReveal.current
    if (pending !== null && !document.nodes.some(node => node.id === pending.nodeId)) pendingActivityReveal.current = null
    observedActivity.current = threadFocus
    revealActivityNode()
  }, [threadFocus, document.id, document.nodes, revealActivityNode])
  const geometry = nodes.map(node => ({ id: node.id, ...node.position,
    width: node.measured?.width ?? (rendererDefinitions[node.data.node.typeId]?.defaultSize?.width ?? RESOURCE_CARD_WIDTH),
    height: node.measured?.height ?? (rendererDefinitions[node.data.node.typeId]?.defaultSize?.height ?? 140),
  }))
  const dimensions = Object.fromEntries(geometry.map(({ id, width, height }) => [id, { width, height }]))
  const views = Object.fromEntries(nodes.map((node): [string, CanvasClipboardView] => [node.id,
    rendererDefinitions[node.data.node.typeId]?.presentation === 'chat' ? { kind: 'chat', presentation: chatPresentations[node.id] ?? { collapsed: false } }
      : rendererDefinitions[node.data.node.typeId]?.presentation === 'resource'
        ? { kind: 'resource', presentation: resourceViews[node.id] ?? { expanded: false } } : { kind: 'default' },
  ]))
  const clipboard = useCanvasClipboard({ document, dimensions, views,
    copyData: node => rendererDefinitions[node.typeId]?.clipboardData?.(node) ?? structuredClone(node.data),
    obstacles: geometry, command, report: reportClipboard,
    select: (ids) => { setSelection(ids); setEdgeSelection([]); setHoveredEdge(null) },
    reveal: (ids) => { pendingReveal.current = ids; queueMicrotask(revealPastedNodes) },
    applyViews: (copies) => {
      for (const { nodeId, view } of copies) {
        switch (view.kind) {
          case 'chat': applyChatPresentation(nodeId, structuredClone(view.presentation)); break
          case 'resource': applyResourceView(nodeId, structuredClone(view.presentation)); break
          case 'default': break
          default: assertNever(view)
        }
      }
    },
    pasteCenter: () => {
      const root = graph.current
      if (root === null || flow === null) return null
      const rect = root.getBoundingClientRect()
      return flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
    },
  })
  const invokeCreation = (entry: CanvasCreationDefinition, position: CanvasPoint, origin?: CanvasConnectionOrigin): void => {
    const context: CanvasCreationContext = { position, ...(origin === undefined ? {} : { origin }), command,
      addProject, addFiles: pickFiles, createChat, addWindow }
    entry.create(context)
  }
  const cut = useCallback((ids: readonly CanvasConnectionId[]): void => {
    if (busy || cutting.current) return
    const connectionIds = ids.filter(id => document.connections.some(connection => connection.id === id))
    if (connectionIds.length === 0) return
    cutting.current = true
    void command({ kind: 'remove-connections', connectionIds }).finally(() => { cutting.current = false })
  }, [busy, document.connections, command])
  const closeContextMenu = useCallback((): void => {
    setContextMenu(null)
    const focused = graph.current?.ownerDocument.activeElement
    const previous = contextFocus.current
    contextFocus.current = null
    if (previous?.isConnected && (focused === previous.ownerDocument.body
      || focused instanceof Element && focused.closest('[role="menu"]') !== null)) {
      previous.focus({ preventScroll: true })
    }
  }, [])
  const closeConnectionMenu = useCallback((): void => {
    setConnectionMenu(null)
  }, [])
  const cancelConnectionCreation = useCallback((): void => {
    if (connectionGesture.current !== null) connectionGesture.current.cancelled = true
    cancelNativeConnection()
    setConnectionMenu(null)
  }, [cancelNativeConnection])
  useEffect(() => {
    const root = graph.current
    if (root === null) return
    const owner = root.ownerDocument
    const cancelDrag = (): void => {
      if (pointerDrag.current === null) return
      pointerDrag.current = 'cancelled'
      snapping.current = null
      setSnapGuides([])
      setDrag({ revision: document.revision, positions: {} })
    }
    const keydown = (event: KeyboardEvent): void => {
      if (isBehindModal(root)) return
      if (connectionMenu !== null || connectionGesture.current !== null && !connectionGesture.current.cancelled) {
        // oxlint-disable-next-line typescript/no-deprecated -- Some IMEs report composition only through keyCode 229.
        if (!event.isComposing && event.keyCode !== 229 && !event.altKey && !event.ctrlKey && !event.metaKey
          && !event.shiftKey && event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          if (!event.repeat) cancelConnectionCreation()
        } else if (resolveCanvasKeyboardAction(event, root)?.kind === 'move') {
          event.preventDefault()
          event.stopPropagation()
        }
        return
      }
      if (contextMenu !== null) {
        // oxlint-disable-next-line typescript/no-deprecated -- Some IMEs report composition only through keyCode 229.
        if (!event.isComposing && event.keyCode !== 229
          && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          if (!event.repeat) closeContextMenu()
        } else if (resolveCanvasKeyboardAction(event, root)?.kind === 'move') {
          event.preventDefault()
          event.stopPropagation()
        }
        return
      }
      const action = resolveCanvasKeyboardAction(event, root)
      if (action === null) return
      if ((action.kind === 'copy' || action.kind === 'duplicate') && selection.length === 0) return
      if ((action.kind === 'copy' || action.kind === 'paste' || action.kind === 'duplicate')
        && (busy || clipboard.pending || pointerDrag.current !== null)) return
      if ((action.kind === 'undo' || action.kind === 'redo') && (busy || clipboard.pending || history.pending
        || pointerDrag.current !== null || !(action.kind === 'undo' ? history.canUndo : history.canRedo))) return
      const focused = owner.activeElement
      if (action.kind === 'move' && selection.length === 0) return
      if (action.kind === 'remove' && (busy || cutting.current || keyboardMutation.current)) return
      const focusedEdge = focused?.closest('.react-flow__edge')?.getAttribute('data-id')
      const edgeCandidates = hoveredEdge === null ? focusedEdge ? [focusedEdge] : edgeSelection : [hoveredEdge]
      const targetedEdges = document.connections.filter(connection => edgeCandidates.includes(connection.id))
        .map(connection => connection.id)
      if (action.kind === 'remove' && targetedEdges.length === 0
        && !document.nodes.some(node => selection.includes(node.id))) return
      event.preventDefault()
      event.stopPropagation()
      switch (action.kind) {
        case 'select-all':
          if (pointerDrag.current !== null) return
          setSelection(document.nodes.map(node => node.id))
          setEdgeSelection([])
          setHoveredEdge(null)
          return
        case 'cancel':
          if (clipboard.cancel()) return
          cancelDrag()
          setSelection([])
          setEdgeSelection([])
          setHoveredEdge(null)
          return
        case 'zoom-in': void flow?.zoomIn(); return
        case 'zoom-out': void flow?.zoomOut(); return
        case 'fit': void flow?.fitView({ padding: 0.2 }); return
        case 'copy': void clipboard.copy(selection as CanvasNodeId[]); return
        case 'paste': void clipboard.paste(); return
        case 'duplicate': void clipboard.duplicate(selection as CanvasNodeId[]); return
        case 'undo': replayHistory('undo'); return
        case 'redo': replayHistory('redo'); return
        case 'remove': {
          if (targetedEdges.length > 0) { cut(targetedEdges); return }
          const nodeIds = document.nodes.filter(node => selection.includes(node.id)).map(node => node.id)
          if (nodeIds.length === 0) return
          keyboardMutation.current = true
          void command({ kind: 'remove-nodes', nodeIds }).then((saved) => {
            if (saved) setSelection([])
          }).finally(() => { keyboardMutation.current = false })
          return
        }
        case 'move': {
          if (busy || keyboardMutation.current || pointerDrag.current !== null) return
          const moved = nodes.filter(node => selection.includes(node.id)).map(node => ({
            id: node.id as CanvasNodeId, position: { x: node.position.x + action.x, y: node.position.y + action.y },
          }))
          if (moved.length === 0) return
          keyboardMutation.current = true
          setDrag({ revision: document.revision, positions: Object.fromEntries(moved.map(node => [node.id, node.position])) })
          void command({ kind: 'move-nodes', nodes: moved }).then((saved) => {
            if (!saved) setDrag({ revision: document.revision, positions: {} })
          }).finally(() => { keyboardMutation.current = false })
          return
        }
        default: assertNever(action)
      }
    }
    owner.addEventListener('keydown', keydown, true)
    owner.defaultView?.addEventListener('blur', cancelDrag)
    owner.defaultView?.addEventListener('blur', cancelConnectionCreation)
    return () => {
      owner.removeEventListener('keydown', keydown, true)
      owner.defaultView?.removeEventListener('blur', cancelDrag)
      owner.defaultView?.removeEventListener('blur', cancelConnectionCreation)
    }
  }, [document, nodes, selection, hoveredEdge, edgeSelection, busy, cut, command, flow, contextMenu, closeContextMenu,
    connectionMenu, cancelConnectionCreation, clipboard, history, replayHistory])
  const edges: GraphEdge[] = document.connections.map(connection => ({
    id: connection.id, type: 'convaxConnection', source: connection.source, target: connection.target,
    sourceHandle: connection.sourcePort, targetHandle: connection.targetPort,
    selected: edgeSelection.includes(connection.id),
    data: {
      hovered: hoveredEdge === connection.id,
      endpointSelected: selection.includes(connection.source) || selection.includes(connection.target),
      busy, zoom, t, cut, hover: setHoveredEdge,
      select: (id) => { setEdgeSelection([id]); setSelection([]) },
    },
  }))
  const connect = (connection: Connection): void => {
    if (connectionGesture.current?.cancelled) return
    void command({
      kind: 'add-connection',
      connection: {
        id: randomUUID() as CanvasConnectionId,
        source: connection.source as CanvasNodeId, target: connection.target as CanvasNodeId,
        sourcePort: connection.sourceHandle ?? 'output', targetPort: connection.targetHandle ?? 'input',
        purpose: 'input',
      },
    })
  }
  const pickFiles = (position: CanvasPoint, origin?: CanvasConnectionOrigin): void => {
    if (busy) return
    filePosition.current = position
    fileOrigin.current = origin
    filePicker.current?.click()
  }
  const finishConnection: OnConnectEnd = (event, state): void => {
    const gesture = connectionGesture.current
    connectionGesture.current = null
    if (gesture === null || gesture.cancelled || busy || state.isValid === true || state.from === null || state.toHandle !== null) return
    const root = graph.current
    const screen = connectionDropPoint(event)
    if (root === null || screen === null || flow === null) return
    const hitTesting: Partial<Pick<Document, 'elementFromPoint'>> = root.ownerDocument
    const target = hitTesting.elementFromPoint?.(screen.x, screen.y) ?? (event.target instanceof Element ? event.target : null)
    if (!isBlankConnectionTarget(root, target)) return
    setContextMenu(null)
    setConnectionMenu({ origin: gesture.origin, screen, world: flow.screenToFlowPosition(screen),
      from: state.from, position: state.fromPosition })
  }
  const openContextMenu = (event: {
    readonly target: EventTarget | null
    readonly clientX: number
    readonly clientY: number
    preventDefault(): void
    stopPropagation(): void
  }, hitId?: CanvasNodeId): void => {
    if (ownsNativeCanvasContextMenu(event.target) || flow === null) return
    event.preventDefault()
    event.stopPropagation()
    setConnectionMenu(null)
    const screen = { x: event.clientX, y: event.clientY }
    const world = flow.screenToFlowPosition(screen)
    const measured = nodes.flatMap(node => node.measured?.width === undefined || node.measured.height === undefined ? [] : [{
      id: node.id as CanvasNodeId, ...node.position, width: node.measured.width, height: node.measured.height,
    }])
    const selected = document.nodes.filter(node => selection.includes(node.id)).map(node => node.id)
    const focused = graph.current?.ownerDocument.activeElement
    contextFocus.current = focused instanceof HTMLElement ? focused : null
    setContextMenu({ screen, world, nodeIds: canvasContextTargets(hitId, selected, measured, world) })
  }
  return (
    <div ref={graph} className={css.graph} data-convax-graph="" data-convax-clipboard-pending={clipboard.pending || undefined}
      data-convax-history-pending={history.pending || undefined}
      onPointerDownCapture={() => { pendingActivityReveal.current = null }}
      onWheelCapture={() => { pendingActivityReveal.current = null }}
      onKeyDownCapture={() => { pendingActivityReveal.current = null }}
      aria-busy={busy || clipboard.pending || history.pending} onPointerLeave={() => { setHoveredEdge(null) }}>
      <input ref={filePicker} type="file" multiple hidden aria-label={t('workspace.addFile')} onChange={(event) => {
        const origin = fileOrigin.current
        fileOrigin.current = undefined
        const files = [...event.currentTarget.files ?? []]
        event.currentTarget.value = ''
        const references = files.map((file) => {
          let path: string | null
          try { path = resolveFilePath(file) || null } catch (_pathError) { path = null }
          return { name: file.name, path }
        })
        if (!busy && references.length > 0) {
          if (origin === undefined) addResources(references, filePosition.current)
          else addResources(references, filePosition.current, origin)
        }
      }} />
      <ReactFlow<GraphNode, GraphEdge>
        nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES} onInit={setFlow}
        nodesDraggable={!busy} nodesConnectable={!busy} deleteKeyCode={null}
        onEdgesChange={(changes) => {
          for (const change of changes) if (change.type === 'select') setEdgeSelection(current => change.selected
            ? [...current.filter(id => id !== change.id), change.id] : current.filter(id => id !== change.id))
        }}
        onPaneClick={() => { setEdgeSelection([]); setHoveredEdge(null) }}
        onNodeClick={() => { setEdgeSelection([]); setHoveredEdge(null) }}
        onPaneContextMenu={(event) => { openContextMenu(event) }}
        onNodeContextMenu={(event, node) => { openContextMenu(event, node.id as CanvasNodeId) }}
        onSelectionContextMenu={(event) => { openContextMenu(event) }}
        panOnScroll={false} zoomOnScroll={false} zoomOnPinch preventScrolling={false}
        panActivationKeyCode={null} zoomActivationKeyCode={null}
        onNodesChange={(changes) => {
          const dimensions = changes.filter(change => change.type === 'dimensions')
          if (dimensions.length > 0) setMeasurements((current) => {
            const next = new Map(current)
            let changed = false
            for (const change of dimensions) {
              if (change.dimensions === undefined) continue
              const previous = current.get(change.id)
              if (previous?.width === change.dimensions.width && previous.height === change.dimensions.height) continue
              next.set(change.id, change.dimensions)
              changed = true
            }
            return changed ? next : current
          })
          if (dimensions.length > 0) {
            const pending = pendingActivityReveal.current
            if (pending !== null && latestPresentations.current[pending.nodeId]?.collapsed !== true
              && dimensions.some(change => change.id === pending.nodeId)) pending.waitingForExpansion = false
            queueMicrotask(() => { revealPastedNodes(); revealActivityNode() })
          }
          const gesture = snapping.current
          const anchor = gesture?.geometry.moving.find(node => node.id === gesture.anchorId)
          const anchorChange = changes.find(change => change.type === 'position' && change.id === gesture?.anchorId)
          if (gesture !== null && anchor !== undefined && anchorChange?.type === 'position' && anchorChange.position !== undefined
            && pointerDrag.current === 'active') {
            const result = snapCanvasDrag(gesture.geometry, {
              x: anchorChange.position.x - anchor.x, y: anchorChange.position.y - anchor.y,
            }, flow?.getZoom() ?? zoom)
            gesture.positions = result.positions
            setSnapGuides(result.guides)
            setDrag({ revision: document.revision, positions: Object.fromEntries(result.positions) })
          }
          for (const change of changes) {
            if (change.type === 'position' && change.position !== undefined && pointerDrag.current !== 'cancelled'
              && gesture === null) {
              const position = change.position
              setDrag(current => ({
                revision: document.revision,
                positions: { ...(current.revision === document.revision ? current.positions : {}), [change.id]: position },
              }))
            }
            if (change.type === 'select') {
              setSelection(current => change.selected
                ? [...current.filter(id => id !== change.id), change.id]
                : current.filter(id => id !== change.id))
            }
          }
        }}
        onNodeDragStart={(_event, anchor, moved) => {
          pointerDrag.current = 'active'
          const movingIds = new Set(moved.map(node => node.id as CanvasNodeId))
          const measured = nodes.flatMap(node => node.measured?.width === undefined || node.measured.height === undefined ? [] : [{
            id: node.id as CanvasNodeId, x: node.position.x, y: node.position.y,
            width: node.measured.width, height: node.measured.height,
          }])
          const geometry = createCanvasSnapGesture(measured, movingIds)
          snapping.current = geometry.moving.length !== moved.length ? null : {
            anchorId: anchor.id as CanvasNodeId, geometry,
            positions: new Map(moved.map(node => [node.id as CanvasNodeId, node.position])),
          }
          setSnapGuides([])
        }}
        onNodeDragStop={(_event, _node, moved) => {
          const cancelled = pointerDrag.current === 'cancelled'
          const positions = snapping.current?.positions
          pointerDrag.current = null
          snapping.current = null
          setSnapGuides([])
          if (cancelled) { setDrag({ revision: document.revision, positions: {} }); return }
          void command({ kind: 'move-nodes', nodes: moved.map(node => ({
            id: node.id as CanvasNodeId, position: positions?.get(node.id as CanvasNodeId) ?? node.position,
          })) })
            .then((saved) => {
              if (!saved) setDrag({ revision: document.revision, positions: {} })
            })
        }}
        onConnect={connect}
        onConnectStart={(_event, params) => {
          if (params.nodeId === null || params.handleId === null || params.handleType === null || busy) return
          setContextMenu(null)
          setConnectionMenu(null)
          connectionGesture.current = { cancelled: false, origin: captureConnectionTarget({
            nodeId: params.nodeId as CanvasNodeId, portId: params.handleId,
            direction: params.handleType === 'source' ? 'output' : 'input',
          }) }
        }}
        onConnectEnd={finishConnection}
        onEdgeDoubleClick={(_event, edge) => {
          cut([edge.id as CanvasConnectionId])
        }}
        onDragEnter={(event) => {
          if (ownsNodeDrop(event.target) || !isResourceTransfer(event.dataTransfer)) return
          event.preventDefault()
          event.stopPropagation()
        }}
        onDragOver={(event) => {
          if (ownsNodeDrop(event.target) || !isResourceTransfer(event.dataTransfer)) return
          event.preventDefault()
          event.stopPropagation()
          event.dataTransfer.dropEffect = busy || flow === null ? 'none' : 'copy'
        }}
        onDrop={(event) => {
          if (ownsNodeDrop(event.target) || !isResourceTransfer(event.dataTransfer)) return
          event.preventDefault()
          event.stopPropagation()
          if (flow === null || busy) return
          const internalPath = event.dataTransfer.getData(RESOURCE_DRAG_TYPE)
          const resources: DroppedResource[] = internalPath !== ''
            ? [{ name: internalPath, path: internalPath }]
            : [...event.dataTransfer.files].map((file) => {
              let path: string | null
              try { path = resolveFilePath(file) || null }
              catch (_pathError) { path = null }
              return { name: file.name, path }
            })
          if (resources.length > 0) addResources(resources,
            flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }))
        }}
        {...viewport === undefined ? {} : { defaultViewport: viewport }}
        fitView={viewport === undefined} onMove={(_event, next) => { setZoom(next.zoom) }}
        onMoveEnd={(_event, next) => { if (!viewportGesture.current) setViewport(next) }}
        minZoom={MIN_ZOOM} maxZoom={MAX_ZOOM} proOptions={{ hideAttribution: true }}
      >
        <Background color="var(--dsw-alias-border-l2)" gap={24} size={1} />
        <ViewportPortal>
          <svg className={css.snapGuides} aria-hidden="true">
            {snapGuides.map(guide => <line key={guide.axis} data-convax-snap-guide={guide.axis} data-coordinate={guide.coordinate}
              x1={guide.axis === 'x' ? guide.coordinate : guide.from} y1={guide.axis === 'x' ? guide.from : guide.coordinate}
              x2={guide.axis === 'x' ? guide.coordinate : guide.to} y2={guide.axis === 'x' ? guide.to : guide.coordinate}
              className={css.snapGuide} />)}
          </svg>
        </ViewportPortal>
        {connectionMenu !== null && <ConnectionCreationPreview origin={connectionMenu.origin} from={connectionMenu.from}
          to={connectionMenu.world} position={connectionMenu.position} />}
        <CreationDock busy={busy} creations={creations} invoke={invokeCreation} />
        <NodeToolbar nodeId={selection} position={Position.Top} isVisible={selection.length > 1}>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => {
            void command({ kind: 'remove-nodes', nodeIds: selection as CanvasNodeId[] }).then((saved) => {
              if (saved) setSelection([])
            })
          }}>{t('selection.remove')}</Button>
        </NodeToolbar>
      </ReactFlow>
      {connectionMenu !== null && <ConnectionCreationMenu point={connectionMenu.screen} busy={busy} close={closeConnectionMenu}
        creations={creations.filter(entry => entry.connected !== false).map(entry => ({ id: entry.id, label: typeof entry.label === 'string' ? entry.label : entry.label(),
          create: () => { invokeCreation(entry, connectionMenu.world, connectionMenu.origin) } }))} />}
      {contextMenu !== null && <CanvasContextMenu point={contextMenu.screen} targetCount={contextMenu.nodeIds.length}
        busy={busy || clipboard.pending} history={history} replayHistory={replayHistory} t={t}
        close={closeContextMenu}
        creations={creations.map(entry => ({ id: entry.id, label: typeof entry.label === 'string' ? entry.label : entry.label(),
          create: () => { invokeCreation(entry, contextMenu.world) } }))}
        focus={() => { void flow?.fitView({ nodes: contextMenu.nodeIds.map(id => ({ id })), padding: 0.2 }) }}
        remove={() => { void command({ kind: 'remove-nodes', nodeIds: [...contextMenu.nodeIds] }).then((saved) => {
          if (saved) setSelection(current => current.filter(id => !contextMenu.nodeIds.includes(id as CanvasNodeId)))
        }) }}
        selectAll={() => { setSelection(document.nodes.map(node => node.id)); setEdgeSelection([]); setHoveredEdge(null) }}
        copy={() => { void clipboard.copy(contextMenu.nodeIds) }}
        paste={() => { void clipboard.paste(contextMenu.world) }}
        duplicate={() => { void clipboard.duplicate(contextMenu.nodeIds) }}
        fit={() => { void flow?.fitView({ padding: 0.2 }) }} />}
      <div className={css.graphControls}>
        <select className={css.inputMode} aria-label={t('canvas.inputMode')} value={inputMode}
          onChange={(event) => {
            const mode = event.currentTarget.value
            if (mode === 'touchpad' || mode === 'mouse') setInputMode(mode)
          }}>
          <option value="touchpad">{t('canvas.input.touchpad')}</option>
          <option value="mouse">{t('canvas.input.mouse')}</option>
        </select>
        <Tooltip label={t('canvas.zoom.out')} portal>
          <Button size="sm" aria-label={t('canvas.zoom.out')} onClick={() => { void flow?.zoomOut() }}><span className={css.minus} /></Button>
        </Tooltip>
        <Tooltip label={t('canvas.zoom.reset')} portal>
          <Button size="sm" aria-label={t('canvas.zoom.reset')} onClick={() => { void flow?.zoomTo(1) }}>{new Intl.NumberFormat(globalThis.document.documentElement.lang || 'en', { style: 'percent', maximumFractionDigits: 0 }).format(zoom)}</Button>
        </Tooltip>
        <Tooltip label={t('canvas.zoom.in')} portal>
          <Button size="sm" aria-label={t('canvas.zoom.in')} onClick={() => { void flow?.zoomIn() }}><Plus size={14} aria-hidden /></Button>
        </Tooltip>
        <Button size="sm" onClick={() => { void flow?.fitView({ padding: 0.2 }) }}>{t('canvas.zoom.fit')}</Button>
        <Button size="sm" disabled={busy || clipboard.pending || history.pending || !history.canUndo}
          onClick={() => { replayHistory('undo') }}>{t('history.undo')}</Button>
        <Button size="sm" disabled={busy || clipboard.pending || history.pending || !history.canRedo}
          onClick={() => { replayHistory('redo') }}>{t('history.redo')}</Button>
      </div>
      {document.nodes.length === 0 && <div className={css.graphHint}>{t('canvas.hint')}</div>}
    </div>
  )
}
