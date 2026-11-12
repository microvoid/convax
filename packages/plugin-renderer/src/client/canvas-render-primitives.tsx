import { createContext, forwardRef, useCallback, useContext, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import type { ForwardRefExoticComponent, PropsWithoutRef, ReactNode, RefAttributes } from 'react'
import { createPortal } from 'react-dom'
import { Handle, NodeToolbar, Position, ViewportPortal, useStore as useFlowStore, useUpdateNodeInternals } from '@xyflow/react'
import type { HandleProps, NodeToolbarProps, Viewport } from '@xyflow/react'
import type { CanvasPoint } from '@deepseek-ai/dsh-convax-plugin-host/types'

export { Position as CanvasHandlePosition }

type HandleKind = NonNullable<HandleProps['type']>
export type CanvasHandleCallbacks = Pick<HandleProps, 'isValidConnection' | 'onConnect'>

export interface CanvasHandleEndpoint extends CanvasPoint {
  readonly position: Position
}

interface NativeCanvasNodeBounds extends CanvasPoint {
  readonly width: number
  readonly height: number
  readonly selected: boolean
}

/** The surface supplies live world geometry and portal targets to its card components. */
export interface NativeCanvasRenderPrimitives {
  readonly worldOverlay: HTMLElement | null
  readonly screenOverlay: HTMLElement | null
  readonly registerHandleCallbacks: (handle: HTMLElement, callbacks: CanvasHandleCallbacks) => () => void
  readonly getHandleEndpoint: (nodeId: string, handleId: string | null, type: HandleKind) => CanvasHandleEndpoint | undefined
  readonly updateNodeLayout: (nodeId: string) => void
  readonly subscribe: (listener: () => void) => () => void
  readonly getVersion: () => number
  readonly getViewport: () => Viewport
  readonly getSize: () => { width: number; height: number }
  readonly getNodeBounds: (nodeId: string) => NativeCanvasNodeBounds | undefined
  readonly getSelectedNodeCount: () => number
}

export const NativeCanvasRenderContext = createContext<NativeCanvasRenderPrimitives | null>(null)
export const NativeCanvasNodeContext = createContext<string | null>(null)

export function readCanvasHandleEndpoint(handle: HTMLElement, surface: HTMLElement, viewport: Viewport): CanvasHandleEndpoint | undefined {
  const position = handle.dataset.handlepos
  if (position !== Position.Left && position !== Position.Right && position !== Position.Top && position !== Position.Bottom) return
  const rect = handle.getBoundingClientRect()
  const canvas = surface.getBoundingClientRect()
  return {
    x: (rect.left + rect.width / 2 - canvas.left - viewport.x) / viewport.zoom,
    y: (rect.top + rect.height / 2 - canvas.top - viewport.y) / viewport.zoom,
    position,
  }
}

/** Render a card port through the current surface while keeping the public Handle props. */
export const CanvasHandle: ForwardRefExoticComponent<PropsWithoutRef<HandleProps> & RefAttributes<HTMLDivElement>> =
  forwardRef<HTMLDivElement, HandleProps>(function CanvasHandle(props, ref) {
    const canvas = useContext(NativeCanvasRenderContext)
    return canvas === null ? <Handle {...props} ref={ref} /> : <NativeCanvasHandle {...props} ref={ref} />
  })

const NativeCanvasHandle = forwardRef<HTMLDivElement, HandleProps>(function NativeCanvasHandle({
  id, type, position, isConnectable = true, isConnectableStart = true,
  isConnectableEnd = true, isValidConnection, onConnect, className, ...props
}, ref) {
  const nodeId = useContext(NativeCanvasNodeContext)
  const canvas = useContext(NativeCanvasRenderContext)
  const element = useRef<HTMLDivElement | null>(null)
  const assignRef = useCallback((next: HTMLDivElement | null) => {
    element.current = next
    if (typeof ref === 'function') ref(next)
    else if (ref !== null) ref.current = next
  }, [ref])
  useLayoutEffect(() => {
    const handle = element.current
    if (handle === null || isValidConnection === undefined && onConnect === undefined) return
    return canvas?.registerHandleCallbacks(handle, {
      ...(isValidConnection === undefined ? {} : { isValidConnection }),
      ...(onConnect === undefined ? {} : { onConnect }),
    })
  }, [canvas, isValidConnection, onConnect])
  const classes = ['react-flow__handle', `react-flow__handle-${position}`, 'nodrag', 'nopan', type, className,
    isConnectable && 'connectable', isConnectableStart && 'connectablestart', isConnectableEnd && 'connectableend',
    isConnectable && (isConnectableStart || isConnectableEnd) && 'connectionindicator']
  return <div {...props} ref={assignRef} data-handleid={id || undefined} data-nodeid={nodeId ?? undefined}
    data-handlepos={position} data-id={`${nodeId}-${id || null}-${type}`} className={classes.filter(Boolean).join(' ')} />
})

/** Notify the owning renderer when a card changes dimensions or port layout. */
export function useCanvasNodeLayout(): (nodeIds: string | string[]) => void {
  const updateNative = useContext(NativeCanvasRenderContext)?.updateNodeLayout
  const updateFlow = useUpdateNodeInternals()
  return useCallback((ids) => {
    if (updateNative === undefined) updateFlow(ids)
    else for (const id of Array.isArray(ids) ? ids : [ids]) updateNative(id)
  }, [updateFlow, updateNative])
}

export function CanvasViewportPortal({ children }: { readonly children: ReactNode }) {
  const canvas = useContext(NativeCanvasRenderContext)
  if (canvas === null) return <ViewportPortal>{children}</ViewportPortal>
  return canvas.worldOverlay === null ? null : createPortal(children, canvas.worldOverlay)
}

export function CanvasNodeToolbar(props: NodeToolbarProps) {
  const canvas = useContext(NativeCanvasRenderContext)
  return canvas === null ? <NodeToolbar {...props} /> : <NativeCanvasToolbar {...props} canvas={canvas} />
}

function NativeCanvasToolbar({ canvas, nodeId, children, className, style, isVisible, position = Position.Top,
  offset = 10, align = 'center', ...props }: NodeToolbarProps & { readonly canvas: NativeCanvasRenderPrimitives }) {
  const currentNodeId = useContext(NativeCanvasNodeContext)
  const ids = Array.isArray(nodeId) ? nodeId : [nodeId ?? currentNodeId ?? '']
  const transform = useSyncExternalStore(canvas.subscribe, () => {
    if (isVisible === false) return null
    if (isVisible === undefined && (ids.length !== 1 || canvas.getSelectedNodeCount() !== 1)) return null
    let left = Infinity
    let top = Infinity
    let right = -Infinity
    let bottom = -Infinity
    for (const id of ids) {
      const node = canvas.getNodeBounds(id)
      if (node === undefined || isVisible === undefined && !node.selected) continue
      left = Math.min(left, node.x)
      top = Math.min(top, node.y)
      right = Math.max(right, node.x + node.width)
      bottom = Math.max(bottom, node.y + node.height)
    }
    if (left === Infinity) return null
    const viewport = canvas.getViewport()
    const alignment = align === 'start' ? 0 : align === 'end' ? 1 : 0.5
    const alignedX = viewport.x + (left + (right - left) * alignment) * viewport.zoom
    const alignedY = viewport.y + (top + (bottom - top) * alignment) * viewport.zoom
    switch (position) {
      case Position.Top: return `translate(${alignedX}px, ${viewport.y + top * viewport.zoom - offset}px) translate(${-100 * alignment}%, -100%)`
      case Position.Bottom: return `translate(${alignedX}px, ${viewport.y + bottom * viewport.zoom + offset}px) translate(${-100 * alignment}%, 0%)`
      case Position.Left: return `translate(${viewport.x + left * viewport.zoom - offset}px, ${alignedY}px) translate(-100%, ${-100 * alignment}%)`
      case Position.Right: return `translate(${viewport.x + right * viewport.zoom + offset}px, ${alignedY}px) translate(0%, ${-100 * alignment}%)`
    }
  }, () => null)
  if (transform === null || canvas.screenOverlay === null) return null
  return createPortal(<div {...props} data-id={ids.join(' ')} className={['react-flow__node-toolbar', className].filter(Boolean).join(' ')}
    style={{ position: 'absolute', left: 0, top: 0, transform, pointerEvents: 'auto', ...style }}>{children}</div>, canvas.screenOverlay)
}

/** Read the current world position of a port for a connection creation preview. */
export function useCanvasHandleEndpoint(nodeId: string, handleId: string, type: HandleKind): CanvasHandleEndpoint | undefined {
  const canvas = useContext(NativeCanvasRenderContext)
  const node = useFlowStore(state => canvas === null ? state.nodeLookup.get(nodeId) : undefined)
  useSyncExternalStore(canvas?.subscribe ?? subscribeToNoChanges, canvas?.getVersion ?? noChanges, noChanges)
  if (canvas !== null) return canvas.getHandleEndpoint(nodeId, handleId, type)
  const handle = node?.internals.handleBounds?.[type]?.find(item => item.id === handleId)
  if (node === undefined || handle === undefined) return
  return {
    x: node.internals.positionAbsolute.x + handle.x + handle.width / 2,
    y: node.internals.positionAbsolute.y + handle.y + handle.height / 2,
    position: handle.position,
  }
}

const subscribeToNoChanges = (): (() => void) => () => {}
const noChanges = (): number => 0
