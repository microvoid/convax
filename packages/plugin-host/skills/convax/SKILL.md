---
name: convax
description: Use when working with Convax canvases, cards, connections, resources, Chat threads, or results delivered to the canvas. Covers understanding and building project workspaces as well as arranging them. For developing a Convax plugin, use convax-plugin-development.
---

# Work in Convax

Use the Convax tools to inspect and operate the user's workspace. Ordinary coding, research, and document work in a Chat can use its existing tools without changing the canvas. Operating a canvas does not require searching the application's source or editing its database or profile.

## Choose the relevant workflow

Read only the guidance needed for the request:

- [Canvas operations](references/canvas-operations.md): understand projects, create cards, edit connections, group or arrange nodes, and restore a graph edit.
- [Resources and deliveries](references/resources-and-deliveries.md): use files and other referenced material, then return requested results to the canvas.
- [Chats and threads](references/chats-and-threads.md): discover conversations, prepare independent threads, fork a conversation, or place an existing Session on a canvas.

For a new node type or plugin, load `convax-plugin-development` when available.

## Use the current scope

A bound Chat Session has a default canvas and Chat identity. Omitting `canvasId` from Convax tools targets that binding, independently of which canvas tab is visible. An unbound Session must discover and name a target before reading or editing its graph. Use an explicit target when the user requests another canvas.

Read the collections required for the task with `convax_graph`; its default response is a summary. Saved nodes contain paths and provider data, not file contents. The graph does not reveal the current selection, viewport, or measured card sizes. Resolve an ambiguous spatial reference from information actually supplied by the user or client.

## Execute and verify

Prefer `convax_graph` and `convax_commit` for graph operations, and `convax_chat` for native thread preparation. Inspect the available tool schema before using capabilities absent from these instructions. Keep DSH's existing filesystem, Session, execution, and delivery tools for their own work.

Submit only changes needed for the requested outcome. Use the observed revision and keep a successful operation's identity for recovery. Verify the affected state through the owning tool or actual resource. Once the requested work is verified, report the result and finish; a separate preview artifact or an application-code investigation is a separate task.

Canvas connections express relationships. They do not add hidden message context, change a Chat's directory or permissions, or send work to another conversation.
