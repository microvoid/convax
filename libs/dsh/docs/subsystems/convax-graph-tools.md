# Convax graph tools

English | [中文](convax-graph-tools.zh.md)

## Summary

Use `convax_graph` to discover saved graphs, Chat threads and provider schemas, `convax_commit` to submit ordered graph edits, and `convax_chat` to prepare native conversations. These tools belong to the Convax Host and remain available without its renderer. Session messages and source files remain owned by DSH and the filesystem.

## Contents

- [Read](#read)
- [Commit](#commit)
- [Chat threads](#chat-threads)
- [History and recovery](#history)
- [Provider and layout integration](#providers)

<a id="read"></a>
## Read

Omitting `canvasId` resolves the calling Session’s Chat binding. An unbound Session can list canvases and inspect providers; node, connection, group or Chat reads require an explicit target. Results describe saved state, independently of open tabs, camera position or selection.

The default response contains canvas summaries and the target identity, title and revision. `include` selects `canvases`, `nodes`, `connections`, `groups`, `chats`, `nodeTypes` and `issues`. Omitted collections are absent, not empty. The `projection` fields declare inclusion and completeness.

`selection.nodeIds`, `selection.typeIds` and `selection.groupIds` intersect. Group filters select member nodes; requested `groups` contain identities, titles and optional palette colors for groups represented in the resulting selection. Node `groupId` fields expose membership, and all positions are world coordinates. Connections must have both endpoints in that node selection. `selection.connectionIds` further filters edges and their endpoint nodes; `selection.incidentTo` selects touching edges, their endpoints and the named nodes. `fields.nodes` and `fields.connections` select record fields; `id` always remains. File data contains paths, not contents.

Requested `chats` contain Chat identities, directories, thread Session identities and lifecycle issues for the final selected nodes. They do not load conversation messages. `projection.completeChats` is true only for an unfiltered Chat collection from an existing target canvas.

```json
{"include":["nodes","connections","nodeTypes"],"selection":{"incidentTo":["note"]},"fields":{"nodes":["typeId","data","revision"]}}
```

<a id="commit"></a>
## Commit

A request contains `canvasId` (optional for a bound Session), `expectedRevision`, `operationId`, nonempty `ops`, and optional `confirmed`. One commit targets one canvas. Canvas creation requires an explicit new identity and revision zero. Existing canvas versions use whole-canvas compare-and-swap; `node.set.ifRevision` adds a staged-node condition and does not enable concurrent writes that bypass the canvas guard.

| Operation | Required fields and effect |
|---|---|
| `canvas.add` | `title`; first operation, new target only. |
| `canvas.set` | `title`; replaces the title. |
| `canvas.remove` | Removes the target graph and retains reversible history. |
| `node.add` | `id`, `typeId`, `dataVersion`, `data`, `position`; any active provider. Optional `groupId` assigns an existing group. |
| `node.set` | `id`, at least `data`, `position` or `groupId`; replacement data requires `dataVersion`. Optional `ifRevision`; `groupId: null` removes membership. |
| `node.remove` | `id`; also removes incident edges, preserving source files. |
| `group.add` | `id`, `title`, optional palette `color`; adds logical group metadata. Assign members in the same batch; empty groups are removed at commit. |
| `group.set` | `id`, at least `title` or `color`; changes only supplied fields. `color: null` restores default gray. |
| `group.remove` | `id`; ungroups members without removing nodes or connections. |
| `group.move` | `id`, `delta: { x, y }`; translates members in world coordinates. |
| `edge.add` | `id`, `source`, `sourcePort`, `target`, `targetPort`, `purpose` (`input` or `delivery`). |
| `edge.remove` | `id`; removes one existing connection. |
| `history` | `targetOperationId`, `direction` (`undo` or `redo`); must appear alone. |

Group colors are `blue`, `green`, `yellow`, `orange`, `purple` or `pink`; omission means default gray. Updating several groups with `group.set` in one batch creates one undo unit.

Operations execute sequentially against a detached graph; later operations see earlier additions and revisions. `node.set.data` replaces the complete provider payload, not a merge. One `node.set` advances its node once even when changing data, position and membership. Provider parsers, payload versions, endpoint ports and value kinds remain enforced.

Graph validation failures publish nothing and consume no retry identity. A success commits the graph, one receipt and one history entry atomically, advancing the canvas once. Replies contain `ok`, `canvasId`, `operationId`, `revision` and nullable `error`; errors contain stable `code`, `message` and a zero-based `opIndex` when an individual operation failed. They do not return the whole graph.

Retry with the same operation identity and identical complete arguments, including the original expected revision. A durable receipt prevents repeating edits even after restart or source removal. A different request under that identity is rejected. Refresh after conflicts, then allocate a new identity for the revised request. Removed canvas replies retain a revision fence for explicit history requests and lost-reply retries.

<a id="chat-threads"></a>
## Chat threads

`convax_chat` reuses the native Session coordinators. `create-thread` creates an independent thread in an existing Chat; optional `cwd` and `agentPreset` select its directory and preset. `fork-thread` uses `sourceSessionId` and optional `atSeq`, inheriting its source directory, preset and event prefix. `open-session` places an existing `sessionId` on a canvas with a retained new `nodeId` and `position`; an already-bound Session returns its actual location, including on another canvas.

Every action requires `expectedRevision`. Omitting `canvasId` uses the calling Chat's canvas. For creation and forks, omitting `nodeId` uses that same Chat, and `operationId` is required. Keep the identical complete request for an uncertain retry. Placement takes no `operationId`; repeat its retained placement request. Replies contain the action, canvas and node identities, nullable Session and operation identities, resulting revision and nullable error; a successful placement reports the actual Chat location.

Creating a Chat node does not prepare a thread. These actions never send prompts, start an Agent, select a visible thread or insert composer references. An accepted native operation can finish after cancellation; inspect current Chat state or retry the same request before allocating another identity. Pending results retain recoverable work and are not confirmed thread creation.

<a id="history"></a>
## History and recovery

One batch is one undo unit. Normal graph history restores recorded fields while preserving unrelated edits. Batch canvas creation and removal additionally retain canvas lifecycle snapshots. History transitions have their own retry identities and advance revisions; they cannot share a batch with edits. Legacy lifecycle commands keep their existing semantics, including irreversible `purge`.

Chat removal validates the complete batch before external work, then uses existing confirmation, stop/archive and recovery coordination. Graph edits remain unpublished until coordination settles. Session writes cannot participate in the graph’s SQLite transaction: `operation-pending` retains recoverable intentions rather than claiming external rollback. Retry the same request or use `retryOperations`. Restoring a Chat retains its original Session bindings and does not restart stopped work.

Agent-created edges never send prompts, insert composer references or create threads. The renderer’s explicit connection gesture owns reference insertion. Graph history does not replay that gesture.

<a id="providers"></a>
## Provider and layout integration

Providers publish `description` and JSON Schema `dataSchema` alongside `id`, `dataVersion` and `ports`. `convax_graph` exposes missing legacy metadata as `null`; absence does not mean arbitrary payloads are accepted. The executable provider parser remains authoritative. Builtins and bundled examples publish schemas, so creating a plugin node needs no dedicated add tool.

The Host exports `layoutGrid(nodes, options)` as a pure calculation with caller-supplied widths and heights. It uses the widest node in each column and tallest node in each row; gaps are empty space between cells. Callers submit its resulting positions through `node.set`. No tool claims to measure rendered card dimensions. The legacy arrange adapter preserves its coordinate-pitch semantics by laying out zero-size points.

The five legacy graph tools remain compatible adapters. New integrations use these two tools or the Host-only `commit(CanvasCommitRequest)` method; old durable requests are not rewritten. See [plugin development](../cookbook/convax-plugin-development.md) for registration and installation.

## Dev Note

Real-model E2E reads the root `.env` API key. It exercises the production profile with the renderer disabled, verifies the SQLite graph independently and preserves source-file bytes. Recorded-session scenarios cover both the generic commit and legacy adapters without requiring a key during replay.
