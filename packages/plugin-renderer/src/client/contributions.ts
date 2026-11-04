/** Public node contributions shared by built-in and third-party packages. */
import type { ComponentType } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { CanvasCommand, CanvasNode, CanvasNodeId, CanvasPoint, CanvasResource, CanvasWindowBindingId, CanvasWorkspace } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { CanvasConnectionOrigin, WorkspaceInjected } from './props.ts'
import type { CanvasNodeRendererDefinition } from './node-renderers.tsx'

/** A creation entry operates against the current canvas, never a captured old revision. */
export interface CanvasCreationContext {
  readonly position: CanvasPoint
  readonly origin?: CanvasConnectionOrigin
  readonly command: (command: CanvasCommand) => Promise<boolean>
  readonly addProject: (position: CanvasPoint, origin?: CanvasConnectionOrigin) => void
  readonly addFiles: (position: CanvasPoint, origin?: CanvasConnectionOrigin) => void
  readonly createChat: (cwd?: string, folderId?: CanvasNodeId, position?: CanvasPoint, origin?: CanvasConnectionOrigin) => void
  readonly addWindow?: ((position: CanvasPoint) => void) | undefined
}

/** One reversible, translated entry in the creation dock and canvas menus. */
export interface CanvasCreationDefinition {
  readonly id: string
  readonly label: string | (() => string)
  readonly icon?: ComponentType<import('lucide-react').LucideProps>
  readonly defaultSize?: { readonly width: number; readonly height: number }
  /** False keeps actions requiring an external picker out of connection creation. */
  readonly connected?: boolean
  readonly create: (context: CanvasCreationContext) => void
}

/** Optional feature actions; registrations never own the graph or native Session lifetime. */
export type CanvasWorkspaceActions = Partial<Pick<WorkspaceInjected,
  'windowsAvailable' | 'listWindows' | 'bindWindow' | 'releaseWindow' | 'captureInput' | 'insertInputs'
  | 'initializeAutomation' | 'openSession'>> & {
    readonly createResourceNode?: (resource: CanvasResource, id: CanvasNodeId, position: CanvasPoint) => CanvasNode
    readonly createChatNode?: (id: CanvasNodeId, cwd: string, title: string, position: CanvasPoint) => CanvasNode
    readonly createWindowNode?: (id: CanvasNodeId, bindingId: CanvasWindowBindingId, name: string, position: CanvasPoint) => CanvasNode
    readonly inputDirectory?: (node: CanvasNode) => Promise<string | undefined>
  }

export type CanvasNodePresentation = Pick<CanvasNodeRendererDefinition, 'defaultSize' | 'dragHandle' | 'presentation' | 'clipboardData'>

/** Immutable identity-stable registry view consumed by React through useSyncExternalStore. */
export interface CanvasRendererSnapshot {
  readonly definitions: Readonly<Record<string, CanvasNodePresentation>>
  readonly creations: readonly CanvasCreationDefinition[]
  readonly actions: CanvasWorkspaceActions
}

/** Authoritative workspace feed observed by optional feature owners. */
export type CanvasWorkspaceSnapshot = ObservableSnapshot<CanvasWorkspace | undefined>
