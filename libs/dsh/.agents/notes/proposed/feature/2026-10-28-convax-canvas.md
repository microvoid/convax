# Agent Note: Convax canvas product and architecture proposal

Status: proposed

English | [中文](2026-10-28-convax-canvas.zh.md)

## Problem

Convax needs a canvas as the Desktop's main interface, where users organize files, folders, and conversations across multiple canvases. DSH already owns conversation execution, history, input, and tool interactions. The design must preserve those capabilities while giving the canvas its own data and lifecycle.

The [plugin development proposal](../architecture/2026-10-30-convax-plugin-development.md) extends this design with contribution, dual-host adaptation and AI authoring decisions. Convax packages its own [development skill](../../../../../../packages/plugin-host/skills/convax-plugin-development/SKILL.md) and [canvas-note template](../../../../../../packages/plugin-host/templates/canvas-note/) through ordinary DSH plugin registration.

The [window mirror proposal](2026-11-02-convax-window-mirror.md) adds specifically bound, directly operable application windows and send-time screenshot references.

The [grouping decision](../../implemented/architecture/2026-11-08-convax-canvas-groups.md) owns logical node membership, world coordinates and window-derived group frames. This broader proposal retains its independent product and integration decisions.

## Proposal

The product behavior below is agreed. Keep DSH unchanged wherever its public extension points already meet the requirement; a Convax-specific requirement alone does not justify a DSH runtime API. Convax owns graph transactions, schema upgrades, thread-operation recovery and deletion coordination. A demonstrated DSH defect can be fixed separately with its own reproduction and tests.

### Agreed product behavior

| Area | Behavior |
|---|---|
| Main interface | The Desktop's main working interface is a canvas. Browser-style tabs switch between canvases. |
| Canvas ownership | Canvases belong to the application. One canvas can contain files and folders from different projects; adding a project means adding a folder or file node. |
| Canvas storage | Convax automatically saves canvases as application-managed data under the application data location. Users open them through the canvas list and tabs without choosing a save path for each canvas. The default medium is an independent Convax SQLite database. |
| Storage transactions | The Convax Host owns SQLite transactions, revision checks and schema migrations. Session messages retain their existing DSH storage; one Convax thread ledger coordinates graph and Session operations after partial success. Node plugins use the Convax API. |
| File and folder nodes | Nodes reference the original local files and folders. The first version supports directory browsing, dragging children onto the canvas, and file previews. Editing uses the agent or external applications. Removing a node leaves the original file untouched. |
| Chat nodes | A Chat is a canvas node containing multiple threads. Each thread maps to one DSH Session, and users create and switch threads inside the Chat card. |
| Session binding | A Chat can own multiple DSH Sessions, but each Session binds to exactly one Chat within Convax. Viewing that Session through native DSH does not create another binding. Continuing the same history in another Chat uses a fork with a new Session identity, so input selection and deletion/archive handling remain unambiguous. |
| Conversation reuse | Chat embeds DSH's existing conversation flow and input, including their existing interactions. Convax does not introduce a second conversation implementation. |
| Node extensions | Other DSH plugins can register canvas node types. File, folder, and Chat nodes use the same registration mechanism. DSH owns plugin installation, activation, and dependencies; Convax defines node types, data schemas, connection ports, and rendering entry points; each node plugin owns its business data and behavior. |
| Unavailable node plugins | Disabling or uninstalling a node plugin preserves its nodes' complete data, geometry, and connections. Show an unavailable-plugin placeholder that users can move or delete; new business operations for that node are unavailable, and other nodes remain usable. Reactivating or installing a compatible implementation restores the original nodes. |
| Node data upgrades | Node data carries a version independent of the plugin release version. Plugins provide versioned migration functions, and Convax automatically runs and validates applicable migrations, retaining a recoverable copy before committing. Commit new data only after success. A failed or missing migration preserves the original data and displays an incompatible-node placeholder while other nodes remain usable. |
| Node persistence ownership | Plugins define the semantics and schemas of node parameters, resource references, and custom fields. This durable node state is stored with the node in the Convax repository and changed through Convax APIs; Convax owns validation, revision conflicts, persistence, and migration. Session messages remain with DSH, real files remain in their original locations, and credentials and user-level settings remain with their owning services. |
| Input connections | Multiple file or folder nodes can connect to one Chat. A new UI connection resolves its source once and inserts a native reference into that Chat's current thread draft. |
| Execution triggers | Input connections declare input relationships; delivery connections record outputs. Adding a connection or changing upstream content does not automatically start downstream work. Users or explicit plugin actions trigger execution. Dedicated workflow plugins own automatic workflows; Convax core owns the canvas and its connection relationships. |
| Agent canvas tools | The Convax Host provides tools for agents to query canvases, add file nodes, create connections, move nodes, and arrange layouts through the same commands as the UI. The default target is the canvas containing the calling Session's Chat; cross-canvas actions name their target explicitly. Tools remain available when only the renderer is disabled. Deleting running threads follows the agreed confirmation, stop, and archive rules. |
| Input changes | Only the current thread draft receives a newly connected reference. Deleting that reference preserves the edge; sending clears the native draft without repopulating references. Saved edges, thread switches and reopening a canvas do not insert references. |
| Reference preparation failure | If explicit reference resolution fails, report the affected resource and preserve the existing draft and edge. Do not insert a stale reference or turn that edge into a hidden send dependency. Other native draft content remains sendable. |
| Working directory | Creating a Chat from folder A uses A's exact folder path as its default project; new threads inherit it. Connecting B later adds one draft reference and preserves A as the project. A Chat created on an empty canvas uses that canvas's retained default directory without a picker; each thread retains DSH's working-directory controls. |
| Outputs | Files explicitly delivered by the agent automatically become file nodes near the Chat, with Chat-to-file connections. Ordinary directory changes refresh existing references rather than importing every changed file. |
| Closing a tab | Closing a tab closes its view while preserving the canvas and background thread execution. The canvas can be reopened, and completion or pending approval produces a notification. Switching tabs also preserves running work. |
| Host and renderer separation | Split Convax into `dsh-convax-plugin-host` and `dsh-convax-plugin-renderer`, with independently controlled lifecycles. The usual deactivation disables only the renderer; the Host remains available. |
| Renderer deactivation | Restore the standard DSH interface while the Convax Host continues persistence, explicit resource resolution, and delivery processing. Running threads remain available through native DSH conversations. Reactivating the renderer displays the Host's current canvas state. |
| Host deactivation | Preserve canvas data, and keep DSH Session execution and history usable without Convax. Deactivation does not invoke deletion's stop-and-archive behavior. Convax graph integration resumes when the Host returns. |
| Deliveries during Host downtime | On Host recovery, use DSH's durable delivery records to add files delivered while that Host was unavailable to their original canvases. Process each delivery once, preserve explicit removal of an output node, and never rerun the task to rebuild the graph. Renderer-only deactivation leaves the Host processing deliveries normally. |
| DSH extension policy | Prefer existing DSH APIs and ordinary plugin registration. Convax owns product-specific state and coordination; absence of cross-record KV transactions is not a DSH bug. New DSH APIs require an independently justified generic need. Existing UI embedding changes remain a separate minimization review. |
| Deleting a Chat or canvas | Deletion stops and archives its threads while retaining their history. Running work requires a confirmation before deletion. File and folder contents remain intact. |
| Capacity | Do not add product quotas for node count, Chat count, or concurrent threads, or require users to select a capacity tier. |

### Existing DSH integration points

These observations identify the DSH source interfaces used by the implementation and the later integration work.

- Desktop runs the shared Web application through the Desktop profile. Cordis plugins are runtime units, while a bundle composes installable profile contributions; a package can carry both bundle and client metadata. See [application composition](../../../../docs/architecture.md), [bundle composition](../../../../packages/bundle/README.md), and [client modules](../../../../packages/client/modules/README.md).
- Installed Host plugins run as trusted code in the Host process. The existing DSH plugin mechanism does not provide a sandbox for arbitrary third-party canvas renderers; any such extension model needs its own explicit design. See [plugin installation and trust](../../../../packages/boot/plugin-manager/README.md).
- The existing `conversation.content` Factory embeds native conversation content under an explicit `SessionProvider`. Convax reuses its flow and composer and owns the surrounding card layout; it does not depend on a new DSH dock API. Preserve one editor per Session binding. See the [Factory declaration](../../../../packages/client/ui-conversation/src/client/contract/slots.ts), [embedded conversation host](../../../../packages/client/ui-subagent/src/client/sidebar-chat/index.tsx), and [input hub](../../../../packages/client/ui-conversation/src/client/input/hub.ts).
- Native Workspace navigation can change the main Session or its draft. Convax must keep card-local thread selection and resource references under their own owners. Existing UI adaptation requires separate review before promising that all DSH UI code is unchanged. See the [Factory actions](../../../../packages/client/ui-conversation/src/client/apply.ts) and [Workspace navigation](../../../../packages/client/ui-workspace/src/client/navigation.ts).
- A plugin can replace the `root` slot by priority. This does not transfer ownership of the existing layout's child slots: settings, the Plugins page, and `shell.overlay` still need valid hosts. See [slot ownership](../../../../docs/subsystems/slots.md) and the [layout registration](../../../../packages/client/ui-layout/src/client/index.ts).
- A Session has an effective working directory, while its original project still anchors project membership and sandbox writable roots. A connected folder reference therefore cannot silently become an additional writable project. See [working-directory semantics](../../../../docs/subsystems/working-directory.md).
- DSH's `present` tool records explicit file deliveries in the calling Session. This supplies an existing source for output nodes without scanning arbitrary filesystem changes. See [file delivery](../../../../packages/deliverables/tool-present/README.md).

### Plugin composition

Expose Convax as one installable product bundle containing the separately controlled `dsh-convax-plugin-host` and `dsh-convax-plugin-renderer` plugins. The packages live in `packages/plugin-host` and `packages/plugin-renderer`, under the repository's explicit optional-product classification. Compose the existing DSH conversation plugins while keeping canvas data and background integration independent of renderer activation.

| Part | Responsibility |
|---|---|
| `dsh-convax-plugin-host` | Own canvases, nodes, connections, Chat-to-Session bindings, explicit reference resolution, delivery projection, and deletion coordination. Expose typed commands and queries, and remain functional without the canvas renderer. |
| `dsh-convax-plugin-renderer` | Own the canvas interface, application tabs, Chat containers, thread selection, previews, and interaction state. Embed the DSH conversation Factory through explicit Session bindings; disabling this plugin returns to the native DSH interface without disabling the Convax Host. |
| Convax bundle | Compose the Host and renderer contributions with DSH dependencies and the Desktop profile. Keep renderer-only deactivation distinct from disabling the Host or the entire bundle. |
| Convax agent tool adapter | Register the agreed graph tools under the Host lifecycle. Resolve targets from real Session bindings and explicit cross-canvas targets, call the same Host commands as the UI, and reuse deletion confirmation and stop/archive behavior. A separate package is unnecessary unless its dependencies or lifecycle require one. |

Keep the Host and renderer separately controllable rather than merging their lifecycle into one plugin entry. Bundle metadata and the tool adapter need not create empty wrapper packages or a parallel agent runtime. The Host must not depend on renderer mounting, browser state, or the selected tab for its domain behavior.

Node type providers register Host definitions and client renderers separately through the public interfaces below. Renderer availability does not determine whether a Host node type can resolve explicit references. Provider availability is also separate from whether a node exists in the durable canvas: the canvas opens with unrecognized node types and preserves their payloads while showing the agreed placeholders.

The full-canvas interface occupies the public `shell.workspace` slot owned by DSH's layout plugin. DSH retains root ownership, global overlays, settings, Plugins, theme presentation, and panel hosts. Native sidebar and rightbar content remains mounted but hidden while the full-window workspace is active; selecting a global panel restores native layout. Removing the workspace contribution restores the original conversation interface. Preserve native plugin rows rather than disabling them through profile patches or copying their implementations. Runtime activation changes follow DSH's module reload support; a persisted preference must not be reported as already active when a restart is required.

### State ownership and storage

| Data | Proposed owner | Persistence |
|---|---|---|
| Canvas identity, title, nodes, connections, Chat defaults, thread bindings | Convax Host domain | A versioned Convax repository under the application data location; store DSH Session identities rather than message copies. |
| Node type identity, data version, and serialized node payload | Convax owns the stored envelope; the node plugin owns its payload semantics | Preserve type identity and payload separately from runtime registrations. Plugins supply versioned migrations; Convax validates and commits successful upgrades with a recoverable prior copy. |
| Recoverable migration copies and migration records | Convax repository | Keep versioned old payloads and upgrade results in application-managed data, independently of the provider installation directory and activation lifecycle. Retain them until an explicit retention policy is implemented. |
| Messages, tool events, model selection, execution and history | Existing DSH Session and agent services | Existing DSH persistence. Convax reads their state through public services. |
| Real files and directories | Original filesystem locations | Keep references; do not copy projects into a canvas database. |
| Open tabs, active tab, viewport and viewing preferences | Convax window preferences | Key preferences by window and canvas separately from canvas existence; do not persist a canvas-engine layout snapshot as the domain format. |
| Selection, dragging, connection gestures and temporary loading state | Convax client interaction state | In memory; durable graph changes go through Host commands. |

DSH's default composition places Session data under `$DSH_HOME/sessions` and storage under `$DSH_HOME/storages`. Convax uses the same resolved home while owning its database implementation; it does not register a replacement DSH storage backend. See the [base composition](../../../../packages/bundle/base/cordis.patch.yml), [domain storage](../../../../packages/storage/storage-domain/README.md), and [Session persistence](../../../../packages/session/session-persistence-jsonl/README.md).

Convax owns SQLite because graph mutations require multi-record transactions and revision checks. This requirement does not change DSH's generic KV guarantees. The alternatives have different ownership costs:

| Option | Existing capability | Ownership cost |
|---|---|---|
| DSH domain with JSON `single` | Schema validation, ordered durable writes and atomic file publication. | It republishes the unit and does not expose Convax's required cross-record transaction; adding those requirements would broaden DSH storage. |
| DSH domain with SQLite | Existing domain API over SQL records. | Backend SQL alone does not expose graph transactions or coordinate Session writes; extending the generic API would add unrelated maintenance. |
| Convax-owned SQLite repository | Graph transactions, revision checks, recovery copies and schema upgrades under one writer. | Convax maintains its own persistence and coordination. DSH Session logs, formats and storage implementations remain unchanged. |

The [storage proposal](../architecture/2026-07-24-domain-kv-storage-and-workspace.md), [JSON backend](../../../../packages/storage/storage-json/README.md) and [SQLite backend](../../../../packages/storage/storage-sqlite/README.md) retain their DSH guarantees. Reusable business plugins can use those services when their own requirements fit them; graph plugins submit Convax commands instead of adding a second graph writer.

### Public interfaces

The Convax-owned interfaces below reuse existing DSH services. Exact exported names and arguments are owned by source declarations; conceptual UI integration does not establish a new generic DSH API.

| Owner | Interface | Required behavior |
|---|---|---|
| Convax Host | `registerNodeType(definition)` | Register a stable provider-qualified type identity, data version and schema, named ports, explicit reference resolution, and versioned migrations. Reject duplicate active type identities and return a disposer. |
| Convax renderer | `registerNodeRenderer(typeId, renderer)` | Render validated node snapshots and submit Host commands. Registration is independent of the Host definition; a missing renderer shows a placeholder without disabling explicit Host reference resolution. |
| Convax Host | `workspace`, `watch`, `execute` | Return revisioned snapshots, publish committed changes, and accept typed commands with an operation identity and expected revision. UI, node plugins and agent tools share this service through DSH typed Remotes. |
| Convax Host | `prepareReference(canvasId, nodeId, signal?)` | Resolve one current node through its provider and existing filesystem policy for an explicit composer insertion. Recheck node/provider identity, honor cancellation, and change neither graph state nor project directories. |
| Convax database | Local transactions and monotonic schema upgrades | Atomically read preconditions and write graph records and receipts, publish cache state after commit, and preserve recovery copies. DSH storage APIs remain unchanged. |
| Convax Session materializer | Fixed creation and fork reservations | Store one reservation in the thread ledger, use native Session preparation/persistence and `buildForkSeed`, then bind the actual Session. Resume the same identity after a lost reply; reject changed requests. |
| Convax lifecycle guard | Existing `agent/pre-step` hook | Reject model steps for deleting or missing bound Chats and their subagent lineage. Native sends and queued messages keep their original DSH behavior; this hook does not promise rejection before enqueue. |
| DSH client UI and Convax layout | Existing Conversation Factory and shared shell hosts | Reuse global UI hosts and `conversation.content`; Convax owns card layout and local selection. Existing embedding adaptations remain separately reviewable rather than becoming a new dock API. |
| Convax resource service | Browse and preview over existing DSH filesystem services | Use explicit resource access without hidden Sessions; preview authority remains separate from granting an agent writable roots. |

Registrations and subscriptions use Cordis effects and release their disposers. Asynchronous preparation and migrations receive cancellation signals; provider removal cancels that provider's unfinished preparation and migrations and prevents stale results from committing. Admitted work retains its logged inputs. Cross-service identities use branded types. Validate configuration, durable records, plugin payload schemas, and wire requests at their respective parsers.

### Repository records

Keep graph records, uniqueness indexes and recovery receipts in one Convax-owned SQLite database. The thread-operation row also owns Session reservation phases; no parallel DSH operation ledger is required.

| Record | Stored facts |
|---|---|
| Canvas | Stable identity, title, graph revision, and active/deleting state. |
| Node | Stable identity, owning canvas, type identity, data version, serialized payload, geometry, and node revision. Runtime provider status is derived. |
| Connection | Stable identity, endpoint node and port identities, input order, and purpose. Input connections record reference relationships without injecting sends; delivery connections record outputs and do not feed an execution loop. |
| Session binding | A unique record keyed by actual DSH Session identity, containing canvas/Chat identities, thread membership, and delivery projection start position. This remains readable without the Chat provider. |
| Operation | Operation and request identities, affected records and Sessions, durable phase, result or recoverable failure, and deletion consent when applicable. A thread operation also retains its fixed Session reservation and fork prefix. |
| Delivery receipt | Session identity, durable event sequence and file index, projected node/connection identities, and processed or explicitly removed status. Keep the replay cursor consistently with these receipts. |
| Migration copy | Node identity, source and target data versions, original payload and revision, and migration result. Repository schema upgrades also retain a recoverable database copy. |

Ports have stable identities, direction, and declared accepted value kinds. File and folder nodes expose resource references; Chat input ports consume those references. Persist port identities with connections so provider changes do not silently reinterpret them. Validate new connections against available definitions; retain existing connections when a provider is missing. Graph changes do not request execution or recursive evaluation.

### SQLite transactions, ownership, and upgrades

Convax opens `storages/convax-canvas.sqlite` under the DSH-resolved application home through its own database owner. The versioned repository imports the predecessor `storages/convax.sqlite` graph and matching Session-operation reservations from one read-only snapshot. The predecessor and unmatched rows remain available for recovery; warnings identify unmatched operation ids. Owned upgrades retain a prior database copy. The development launcher supplies repository `.convax` through DSH's existing home override.

One Host owns the database writer and cache. Multiple windows communicate with that Host; a competing writer receives `storage-in-use`. Ownership starts before cache loading and ends after dependent work closes. The retained predecessor lease prevents an old Host from writing the migration source; source and target paths must name different files. SQLite statement locks alone cannot coordinate stale caches. This limits competing writers, not windows, canvases or threads.

For an existing canvas, a mutation carries `canvasId`, `operationId`, and `expectedRevision`. In one transaction, read the durable revision, check record constraints and Session-binding uniqueness, apply all graph changes, record the operation result, and increment the revision. A conflict writes nothing and returns the current revision. Repeating a committed operation returns its recorded result; reusing an operation identity with different request arguments is rejected. External file access, Session calls, and asynchronous plugin work occur outside the SQL transaction; any prepared result rechecks its source revisions when committed.

After a durable commit, update the Convax cache together and publish the new revision. Notification failure cannot roll back a committed write. Unknown outcomes require receipt inspection before retry; unresolved state suspends dependent mutations. Do not emulate transactions with repeated KV writes or silently reset damaged data. Corruption or unsupported versions preserve the medium and report a recovery failure.

Keep SQLite physical schema, Convax repository schema, node data version, and plugin release version distinct. Repository upgrades run under exclusive writer ownership and make a recoverable database copy before changing schema. Node migrations transform a copy without external side effects, then validate the result. Commit the old payload copy, new payload/version, migration result, and revision together only if the original node and provider registration remain current. A missing migration path or migration failure preserves the original payload and displays the agreed incompatible placeholder; one node's failure does not reset its canvas.

### Explicit references and failure recovery

Canvas connections declare relationships. A UI connection gesture invokes `prepareReference` once after its graph command succeeds; the Host does not scan incoming edges during sends.

1. Capture the originating Chat and current thread draft. Resolve the selected source through its current node provider, `prepareInput` when supplied, and the existing filesystem policy. Recheck node data, compatibility, provider identity and cancellation before returning a path.
2. Insert the resolved path through the native composer's reference API once. Keep this operation local to the captured thread; do not distribute it to sibling threads or a newly selected draft. A failed or cancelled resolution preserves existing draft content and the edge, reports the resource, and inserts no stale value.
3. Users can delete the reference without deleting the edge. Sending follows the native draft lifecycle; neither clearing it, changing threads, reopening a canvas nor reloading its saved edges inserts the reference again.
4. Send exactly the native message and references retained in that draft. Preserve ordinary DSH logging and draft retention; graph changes do not rewrite admitted messages. The Convax `agent/pre-step` guard prevents deleting or missing bound Chats and their subagent descendants from entering another model step. It does not change enqueue semantics.

References retain normal DSH path semantics and do not freeze future directory-tree bytes or expand writable roots. Renderer deactivation keeps Host resource APIs and delivery recovery available. Native Web, SDK, ACP and headless sends retain their original protocols; Convax does not add prepared-input events or hidden graph-derived context.

### Session coordination and delivery projection

Creating or forking a thread first stores its intent and fixed Session reservation in the same Convax thread ledger. The materializer uses DSH's original Session preparation, persistence, Workspace attachment and `buildForkSeed` APIs. It persists the full seed in one append, records Session completion, then commits the unique graph binding. Recovery retains the Session id and pinned fork prefix after a lost reply; a completed reservation does not recreate deliberately removed Workspace membership. Invalid persisted seed data fails closed under its original pending identity. Session Controller receives no durable-operation API.

After any required confirmation, Convax persists deletion state, affected Sessions and unfinished create/fork intents. It blocks new bindings and model steps, settles late-created Sessions, then uses native Workspace archival, stop events and activity queries to settle each thread and its subagent descendants. It awaits Agents and owned jobs before graph removal, preserving operation records, history and delivery tombstones. Retrying an already archived Session explicitly requests stop again; archive success alone does not establish inactivity. Partial failure remains visible and retryable. See [Workspace archive handling](../../../../packages/workspace/workspace/src/index.ts).

Project each `deliverables/presented` file item using the key `(SessionId, event sequence, file index)`. In one Convax transaction, create its output node and delivery connection and store the receipt. Advance an event-level replay cursor only when all its file items have receipts and preceding events are complete; concurrent processing cannot skip unfinished items. Distinct delivery events remain distinct even when they reference the same path. Removing an output node preserves its receipt as explicitly removed. A delivery for a deleting or deleted target is recorded as suppressed and cannot restore that target. Live observation and restart replay use the same operation; neither reruns a task. Renderer-only deactivation leaves this Host processing active.

### View state, resources, and agent actions

Retain each displayed Session reference explicitly and mount one editable composer per Session binding within a client. Keep drafts in the shared DSH draft owner independently of Chat-card mounting; switching threads, closing tabs, or changing the root renderer does not discard them. Application-level notification and approval observers remain above individual cards. Release view references without requesting Host agent shutdown. See the [Session reference lifecycle](../../../../packages/api/session-controller/README.md) and [reference release](../../../../packages/api/session-controller/src/client/sessions/service.ts).

File nodes preserve the selected absolute resource reference. Missing or moved paths produce a visible unavailable resource with a relink action rather than silent removal or guessed relocation; a relink affects later explicit reference resolution and preserves existing drafts and admitted history. Repeated references can remain separate nodes. Convax browse and preview use existing DSH filesystem services and access policy; connecting a folder does not expand sandbox writable roots.

Agent tools resolve their default canvas from the caller's Session binding. An unbound caller must name a canvas explicitly; cross-canvas actions also name the target. Tools submit the same revisioned commands as the UI, propagate cancellation, and use DSH human interaction for running-thread deletion confirmation. The renderer is not required. Closing a canvas tab preserves work. Following DSH's existing window/quit lifecycle without a separate daemon is the proposed initial default; task behavior after quitting remains a product decision to confirm.

### Implementation order and verification

The three product steps below remain independently demonstrable. Their implementation uses Convax-owned persistence and coordination over existing DSH APIs. New generic DSH runtime APIs are not a prerequisite; remaining UI adaptations have separate review scope.

| Step | Delivery | Dependencies | Observable completion |
|---|---|---|---|
| 1. Persistent file canvas workspace | Host/renderer separation, shared shell proof, SQLite transactions and repository, public node/port registration, file/folder browse/preview, graph editing, and multiple canvas tabs. | Development environment and concrete UI/storage interface design; UI composition and storage can proceed in parallel. | Add references from different projects, arrange and connect nodes, switch tabs, and restore the saved workspace after restart; renderer deactivation restores native DSH. |
| 2. Chat input-to-delivery workflow | Reuse full DSH conversations with multiple threads; add durable create/fork bindings, drafts, notifications, explicit composer references, file delivery projection, and coordinated deletion. | Step 1; explicit reference resolution and delivery projection can proceed in parallel after durable Chat bindings exist. | New folder connections insert one current-draft reference; delivered files become nodes; restart and replay preserve Sessions and outputs; confirmed deletion stops and archives threads. |
| 3. Plugin extensions and integrated acceptance | Provider activation/removal and migrations, recovery copies, agent canvas tools, product composition, and verification across completed features. | Steps 1 and 2; migration work can begin once the repository and registry exist. | Extension nodes recover after provider changes; agents edit canvases without the renderer; the complete Desktop workflow survives specified failures and lifecycle changes. |

All three steps have implementations and focused verification. Real Loader tests cover durable create/fork identities, unique bindings, cross-process recovery, renderer-independent deliveries, confirmed stop-and-archive deletion, provider reload, and repository upgrades with retained recovery copies. Embedded UI tests exercise independent native Conversations, retained drafts, local navigation, and compatible-node placeholders. Real-model tests verify explicit native resource references and file deliveries, and invoke five canvas tools after renderer deactivation; the outer test inspects durable SQLite graph records and unchanged source-file contents instead of relying on model text.

#### Step 1: persistent file canvas workspace

##### Desktop and conversation composition proof

Prepare Node >=24.9 and the workspace dependencies, establish a native DSH Desktop smoke baseline, and select the canvas interaction dependency against embedded-composer, pointer, keyboard, and layout requirements. Use supported DSH profile composition for the proof; bind a Session already opened by the test setup rather than inventing a second conversation or a temporary production Session-creation path. Document concrete shared-shell and card-local navigation interfaces before changing their owners.

Keep Convax card composition separate from native Conversation ownership. Verify distinct Sessions without draft, focus, tool or approval crossover and release the previous editor before mounting another presentation. Check settings, Plugins, account flows, overlays and theme. Existing DSH UI embedding changes require their own minimization review; this proof does not establish durable Chat bindings.

##### Durable Host

Implement Convax's own SQLite owner, graph constraints, operation receipts, recovery copies and committed-change subscriptions. Keep DSH storage declarations, backends and routes unchanged. Explicit monotonic repository versions reject unsupported writers and preserve the medium on failure.

Verify multi-record rollback, durable revision comparison, operation deduplication and argument mismatch, coherent cache publication, unknown commit recovery, restart, and competing Host ownership. Persistent graph editing depends on these guarantees; Session creation, prompt admission, and migration logic do not belong in this first storage change.

##### File workspace

Implement the node envelope and separate Host/client registration from the start, then register file and folder types through those public interfaces. Add application-level browse/preview access, directory-child dragging, geometry and connections, automatic saving, canvas creation/list/reopen, and browser-style tabs with window-local viewport preferences. Preserve unknown node payloads and connections as placeholders from the first durable version.

Verify real files remain unchanged when reference nodes are removed, missing paths remain visible and relinkable, file access follows existing policy, and closing a tab retains the saved graph. Completing this work delivers step 1: a usable persistent file workspace. Durable Chat and input execution follow in step 2.

#### Step 2: Chat input-to-delivery workflow

##### Durable conversations and deletion

Implement the Convax thread ledger, native Session materializer, unique binding recovery, embedded Chat/thread UI and deletion coordinator as separate work packages. Keep durable identities and late-result handling in Convax before exposing create, fork or delete as complete. Reuse native Session controls, draft retention and application-level completion/approval observation.

Verify independent multi-Chat/multi-thread execution, card-local Workspace selection, close-tab behavior, renderer fallback, and reuse of the actual returned Session after restart or a lost reply. Inject failures at creation and deletion phases, including deletion while creation is pending; confirm stopped and archived state externally. Closing a view or disabling Convax must remain distinct from deleting a Chat. Do not substitute a non-idempotent temporary creation path or treat archive success as proof that work stopped.

##### Native composer references

Resolve a newly created UI connection explicitly and insert its source into the originating native draft. Folder-created Chats use that folder path as their project; later connections preserve it. The Convax lifecycle guard uses the existing agent pre-step hook and adds no graph-derived message content.

Verify one-time insertion, thread ownership, reference removal with its edge retained, native send/clear behavior, saved-edge reopening, provider cancellation and changed-source rejection. Neither native DSH nor Convax sends automatically add connected resources. Exercise the unchanged native send path and pre-step rejection without new Session events or SDK projections.

##### Delivered files

Consume DSH's durable delivery facts through one Host projection used for both live observation and catch-up. Commit each file item's output node, delivery connection, and receipt together; advance the continuous event cursor only after all earlier items are complete. Coordinate explicit output removal and deleting/deleted targets through the same repository commands.

Verify multiple files in one event, distinct deliveries of the same path, interruption between file items, live/replay overlap, output removal followed by replay, and delivery during deletion. Disable only the renderer and then the Host in separate scenarios to verify continued processing versus later catch-up. Combined with durable conversations and native draft references, this completes step 2: the Chat input-to-delivered-file workflow.

#### Step 3: plugin extensions and integrated acceptance

##### Provider lifecycle and migration

Implement repository upgrades inside Convax's database owner and keep them distinct from node migration policy. Retain database recovery copies, pure payload transforms, atomic old/new payload records, revision checks and provider cancellation. A test-only provider demonstrates public registration without requiring another shipped product package.

Verify provider unload/reload, missing client renderer with a working Host provider, missing Host provider with retained data, successful upgrade, unsupported migration path, invalid output, cancellation, and restart during upgrade. Do not overwrite the old payload on failure. This work can proceed after the repository and registry exist, without delaying the initial UI proof or requiring an early artificial schema upgrade.

##### Agent tools and integrated acceptance

Wrap the established Host command service in DSH agent tools for canvas queries, file nodes, connections, movement, and arrangement. Reuse real Session targeting, explicit cross-canvas selection, cancellation, conflict results, and deletion confirmation. Finish bundle metadata and profile integration, retaining separate Host/renderer lifecycle control and native fallback.

Run one assembled acceptance path through multiple canvases and Chats, linked folders, a prompt, explicit file delivery, closed/reopened tabs, renderer fallback, Host catch-up, and provider recovery. Verify agent mutations by querying durable graph state rather than trusting tool text. Milestone three covers the full agreed scheme; it does not require new workflow execution semantics or a second Session store.

#### Review, parallel work, and verification

Keep independently useful Convax work separately reviewable. A DSH defect fix requires its own reproduction and tests; a Convax requirement does not automatically justify a shared API change. Review retained UI adaptations separately and validate each ownership change with focused E2E before continuing.

Every step carries affected README/JSDoc and locale updates, focused unit and real-Loader composition tests, and the required keyless user/model-visible snapshots. Record persistence-type acknowledgements and any required upgrade guide with the introducing change. Pure canvas geometry and UI expectations stay owner-local; Session-driven cases use the recorded-session harness. Session lifecycle or event changes update both SDK projections. Concurrency/restart fixtures use isolated temporary databases, deterministic barriers, explicit readiness, and awaited teardown rather than fixed sleeps. Browser automation uses the repository's in-page picker overlay except when testing native pickers.

For implementation completion, run the checks selected for the actual diff and `build:check` after the latest `build:artifacts`, or `build`; do not treat UI smoke success as compiler evidence. Finish with the applicable documentation/package gates and a real-model file-delivery smoke when credentials are available. Report absent credentials as missing evidence. The full test suite is not the default verification for each step.

Real API tests follow the [with-key policy](../../../../docs/testing.md): `vitest.e2e.config.ts` loads `DEEPSEEK_API_KEY` from repository-root `.env`, and suites self-skip without the key. Keep credentials out of docs, fixtures and output. `packages/plugin-host/tests/chat-real-model.e2e.ts` verifies explicit native references, Session prompts, actual file contents and delivery projection through the production Web profile. `packages/plugin-host/tests/graph-real-model.e2e.ts` verifies five model tool calls and durable graph changes with the renderer disabled. Both have credentialed verification; `apps/cli/tests/profiles/headless/tests/real-model.e2e.ts` separately owns the shipped headless path.

Undo/redo, user-facing restoration after an intentional Chat/canvas deletion, and task survival after quitting the application remain explicit product decisions to confirm. Keep these separate from the already-required crash recovery, retained Session history, and stop/archive deletion behavior. Record the suggested defaults without making them prerequisites for steps 1 and 2 or silently adding them to agreed acceptance criteria.

The suggested defaults are undo/redo for ordinary graph edits and recoverable graph/thread entries after deletion, without automatically restarting old tasks. The proposed initial application lifecycle remains DSH's existing behavior without an additional daemon. These suggestions are not confirmed product requirements.

## Alternatives considered

**A fixed global chat beside the canvas.** Chat nodes were selected instead so one canvas can contain multiple independently connected conversations, each with its own threads.

**Project-owned canvas groups.** Application-owned canvases were selected so users can organize files and folders from multiple projects without first choosing one project as the canvas container.

**Independent canvas files as primary storage.** Application-managed storage was selected so users can create and reopen canvases without managing individual save locations. This decision does not define a future export format.

**Stopping work when a canvas tab closes.** Closing a view should preserve ongoing work. Explicit deletion instead stops and archives threads with the agreed confirmation behavior.

**Manual insertion of every delivered file.** Automatic nodes from explicit deliveries were selected so task results appear in the graph without a second user action.

## Acceptance criteria

- The Desktop presents application-level canvas tabs and supports file, folder, and Chat nodes with connections, without product count quotas.
- The Convax Host owns SQLite transactions, revision checks, schema upgrades and recovery copies without extending DSH storage. DSH Session storage remains separate; a single Convax thread ledger coordinates partial graph/Session operations.
- A Chat creates and switches multiple DSH-backed threads using the existing conversation flow and input.
- Each DSH Session has only one Chat binding in Convax; native DSH views preserve that identity, and continuing its history in another Chat creates a distinct forked Session.
- File, folder, Chat, and additional DSH-plugin node types use the same public registration mechanism, with DSH retaining ownership of plugin installation and lifecycle.
- Disabling or uninstalling a node provider preserves node payloads, geometry, and connections as movable/deletable placeholders; the canvas and its other nodes remain usable, and a compatible provider restores the original nodes.
- Node upgrades use independent data versions and plugin-provided migrations. Convax retains a recoverable copy, validates before committing, and preserves incompatible data as a placeholder when migration fails or is unavailable.
- Durable node business state is stored with the node and updated through the Convax API; plugin semantics do not introduce a separate canvas-data writer or duplicate DSH Session storage.
- A new UI connection inserts one native reference into the current thread draft only. Deleting it keeps the edge; clearing the draft or reopening a saved graph does not repopulate it. Sent references are reconstructable from the native Session message.
- Explicit reference resolution failure identifies the resource, preserves the draft and edge, and inserts no stale value. No saved edge blocks or augments a native send; the Chat deletion gate remains enforced.
- Explicit reference resolution failure identifies the resource, preserves the draft and edge, and inserts no stale value. Saved edges never block or augment native sends; deleting or missing bound Chats cannot enter another model step.
- Agent graph tools use the same Host commands as the UI, resolve their default canvas from the Session binding, support explicitly targeted cross-canvas operations, and remain usable without the renderer.
- Folder-created Chats and their new threads use the agreed working-directory defaults without treating later folder inputs as an implicit directory change.
- Explicit file deliveries create connected output nodes, and reconnect or replay does not duplicate them.
- Closing a tab preserves the canvas and running threads; completion and pending approval remain discoverable.
- Disabling only `dsh-convax-plugin-renderer` restores standard DSH while `dsh-convax-plugin-host` continues node persistence, explicit resource resolution, and delivery processing. Renderer reactivation displays the current Host state.
- Disabling the Convax Host preserves canvas data and does not stop or archive native DSH Sessions; their execution and history remain usable independently.
- Host recovery catches up deliveries made during its downtime from durable DSH records, without rerunning tasks, duplicating deliveries, or restoring output nodes the user removed.
- Confirmed deletion stops and archives affected threads, preserves their history and original files, and remains recoverable after partial failure.
- Transaction/cache publication, lost-reply Session creation, writer ownership, provider removal, and shell fallback have focused failure, conflict, restart, and composition verification before implementation is presented as complete.

## Risks

Replacing the root UI without retaining its global hosts can leave existing actions registered but invisible. Copying conversation code would also lose DSH behavior as its plugins evolve. The design therefore depends on explicit composition rather than private component imports.

Graph persistence, Session persistence and filesystem writes do not share a transaction. Convax retains fixed identities and pending operations after partial failure and fails visibly on damaged or unsupported data. Focused Loader and real-model tests cover the owned database, Session recovery and deletion paths; remaining UI adaptations still require separate minimization review.
