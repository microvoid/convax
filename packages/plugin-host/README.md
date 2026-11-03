---
description: "Save canvases, bind Chat threads to DSH Sessions, resolve explicit composer references, and project delivered files."
kind: "package-reference"
---

# @deepseek-ai/dsh-convax-plugin-host

English | [中文](README.zh.md)

## Summary

Save multiple canvases containing references to files and folders from different projects. Edit nodes and connections through revisioned commands, with automatic persistence independent of the canvas interface. Browse directories and read preview content through the composed filesystem. Removing a reference preserves the original file. Chat nodes contain multiple DSH Session threads and reuse native conversation UI. Messages use native composer references, and explicitly delivered files become output nodes.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this Host through the [Convax product composition](../plugin-renderer/cordis.patch.yml). Convax exclusively owns `storages/convax-canvas.sqlite` under the configured application home; DSH retains its existing storage routes. The Host requires filesystem, Agent, Session persistence, projection, tool, and Remote access services. Chat creation additionally requires Workspace and Session query services. Renderer activation is independent of the Host.

When DSH's skill registry is present, this Host exposes the packaged [Convax development skill](skills/convax-plugin-development/SKILL.md) through the existing filesystem skill provider. Use it alongside the original Creator workflow to copy the runnable [canvas note bundle](templates/canvas-note/README.md) into a workspace and install it through Plugin Manager. The template is canvas-only; it loads without Convax but supplies no native note view. Host APIs ship as public `lib/types/index.d.ts`; Client node APIs ship from the renderer's public `./client` declarations. Static central catalogs are not required for these optional registrations.

New canvases receive a local working directory beneath `canvasDirectoryRoot`, which defaults to `~/Documents/convax`. The directory name uses the stable canvas identity, so renaming or archiving a canvas does not move it. `ensureCanvasDirectory` returns its usable absolute path; earlier canvases receive one when first requested. Existing assignments survive configuration changes. Directory creation precedes graph creation, including graph-tool batches and canvas copies. A failed creation can retain an empty directory reservation, but never publishes a canvas whose directory preparation failed. The Host validates local directories through the composed filesystem and reports incompatible or denied access instead of substituting another path.

`previewBytes` bounds the existing UTF-8 text preview, which reports `truncated` when content exceeds its window. `documentBytes` defaults to 52,428,800 bytes (50 MiB) and bounds complete source bytes and converted PDF bytes separately. Complete document reads reject oversized or changed sources rather than returning partial content. Resource paths must be absolute. Reads use the composed filesystem policy, never modify files, and report failures to the caller.

`mediaSource` authorizes media access and returns versioned metadata without buffering the complete file. The authenticated Connection route `/api/convax/media` serves GET and HEAD requests through the same filesystem policy. Known-size sources support single HTTP byte ranges for playback and seeking; unknown-size sources stream sequentially. `mediaChunkBytes` defaults to 262,144 bytes (256 KiB) and bounds each filesystem read under response backpressure. Media streams do not use `documentBytes`, create Sessions, or transcode files. A changed source or cancelled consumer terminates its read; Host shutdown cancels response bodies and drains their filesystem work.

Graph commands require the target canvas identity, expected revision, and operation identity. A stale revision returns a conflict without writes. An identical retry is recognized by its durable receipt and returns current workspace state without repeating the mutation. Reusing an operation identity for different arguments is rejected. A transaction includes the graph and receipt; it does not include Session or filesystem writes.

Retry equality compares serialized request fields. Object property order and optional fields whose value is `undefined` do not distinguish otherwise identical requests. The same comparison applies while an operation is running and after its receipt is durable.

`set-archived` persists the canvas's organizational `archived` flag; an absent flag means active. Archiving or restoring a canvas preserves its graph, Session bindings, running work and native Session archive state. It creates no graph undo entry. `duplicate` takes `newCanvasId` and `title`, checks the source revision, and atomically creates an active canvas with new node and connection identities. Positions, file paths, provider payloads and connection ports are retained even when a provider is unavailable; canvas and node revisions start at one. Source Chat Sessions, pending creations, composer drafts, running tasks and graph history are not copied. New Chat containers have no bound threads. A copied Chat that used its source canvas’s default directory uses the copied canvas’s directory; explicit folder directories remain unchanged. Canvas copying does not copy filesystem contents. Deleting or purging a canvas preserves its assigned directory and files.

`purge` permanently removes the canvas graph and all of its graph undo records after the existing stop-and-archive coordinator settles its Chat threads, including pending creations. Confirmation is required when threads are affected. Failure retains the graph, undo records and durable retry intention; graph removal, history removal and the final receipt commit together. Source files and DSH Session logs remain. Operation receipts, Session bindings and deletion tombstones remain to recognize retries and suppress late outputs; purged canvas identities cannot be reused. The legacy `delete` command retains its existing behavior.

`add-subgraph` commits multiple new nodes and their connections in one canvas revision. Callers allocate globally unique node and connection identities; new node revisions start at one. The Host validates every node's provider, data version and payload before validating connection endpoints and ports. A rejected batch leaves the graph unchanged and its operation identity available for a corrected request. The command creates no Session bindings or composer references, including when it adds Chat containers.

`history` targets a committed graph operation with `targetOperationId` and `direction: 'undo' | 'redo'`. Its own operation identity makes retries idempotent. The Host applies only the recorded fields, preserving unrelated Agent edits; changed affected fields or newly attached connections reject the transition atomically. Restored nodes retain their identities and provider payloads with increasing revisions, including when their provider is unavailable. Batch canvas creation and removal retain reversible lifecycle snapshots; legacy lifecycle commands retain their existing history behavior. Replaying connections never inserts composer references or replays delivery receipts.

Removing a Chat through history uses the existing confirmation and stop/archive coordinator. Restoring it retains its original Session bindings and unarchives only Sessions archived by that removal, including discovered subagents; it does not resume stopped work. Native archive restoration has a durable intention and blocks graph publication until completion. External failure retains the intention for `retryOperations` or Host activation recovery. Previously archived Sessions and suppressed delivery or creation records remain unchanged.

`createThread` retains its operation identity through retries. Convax saves the fixed Session identity, resolved directory and preset, and exact fork cut in the same thread intention before using DSH's public Session persistence APIs. Session and Workspace completion is recorded before Chat binding, so a lost binding reply does not recreate a Session or restore removed Workspace membership. Requests may select `agentPreset`; omission resolves DSH's configured default once. Forks inherit their source's projected preset and retain their inherited prefix so historical deliveries do not become new outputs. A folder-created Chat uses that folder as its default project; later input connections preserve existing thread directories.

`openSession` places an existing native Session on a canvas without creating, forking, or activating an Agent. The request supplies the original `sessionId`, preferred `canvasId`, `expectedRevision`, a caller-allocated `nodeId`, and `position`. The Host verifies that the original Session exists, is unarchived, and has an absolute working directory. A Session already bound to a live Chat returns that actual location, including on another canvas or after a lost reply. Otherwise one transaction adds the Chat and its unique Session binding, so observers never see an empty Chat requiring initialization. The original conversation log, Workspace membership, and schedule bindings remain unchanged. Historical deliveries are already consumed at the observed Session cursor. Revision conflicts, occupied Chat identities, unavailable providers, and unfinished native binding operations reject without partial graph writes. Remote callers need access to both the original Session and the complete canvas workspace.

A file/folder connection gesture can call `prepareReference(canvasId, nodeId)` once to resolve its source into an explicit native composer reference. Resolution checks the current provider, node data, compatibility and composed filesystem, and rejects cancellation or changed sources. Only references retained in the composer are sent. Deleting a reference preserves the edge; sending and clearing the draft does not repopulate it. Neither bound nor native DSH Sessions receive hidden graph-derived content. The Host rejects model steps while the owning Chat is being deleted through the existing `agent/pre-step` hook, including subagent lineage read from live or persisted headers. Queuing input still uses native DSH APIs.

The `convax.window` node stores only `bindingId` (a UUID selection identity) and `name`; native window/process ids and capture handles are rejected in its payload. The current Desktop renderer owns the explicitly selected capture and send-time screenshot reference. The Host persists window nodes and connections without starting capture, granting input access, or resolving them through filesystem `prepareReference`. Copying or restoring graph data does not restore capture authority; the renderer must own a matching live selection or show a reconnect action.

Closing a view does not stop a thread. Deleting a Chat or canvas with threads requires explicit confirmation. Convax records the deletion, uses native Workspace archival and stop requests, then waits for owned Agents and jobs before removing graph records. Actual subagent descendants are included; independent forks remain separate. Residual activity, stop failures and cancellation preserve the archived Sessions, graph and visible retry intention. Retrying an already archived thread requests its stop again. Failed or late creation and deletion work remains retryable under the original identity. `retryOperations` resumes pending operations and delivery recovery.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The repository owns its versioned SQLite database and publishes detached graph snapshots only after persistence succeeds. Provider definitions live in an effect-owned registry; durable envelopes retain type identity and complete payloads independently of provider availability. Built-in file, folder, window and Chat definitions use that registry. Geometry changes and reference removal remain possible when a provider is absent, while new business-data operations require a compatible provider. Client transport derives from the Host's Typert Remote methods. `watchResource` streams metadata independently of content; `readDocument` returns complete versioned bytes through a unary Remote call without creating a Session. Word and PowerPoint sources (`.doc`, `.docx`, `.ppt`, `.pptx`) use the optional [Office converter](../../libs/dsh/packages/document/office-to-pdf/README.md) and return PDF bytes with the original path and missing-font metadata. Missing conversion services and conversion failures remain explicit errors. Spreadsheets retain their original bytes for browser rendering.

Workspace snapshots and individual Chat reads use one pure Chat projection over detached binding, thread-operation, and deletion records. Each read builds its own index and retains no cache across commits. Threads sort by ordinal and Session identity; failures retain durable-key order and prefer thread creation, active deletion, then delivery errors. Suppressed thread creations stay outside the visible thread list and its delivery errors.

`ctx.convax.registerNodeType` registers a provider through its owning Cordis effect. Definitions declare stable ports, a current payload parser, adjacent pure `migrations`, and optional cancellable `prepareInput` called only by explicit reference resolution. Removing the provider cancels and drains its transforms and preparation; a replacement cannot commit an old registration’s result. Explicit reference resolution requires an active compatible provider.

Repository upgrades are owned by Convax and retain a SQLite recovery copy before changing versions. The predecessor `storages/convax.sqlite` is read under a consistent snapshot and kept unchanged; its writer lease prevents simultaneous use by an older Host. Schema seven accepts version-one through version-six stores, preserving existing graphs, history and coordination records, and adds durable canvas directory assignments. Directory assignments remain outside graph undo history and survive graph removal. Earlier Hosts refuse the new version instead of discarding archive state or misreading new command receipts. Legacy Session reservations merge into matching thread intentions; unmatched operations remain in the predecessor and produce an explicit startup warning. Node upgrades transform detached payloads, validate the result, then atomically retain old and new payloads with their revisions. Missing paths, invalid output and cancellation preserve originals; `retryMigrations` retries against the current provider.

The Host-only `convaxDeliveries` Session projection folds explicit `deliverables/presented` facts. Recovery reads live or persisted Sessions without driving their Agents. It commits all file nodes, delivery connections, per-file receipts and the event cursor together. Removed output references retain tombstones; deletion suppresses late outputs. Renderer disposal leaves this owner running. Deleted canvas identities remain retired. Removed node and connection identities can only return through their own graph history, keeping retained Session bindings attached to their original Chat.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Convax packages](../README.md) — Host and renderer responsibilities.
- [Session persistence](../../libs/dsh/packages/session/session-persistence/README.md) — native Session records and handles.
- [Repository migration](../../libs/dsh/docs/upgrade-guide/v0.2.1-rc.3/convax-owned-storage/guide.md) — predecessor import, verification and rollback.
- [Convax proposal](../../libs/dsh/.agents/notes/proposed/feature/2026-10-28-convax-canvas.md) — complete product design and remaining implementation.

<a id="model-experience"></a>
## Model Experience

### Explicit composer references

#### What the model sees

The model receives the native user message, including any file or folder references the user retained in the composer. Canvas edges do not append resource metadata or folder contents to a send. Explicit graph-tool results remain visible through the ordinary tool log.

#### Token effect

Reference text contributes tokens through the ordinary native message. The Host adds no per-send graph-context text.

#### KV Cache effect

Native message history determines the request prefix. Changing an edge does not rewrite an admitted message or insert new context into later messages.

### Canvas graph tools

#### What the model sees

The Host exposes `convax_graph` for selected reads and provider schemas, and `convax_commit` for ordered semantic edits. One successful batch advances its canvas once, with one receipt and one history entry. The five legacy tools remain compatible. The [graph-tool reference](../../libs/dsh/docs/subsystems/convax-graph-tools.md) defines selectors, operations, revision guards and lifecycle recovery. Tool registration and default Session-to-Chat targeting work independently of the renderer.

#### Token effect

The two generic and five legacy tool schemas join the registered tool set while the Host is active. The standard skill catalog also exposes the Convax development summary when its registry is present; full instructions are read when loaded. Generic reads include only requested collections and fields; commit replies contain identities, the resulting revision and an explicit rejection when applicable. Legacy edit replies retain the target graph. Calls and rendered JSON enter ordinary Session history without copying source-file contents.

#### KV Cache effect

Graph edits append tool interactions without rewriting earlier Session history. The schemas remain stable across canvas changes; activating or unloading the Host changes the available tool set through ordinary tool registration.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Complete document reads are bounded by `documentBytes`; Word and PowerPoint previews require an active Office conversion provider. The [renderer](../plugin-renderer/README.md) owns supported presentation formats.

<a id="dev-note"></a>
### Dev Note

None.
