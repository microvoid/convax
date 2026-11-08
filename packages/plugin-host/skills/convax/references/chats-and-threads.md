# Chats and threads

A Chat is a canvas container; each thread is a native DSH Session with its own history and draft. New threads use the Chat's directory unless the creation request explicitly selects another supported directory. Canvas relationships do not change existing Session directories, presets, permissions, or history.

## Prepare the target

Read `convax_graph` with `include: ["chats"]` to discover Chat containers, thread Session identities, directories, and lifecycle issues. Request nodes too when their locations or provider data matter. Existing node selection also limits returned Chats. Use native Session-query tools for conversation contents when those tools are available and the task needs them.

Create a new Chat card with `convax_commit` only when the user needs another container or project location. Read the active `convax.chat` provider schema for its required data. Then use `convax_chat` to prepare an actual native thread; a node creation receipt alone is not a thread creation receipt.

## Use `convax_chat`

The actions prepare conversations without sending a prompt or starting their work:

- `create-thread`: create an independent Session in the target Chat. Optional `cwd` and `agentPreset` select the new thread's supported directory and preset.
- `fork-thread`: create a thread from `sourceSessionId`, optionally at `atSeq`; the native fork retains the selected source prefix and its Session rules.
- `open-session`: place an existing `sessionId` on a canvas. Supply the retained `nodeId` and `position` for a possible new Chat location; the receipt identifies the actual location when that Session is already bound.

All actions require `expectedRevision`. Omit `canvasId` to use the calling Chat's canvas. `create-thread` and `fork-thread` require `operationId` and can omit `nodeId` for that same Chat; name the target Chat explicitly when preparing a different one. Retain the complete request for retries, including the original revision. If the request must change after a conflict, read current state and use a new operation identity.

`open-session` requires its retained placement `nodeId` and does not take `operationId`; repeat the same placement request to recover an uncertain response. Its result has `operationId: null`, and an already-bound Session returns its actual canvas and Chat location.

Verify `ok`, `sessionId`, the returned canvas and node identities, and the resulting binding. A pending result is not a confirmed prepared thread. Native Session lifecycle and authorization remain authoritative.

## Separate preparation from execution

For “prepare an independent conversation for each project,” report the prepared locations and threads after verification. For “ask each conversation to investigate its project,” use an available native message or task capability only when the user has requested that execution. If no such capability is available, report the prepared threads and the remaining send step. Do not claim that creating a thread or connecting a resource started its task.

Reuse native Session, task, subagent, and scheduling tools for execution and progress when available. Preserve the user's choice of independent threads versus delegated agents; a canvas relationship is not a workflow engine.
