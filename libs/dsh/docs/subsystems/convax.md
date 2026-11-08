# Convax canvas subsystem

English | [中文](convax.zh.md)

Convax owns application-level canvas records, node definitions, reference connections and revisioned graph commands. The [Host package](../../../../packages/plugin-host/README.md) owns its SQLite database, transactions, migrations and recovery coordination. DSH storage and Session APIs remain unchanged. The [renderer package](../../../../packages/plugin-renderer/README.md) contributes the full-window canvas and Chat workspace and can be disabled independently.

## Records and commands

`CanvasDocument` owns its nodes, logical `groups`, connections, and monotonic revision. `CanvasGroup` retains an identity, title and optional palette `color`; optional `CanvasNode.groupId` establishes one membership while positions remain in world coordinates. The renderer derives group frames from each window’s measured card sizes and resolves saved color identifiers through the active theme; missing color means default gray. Membership and group metadata use Host transactions and field-level history; the [grouping decision](../../.agents/notes/implemented/architecture/2026-11-08-convax-canvas-groups.md) explains this separation. `CanvasWorkspace` is a detached snapshot of saved canvases, currently available Host node types, and Chat-to-Session bindings. The [client-safe declarations](../../../../packages/plugin-host/src/types.ts) define the records and discriminated command vocabulary; Typert generates the transport from the Host methods.

`CanvasResource` describes file or directory metadata. `CanvasDocumentPreview` carries the resolved `path`, `name`, nullable byte `size`, filesystem `version`, `mimeType`, and complete transient `bytes`; Office conversion can add `renderedAs: 'pdf'` and `missingFonts` while retaining the source path. `watchResource` observes metadata; the unary `readDocument` call reads content through the composed filesystem without a Session. The [Host package](../../../../packages/plugin-host/README.md#use-this-package) owns byte limits, conversion availability, and read failures.

`CanvasMediaSource` carries resolved file metadata (`path`, `name`, nullable `size`, `version`, and `mimeType`) for version-pinned media requests. The authenticated Connection route streams HTTP byte ranges through composed filesystem reads; it creates no Session, performs no transcoding, and does not buffer the complete source. The [Host package](../../../../packages/plugin-host/README.md#use-this-package) defines response lifetime, byte windows, and failures.

Each mutation carries an operation identity and expected canvas revision. The Convax repository commits graph state and its receipt in one SQLite transaction. Duplicate retries do not repeat mutations; conflicts preserve durable state. Runtime definitions validate new payloads and ports; missing definitions retain stored payloads and editable geometry. Plugin installation and enablement remain DSH responsibilities.

`CanvasWindowBindingId` names a window selection independently of native handles. A version-one `convax.window` payload contains only `bindingId` and `name`; the current Desktop renderer owns the live capture. Stored or copied node data does not establish a valid runtime selection or grant window access. The [Host package](../../../../packages/plugin-host/README.md#use-this-package) owns payload validation, and the [renderer package](../../../../packages/plugin-renderer/README.md#use-this-package) owns reconnection and mirror presentation.

## UI composition

The `shell.workspace` slot belongs to DSH's layout owner. Convax occupies it while global panels, settings, theme and overlays remain DSH-hosted. Removing the renderer restores native conversations without removing the Host. Chat cards retain explicit Session references and embed the existing `conversation.content` Factory; Convax owns card layout, thread selection and tool-panel placement. Shared DSH drafts preserve unsent text and attachments. This reuse does not establish a new DSH dock API; existing UI adaptations remain separately reviewable. The [renderer package](../../../../packages/plugin-renderer/README.md#use-this-package) owns navigation and resource-opening interactions.

Resource cards use `document.preview` for documents and the separate root Factory `convax.media.preview` for audio and video. Media playback belongs to the window rather than the card occurrence: hover playback pauses when the pointer leaves, while explicit manual playback continues across card folding and canvas navigation with a background pause control. Source replacement or removal and plugin disposal release the player. Audio waveform analysis reads and decodes incrementally into fixed peak bins; waveform failure preserves native playback. Unsupported codecs offer system opening. These presentations add no Session or model-visible content. The [renderer package](../../../../packages/plugin-renderer/README.md#use-this-package) owns their controls and interaction details.

## Chat Sessions and inputs

Each thread is one DSH Session with a unique Convax Chat binding. One Convax thread ledger owns its immutable request, fixed Session reservation and pinned fork prefix. The materializer uses native Session preparation, persistence, Workspace attachment and fork APIs, records Session completion, then binds the graph. Restart retries keep the actual identity without resending input or recreating deliberately removed Workspace membership. Session messages and execution remain DSH-owned.

A file/folder connection explicitly resolves its source through the Host and inserts one native reference into the selected draft. Folder-created Chats use that folder as their default project and add it to the first draft. Removing a reference preserves the edge; retained edges never add hidden context to later sends or grant writable roots. Native Web, SDK, ACP and headless send protocols remain unchanged. Convax uses the existing `agent/pre-step` hook to reject model steps for deleting or missing bound Chats and their subagent lineage; it does not promise rejection before enqueue.

A window connection inserts a source-owned reference into that same native draft. At submit, its preparation resolves the exact node/binding to a fresh, immutable image plus source text before ordinary DSH attachment admission. Queue delivery and model retry reuse the admitted image. Native window selection and capture do not change the thread's project, preset, or Computer Use authorization. Preview frames are transient; admitted screenshot history remains DSH-owned and replayable without the live window.

## Deliveries and deletion

The Host-only Session projection recovers explicit file deliveries from live or persisted history. Each complete event commits file nodes, delivery connections, per-file receipts and the replay cursor in one transaction. A removed output keeps its receipt; independent events remain distinct even when paths match. Host activation repairs missed deliveries without rerunning tasks.

Convax persists deletion targets and unfinished creation identities before settlement. Its coordinator uses native Workspace archival, stop events and activity queries, waits for Agents and owned jobs, and includes discovered subagent descendants. Already archived Sessions receive an explicit stop retry. Only confirmed archival and inactivity permit graph removal and tombstones; failures remain retryable and late-created Sessions settle without binding. Closing a view or unloading the renderer does not request deletion.

## Providers, migrations and agent tools

The default [node Host](../../../../packages/plugin-inernal-nodes-host/README.md) and [node displays](../../../../packages/plugin-inernal-nodes-renderer/README.md) mount independently of the canvas kernel. `CanvasNodeTypeInfo.capabilities` declares resource kind or Session-container semantics. `CanvasSessionOperations` and `CanvasDeliveryOperations` attach native Session coordination and recorded delivery catch-up without owning Agent execution. Durable bindings keep Session lifecycle protection available when a provider is missing.

`CanvasNodeRendererDefinition` declares default dimensions, drag handles, presentation and copy behavior. `registerCreation` contributes translated actions to the creation dock and menus. `registerWorkspaceActions` supplies optional feature actions. Their disposers remove the contributions while saved graph records remain. Default and third-party nodes use the same registrations. When a provider is unavailable and a node has no recorded Session ownership, copying the node preserves its payload fields as stored.

Host providers register versioned parsers, named ports, pure adjacent migrations and optional cancellable reference preparation. Client renderers register independently; missing or incompatible registrations retain data, geometry and connections as placeholders. The Convax database imports a validated predecessor snapshot and merges matching Session reservations into its thread ledger, retaining predecessor data and reporting unmatched ids. Owned upgrades preserve recovery copies. Node upgrades atomically retain old and new payloads only while source revisions and provider registrations match. The [Host package](../../../../packages/plugin-host/README.md) owns failure and recovery details.

The Host exposes selected reads and provider schemas through `convax_graph`, and ordered semantic edits through `convax_commit`. The [graph-tool reference](convax-graph-tools.md) defines operations, atomicity, history and compatibility adapters. Tools resolve the calling Session’s bound Chat canvas unless an explicit target is supplied; availability follows the Host lifecycle independently of the renderer.

## Plugin authoring

The Host optionally mounts DSH's existing filesystem skill provider when `skills` is available. Its `convax-development` provider exposes the packaged [development skill](../../../../packages/plugin-host/skills/convax-plugin-development/SKILL.md) and unregisters with the Host. The [canvas-note template](../../../../packages/plugin-host/templates/canvas-note) uses ordinary bundle installation, optional node adapters and an explicit creation tool; it supplies no native note UI or creation-dock contribution. The central Creator assets and DSH discovery protocol remain unchanged.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxconvax--convaxhost"></a>

### `ctx.convax` — `ConvaxHost`

Host Remote namespace for canvases, Chat operations and resource access.

```ts cordis-catalog
/**
 * Read the current graph and runtime provider metadata.
 * @returns Current committed canvases and available Host node types.
 */
@Remote workspace(): CanvasWorkspace

/**
 * Register a Host node provider independently of its client renderer.
 * @param definition - Stable type identity, current payload parser and optional pure upgrades.
 * @returns Effect disposer that cancels and drains this provider's asynchronous work.
 */
registerNodeType(definition: CanvasNodeDefinition): () => Promise<void>

/**
 * Attach native Session operations until the contributing node plugin unloads.
 * @param operations - One adapter owning native Session coordination, not Agent execution.
 * @returns Idempotent disposer that removes entry points before draining coordination.
 */
registerSessionOperations(operations: CanvasSessionOperations): () => Promise<void>

/**
 * Attach recorded delivery catch-up independently of the canvas interface.
 * @param operations - Feature-owned observation and retry operations.
 * @returns Idempotent disposer which drains observations without stopping Agents.
 */
registerDeliveryOperations(operations: CanvasDeliveryOperations): () => Promise<void>

/**
 * Retry incompatible nodes using the current provider without discarding original data.
 * @returns Once each attempted transform settles; failures remain in workspace diagnostics.
 */
@Remote async retryMigrations(): Promise<void>

/**
 * Commit one graph mutation or return an explicit rejection.
 * @param request - Retry identity, expected revision and command.
 * @param signal - Optional cancellation before a graph commit; deletion intentions remain recoverable.
 * @returns Mutation outcome with a complete current snapshot.
 */
@Remote async execute(request: CanvasCommandRequest, signal?: AbortSignal): Promise<CanvasCommandResult>

/**
 * Return the canvas's local default working directory, creating it if needed.
 * @param canvasId - Existing canvas identity; existing Chat directories remain unchanged.
 * @param signal - Optional caller cancellation; Host shutdown cancels and drains the operation.
 * @returns Absolute directory usable by the composed filesystem, or an explicit failure.
 */
@Remote ensureCanvasDirectory(canvasId: CanvasId, signal?: AbortSignal): Promise<string>

/**
 * Validate and commit ordered graph edits under one durable retry identity.
 * Resource creation checks do not repeat after a receipt or lifecycle intention exists.
 * @param input - One canvas version, retry identity and ordered semantic operations.
 * @param signal - Cancellation before graph publication; pending lifecycle work remains recoverable.
 * @returns Current workspace or an explicit conflict, failed operation, or recoverable lifecycle state.
 */
async commit(input: CanvasCommitRequest, signal?: AbortSignal): Promise<CanvasCommandResult>

/**
 * Create or fork a durable thread inside one Chat without sending input.
 * @param request - Chat target, expected revision and stable retry identity.
 * @returns Actual DSH Session binding, or a recoverable failure.
 */
@Remote createThread(request: CanvasThreadRequest): Promise<CanvasThreadResult>

/**
 * Open an original Session on a canvas, retaining its messages and schedule identity.
 * @param request - Existing Session, preferred canvas and retained Chat placement identity.
 * @returns Unique Chat location and complete workspace, or a rejection without creating a Session.
 */
@Remote({ resources: { session: (request: CanvasOpenSessionRequest) => request.sessionId } }) openSession(request: CanvasOpenSessionRequest): Promise<CanvasOpenSessionResult>

/**
 * Retry unfinished Chat operations and delivery catch-up using their saved identities.
 * @returns Once every retry has settled or exposed a retained failure.
 */
@Remote async retryOperations(): Promise<void>

/**
 * Follow committed workspace snapshots until cancellation or Host shutdown.
 * @param signal - Caller lifetime supplied by the Remote carrier.
 * @returns Initial snapshot followed by coalesced committed snapshots.
 */
@Remote({ mode: 'stream' }) async *watch(signal: AbortSignal): AsyncIterable<CanvasWorkspace>

/**
 * Resolve a resource explicitly chosen by the user without a hidden Session.
 * @param path - Absolute path in the composed filesystem world.
 * @param signal - Optional cancellation; absent reads run to completion.
 * @returns Existing file or directory metadata.
 */
@Remote describe(path: string, signal?: AbortSignal): Promise<CanvasResource>

/**
 * Resolve one node into an explicit composer reference without sending input.
 * The provider and node must remain current until resolution completes.
 * @param canvasId - Canvas containing the source node.
 * @param nodeId - Source node chosen by the connection gesture.
 * @param signal - Optional cancellation; absent work follows the Host lifetime.
 * @returns Filesystem-validated file or folder metadata; no graph or project mutation.
 */
@Remote prepareReference(canvasId: CanvasId, nodeId: CanvasNodeId, signal?: AbortSignal): Promise<CanvasResource>

/**
 * Read direct children of an explicitly selected folder.
 * @param path - Absolute directory path.
 * @param signal - Optional cancellation; absent reads run to completion.
 * @returns Sorted metadata; reading does not add nodes or change real files.
 */
@Remote listDirectory(path: string, signal?: AbortSignal): Promise<CanvasDirectory>

/**
 * Preview UTF-8 text through the composed filesystem's existing access policy.
 * @param path - Absolute file path.
 * @param signal - Optional cancellation; absent reads run to completion.
 * @returns Text window with explicit truncation.
 */
@Remote previewFile(path: string, signal?: AbortSignal): Promise<CanvasPreview>

/**
 * Read complete document bytes through the filesystem policy, converting Word and PowerPoint files with the shared service.
 * @param path - Absolute source path, independent of any Session.
 * @param signal - Optional caller cancellation; Host shutdown also cancels and drains the read.
 * @returns Caller-owned binary content and source metadata; oversized or changed sources reject.
 */
@Remote readDocument(path: string, signal?: AbortSignal): Promise<CanvasDocumentPreview>

/**
 * Authorize media content access without buffering the file or creating a Session.
 * @param path - Absolute source path.
 * @param signal - Optional caller cancellation; Host shutdown cancels and drains the authorization read.
 * @returns Metadata used by the version-pinned authenticated media URL.
 */
@Remote mediaSource(path: string, signal?: AbortSignal): Promise<CanvasMediaSource>

/**
 * Observe resource metadata without reading file content.
 * @param path - Absolute file or folder reference.
 * @param signal - Remote consumer lifetime.
 * @returns Initial metadata and refreshed metadata after filesystem invalidations.
 */
@Remote({ mode: 'stream' }) watchResource(path: string, signal: AbortSignal): AsyncIterable<CanvasResource>

/**
 * Observe directory contents without importing changed files into the canvas.
 * @param path - Absolute directory reference.
 * @param signal - Remote consumer lifetime.
 * @returns Initial listing and refreshed listings after filesystem invalidations.
 */
@Remote({ mode: 'stream' }) watchDirectory(path: string, signal: AbortSignal): AsyncIterable<CanvasDirectory>

/**
 * Observe a file preview without modifying its original content.
 * @param path - Absolute file reference.
 * @param signal - Remote consumer lifetime.
 * @returns Initial preview and refreshed previews after filesystem invalidations.
 */
@Remote({ mode: 'stream' }) watchFile(path: string, signal: AbortSignal): AsyncIterable<CanvasPreview>

/**
 * Cancel and drain ancestry checks, Chat coordination, resource reads and observations before dependencies unload.
 * @returns Resolution after accepted work and watcher cleanup settle; independent of stream pulls.
 */
close(): Promise<void>
```

Types: [CanvasCommitRequest](convax-graph-tools.md)

Source: [`../../packages/plugin-host/src/index.ts`](../../../../packages/plugin-host/src/index.ts)

<a id="ctxconvaxterminal--canvasterminalcontroller"></a>

### `ctx.convaxTerminal` — `CanvasTerminalController`

Typed terminal operations using committed canvas nodes as their resource owner.

```ts cordis-catalog
/**
 * Read the card's launch directory and shared terminal limits.
 * @param canvasId - Owning canvas identity.
 * @param nodeId - Terminal card identity.
 * @param signal - Request cancellation.
 * @returns Current launch directory and terminal limits; running shells retain their own directory.
 */
@Remote async environment(canvasId: CanvasId, nodeId: CanvasNodeId, signal: AbortSignal): Promise<TerminalEnvironment>

/**
 * Discover shells without allocating a terminal process.
 * @param canvasId - Owning canvas identity.
 * @param nodeId - Terminal card identity.
 * @param signal - Request cancellation.
 * @returns Installed shell choices in the canvas execution environment.
 */
@Remote shells(canvasId: CanvasId, nodeId: CanvasNodeId, signal: AbortSignal): Promise<TerminalShell[]>

/**
 * List the card's retained process without creating a Session or shell.
 * @param canvasId - Owning canvas identity.
 * @param nodeId - Terminal card identity.
 * @returns At most one retained process, including its exited screen.
 */
@Remote list(canvasId: CanvasId, nodeId: CanvasNodeId): WebTerminalInfo[]

/**
 * Start a shell for this card, sharing the current instance across windows and retries.
 * @param canvasId - Owning canvas identity.
 * @param nodeId - Terminal card identity.
 * @param request - New runtime identity, shell choice and initial dimensions.
 * @param signal - Cancellation before allocation commits.
 * @returns Existing or newly committed process metadata; its id may belong to another window's first create.
 */
@Remote async create(canvasId: CanvasId, nodeId: CanvasNodeId, request: TerminalCreateRequest, signal: AbortSignal): Promise<WebTerminalInfo>

/**
 * Hold an existing process without taking input control; cards also retain their process on the Host.
 * @param canvasId - Owning canvas identity.
 * @param nodeId - Terminal card identity.
 * @param id - Retained runtime identity.
 * @param signal - Physical stream lifetime.
 * @returns Hold acknowledgement followed by its lifetime stream.
 */
@Remote({ mode: 'stream' }) retain(canvasId: CanvasId, nodeId: CanvasNodeId, id: WebTerminalId, signal: AbortSignal): AsyncIterable<TerminalRetentionFrame>

/**
 * Attach screen and input to the card's current process.
 * @param canvasId - Owning canvas identity.
 * @param nodeId - Terminal card identity.
 * @param id - Retained runtime identity.
 * @param signal - Attachment cancellation, which preserves the process.
 * @returns Screen recovery, output, writable state and command acknowledgements.
 */
@Remote({ mode: 'stream' }) attach(canvasId: CanvasId, nodeId: CanvasNodeId, id: WebTerminalId, signal: AbortSignal): RemoteStream<TerminalFrame, TerminalInput>

/**
 * Rename the running instance without changing its launch configuration.
 * @param canvasId - Owning canvas identity.
 * @param nodeId - Terminal card identity.
 * @param id - Retained runtime identity.
 * @param title - Nonempty display title.
 */
@Remote rename(canvasId: CanvasId, nodeId: CanvasNodeId, id: WebTerminalId, title: string): void

/**
 * Terminate the runtime identity using the shared terminal close path, including after card deletion.
 * @param canvasId - Original owning canvas identity.
 * @param nodeId - Original terminal card identity.
 * @param id - Runtime identity to close; a later replacement remains independent.
 * @returns After provider process cleanup and output drainage settle.
 */
@Remote async close(canvasId: CanvasId, nodeId: CanvasNodeId, id: WebTerminalId): Promise<void>
```

Types: [RemoteStream](typert.md)

Source: [`../../packages/plugin-inernal-nodes-host/src/terminals.ts`](../../../../packages/plugin-inernal-nodes-host/src/terminals.ts)
<!-- END GENERATED cordis-surface -->
