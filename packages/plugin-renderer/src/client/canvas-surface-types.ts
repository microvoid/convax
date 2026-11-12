import type { ComponentType } from 'react'
import type { Node, ReactFlowInstance, ReactFlowProps } from '@xyflow/react'
import type { CanvasPoint } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { GraphEdge } from './CanvasEdge.tsx'
import type { NativeGestureHandle } from './native-canvas-gestures.ts'

export interface CanvasZoom {
  readonly getSnapshot: () => number
  readonly subscribe: (listener: () => void) => () => void
}

export type CanvasSurfaceControls<N extends Node> = Pick<ReactFlowInstance<N, GraphEdge>,
  'getViewport' | 'setViewport' | 'getNode' | 'getZoom' | 'fitView' | 'zoomIn' | 'zoomOut' | 'zoomTo' | 'screenToFlowPosition'>
  & { cancelConnection?: () => void; cancelGesture?: () => void }

export type CanvasSurfaceProps<N extends Node> = Pick<ReactFlowProps<N, GraphEdge>,
  'nodes' | 'edges' | 'children' | 'nodesDraggable' | 'nodesConnectable' | 'selectionOnDrag' |
  'onEdgesChange' | 'onNodesChange' | 'onNodeDragStart' | 'onNodeDragStop' | 'onConnect' | 'onConnectStart' |
  'onPaneClick' | 'onPaneContextMenu' | 'onNodeContextMenu' | 'onEdgeDoubleClick' |
  'onDragEnter' | 'onDragOver' | 'onDrop' | 'defaultViewport' | 'fitView' | 'fitViewOptions' |
  'onMove' | 'onMoveEnd' | 'minZoom' | 'maxZoom'> & {
    nodes: N[]
    edges: GraphEdge[]
    active: boolean
    card: ComponentType<{ data: N['data']; selected: boolean }>
    onInit: (controls: CanvasSurfaceControls<N>) => void
    onDragCancel: () => void
    onNativeNodeClick?: (extend: boolean) => void
    onNativePaneClick: () => void
    onBlankConnection: (event: MouseEvent | TouchEvent, from: CanvasPoint, position: NativeGestureHandle['position']) => void
    onConnectionCancel: () => void
  }
