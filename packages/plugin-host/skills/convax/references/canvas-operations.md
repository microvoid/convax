# Canvas operations

## Understand or build a workspace

Read nodes, connections, and existing groups together when reasoning about projects. Request only relevant fields or a selected subgraph for a large canvas. `projection` states what was included; an omitted collection is not an empty one. Group membership is `node.groupId`, and positions are world coordinates even inside groups.

For an overview, use titles, paths, node types, and relationships to identify projects and shared material. Read file contents only when the user's task needs their meaning. For new provider nodes, request `nodeTypes` to discover the active `typeId`, `dataVersion`, `dataSchema`, and named ports. A missing schema is not permission to invent a payload.

Use `convax_commit` to build or modify one canvas. `canvas.add` creates an explicitly named new canvas identity at revision zero. Ordered operations in one batch can create a group and then assign its members, or create nodes and then connect their ports. A `convax.chat` node is a conversation container; prepare a native thread separately with `convax_chat` when the task requires one.

Keep existing resources at their real paths. A file or folder card refers to the resource; adding a card does not copy its contents. For a requested project setup, verify the created nodes, intended relationships, group membership, and any separately prepared threads.

## Submit edits

- Use the revision returned by the latest relevant read or successful operation as `expectedRevision`.
- Give each new request an `operationId`. Retry an uncertain response with the identical request and identity. After a revision conflict, read again and assign a new identity to the revised request.
- `node.set` changes only the fields supplied. For position or membership edits, omit `data`. Replacing `data` replaces the entire payload and requires `dataVersion`.
- One successful commit is one graph-history unit. Combine related graph edits when they belong to the same user action.

Check `ok` and the returned error before claiming completion. A pending lifecycle operation is still pending; an error is not proof that external Session work was rolled back.

## Group or arrange cards

Respect the requested scope and meaningful existing groups. Use paths, titles, and connections to group related work; keep shared references and cross-project coordination understandable. Preserve content and connections unless the request calls for changing them.

Use supplied card dimensions when available. Otherwise choose explicit conservative spacing and avoid claiming measured collision-free placement. The saved graph does not contain rendered widths, heights, expansion, or camera state. `convax_arrange_nodes`, when available, places ordered nodes on an equal-spacing grid; it does not discover project structure or route connections around cards. A layout result does not establish that the user's viewport now shows it.

Verify the affected positions and groups and check that the original nodes and relationships remain. Generate an image or other preview only when it is part of the requested deliverable.

## Restore a graph edit

Use a separate `convax_commit` containing only `history`, with the original `targetOperationId` and `direction: "undo"` or `"redo"`. The history request needs its own operation identity and current expected revision. Verify the restored records. Graph history preserves source files; it does not undo file edits, replay sent prompts, or restart stopped work.
