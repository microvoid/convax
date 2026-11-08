/** Controlled graph presentation; Host commands own every durable edit. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background, NodeToolbar, Panel, Position, ReactFlow, ReactFlowProvider, ViewportPortal, useStore as useFlowStore,
  type Connection, type Node, type NodeProps, type OnConnectEnd, type ReactFlowInstance, type Viewport,
} from '@xyflow/react'
import { Button, Input, Modal, isBehindModal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  CanvasChat, CanvasCommand, CanvasConnectionId, CanvasDocument, CanvasNode, CanvasNodeId, CanvasNodeIssue,
  CanvasNodeTypeInfo, CanvasPoint, CanvasPort, CanvasResource, CanvasGroupId, CanvasGroupColor,
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
import { CanvasAddToolbar } from './CanvasAddToolbar.tsx'
import { CanvasViewToolbar } from './CanvasViewToolbar.tsx'
import toolbarCss from './CanvasToolbar.module.css'
import { CanvasGroupingController, CanvasGroupDrag, canvasGroupBounds, type CanvasSelection } from './canvas-grouping.ts'
import { CanvasGroupFrame } from './CanvasGroupFrame.tsx'
import { GroupColorPicker } from './GroupColorPicker.tsx'
import { CanvasGroupColorController, type CanvasGroupColorView } from './group-color-controller.ts'

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
    active: data.active,
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
  readonly active?: boolean
  readonly document: CanvasDocument
  readonly ensureCanvasDirectory?: () => Promise<string>
  readonly getNode?: (nodeId: CanvasNodeId) => CanvasNode | undefined
  readonly inputDirectory?: (nodeId: CanvasNodeId) => Promise<string | undefined>
  readonly chats: readonly CanvasChat[]
  readonly nodeTypes: readonly CanvasNodeTypeInfo[]
  readonly nodeIssues: readonly CanvasNodeIssue[]
  readonly rendererDefinitions?: Readonly<Record<string, Pick<CanvasNodeRendererDefinition, 'defaultSize' | 'defaultExpanded' | 'dragHandle' | 'presentation' | 'clipboardData'>>>
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

const FIT_PADDING = { top: '112px', bottom: '112px', left: 0.2, right: 0.2 } as const

function CreationDock({ busy, creations, invoke, t }: {
  readonly busy: boolean
  readonly creations: readonly CanvasCreationDefinition[]
  readonly invoke: (entry: CanvasCreationDefinition, position: CanvasPoint) => void
  readonly t: WorkspaceProps['t']
}) {
  const width = useFlowStore(state => state.width)
  const height = useFlowStore(state => state.height)
  const transform = useFlowStore(state => state.transform)
  return creations.length === 0 ? null : <Panel position="bottom-center" className={`${css.creationDock} ${toolbarCss.bar} nodrag nopan nowheel`} data-convax-creation-dock="">
    <CanvasAddToolbar creations={creations} busy={busy} t={t} create={(entry) => {
      const size = entry.defaultSize ?? { width: RESOURCE_CARD_WIDTH, height: 140 }
      const top = width <= 600 ? 112 : 72
      const position = { x: (width / 2 - transform[0]) / transform[2] - size.width / 2,
        y: (Math.max(top, top + (height - top - 112 - size.height * transform[2]) / 2) - transform[1]) / transform[2] }
      invoke(entry, position)
    }} />
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
  active = true, document, ensureCanvasDirectory, getNode, inputDirectory, chats, nodeTypes, nodeIssues,
  rendererDefinitions = {}, creations = [], renderSlot, createChat, threadFocus, consumeThreadFocus,
  t, busy, viewport, setViewport, inputMode, setInputMode, resourceViews, setResourceExpanded, setResourcePreviewSize,
  command, openResource, openSource, resolveFilePath, addResources, addProject, addWindow, captureConnectionTarget, reportClipboard,
  chatPresentations, applyChatPresentation, applyResourceView,
  history, replayHistory,
}: CanvasGraphProps) {
  const dragSelects = inputMode === 'touchpad'
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
    readonly groupIds: readonly CanvasGroupId[]
  } | null>(null)
  const contextFocus = useRef<HTMLElement | null>(null)
  const groupingInputs = useRef({ document, command, available: !busy && !history.pending })
  groupingInputs.current = { document, command, available: !busy && !history.pending }
  const [grouping] = useState(() => new CanvasGroupingController({
    document: () => groupingInputs.current.document,
    command: operation => groupingInputs.current.command(operation),
    newId: () => randomUUID() as CanvasGroupId,
  }))
  const [selectedGroupIds, setGroupSelection] = useState<CanvasGroupId[]>([])
  const colorAnchor = useRef<HTMLElement | null>(null)
  const [colorPicker, setColorPicker] = useState<CanvasGroupColorView | null>(null)
  const [coloring] = useState(() => new CanvasGroupColorController({
    document: () => groupingInputs.current.document,
    available: () => groupingInputs.current.available && pointerDrag.current === null,
    setColor: (ids, color) => grouping.setColor(ids, color), changed: setColorPicker,
  }))
  const previewGroupColor = useCallback((color: CanvasGroupColor | null | undefined): void => { coloring.preview(color) }, [coloring])
  const closeGroupColors = useCallback((): void => { coloring.close() }, [coloring])
  useEffect(() => () => { coloring.dispose() }, [coloring])
  const [renamingGroup, setRenamingGroup] = useState<{ id: CanvasGroupId; title: string } | null>(null)
  const groupPointer = useRef<{ cancel: () => void } | null>(null)
  useEffect(() => {
    if (!active) groupPointer.current?.cancel()
    return () => { groupPointer.current?.cancel() }
  }, [active, document.id, document.revision])
  const cutting = useRef(false)
  const keyboardMutation = useRef(false)
  const pointerDrag = useRef<'active' | 'cancelled' | null>(null)
  const groupedNodeDrag = useRef<{
    gesture: CanvasGroupDrag
    anchorId: string
    origin: CanvasPoint
    canvasId: CanvasDocument['id']
    revision: number
  } | null>(null)
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
  useEffect(() => {
    const grouped = groupedNodeDrag.current
    if (grouped === null || active && grouped.canvasId === document.id && grouped.revision === document.revision) return
    groupedNodeDrag.current = null
    pointerDrag.current = 'cancelled'
    snapping.current = null
    setSnapGuides([])
    setDrag({ revision: document.revision, positions: {} })
  }, [active, document.id, document.revision])
  const [selectedNodeIds, setSelection] = useState<string[]>([])
  const retainedNodeIds = useMemo(() => new Set<string>(document.nodes.map(node => node.id)), [document.nodes])
  // Host updates can remove selected nodes before React Flow emits a selection change.
  const selection = useMemo(() => selectedNodeIds.filter(id => retainedNodeIds.has(id)), [selectedNodeIds, retainedNodeIds])
  const groupSelection = grouping.selectedGroups({ nodeIds: selection as CanvasNodeId[], groupIds: selectedGroupIds })
  const [edgeSelection, setEdgeSelection] = useState<string[]>([])
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null)
  const [measurements, setMeasurements] = useState<ReadonlyMap<string, { width: number; height: number }>>(new Map())
  const [zoom, setZoom] = useState(viewport?.zoom ?? 1)
  const selectedTargets: CanvasSelection = { nodeIds: selection as CanvasNodeId[], groupIds: groupSelection }
  const selectedMembers = grouping.members(selectedTargets)
  const colorSelectionKey = JSON.stringify([...groupSelection].sort())
  useEffect(() => { coloring.reconcile(active, groupSelection) }, [active, document.id, document.revision, colorSelectionKey, coloring])
  const openGroupColors = (groupIds: readonly CanvasGroupId[], anchor: HTMLElement): void => {
    if (!coloring.open(groupIds)) return
    colorAnchor.current = anchor
    setSelection([])
    setGroupSelection([...groupIds])
  }
  const createGroup = (targets: CanvasSelection): void => {
    if (busy || pointerDrag.current !== null) return
    void grouping.group(targets, t('group.untitled')).then((id) => {
      if (id !== null) { setSelection([]); setGroupSelection([id]); setEdgeSelection([]) }
    })
  }
  const ungroup = (ids: readonly CanvasGroupId[]): void => {
    if (busy || ids.length === 0) return
    const members = grouping.members({ nodeIds: [], groupIds: ids })
    void grouping.ungroup(ids).then((saved) => {
      if (saved) { setGroupSelection(current => current.filter(id => !ids.includes(id))); setSelection(members) }
    })
  }
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
    if (!active || root === null || flow === null) return
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
  }, [active, flow, inputMode])
  useEffect(() => {
    setSelection(current => current.every(id => retainedNodeIds.has(id))
      ? current : current.filter(id => retainedNodeIds.has(id)))
    setMeasurements(current => [...current.keys()].every(id => retainedNodeIds.has(id))
      ? current
      : new Map([...current].filter(([id]) => retainedNodeIds.has(id))))
  }, [retainedNodeIds])
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
        }, active, busy, t,
        chooseWindow: addWindow === undefined ? undefined : (nodeId) => { addWindow(node.position, nodeId) },
        chat: chats.find(item => item.nodeId === node.id),
        canvasId: document.id, canvasRevision: document.revision, renderSlot,
        focusSessionId: active && threadFocus?.nodeId === node.id ? threadFocus.sessionId : undefined,
        consumeFocus: () => { if (threadFocus?.nodeId === node.id) consumeThreadFocus(node.id, threadFocus.sessionId) },
        inputs: inputNodes.get(node.id) ?? [],
        resourceExpanded: resourceView?.expanded ?? rendererDefinitions[node.typeId]?.defaultExpanded ?? false,
        setResourceExpanded: (expanded) => { setResourceExpanded(node.id, expanded) },
        ...(resourceView?.height === undefined ? {} : { resourcePreviewHeight: resourceView.height }),
        ...(resourceView?.width === undefined ? {} : { resourcePreviewWidth: resourceView.width }),
        setResourcePreviewSize: (size) => { setResourcePreviewSize(node.id, size) },
        focusNode: () => { if (active) void flow?.fitView({ nodes: [{ id: node.id }], padding: FIT_PADDING }) },
      },
    }
  }), [document, nodeTypes, nodeIssues, rendererDefinitions, drag, selection, measurements, t, command, openResource, openSource, chats,
    renderSlot, createChat, threadFocus, consumeThreadFocus, busy, flow, inputNodes,
    resourceViews, setResourceExpanded, setResourcePreviewSize, addWindow, activityHighlight, active])
  const revealPastedNodes = useCallback((): void => {
    const ids = pendingReveal.current
    if (!active || graph.current === null || flow === null || ids === null
      || !ids.every(id => flow.getNode(id)?.measured?.width !== undefined)) return
    pendingReveal.current = null
    void flow.fitView({ nodes: ids.map(id => ({ id })), padding: FIT_PADDING })
  }, [active, flow])
  const revealActivityNode = useCallback((): void => {
    const request = pendingActivityReveal.current
    if (!active || flow === null || request === null || request.canvasId !== document.id
      || request.waitingForExpansion || latestPresentations.current[request.nodeId]?.collapsed === true) return
    const target = flow.getNode(request.nodeId)
    if (target?.measured?.width === undefined || target.measured.height === undefined) return
    pendingActivityReveal.current = null
    setActivityHighlight(request.nodeId)
    void flow.fitView({ nodes: [{ id: request.nodeId }], padding: FIT_PADDING,
      minZoom: MIN_ZOOM, maxZoom: flow.getZoom(),
      duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 240 })
  }, [active, flow, document.id])
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
  const geometry = nodes.map(node => ({ id: node.id as CanvasNodeId, ...node.position,
    width: node.measured?.width ?? (rendererDefinitions[node.data.node.typeId]?.defaultSize?.width ?? RESOURCE_CARD_WIDTH),
    height: node.measured?.height ?? (rendererDefinitions[node.data.node.typeId]?.defaultSize?.height ?? 140),
  }))
  const groupFrames = canvasGroupBounds(document, geometry)
  const visibleGroupFrames = groupFrames.map((frame) => {
    if (colorPicker === null || colorPicker.preview === undefined || !colorPicker.groupIds.includes(frame.id)) return frame
    const preview = { ...frame }
    if (colorPicker.preview === null) delete preview.color
    else preview.color = colorPicker.preview
    return preview
  })

  const dimensions = Object.fromEntries(geometry.map(({ id, width, height }) => [id, { width, height }]))
  const views = Object.fromEntries(nodes.map((node): [string, CanvasClipboardView] => [node.id,
    rendererDefinitions[node.data.node.typeId]?.presentation === 'chat' ? { kind: 'chat', presentation: chatPresentations[node.id] ?? { collapsed: false } }
      : rendererDefinitions[node.data.node.typeId]?.presentation === 'resource'
        ? { kind: 'resource', presentation: resourceViews[node.id] ?? { expanded: rendererDefinitions[node.data.node.typeId]?.defaultExpanded ?? false } } : { kind: 'default' },
  ]))
  const clipboard = useCanvasClipboard({ document, dimensions, views,
    copyData: node => rendererDefinitions[node.typeId]?.clipboardData?.(node) ?? structuredClone(node.data),
    obstacles: geometry, command, report: reportClipboard,
    select: (ids) => { setSelection(ids); setGroupSelection([]); setEdgeSelection([]); setHoveredEdge(null) },
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
    const context: CanvasCreationContext = { canvasId: document.id, position, ...(origin === undefined ? {} : { origin }), command,
      ensureCanvasDirectory: ensureCanvasDirectory ?? (() => Promise.reject(new Error('Canvas directories are unavailable'))),
      getNode: getNode ?? (nodeId => document.nodes.find(node => node.id === nodeId)),
      inputDirectory: inputDirectory ?? (() => Promise.resolve(undefined)),
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
    if (!active || root === null) return
    const owner = root.ownerDocument
    const cancelDrag = (): void => {
      if (pointerDrag.current === null) return
      if (groupPointer.current !== null) { groupPointer.current.cancel(); return }
      pointerDrag.current = 'cancelled'
      groupedNodeDrag.current = null
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
      if ((action.kind === 'copy' || action.kind === 'duplicate') && selectedMembers.length === 0) return
      if (action.kind === 'group' && (busy || !grouping.canGroup(selectedTargets) || pointerDrag.current !== null)) return
      if (action.kind === 'ungroup' && (busy || groupSelection.length === 0 || pointerDrag.current !== null)) return
      if ((action.kind === 'copy' || action.kind === 'paste' || action.kind === 'duplicate')
        && (busy || clipboard.pending || pointerDrag.current !== null)) return
      if ((action.kind === 'undo' || action.kind === 'redo') && (busy || clipboard.pending || history.pending
        || pointerDrag.current !== null || !(action.kind === 'undo' ? history.canUndo : history.canRedo))) return
      const focused = owner.activeElement
      if (action.kind === 'move' && selectedMembers.length === 0) return
      if (action.kind === 'remove' && (busy || cutting.current || keyboardMutation.current)) return
      const focusedEdge = focused?.closest('.react-flow__edge')?.getAttribute('data-id')
      const edgeCandidates = hoveredEdge === null ? focusedEdge ? [focusedEdge] : edgeSelection : [hoveredEdge]
      const targetedEdges = document.connections.filter(connection => edgeCandidates.includes(connection.id))
        .map(connection => connection.id)
      if (action.kind === 'remove' && targetedEdges.length === 0
        && selectedMembers.length === 0) return
      event.preventDefault()
      event.stopPropagation()
      switch (action.kind) {
        case 'select-all':
          if (pointerDrag.current !== null) return
          setSelection(document.nodes.filter(node => node.groupId === undefined).map(node => node.id))
          setGroupSelection((document.groups ?? []).map(group => group.id))
          setEdgeSelection([])
          setHoveredEdge(null)
          return
        case 'cancel':
          if (clipboard.cancel()) return
          cancelDrag()
          setSelection([])
          setGroupSelection([])
          setEdgeSelection([])
          setHoveredEdge(null)
          return
        case 'zoom-in': void flow?.zoomIn(); return
        case 'zoom-out': void flow?.zoomOut(); return
        case 'fit': void flow?.fitView({ padding: FIT_PADDING }); return
        case 'copy': void clipboard.copy(selectedMembers); return
        case 'paste': void clipboard.paste(); return
        case 'duplicate': void clipboard.duplicate(selectedMembers); return
        case 'group': createGroup(selectedTargets); return
        case 'ungroup': ungroup(groupSelection); return
        case 'undo': replayHistory('undo'); return
        case 'redo': replayHistory('redo'); return
        case 'remove': {
          if (targetedEdges.length > 0) { cut(targetedEdges); return }
          const nodeIds = selectedMembers
          if (nodeIds.length === 0) return
          keyboardMutation.current = true
          void (groupSelection.length === 0 ? command({ kind: 'remove-nodes', nodeIds }) : grouping.remove(selectedTargets)).then((saved) => {
            if (saved) { setSelection([]); setGroupSelection([]) }
          }).finally(() => { keyboardMutation.current = false })
          return
        }
        case 'move': {
          if (busy || keyboardMutation.current || pointerDrag.current !== null) return
          const moved = nodes.filter(node => selectedMembers.includes(node.id as CanvasNodeId)).map(node => ({
            id: node.id as CanvasNodeId, position: { x: node.position.x + action.x, y: node.position.y + action.y },
          }))
          if (moved.length === 0) return
          keyboardMutation.current = true
          setDrag({ revision: document.revision, positions: Object.fromEntries(moved.map(node => [node.id, node.position])) })
          void (groupSelection.length === 0 ? command({ kind: 'move-nodes', nodes: moved }) : grouping.move(selectedTargets, { x: action.x, y: action.y })).then((saved) => {
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
    connectionMenu, cancelConnectionCreation, clipboard, history, replayHistory, active, groupSelection, selectedMembers, grouping])
  const edges: GraphEdge[] = document.connections.map(connection => ({
    id: connection.id, type: 'convaxConnection', source: connection.source, target: connection.target,
    sourceHandle: connection.sourcePort, targetHandle: connection.targetPort,
    selected: edgeSelection.includes(connection.id),
    data: {
      hovered: hoveredEdge === connection.id,
      endpointSelected: selection.includes(connection.source) || selection.includes(connection.target),
      busy, zoom, t, cut, hover: setHoveredEdge,
      select: (id) => { setEdgeSelection([id]); setSelection([]); setGroupSelection([]) },
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
    const ids = canvasContextTargets(hitId, selected, measured, world)
    const inSelectedGroup = hitId === undefined && groupFrames.some(frame => groupSelection.includes(frame.id)
      && world.x >= frame.x && world.x <= frame.x + frame.width && world.y >= frame.y && world.y <= frame.y + frame.height)
    setContextMenu({ screen, world, nodeIds: ids,
      groupIds: grouping.selectedGroups({ nodeIds: ids, groupIds: inSelectedGroup ? groupSelection : [] }) })
  }
  return (
    <div ref={graph} className={css.graph} data-convax-graph="" data-convax-clipboard-pending={clipboard.pending || undefined}
      data-convax-history-pending={history.pending || undefined} data-canvas-drag-select={dragSelects || undefined}
      onPointerDownCapture={(event) => {
        pendingActivityReveal.current = null
        if (event.target instanceof Element && event.target.closest('[data-convax-group-color-picker], [data-convax-group-color-trigger]') === null) {
          coloring.close()
        }
        if (event.target instanceof Element && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
          const nodeId = event.target.closest('.react-flow__node')?.getAttribute('data-id')
          if (event.target.classList.contains('react-flow__pane') || nodeId !== undefined && nodeId !== null && !selection.includes(nodeId)) setGroupSelection([])
        }
      }}
      onWheelCapture={(event) => {
        pendingActivityReveal.current = null
        if (!(event.target instanceof Element) || event.target.closest('[data-convax-group-color-picker]') === null) coloring.close()
      }}
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
        onPaneClick={() => { setGroupSelection([]); setEdgeSelection([]); setHoveredEdge(null) }}
        onNodeClick={(event) => {
          if (!event.shiftKey && !event.metaKey && !event.ctrlKey) setGroupSelection([])
          setEdgeSelection([]); setHoveredEdge(null)
        }}
        onPaneContextMenu={(event) => { openContextMenu(event) }}
        onNodeContextMenu={(event, node) => { openContextMenu(event, node.id as CanvasNodeId) }}
        onSelectionContextMenu={(event) => { openContextMenu(event) }}
        panOnScroll={false} zoomOnScroll={false} zoomOnPinch preventScrolling={false}
        panActivationKeyCode={null} zoomActivationKeyCode={null}
        // Touchpad panning comes from two-finger scroll, Space, and the middle button, so a primary
        // drag box-selects there. Mouse mode keeps its drag-to-pan navigation. The button array also
        // leaves touch panning to React Flow instead of turning touch drags into a selection.
        panOnDrag={dragSelects ? [1] : true} selectionOnDrag={dragSelects}
        onNodesChange={(changes) => {
          if (!active) return
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
          const grouped = groupedNodeDrag.current
          const groupedAnchor = changes.find(change => change.type === 'position' && change.id === grouped?.anchorId)
          if (grouped !== null && groupedAnchor?.type === 'position' && groupedAnchor.position !== undefined && pointerDrag.current === 'active') {
            const result = grouped.gesture.preview({
              x: groupedAnchor.position.x - grouped.origin.x, y: groupedAnchor.position.y - grouped.origin.y,
            }, flow?.getZoom() ?? zoom)
            setDrag({ revision: grouped.revision, positions: result.positions }); setSnapGuides(result.guides)
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
              && gesture === null && grouped === null) {
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
          if (!active) return
          pointerDrag.current = 'active'
          if (groupSelection.length > 0) {
            groupedNodeDrag.current = { gesture: new CanvasGroupDrag(document, selectedTargets, geometry, groupFrames),
              anchorId: anchor.id, origin: anchor.position, canvasId: document.id, revision: document.revision }
            snapping.current = null; setSnapGuides([]); return
          }
          setGroupSelection([])
          const movingIds = new Set(moved.map(node => node.id as CanvasNodeId))
          const measured = nodes.flatMap(node => node.measured?.width === undefined || node.measured.height === undefined ? [] : [{
            id: node.id as CanvasNodeId, x: node.position.x, y: node.position.y,
            width: node.measured.width, height: node.measured.height,
          }])
          const snapGeometry = createCanvasSnapGesture(measured, movingIds)
          snapping.current = snapGeometry.moving.length !== moved.length ? null : {
            anchorId: anchor.id as CanvasNodeId, geometry: snapGeometry,
            positions: new Map(moved.map(node => [node.id as CanvasNodeId, node.position])),
          }
          setSnapGuides([])
        }}
        onNodeDragStop={(_event, _node, moved) => {
          const positions = snapping.current?.positions
          const grouped = groupedNodeDrag.current
          const cancelled = pointerDrag.current === 'cancelled' || !active
            || grouped !== null && (grouped.canvasId !== document.id || grouped.revision !== document.revision)
          groupedNodeDrag.current = null
          pointerDrag.current = null
          snapping.current = null
          setSnapGuides([])
          if (cancelled) { setDrag({ revision: document.revision, positions: {} }); return }
          if (grouped !== null) {
            const operation = grouped.gesture.command()
            if (operation !== null) void command(operation).then((saved) => {
              if (!saved) setDrag({ revision: document.revision, positions: {} })
            })
            return
          }
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
        fitView={viewport === undefined} fitViewOptions={{ padding: FIT_PADDING }} onMove={(_event, next) => { setZoom(next.zoom) }}
        onMoveEnd={(_event, next) => { if (!viewportGesture.current) setViewport(next) }}
        minZoom={MIN_ZOOM} maxZoom={MAX_ZOOM} proOptions={{ hideAttribution: true }}
      >
        <Background color="var(--dsw-alias-border-l2)" gap={24} size={1} />
        <ViewportPortal>
          {visibleGroupFrames.map(frame => <CanvasGroupFrame key={frame.id} frame={frame}
            selected={groupSelection.includes(frame.id)}
            busy={busy || clipboard.pending || history.pending || colorPicker?.pending === true}
            t={t} currentColor={grouping.color(groupSelection) ?? 'default'}
            color={(anchor) => { openGroupColors(groupSelection.includes(frame.id) ? groupSelection : [frame.id], anchor) }}
            select={(extend) => {
              setGroupSelection((current) => {
                if (extend) return current.includes(frame.id) ? current.filter(id => id !== frame.id) : [...current, frame.id]
                return current.includes(frame.id) ? current : [frame.id]
              })
              if (!extend && !groupSelection.includes(frame.id)) setSelection([])
              setEdgeSelection([]); setHoveredEdge(null)
            }}
            rename={() => { setRenamingGroup({ id: frame.id, title: frame.title }) }}
            context={(event) => {
              event.preventDefault(); event.stopPropagation()
              contextFocus.current = event.currentTarget
              setContextMenu({ screen: { x: event.clientX, y: event.clientY },
                world: flow?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? { x: frame.x, y: frame.y },
                nodeIds: groupSelection.includes(frame.id) ? selection as CanvasNodeId[] : [],
                groupIds: groupSelection.includes(frame.id) ? groupSelection : [frame.id] })
            }}
            drag={(event) => {
              if (flow === null || pointerDrag.current !== null || event.shiftKey || event.metaKey || event.ctrlKey) return
              const targets: CanvasSelection = groupSelection.includes(frame.id) ? selectedTargets : { nodeIds: [], groupIds: [frame.id] }
              const gesture = new CanvasGroupDrag(document, targets, geometry, groupFrames)
              const start = { x: event.clientX, y: event.clientY }
              const owner = event.currentTarget.ownerDocument
              const element = event.currentTarget
              const pointerId = event.pointerId
              const revision = document.revision
              let distance = 0
              let ended = false
              pointerDrag.current = 'active'
              element.setPointerCapture(pointerId)
              const detach = (): void => {
                owner.removeEventListener('pointermove', move, true)
                owner.removeEventListener('pointerup', up, true)
                owner.removeEventListener('pointercancel', cancel, true)
                owner.defaultView?.removeEventListener('blur', cancel)
                if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId)
                groupPointer.current = null
                pointerDrag.current = null
                setSnapGuides([])
              }
              const cancel = (): void => {
                if (ended) return
                ended = true; detach(); setDrag({ revision, positions: {} })
              }
              const move = (next: PointerEvent): void => {
                if (next.pointerId !== pointerId) return
                next.preventDefault(); next.stopPropagation()
                const dx = next.clientX - start.x
                const dy = next.clientY - start.y
                distance = Math.max(distance, Math.hypot(dx, dy))
                if (distance < 3) return
                const result = gesture.preview({ x: dx / flow.getZoom(), y: dy / flow.getZoom() }, flow.getZoom())
                setDrag({ revision, positions: result.positions }); setSnapGuides(result.guides)
              }
              const up = (next: PointerEvent): void => {
                if (next.pointerId !== pointerId) return
                move(next)
                ended = true; detach()
                const operation = distance < 3 ? null : gesture.command()
                if (operation !== null) void command(operation).then((saved) => { if (!saved) setDrag({ revision, positions: {} }) })
              }
              groupPointer.current = { cancel }
              owner.addEventListener('pointermove', move, true)
              owner.addEventListener('pointerup', up, true)
              owner.addEventListener('pointercancel', cancel, true)
              owner.defaultView?.addEventListener('blur', cancel)
            }} />)}
          <svg className={css.snapGuides} aria-hidden="true">
            {snapGuides.map(guide => <line key={guide.axis} data-convax-snap-guide={guide.axis} data-coordinate={guide.coordinate}
              x1={guide.axis === 'x' ? guide.coordinate : guide.from} y1={guide.axis === 'x' ? guide.from : guide.coordinate}
              x2={guide.axis === 'x' ? guide.coordinate : guide.to} y2={guide.axis === 'x' ? guide.to : guide.coordinate}
              className={css.snapGuide} />)}
          </svg>
        </ViewportPortal>
        {connectionMenu !== null && <ConnectionCreationPreview origin={connectionMenu.origin} from={connectionMenu.from}
          to={connectionMenu.world} position={connectionMenu.position} />}
        <CreationDock busy={busy} creations={creations} invoke={invokeCreation} t={t} />
        <NodeToolbar nodeId={selectedMembers} position={groupSelection.length > 0 ? Position.Bottom : Position.Top}
          isVisible={active && selectedMembers.length > 1}>
          {grouping.canGroup(selectedTargets) && <Button size="sm" variant="outline" disabled={busy}
            onClick={() => { createGroup(selectedTargets) }}>{t('group.create')}</Button>}
          {groupSelection.length > 0 && <Button size="sm" variant="outline" disabled={busy} onClick={() => { ungroup(groupSelection) }}>{t('group.ungroup')}</Button>}
          <Button size="sm" variant="outline" disabled={busy} onClick={() => {
            void (groupSelection.length === 0 ? command({ kind: 'remove-nodes', nodeIds: selection as CanvasNodeId[] }) : grouping.remove(selectedTargets)).then((saved) => {
              if (saved) { setSelection([]); setGroupSelection([]) }
            })
          }}>{t('selection.remove')}</Button>
        </NodeToolbar>
      </ReactFlow>
      {active && connectionMenu !== null && <ConnectionCreationMenu point={connectionMenu.screen} busy={busy} close={closeConnectionMenu}
        creations={creations.filter(entry => entry.connected !== false
          && (entry.connectionDirection === undefined || entry.connectionDirection !== connectionMenu.origin.direction))
          .map(entry => ({ id: entry.id, label: typeof entry.label === 'string' ? entry.label : entry.label(),
            create: () => { invokeCreation(entry, connectionMenu.world, connectionMenu.origin) } }))} />}
      {active && contextMenu !== null && <CanvasContextMenu point={contextMenu.screen}
        targetCount={grouping.members(contextMenu).length} groupCount={contextMenu.groupIds.length}
        groups={document.groups ?? []} canGroup={grouping.canGroup(contextMenu)}
        canRemoveFromGroup={document.nodes.some(node => grouping.members(contextMenu).includes(node.id) && node.groupId !== undefined)}
        group={() => { createGroup(contextMenu) }} ungroup={() => { ungroup(contextMenu.groupIds) }}
        colorGroup={contextMenu.groupIds.length === 0 ? undefined : () => {
          const header = [...graph.current?.querySelectorAll<HTMLElement>('[data-convax-group-header]') ?? []]
            .find(element => element.dataset.convaxGroupHeader === contextMenu.groupIds[0])
          if (header !== undefined) openGroupColors(contextMenu.groupIds, header)
        }}
        renameGroup={contextMenu.groupIds.length === 1 ? () => {
          const group = document.groups?.find(item => item.id === contextMenu.groupIds[0])
          if (group !== undefined) setRenamingGroup({ id: group.id, title: group.title })
        } : undefined}
        assignGroup={(groupId) => { void grouping.assign(contextMenu, groupId) }}
        busy={busy || clipboard.pending} history={history} replayHistory={replayHistory} t={t} close={closeContextMenu}
        creations={creations.map(entry => ({ id: entry.id, label: typeof entry.label === 'string' ? entry.label : entry.label(),
          create: () => { invokeCreation(entry, contextMenu.world) } }))}
        focus={() => { void flow?.fitView({ nodes: grouping.members(contextMenu).map(id => ({ id })), padding: FIT_PADDING }) }}
        remove={() => {
          void (contextMenu.groupIds.length === 0 ? command({ kind: 'remove-nodes', nodeIds: [...contextMenu.nodeIds] }) : grouping.remove(contextMenu)).then((saved) => {
            if (saved) {
              setSelection(current => current.filter(id => !contextMenu.nodeIds.includes(id as CanvasNodeId)))
              setGroupSelection(current => current.filter(id => !contextMenu.groupIds.includes(id)))
            }
          })
        }}
        selectAll={() => {
          setSelection(document.nodes.filter(node => node.groupId === undefined).map(node => node.id))
          setGroupSelection((document.groups ?? []).map(group => group.id)); setEdgeSelection([]); setHoveredEdge(null)
        }}
        copy={() => { void clipboard.copy(grouping.members(contextMenu)) }}
        paste={() => { void clipboard.paste(contextMenu.world) }}
        duplicate={() => { void clipboard.duplicate(grouping.members(contextMenu)) }}
        fit={() => { void flow?.fitView({ padding: FIT_PADDING }) }} />}
      {active && colorPicker !== null && <GroupColorPicker anchorRef={colorAnchor}
        current={grouping.color(colorPicker.groupIds)} pending={colorPicker.pending || busy || history.pending}
        preview={previewGroupColor} apply={(color) => { void coloring.apply(color) }} close={closeGroupColors} t={t} />}
      <Modal open={renamingGroup !== null} onClose={() => { if (!busy) setRenamingGroup(null) }}
        title={t('group.rename')} closeLabel={t('canvas.cancel')}>
        <form className={css.renameForm} onSubmit={(event) => {
          event.preventDefault()
          if (renamingGroup !== null && renamingGroup.title.trim() !== '') void grouping.rename(renamingGroup.id, renamingGroup.title).then((saved) => {
            if (saved) setRenamingGroup(null)
          })
        }}>
          <Input autoFocus aria-label={t('group.name')} value={renamingGroup?.title ?? ''}
            onChange={(event) => { setRenamingGroup(current => current === null ? null : { ...current, title: event.target.value }) }} />
          <Button size="sm" type="submit" disabled={busy || (renamingGroup?.title.trim() ?? '') === ''}>{t('canvas.save')}</Button>
        </form>
      </Modal>
      {active && <CanvasViewToolbar className={css.graphControls} inputMode={inputMode} setInputMode={setInputMode}
        zoom={zoom} locale={globalThis.document.documentElement.lang || 'en'} t={t}
        zoomOut={() => { void flow?.zoomOut() }} resetZoom={() => { void flow?.zoomTo(1) }}
        zoomIn={() => { void flow?.zoomIn() }} fit={() => { void flow?.fitView({ padding: FIT_PADDING }) }}
        undoDisabled={busy || clipboard.pending || history.pending || !history.canUndo}
        redoDisabled={busy || clipboard.pending || history.pending || !history.canRedo}
        undo={() => { replayHistory('undo') }} redo={() => { replayHistory('redo') }} />}
      {document.nodes.length === 0 && <div className={css.graphHint}>{t('canvas.hint')}</div>}
    </div>
  )
}
