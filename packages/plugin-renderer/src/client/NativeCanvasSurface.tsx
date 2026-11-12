import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType } from 'react'
import { getBezierPath, Position, type Node, type NodeChange, type Viewport } from '@xyflow/react'
import type { CanvasSurfaceControls, CanvasSurfaceProps } from './canvas-surface-types.ts'
import { NativeCanvasNodeContext, NativeCanvasRenderContext } from './canvas-render-primitives.tsx'
import { installNativeCanvasGestures, nativeHandleConnection, type NativeGestureHandle } from './native-canvas-gestures.ts'
import { NativeCanvasScene } from './native-canvas-scene.ts'
import { NativeCanvasEdge } from './CanvasEdge.tsx'
import css from './NativeCanvasSurface.module.css'
import workspaceCss from './Workspace.module.css'

const INITIAL_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 }
const OPPOSITE = { [Position.Left]: Position.Right, [Position.Right]: Position.Left,
  [Position.Top]: Position.Bottom, [Position.Bottom]: Position.Top }

const RetainedCanvasCard = memo(function RetainedCanvasCard({ node, card: Card, register, draggable }: {
  node: Node
  card: ComponentType<{ data: Node['data']; selected: boolean }>
  register: (id: string, element: HTMLElement | null) => void
  draggable: boolean
}) {
  const ref = useCallback((element: HTMLDivElement | null) => { register(node.id, element) }, [node.id, register])
  return <div ref={ref} data-id={node.id} {...node.domAttributes} role="group" tabIndex={0}
    aria-roledescription="node" className={`react-flow__node react-flow__node-convaxNode selectable ${draggable ? 'draggable' : ''} ${node.selected ? 'selected' : ''} ${node.className ?? ''}`}
    style={{ ...node.style, transform: `translate(${node.position.x}px, ${node.position.y}px)`, zIndex: node.selected ? 2 : 0 }}>
    <NativeCanvasNodeContext.Provider value={node.id}>
      <Card data={node.data} selected={node.selected === true} />
    </NativeCanvasNodeContext.Provider>
  </div>
})

/** Mount real card components above a batched native connection layer. */
export function NativeCanvasSurface<N extends Node>(props: CanvasSurfaceProps<N>) {
  const current = useRef(props)
  current.current = props
  const root = useRef<HTMLDivElement>(null)
  const pane = useRef<HTMLDivElement>(null)
  const grid = useRef<HTMLDivElement>(null)
  const world = useRef<HTMLDivElement>(null)
  const overlay = useRef<HTMLDivElement>(null)
  const screen = useRef<HTMLDivElement>(null)
  const raster = useRef<HTMLCanvasElement>(null)
  const line = useRef<SVGPathElement>(null)
  const marquee = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(false)
  const gesture = useRef<ReturnType<typeof installNativeCanvasGestures> | null>(null)
  const [scene] = useState(() => new NativeCanvasScene<N>(props.defaultViewport ?? INITIAL_VIEWPORT, {
    move: next => current.current.onMove?.(null, next),
    end: next => current.current.onMoveEnd?.(null, next),
    measure: changes => current.current.onNodesChange?.(changes.map(change => ({ type: 'dimensions', ...change }))),
    ready: () => {
      const p = current.current
      if (p.fitView) void scene.fit(p.fitViewOptions, p.minZoom ?? 0.15, p.maxZoom ?? 2)
    },
  }))
  const revision = useSyncExternalStore(scene.subscribeGeometry, scene.getGeometryVersion, scene.getGeometryVersion)
  const curves = useMemo(() => scene.getCurves(props.edges, props.nodes), [scene, props.edges, props.nodes, revision])
  const [edgeFocus, setEdgeFocus] = useState<string | null>(null)
  const [marqueeSelection, setMarqueeSelection] = useState(false)
  const selectionBounds = useMemo(() => {
    if (!marqueeSelection) return undefined
    let left = Infinity; let top = Infinity; let right = -Infinity; let bottom = -Infinity
    for (const { selected, measured, position } of props.nodes) {
      if (!selected || measured?.width === undefined || measured.height === undefined) continue
      left = Math.min(left, position.x)
      top = Math.min(top, position.y)
      right = Math.max(right, position.x + measured.width)
      bottom = Math.max(bottom, position.y + measured.height)
    }
    return left === Infinity ? undefined : { left, top, width: right - left, height: bottom - top }
  }, [marqueeSelection, props.nodes])
  const controls = useMemo((): CanvasSurfaceControls<N> => {
    const zoomTo: CanvasSurfaceControls<N>['zoomTo'] = (zoom, options) => {
      const p = current.current
      return scene.zoomTo(Math.max(p.minZoom ?? 0.15, Math.min(p.maxZoom ?? 2, zoom)), options?.duration)
    }
    return {
      getViewport: scene.getViewport,
      getZoom: () => scene.getViewport().zoom,
      setViewport: (next, options) => scene.setViewport(next, options?.duration),
      getNode: scene.getNode,
      screenToFlowPosition: scene.screenToFlowPosition,
      fitView: options => scene.fit(options, current.current.minZoom ?? 0.15, current.current.maxZoom ?? 2),
      zoomTo, zoomIn: options => zoomTo(scene.getViewport().zoom * 1.2, options),
      zoomOut: options => zoomTo(scene.getViewport().zoom / 1.2, options),
      cancelConnection: () => { gesture.current?.cancelConnection() },
      cancelGesture: () => {
        gesture.current?.cancelGesture()
        setMarqueeSelection(false)
      },
    }
  }, [scene])
  const register = useCallback((id: string, element: HTMLElement | null) => { scene.registerNode(id, element) }, [scene])
  useLayoutEffect(() => { scene.syncNodes(props.nodes) }, [scene, props.nodes])
  useLayoutEffect(() => { scene.setCurves(curves) }, [scene, curves])
  useLayoutEffect(() => {
    if (root.current === null || world.current === null || overlay.current === null || screen.current === null
      || raster.current === null || grid.current === null) return
    const disconnect = scene.connect(root.current, world.current, overlay.current, screen.current, raster.current, grid.current)
    current.current.onInit(controls)
    setMounted(true)
    return disconnect
  }, [scene, controls])
  useLayoutEffect(() => {
    const surface = root.current
    if (surface === null || !props.active) return
    let anchor: N | undefined
    const movedNodes = (positions: ReadonlyMap<string, Node['position']>): N[] =>
      [...positions].flatMap(([id, position]) => {
        const node = scene.getNode(id)
        return node === undefined ? [] : [{ ...node, position }]
      })
    const changeEdges = (selectedId: string | null): void => {
      const p = current.current
      p.onEdgesChange?.(p.edges.flatMap(edge =>
        (edge.selected === true) === (edge.id === selectedId) ? [] : [{ type: 'select', id: edge.id, selected: edge.id === selectedId }]))
    }
    const changeSelection = (p: CanvasSurfaceProps<N>, selected: ReadonlySet<string>): void => {
      p.onNodesChange?.(p.nodes.flatMap((node): NodeChange<N>[] =>
        (node.selected === true) === selected.has(node.id) ? [] : [{ type: 'select', id: node.id, selected: selected.has(node.id) }]))
    }
    const showLine = (from: NativeGestureHandle, to: Node['position']): void => {
      const [path] = getBezierPath({ sourceX: from.point.x, sourceY: from.point.y, sourcePosition: from.position,
        targetX: to.x, targetY: to.y, targetPosition: OPPOSITE[from.position] })
      line.current?.setAttribute('d', path)
    }
    const installed = installNativeCanvasGestures(surface, () => {
      const p = current.current
      return {
        active: p.active, nodesDraggable: p.nodesDraggable !== false, nodesConnectable: p.nodesConnectable !== false,
        dragSelects: p.selectionOnDrag === true, minZoom: p.minZoom ?? 0.15, maxZoom: p.maxZoom ?? 2,
        getHandleCallbacks: scene.getHandleCallbacks,
        getViewport: scene.getViewport, setViewport: (next) => { scene.stopAnimation(); scene.move(next) },
        endViewport: scene.end, nodes: p.nodes,
        changeSelection: (ids) => { changeSelection(p, new Set(ids)) },
        changeMarqueeSelection: (ids) => {
          const selected = new Set(ids)
          changeSelection(p, selected)
          p.onEdgesChange?.(p.edges.flatMap((edge) => {
            const connected = selected.has(edge.source) || selected.has(edge.target)
            return (edge.selected === true) === connected ? [] : [{ type: 'select', id: edge.id, selected: connected }]
          }))
        },
        finishMarquee: (ids, cancelled) => { setMarqueeSelection(!cancelled && ids.length > 0) },
        clearPane: () => { setMarqueeSelection(false); changeEdges(null); p.onNativePaneClick() },
        clickNode: (extend) => { setMarqueeSelection(false); changeEdges(null); p.onNativeNodeClick?.(extend) },
        startDrag: (id, ids, event) => {
          anchor = scene.getNode(id)
          if (anchor === undefined) return
          const moved = ids.flatMap((id) => { const node = scene.getNode(id); return node === undefined ? [] : [node] })
          p.onNodeDragStart?.(event, anchor, moved)
        },
        moveDrag: positions => p.onNodesChange?.([...positions].map(([id, position]) => ({ type: 'position', id, position, dragging: true }))),
        endDrag: (positions, cancelled, event) => {
          const dragged = anchor
          anchor = undefined
          if (cancelled) p.onDragCancel()
          if (dragged !== undefined) p.onNodeDragStop?.(event, dragged, movedNodes(positions))
        },
        showMarquee: (rect) => {
          const box = marquee.current
          if (box === null) return
          box.hidden = rect === null
          if (rect !== null) {
            box.style.left = `${rect.x}px`; box.style.top = `${rect.y}px`
            box.style.width = `${rect.width}px`; box.style.height = `${rect.height}px`
          }
        },
        startConnection: (handle, event) => {
          p.onConnectStart?.(event, { nodeId: handle.nodeId, handleId: handle.portId, handleType: handle.type })
          showLine(handle, handle.point)
        },
        moveConnection: showLine,
        endConnection: (event, from, to, cancelled) => {
          line.current?.removeAttribute('d')
          if (cancelled) { p.onConnectionCancel(); return }
          if (to !== null) {
            const connection = nativeHandleConnection(from, to)
            p.onConnect?.(connection)
            scene.getHandleCallbacks(from.element)?.onConnect?.(connection)
            p.onConnectionCancel()
          } else p.onBlankConnection(event, from.point, from.position)
        },
      }
    })
    gesture.current = installed
    return () => { gesture.current = null; installed.dispose() }
  }, [props.active, scene])
  const selectEdge = (id: string): void => {
    const edge = props.edges.find(edge => edge.id === id)
    edge?.data?.select(id)
  }
  const edgeActions = (curve: typeof curves[number]) => {
    if (edgeFocus !== curve.edge.id || curve.edge.selected || curve.edge.data === undefined) return curve
    return { ...curve, edge: { ...curve.edge, data: { ...curve.edge.data, hovered: true } } }
  }
  return <NativeCanvasRenderContext.Provider value={scene}>
    <div ref={root} role="application" className={`react-flow ${css.surface}`} onDragEnter={props.onDragEnter} onDragOver={props.onDragOver} onDrop={props.onDrop}
      onContextMenu={(event) => {
        const nodeId = event.target instanceof Element ? event.target.closest<HTMLElement>('.react-flow__node')?.dataset.id : undefined
        const node = nodeId === undefined ? undefined : scene.getNode(nodeId)
        if (node !== undefined) props.onNodeContextMenu?.(event, node)
        else if (event.target === pane.current || event.target instanceof Element && event.target.hasAttribute('data-native-canvas-selection')) {
          props.onPaneContextMenu?.(event)
        }
      }}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget || !(event.target instanceof Element)) return
        if (event.key !== 'Enter' && event.key !== ' ') return
        if (event.target.matches('.react-flow__edge')) {
          const id = event.target.getAttribute('data-id')
          if (id !== null) { event.preventDefault(); selectEdge(id) }
        } else if (event.target.matches('.react-flow__node')) {
          const id = event.target.getAttribute('data-id')
          if (id !== null) {
            event.preventDefault()
            const extend = event.shiftKey || event.metaKey || event.ctrlKey
            const selected = props.nodes.filter(node => node.selected).map(node => node.id)
            const next = new Set(extend ? selected : [])
            if (extend && next.has(id)) next.delete(id)
            else next.add(id)
            props.onNativeNodeClick?.(extend)
            props.onNodesChange?.(props.nodes.flatMap((node): NodeChange<N>[] =>
              (node.selected === true) === next.has(node.id) ? [] : [{ type: 'select', id: node.id, selected: next.has(node.id) }]))
          }
        }
      }}>
      <div ref={grid} className={css.grid} aria-hidden="true" />
      <canvas className={css.raster} ref={raster} aria-hidden="true" data-convax-edge-raster="" />
      <div ref={pane} className={`react-flow__pane react-flow__container ${css.pane} ${props.selectionOnDrag ? 'selection' : 'draggable'}`}
        onDoubleClick={(event) => {
          if (!props.active) return
          const rect = event.currentTarget.getBoundingClientRect()
          const { x, y, zoom } = scene.getViewport()
          const next = Math.max(props.minZoom ?? 0.15, Math.min(props.maxZoom ?? 2, zoom * (event.shiftKey ? 0.5 : 2)))
          const px = event.clientX - rect.left; const py = event.clientY - rect.top
          void scene.setViewport({ x: px - (px - x) * next / zoom, y: py - (py - y) * next / zoom, zoom: next }, 200)
        }} />
      <div ref={world} className="react-flow__viewport react-flow__container">
        <svg className={css.edgeHitLayer}>
          {curves.map(curve => <g className={`react-flow__edge selectable ${css.edge}`} key={curve.edge.id}
            data-id={curve.edge.id} role="group" aria-roledescription="edge"
            aria-label={curve.edge.data?.t('connection.description', { source: curve.edge.source, target: curve.edge.target })} tabIndex={0}
            onFocus={() => { setEdgeFocus(curve.edge.id) }}
            onBlur={() => { setEdgeFocus(null) }}
            onClick={() => { selectEdge(curve.edge.id) }}
            onDoubleClick={event => props.onEdgeDoubleClick?.(event, curve.edge)}>
            <NativeCanvasEdge curve={edgeActions(curve)} />
          </g>)}
        </svg>
        {selectionBounds !== undefined && <div className="react-flow__nodesselection-rect" data-native-canvas-selection=""
          style={selectionBounds} />}
        <div ref={overlay} className={`react-flow__viewport-portal ${css.layer}`} />
        <div className={`react-flow__nodes ${css.layer}`}>
          {props.nodes.map(node => <RetainedCanvasCard key={node.id} node={node}
            card={props.card as ComponentType<{ data: Node['data']; selected: boolean }>} register={register} draggable={props.nodesDraggable !== false} />)}
        </div>
        <svg className={workspaceCss.snapGuides} aria-hidden="true">
          <path ref={line} className={workspaceCss.connectionPreview} />
        </svg>
      </div>
      <div ref={marquee} className={css.selection} hidden aria-hidden="true" />
      <div ref={screen} className={`${css.layer} ${css.screen}`} />
      {mounted && props.children}
    </div>
  </NativeCanvasRenderContext.Provider>
}
