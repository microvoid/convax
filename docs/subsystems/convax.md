# Convax canvas subsystem

English | [中文](convax.zh.md)

Convax owns application-level canvas records, node definitions, reference connections and revisioned graph commands. The [Host package](../../packages/convax/plugin-host/README.md) owns its SQLite database, transactions, migrations and recovery coordination. DSH storage and Session APIs remain unchanged. The [renderer package](../../packages/convax/plugin-renderer/README.md) contributes the full-window canvas and Chat workspace and can be disabled independently.

## Records and commands

`CanvasDocument` owns its nodes, connections, and monotonic revision. `CanvasWorkspace` is a detached snapshot of saved canvases, currently available Host node types, and Chat-to-Session bindings. The [client-safe declarations](../../packages/convax/plugin-host/src/types.ts) define the records and discriminated command vocabulary; Typert generates the transport from the Host methods.

`CanvasResource` describes file or directory metadata. `CanvasDocumentPreview` carries the resolved `path`, `name`, nullable byte `size`, filesystem `version`, `mimeType`, and complete transient `bytes`; Office conversion can add `renderedAs: 'pdf'` and `missingFonts` while retaining the source path. `watchResource` observes metadata; the unary `readDocument` call reads content through the composed filesystem without a Session. The [Host package](../../packages/convax/plugin-host/README.md#use-this-package) owns byte limits, conversion availability, and read failures.

`CanvasMediaSource` carries resolved file metadata (`path`, `name`, nullable `size`, `version`, and `mimeType`) for version-pinned media requests. The authenticated Connection route streams HTTP byte ranges through composed filesystem reads; it creates no Session, performs no transcoding, and does not buffer the complete source. The [Host package](../../packages/convax/plugin-host/README.md#use-this-package) defines response lifetime, byte windows, and failures.

Each mutation carries an operation identity and expected canvas revision. The Convax repository commits graph state and its receipt in one SQLite transaction. Duplicate retries do not repeat mutations; conflicts preserve durable state. Runtime definitions validate new payloads and ports; missing definitions retain stored payloads and editable geometry. Plugin installation and enablement remain DSH responsibilities.

`CanvasWindowBindingId` names a window selection independently of native handles. A version-one `convax.window` payload contains only `bindingId` and `name`; the current Desktop renderer owns the live capture. Stored or copied node data does not establish a valid runtime selection or grant window access. The [Host package](../../packages/convax/plugin-host/README.md#use-this-package) owns payload validation, and the [renderer package](../../packages/convax/plugin-renderer/README.md#use-this-package) owns reconnection and mirror presentation.

## UI composition

The `shell.workspace` slot belongs to DSH's layout owner. Convax occupies it while global panels, settings, theme and overlays remain DSH-hosted. Removing the renderer restores native conversations without removing the Host. Chat cards retain explicit Session references and embed the existing `conversation.content` Factory; Convax owns card layout, thread selection and tool-panel placement. Shared DSH drafts preserve unsent text and attachments. This reuse does not establish a new DSH dock API; existing UI adaptations remain separately reviewable. The [renderer package](../../packages/convax/plugin-renderer/README.md#use-this-package) owns navigation and resource-opening interactions.

Resource cards use `document.preview` for documents and the separate root Factory `convax.media.preview` for audio and video. Media playback belongs to the window rather than the card occurrence: hover playback pauses when the pointer leaves, while explicit manual playback continues across card folding and canvas navigation with a background pause control. Source replacement or removal and plugin disposal release the player. Audio waveform analysis reads and decodes incrementally into fixed peak bins; waveform failure preserves native playback. Unsupported codecs offer system opening. These presentations add no Session or model-visible content. The [renderer package](../../packages/convax/plugin-renderer/README.md#use-this-package) owns their controls and interaction details.

## Chat Sessions and inputs

Each thread is one DSH Session with a unique Convax Chat binding. One Convax thread ledger owns its immutable request, fixed Session reservation and pinned fork prefix. The materializer uses native Session preparation, persistence, Workspace attachment and fork APIs, records Session completion, then binds the graph. Restart retries keep the actual identity without resending input or recreating deliberately removed Workspace membership. Session messages and execution remain DSH-owned.

A file/folder connection explicitly resolves its source through the Host and inserts one native reference into the selected draft. Folder-created Chats use that folder as their default project and add it to the first draft. Removing a reference preserves the edge; retained edges never add hidden context to later sends or grant writable roots. Native Web, SDK, ACP and headless send protocols remain unchanged. Convax uses the existing `agent/pre-step` hook to reject model steps for deleting or missing bound Chats and their subagent lineage; it does not promise rejection before enqueue.

A window connection inserts a source-owned reference into that same native draft. At submit, its preparation resolves the exact node/binding to a fresh, immutable image plus source text before ordinary DSH attachment admission. Queue delivery and model retry reuse the admitted image. Native window selection and capture do not change the thread's project, preset, or Computer Use authorization. Preview frames are transient; admitted screenshot history remains DSH-owned and replayable without the live window.

## Deliveries and deletion

The Host-only Session projection recovers explicit file deliveries from live or persisted history. Each complete event commits file nodes, delivery connections, per-file receipts and the replay cursor in one transaction. A removed output keeps its receipt; independent events remain distinct even when paths match. Host activation repairs missed deliveries without rerunning tasks.

Convax persists deletion targets and unfinished creation identities before settlement. Its coordinator uses native Workspace archival, stop events and activity queries, waits for Agents and owned jobs, and includes discovered subagent descendants. Already archived Sessions receive an explicit stop retry. Only confirmed archival and inactivity permit graph removal and tombstones; failures remain retryable and late-created Sessions settle without binding. Closing a view or unloading the renderer does not request deletion.

## Providers, migrations and agent tools

Host providers register versioned parsers, named ports, pure adjacent migrations and optional cancellable reference preparation. Client renderers register independently; missing or incompatible registrations retain data, geometry and connections as placeholders. The Convax database imports a validated predecessor snapshot and merges matching Session reservations into its thread ledger, retaining predecessor data and reporting unmatched ids. Owned upgrades preserve recovery copies. Node upgrades atomically retain old and new payloads only while source revisions and provider registrations match. The [Host package](../../packages/convax/plugin-host/README.md) owns failure and recovery details.

The Host exposes selected reads and provider schemas through `convax_graph`, and ordered semantic edits through `convax_commit`. The [graph-tool reference](convax-graph-tools.md) defines operations, atomicity, history and compatibility adapters. Tools resolve the calling Session’s bound Chat canvas unless an explicit target is supplied; availability follows the Host lifecycle independently of the renderer.

## Plugin authoring

The Host optionally mounts DSH's existing filesystem skill provider when `skills` is available. Its `convax-development` provider exposes the packaged [development skill](../../packages/convax/plugin-host/skills/convax-plugin-development/SKILL.md) and unregisters with the Host. The [canvas-note template](../../packages/convax/plugin-host/templates/canvas-note/) uses ordinary bundle installation, optional node adapters and an explicit creation tool; it supplies no native note UI or creation-dock contribution. The central Creator assets and DSH discovery protocol remain unchanged.

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

Source: [`packages/convax/plugin-host/src/index.ts`](../../packages/convax/plugin-host/src/index.ts)
<!-- END GENERATED cordis-surface -->
