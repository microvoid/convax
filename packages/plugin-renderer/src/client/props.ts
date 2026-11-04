/** Slot-derived workspace inputs and the narrow action face supplied by apply. */
import type {
  FactoryComponentPropsOf, InjectFace, PropsLocale, PropsRenderFactories, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { RefObject } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { CanvasActivityItem } from './activity.ts'
import type { DesktopWindowSource, DesktopWindowSourceId } from '@deepseek-ai/dsh-util-desktop-capture'
import type {
  CanvasChat, CanvasCommand, CanvasCommandRequest, CanvasCommandResult, CanvasId, CanvasNode, CanvasNodeId,
  CanvasNodeTypeInfo, CanvasOpenSessionRequest, CanvasOpenSessionResult, CanvasPort, CanvasResource,
  CanvasThreadRequest, CanvasThreadResult,
} from '@deepseek-ai/dsh-convax-plugin-host/types'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type { EmbeddedSidebarResize } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { createCanvasViewStore, createChatViewStore } from './store.ts'
import type { ConvaxKey } from './locales.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CanvasInputMode } from './input-mode.ts'
import type { ChatSize } from './chat-size.ts'
import type { ResourceSize } from './resource-size.ts'
import type { CanvasGraphProps } from './CanvasGraph.tsx'
import type { IConvaxRenderer } from './node-renderers.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Multi-canvas file workspace copy. */
    convax: ConvaxKey
  }
  interface SlotMap {
    /** Compatible nodes dispatched independently of Host definition registration. */
    'convax.node': {
      kind: 'keyed'
      scope: 'root'
      owner: CanvasNodeOwner
    }
    /** Shared DSH Conversation under the explicitly retained thread. */
    'convax.chat.session': {
      kind: 'single'
      scope: 'session'
      owner: {
        onSelectWorkspace: (workspaceId: WorkspaceId) => Promise<void>
        onFork: (seq: number) => void
        /** Create a fresh thread in this Chat using the chosen DSH preset. */
        onNewSessionWithPreset: (agentPreset: string) => Promise<void>
        resize?: ChatResizeControls
      }
    }
    /** Native tools toggle in the thread tab row. */
    'convax.chat.header': {
      kind: 'single'
      scope: 'session'
    }
    /** Native Conversation view choices inside the current thread menu. */
    'convax.chat.views': {
      kind: 'single'
      scope: 'session'
      owner: { onDismiss: () => void }
    }
    /** Native tools retained with their own thread rather than global canvas focus. */
    'convax.chat.tools': {
      kind: 'single'
      scope: 'session'
      owner: { active: boolean } & ChatToolsLayout
    }
  }
  interface SlotFactoryMap {
    /** Optional file node plugin preview, without opening a native DSH details page. */
    'convax.resource.preview': { scope: 'root'; props: { path: string; gestureMode?: 'container' }; locale: 'convax' }
    /** Optional native source picker supplied by the window node plugin. */
    'convax.window.picker': {
      scope: 'root'
      props: {
        rebind: boolean
        list: () => Promise<readonly DesktopWindowSource[]>
        select: (id: DesktopWindowSourceId) => Promise<boolean>
        close: () => void
      }
      locale: 'convax'
    }

    /** Session-owned controls anchored to the current thread's dropdown. */
    'convax.chat.settings': {
      scope: 'session'
      props: {
        anchorRef: RefObject<HTMLButtonElement>
        title: string
        onClose: () => void
      }
      locale: 'convax'
    }
    /** Canvas gestures and node rendering share the Chat presentation store. */
    'convax.graph': {
      scope: 'root'
      props: CanvasGraphOwner
      store: ReturnType<typeof createChatViewStore>
      locale: 'convax'
      children: { 'convax.node': { kind: 'keyed'; scope: 'root' } }
    }
    /** Chat navigation and the shared DSH Conversation assembly. */
    'convax.chat.content': {
      scope: 'root'
      props: CanvasChatOwner
      store: ReturnType<typeof createChatViewStore>
      locale: 'convax'
      inject: ChatInjected
      children: {
        'convax.chat.header': { kind: 'single'; scope: 'session' }
        'convax.chat.views': { kind: 'single'; scope: 'session' }
      }
    }
    /** One visited thread's retained Conversation and tool surfaces. */
    'convax.chat.thread': {
      scope: 'root'
      props: CanvasChatThreadOwner
      locale: 'convax'
      children: {
        'convax.chat.session': { kind: 'single'; scope: 'session' }
        'convax.chat.tools': { kind: 'single'; scope: 'session' }
      }
    }
  }
}

/** Safe window preferences copied with a Chat, excluding thread selection and drafts. */
export interface CanvasChatPresentation {
  collapsed: boolean
  size?: ChatSize
  toolWidths?: { normal?: number; fullscreen?: number }
}

/** Revision-bound graph data supplied independently of its shared presentation store. */
export type CanvasGraphOwner = Omit<CanvasGraphProps, 't' | 'renderSlot' | 'chatPresentations' | 'applyChatPresentation'>

/** Framework-derived graph inputs and the shared Chat presentation actions. */
export type CanvasGraphSurfaceProps = FactoryComponentPropsOf<'convax.graph'>

/** Plain node data and revision-bound callbacks supplied by its canvas. */
export interface CanvasNodeOwner {
  /** Complete provider payload; supplied only after Host compatibility checks. */
  node: CanvasNode
  /** Owning canvas identity. */
  canvasId: CanvasId
  /** Current committed canvas revision. */
  canvasRevision: number
  /** Available and version-compatible Host definition. */
  definition: CanvasNodeTypeInfo
  /** Declared ports plus retained connection endpoints. */
  ports: readonly CanvasPort[]
  /** Whether the graph selected this node. */
  selected: boolean
  /** Whether a mutation prevents new graph gestures. */
  busy: boolean
  /** Associated Chat, independent of its renderer's presence. */
  chat: CanvasChat | undefined
  /** Remove this node through the owning canvas command. */
  remove: () => void
  /** Submit one command against the owning canvas revision. */
  command: (command: CanvasCommand) => Promise<boolean>
  /** Open a folder in the system file manager or preview a file. */
  openResource: (resource: CanvasResource) => void
  /** Open the original file or folder in its system application. */
  openSource: (path: string) => void
  /** Create a Chat from a folder and connect the reference atomically. */
  createChat: (cwd: string | undefined, folderId: CanvasNode['id']) => void
  /** Explicitly choose another source for this window node; never retarget existing references. */
  chooseWindow?: ((nodeId: CanvasNodeId) => void) | undefined
  /** Thread selected by a window-level activity notice. */
  focusSessionId: SessionId | undefined
  /** Acknowledge local handling of that activity notice. */
  consumeFocus: () => void
  /** Nodes connected as inputs to this node. */
  inputs: readonly CanvasNode[]
  /** Fit this node's current presentation into the canvas viewport. */
  focusNode: () => void
  /** Whether this resource's inline preview is expanded. */
  resourceExpanded: boolean
  /** Retain this resource's expansion independently from canvas document mutations. */
  setResourceExpanded: (expanded: boolean) => void
  /** Saved height of the resource's inline preview, when resized. */
  resourcePreviewHeight?: number
  /** Saved width of the resource card, when resized. */
  resourcePreviewWidth?: number
  /** Retain the resource card width and preview height together after a resize gesture. */
  setResourcePreviewSize: (size: ResourceSize) => void
}

/** Window-local Chat navigation inputs, separate from its retained Session. */
export interface CanvasChatOwner {
  chat: CanvasChat
  canvasRevision: number
  remove: () => void
  focusSessionId?: SessionId
  consumeFocus: () => void
  focusNode: () => void
}

/** One visited thread stays mounted while its Chat selects another thread. */
export interface CanvasChatThreadOwner {
  sessionId: SessionId
  active: boolean
  collapsed: boolean
  onSelectWorkspace: (workspaceId: WorkspaceId) => Promise<void>
  onFork: (seq: number) => void
  /** Create a fresh thread without changing the current Session or global default. */
  onNewSessionWithPreset: (agentPreset: string) => Promise<void>
  resize?: ChatResizeControls
  tools: ChatToolsLayout
  /** Refresh graph endpoints after the native card's measured height changes. */
  layoutChanged: () => void
}

/** Widths and the resize action shared by a Chat's retained native tool panes. */
export interface ChatToolsLayout {
  width: number
  fullscreenWidth: number
  resize: EmbeddedSidebarResize
}

/** Preview and commit a Chat's left width and transcript height in canvas pixels. */
export interface ChatResizeControls {
  /** Localized accessible action name. */
  label: string
  /** Localized pointer and keyboard guidance. */
  help: string
  /** @param size - Gesture preview, or null to restore the saved dimensions. */
  preview: (size: ChatSize | null) => void
  /** @param size - Completed dimensions to retain in this window's preferences. */
  commit: (size: ChatSize) => void
}

/** Framework-derived props for a versioned node display contribution. */
export type CanvasNodeRendererProps = PropsRuntime<'convax.node'> & PropsRenderFactories & PropsLocale<'convax'>

/** Retained connection endpoint used when a drag creates a node in blank canvas space. */
export interface CanvasConnectionOrigin {
  /** Existing node that owns the endpoint. */
  nodeId: CanvasNodeId
  /** Provider-declared endpoint identity. */
  portId: string
  /** Direction of the existing endpoint. */
  direction: 'input' | 'output'
  /** Captured input draft target; presence retains an unbound target across pickers. Never persisted in graph data. */
  targetSession?: { readonly sessionId: SessionId | undefined }
}

/** Actions close over generated Remote services; components never receive ctx. */
export interface WorkspaceInjected {
  /** Reversible node plugin contributions; absent in isolated workspace fixtures. */
  nodePlugins?: Pick<IConvaxRenderer, 'getSnapshot' | 'subscribe'>

  /** Framework-owned reads over this window's canvas activity. */
  hooks: { canvasActivity: ObservableSnapshot<readonly CanvasActivityItem[]> }
  /** Mark explicitly viewed activity as read without resolving pending interactions. */
  markActivityRead: (sessionIds: readonly SessionId[]) => void
  /** Whether the current renderer has the Desktop window capture bridge. */
  windowsAvailable?: boolean
  /** List native windows without capturing thumbnails. */
  listWindows?: (() => Promise<readonly DesktopWindowSource[]>) | undefined
  /** Acquire an explicitly selected source for a newly minted graph binding. */
  bindWindow?: ((nodeId: CanvasNodeId, bindingId: import('@deepseek-ai/dsh-convax-plugin-host/types').CanvasWindowBindingId,
    sourceId: DesktopWindowSourceId) => Promise<string>) | undefined
  /** Release an acquired source when graph admission fails. */
  releaseWindow?: ((bindingId: import('@deepseek-ai/dsh-convax-plugin-host/types').CanvasWindowBindingId) => Promise<void>) | undefined
  /** Platform default used until this window stores an explicit input preference. */
  defaultInputMode: CanvasInputMode
  /** Capture the selected thread before a connection commit starts. */
  captureInput: (nodeId: CanvasNode['id']) => SessionId | undefined
  /** Add a committed input batch to captured native drafts, creating each missing target thread once. */
  insertInputs: (canvasId: CanvasId, revision: number, inputs: readonly {
    nodeId: CanvasNodeId
    sourceId: CanvasNodeId
    sessionId?: SessionId | undefined
  }[]) => Promise<boolean>
  /** Execute one revisioned operation through the Host. */
  execute: (request: CanvasCommandRequest) => Promise<CanvasCommandResult>
  /** Prepare the canvas-owned default working directory without opening a picker. */
  ensureCanvasDirectory: (canvasId: CanvasId) => Promise<string>
  /** Resolve the kind of a file reference before admitting a node. */
  describe: (path: string) => Promise<CanvasResource>
  /** Resolve a Desktop file reference without copying its contents. */
  resolveFilePath: (file: File) => string
  /** Restart the authoritative watch after an interrupted load. */
  refresh: () => void
  /** Open existing global settings. */
  openSettings: () => void
  /** Open plugin management in an overlay drawer. */
  openPlugins: () => void
  /** Initialize a new Chat's native draft for an automation request without submitting it. */
  initializeAutomation: (request: CanvasThreadRequest, prompt: string) => Promise<CanvasThreadResult>
  /** Locate an existing native Session, atomically adding its first Chat occurrence when needed. */
  openSession: (request: CanvasOpenSessionRequest) => Promise<CanvasOpenSessionResult>
  /** Open a folder in the Host's file manager. */
  openFolder: (path: string) => Promise<void>
  /** Show a source file or folder in the Host's file manager. */
  revealSource: (path: string) => Promise<void>
}

/** Complete props of the single whole-window workspace contribution. */
export type WorkspaceProps = PropsRuntime<'shell.workspace'>
  & PropsRenderFactories
  & PropsLocale<'convax'>
  & PropsStore<ReturnType<typeof createCanvasViewStore>>
  & InjectFace<WorkspaceInjected>

/** Durable thread operations supplied by the Host binding coordinator. */
export interface ChatInjected {
  /** Register the visible draft target until this selection changes or the Chat unmounts. */
  bindInput: (nodeId: CanvasNode['id'], sessionId: SessionId | undefined) => () => void
  /** Address the native details owner without changing main Conversation selection. */
  focusSession: (sessionId: SessionId) => void
  /** Resume an identical creation attempt until its actual Session is known. */
  createThread: (request: CanvasThreadRequest) => Promise<CanvasThreadResult>
  /** Share the first creation with linked references and persist its actual retry identity. */
  ensureInitialThread: (request: CanvasThreadRequest, stage: (request: CanvasThreadRequest) => void) => Promise<CanvasThreadResult>
  /** Acknowledge a completion on deliberate thread selection. */
  acknowledgeCompletion: (sessionId: SessionId) => void
}

/** Framework-derived Chat node component inputs. */
export type ChatProps = FactoryComponentPropsOf<'convax.chat.content'>

/** Strict Session occurrence of the public Conversation Factory. */
export type ChatSessionProps = PropsRuntime<'convax.chat.session'> & PropsRenderFactories

/** Native Session controls embedded within the thread tab row. */
export type ChatHeaderProps = PropsRuntime<'convax.chat.header'> & PropsRenderFactories

/** Native Session action groups in the current thread's settings dialog. */
export type ChatSettingsProps = FactoryComponentPropsOf<'convax.chat.settings'>

/** Session-owned view menu rows hosted by the current thread dropdown. */
export type ChatViewsProps = PropsRuntime<'convax.chat.views'> & PropsRenderFactories

/** Framework-owned retention and strict Session seats for one visited thread. */
export type ChatThreadProps = FactoryComponentPropsOf<'convax.chat.thread'>

/** Strict Session occurrence of the native tool panel. */
export type ChatToolsProps = PropsRuntime<'convax.chat.tools'> & PropsRenderFactories
