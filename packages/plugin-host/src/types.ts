/** Durable canvas records and the client-safe Convax command vocabulary. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-typert-protocol'

/** Application-owned canvas identity. */
export type CanvasId = Branded<'ConvaxCanvasId'>
/** Node identity, unique within the repository. */
export type CanvasNodeId = Branded<'ConvaxCanvasNodeId'>
/** Connection identity, unique within the repository. */
export type CanvasConnectionId = Branded<'ConvaxConnectionId'>
/** Idempotent command identity. */
export type CanvasOperationId = Branded<'ConvaxOperationId'>
/** One file item of a durable Session delivery event. */
export type CanvasDeliveryId = Branded<'ConvaxDeliveryId'>
/** Identity of one retained node migration copy. */
export type CanvasMigrationId = Branded<'ConvaxMigrationId'>
/** Provider-qualified node type identity. */
export type CanvasNodeTypeId = Branded<'ConvaxNodeTypeId'>
/** Persisted selection identity; native capture handles remain renderer-lifetime data. */
export type CanvasWindowBindingId = Branded<'ConvaxWindowBindingId'>
/** Serializable plugin-owned value. */
export type CanvasValue = null | boolean | number | string | CanvasValue[] | { [key: string]: CanvasValue }
/** Serializable plugin-owned node fields. */
export type CanvasData = { [key: string]: CanvasValue }
/** Position in canvas coordinates. */
export interface CanvasPoint {
  /** Horizontal coordinate. */
  x: number
  /** Vertical coordinate. */
  y: number
}
/** Durable node envelope, independent of provider availability. */
export interface CanvasNode {
  /** Stable node identity. */
  id: CanvasNodeId
  /** Registered provider-qualified type. */
  typeId: CanvasNodeTypeId
  /** Plugin payload schema version. */
  dataVersion: number
  /** Plugin-owned serialized fields. */
  data: CanvasData
  /** Position independent of the graph library. */
  position: CanvasPoint
  /** Revision of this node. */
  revision: number
}
/** Durable directed connection between named ports. */
export interface CanvasConnection {
  /** Stable connection identity. */
  id: CanvasConnectionId
  /** Source node. */
  source: CanvasNodeId
  /** Named source port. */
  sourcePort: string
  /** Target node. */
  target: CanvasNodeId
  /** Named target port. */
  targetPort: string
  /** Relationship semantics; creating a connection does not execute work. */
  purpose: 'input' | 'delivery'
}
/** System-generated title composition; literal user names are never translated. */
export type CanvasTitleFormat =
  | { kind: 'default' }
  | { kind: 'literal'; value: string }
  | { kind: 'copy'; source: CanvasTitleFormat }
/** One complete committed canvas. */
export interface CanvasDocument {
  /** Stable canvas identity. */
  id: CanvasId
  /** User-provided title. */
  title: string
  /** Optional system naming recipe; absence preserves the literal saved title. */
  titleFormat?: CanvasTitleFormat
  /** Organizational archive state; absence means active and never changes Session activity. */
  archived?: boolean
  /** Monotonic graph revision. */
  revision: number
  /** Durable nodes, including those whose providers are unavailable. */
  nodes: CanvasNode[]
  /** Durable relationships. */
  connections: CanvasConnection[]
}
/** Application-level repository snapshot. */
export interface CanvasWorkspace {
  /** Monotonic repository revision, including creates and deletes. */
  revision: number
  /** Saved canvases; open tabs are window preferences. */
  canvases: CanvasDocument[]
  /** Currently available Host node definitions. */
  nodeTypes: CanvasNodeTypeInfo[]
  /** Chat containers and their unique DSH Session bindings. */
  chats: CanvasChat[]
  /** Provider migration or validation failures; durable node data remains intact. */
  nodeIssues: CanvasNodeIssue[]
}
/** Runtime compatibility state derived independently of the stored node payload. */
export interface CanvasNodeIssue {
  /** Owning canvas. */
  canvasId: CanvasId
  /** Affected node. */
  nodeId: CanvasNodeId
  /** Pending migration or unavailable compatible interpretation. */
  kind: 'migrating' | 'incompatible'
  /** Technical diagnostic; clients localize the user-facing explanation from kind. */
  message: string
}
/** One Session owned by exactly one Chat; messages remain in DSH. */
export interface CanvasThread {
  /** Actual DSH identity returned by the durable creation operation. */
  sessionId: SessionId
  /** Fork source, or null for a fresh conversation. */
  parentSessionId: SessionId | null
  /** Inherited prefix excluded from new delivery projection. */
  inheritedEventCount: number
}
/** Stable category used by clients to translate a Chat failure without parsing diagnostics. */
export type CanvasChatIssueCode = 'thread-create' | 'deletion' | 'delivery' | 'chat-unavailable'
/** Derived Chat state, retained independently of open canvas views. */
export interface CanvasChat {
  /** Owning canvas. */
  canvasId: CanvasId
  /** Chat node identity. */
  nodeId: CanvasNodeId
  /** User-facing Chat name. */
  title: string
  /** Explicit system-name marker; absent for legacy and user-defined titles. */
  defaultTitle?: true
  /** Default working directory for new threads. */
  cwd: string
  /** Sessions uniquely bound to this Chat. */
  threads: CanvasThread[]
  /** True while stop-and-archive coordination prevents new work. */
  deleting: boolean
  /** Technical diagnostic for a recoverable operation failure; null when no intervention is needed. */
  issue: string | null
  /** Localizable failure category; absent in older snapshots or when issue is null. */
  issueCode?: CanvasChatIssueCode
}
/** Unique Session ownership, readable without a node provider. */
export interface CanvasSessionBinding extends CanvasThread {
  /** Owning canvas. */
  canvasId: CanvasId
  /** Owning Chat. */
  nodeId: CanvasNodeId
}
/** Recoverable creation or fork request; it never sends a prompt. */
export type CanvasThreadRequest = {
  /** Target canvas. */
  canvasId: CanvasId
  /** Target Chat. */
  nodeId: CanvasNodeId
  /** Revision checked before reserving the operation. */
  expectedRevision: number
  /** Stable identity retained across transport failures and restarts. */
  operationId: CanvasOperationId
} & (
  | {
    kind: 'create'
    cwd?: string | undefined
    /** DSH preset for the new Session; omission uses the configured default. */
    agentPreset?: string | undefined
  }
  | { kind: 'fork'; sourceSessionId: SessionId; atSeq?: SessionSeq | undefined }
)
/** Thread creation result; a rejection never permits allocating a new retry identity. */
export type CanvasThreadResult =
  | { ok: true; sessionId: SessionId; workspace: CanvasWorkspace }
  | { ok: false; code: 'conflict' | 'not-found' | 'invalid-command' | 'deleting' | 'operation-pending'; message: string; workspace: CanvasWorkspace }
/** Place an existing native Session on a canvas without creating or forking it. */
export interface CanvasOpenSessionRequest {
  /** Preferred canvas when the Session has no existing Chat binding. */
  canvasId: CanvasId
  /** Revision checked only when a new Chat must be added. */
  expectedRevision: number
  /** Caller-allocated Chat identity retained across retries. */
  nodeId: CanvasNodeId
  /** Original native Session; schedules and messages retain this identity. */
  sessionId: SessionId
  /** Initial Chat position, ignored when the Session already has a binding. */
  position: CanvasPoint
}
/** Existing or newly committed Chat location; failures do not create a Session. */
export type CanvasOpenSessionResult =
  | { ok: true; canvasId: CanvasId; nodeId: CanvasNodeId; sessionId: SessionId; workspace: CanvasWorkspace }
  | Extract<CanvasCommandResult, { ok: false }>
/** Client-safe node type metadata. */
export interface CanvasNodeTypeInfo {
  /** Provider-qualified identity. */
  id: CanvasNodeTypeId
  /** Current payload version. */
  dataVersion: number
  /** Human-readable purpose supplied by the provider; absent for legacy providers. */
  description?: string
  /** JSON Schema for current serialized data; absent when a legacy provider has no declarative schema. */
  dataSchema?: CanvasData
  /** Named connection ports. */
  ports: CanvasPort[]
}
/** A stable named connection port. */
export interface CanvasPort {
  /** Provider-owned identity. */
  id: string
  /** Port direction. */
  direction: 'input' | 'output'
  /** Compatible value kind. */
  valueKind: string
}
/** One atomic graph command. */
export type CanvasCommand =
  | { kind: 'create'; title: string; defaultTitle?: boolean | undefined }
  | { kind: 'rename'; title: string }
  | { kind: 'delete' }
  | { kind: 'set-archived'; archived: boolean }
  | { kind: 'duplicate'; newCanvasId: CanvasId; title: string; localizedCopy?: boolean | undefined }
  | { kind: 'purge' }
  | {
    kind: 'add-node'
    node: CanvasNode
    /** Connections touching the new node, committed atomically with it. */
    initialConnections?: CanvasConnection[] | undefined
  }
  | {
    kind: 'add-subgraph'
    /** New envelopes with caller-allocated identities; committed revisions start at one. */
    nodes: CanvasNode[]
    /** Connections validated after every new node is present. */
    connections: CanvasConnection[]
  }
  | { kind: 'move-nodes'; nodes: { id: CanvasNodeId; position: CanvasPoint }[] }
  | { kind: 'arrange-nodes'; nodeIds: CanvasNodeId[]; origin: CanvasPoint; columns: number; columnGap: number; rowGap: number }
  | { kind: 'remove-nodes'; nodeIds: CanvasNodeId[] }
  | { kind: 'update-node'; nodeId: CanvasNodeId; dataVersion: number; data: CanvasData }
  | { kind: 'add-connection'; connection: CanvasConnection }
  | { kind: 'remove-connections'; connectionIds: CanvasConnectionId[] }
  | { kind: 'history'; targetOperationId: CanvasOperationId; direction: 'undo' | 'redo' }
  | { kind: 'batch'; ops: CanvasGraphOperation[] }

/** One sequential operation on a transaction-local canvas. Node data is replaced completely. */
export type CanvasGraphOperation =
  | { op: 'canvas.add'; title: string }
  | { op: 'canvas.set'; title: string }
  | { op: 'canvas.remove' }
  | { op: 'node.add'; id: CanvasNodeId; typeId: CanvasNodeTypeId; dataVersion: number; data: CanvasData; position: CanvasPoint }
  | { op: 'node.set'; id: CanvasNodeId; ifRevision?: number | undefined; dataVersion?: number | undefined; data?: CanvasData | undefined; position?: CanvasPoint | undefined }
  | { op: 'node.remove'; id: CanvasNodeId }
  | { op: 'edge.add'; id: CanvasConnectionId; source: CanvasNodeId; sourcePort: string; target: CanvasNodeId; targetPort: string; purpose: 'input' | 'delivery' }
  | { op: 'edge.remove'; id: CanvasConnectionId }
  | { op: 'history'; targetOperationId: CanvasOperationId; direction: 'undo' | 'redo' }

/** Ordered graph edits sharing one retry identity, canvas version and transaction. */
export interface CanvasCommitRequest {
  /** Explicit target, including a caller-allocated identity for canvas.add. */
  canvasId: CanvasId
  /** Canvas revision read by the caller; zero creates a new canvas. */
  expectedRevision: number
  /** Stable identity reused only with the identical complete request. */
  operationId: CanvasOperationId
  /** Sequential edits; history must be submitted alone. */
  ops: CanvasGraphOperation[]
  /** Explicit consent for Chat stop-and-archive work. */
  confirmed?: boolean | undefined
}
/** Revisioned, retryable mutation request. */
export interface CanvasCommandRequest {
  /** Target canvas; create uses a caller-allocated new identity. */
  canvasId: CanvasId
  /** Expected canvas revision; zero for create. */
  expectedRevision: number
  /** Identity reused only for an identical retry. */
  operationId: CanvasOperationId
  /** Atomic mutation. */
  command: CanvasCommand
  /** Explicit consent to stop running work during deletion. */
  confirmed?: boolean | undefined
}
/** Structured mutation result; failures leave the graph unchanged. */
export type CanvasCommandResult =
  | { ok: true; workspace: CanvasWorkspace }
  | { ok: false; code: 'conflict' | 'not-found' | 'invalid-command' | 'provider-unavailable' | 'confirmation-required' | 'deleting' | 'operation-pending'; message: string; opIndex?: number; workspace: CanvasWorkspace }
/** Application-level file reference metadata. */
export interface CanvasResource {
  /** Absolute provider process path. */
  path: string
  /** Display filename. */
  name: string
  /** Resource kind. */
  kind: 'file' | 'folder' | 'other'
  /** Byte size when known. */
  size: number | null
}
/** Direct children of a directory. */
export interface CanvasDirectory {
  /** Absolute directory path. */
  path: string
  /** Children, sorted with folders first. */
  entries: CanvasResource[]
}
/** Read-only UTF-8 file preview. */
export interface CanvasPreview {
  /** Absolute resource path. */
  path: string
  /** Preview content. */
  text: string
  /** True when more content remains beyond the configured preview window. */
  truncated: boolean
}
/** Authorized application-level media metadata, independent of any Session or complete document read. */
export interface CanvasMediaSource {
  /** Absolute provider process path used by the authenticated media route. */
  path: string
  /** Display filename. */
  name: string
  /** Complete source byte size when reported by the filesystem. */
  size: number | null
  /** Opaque source freshness token pinned by every media request. */
  version: Branded<'FsVersion'>
  /** Source media type inferred from the filename. */
  mimeType: string
}
/** Complete application-level document content, independent of any Session. */
export interface CanvasDocumentPreview {
  /** Absolute source path, including when Office content is rendered as PDF. */
  path: string
  /** Original source filename. */
  name: string
  /** Complete source file size when reported by the filesystem. */
  size: number | null
  /** Opaque source freshness token; consumers must not parse it. */
  version: string
  /** Complete caller-owned content, transferred as Multipart binary. */
  bytes: Uint8Array<ArrayBuffer>
  /** Media type of the returned content. */
  mimeType: string
  /** Present when returned bytes contain a converted PDF. */
  renderedAs?: 'pdf'
  /** Font families unavailable during Office conversion. */
  missingFonts?: string[]
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A local canvas working directory could not be created or used by the composed filesystem. */
    'canvas-directory/unavailable': Record<string, never>
    /** Complete document content exceeded its configured byte cap. */
    'canvas-resource/too-large': { path: string; limit: number }
    /** Source identity or freshness changed during a document or media read. */
    'canvas-resource/source-changed': { path: string }
  }
}
