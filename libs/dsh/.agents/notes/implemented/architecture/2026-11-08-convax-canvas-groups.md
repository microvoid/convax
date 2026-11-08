# Agent Note: Logical Convax groups with world coordinates

Status: implemented

English | [中文](2026-11-08-convax-canvas-groups.zh.md)

## Problem

Canvas users need to name, move and copy related cards together without changing the cards' own interaction or execution ownership. Chat and resource dimensions are window preferences, so a saved group rectangle cannot accurately describe the same group in every window.

## Decision

The Convax Host stores group identities and titles in `CanvasDocument.groups`. Optional `CanvasNode.groupId` is the sole membership source; each node belongs to at most one group. Node positions remain world coordinates. Groups have no provider payload, ports, Session binding or execution lifecycle.

The renderer derives each frame from current measured member bounds, including transient drag positions. Its canvas-owned grouping controller submits semantic Host commands. Moving a group expands membership into a unique node set, so a mixed selection never moves a member twice. Creating, ungrouping and reassigning nodes preserve their world positions. Dragging across a frame does not implicitly reassign membership.

Membership, titles and positions commit with one revision, durable receipt and field-level history. Ungrouping preserves content; deleting a group with its members uses existing Chat confirmation and stop/archive coordination. Complete-group copies allocate a new group identity and retain its title; partial copies lose membership. Canvas copies also remap groups without copying Session history.

The [Host declarations](../../../../../../packages/plugin-host/src/types.ts), [repository](../../../../../../packages/plugin-host/src/repository.ts) and [grouping controller](../../../../../../packages/plugin-renderer/src/client/canvas-grouping.ts) own these contracts. The [broader canvas proposal](../../proposed/feature/2026-10-28-convax-canvas.md) retains independent product and integration decisions; this record owns only grouping.

## Alternatives considered

**Parent-relative node coordinates.** A structural parent node would require coordinate conversion throughout Host commands, tools, copies and history. It also cannot derive a durable container size from window-owned Chat and preview dimensions. Keeping world coordinates preserves existing provider and layout semantics.

**Persisted frame geometry or renderer-only membership.** Saved frames drift when another window uses different card dimensions. Local-only membership prevents the Host, agents and history from observing the same groups. Durable logical membership plus derived frames keeps each fact with its owner.

**Automatic nesting, drag admission and group scaling.** These add membership and resize behavior beyond explicit grouping. Scaling Chat, Browser and Terminal cards also changes their content layout. The implementation keeps one-level membership and independent card sizing.

## Consequences

Group organization survives restarts and renderer deactivation, while each window displays a frame matching its own card sizes. Existing node providers retain their geometry and lifecycle. A frame is not a saved fixed-size container; nested groups, folding, automatic drag admission and whole-group resizing are unavailable.

The repository uses schema nine and backs up earlier databases before upgrading. Older Hosts reject the upgraded store; the [upgrade guide](../../../../docs/upgrade-guide/v0.2.1-rc.3/convax-canvas-groups/guide.md) owns recovery steps.

## Verification

[Repository tests](../../../../../../packages/plugin-host/tests/repository.spec.ts) exercise atomic membership and history; [database tests](../../../../../../packages/plugin-host/tests/database.spec.ts) preserve predecessor graphs and upgrade backups. [Grouping tests](../../../../../../packages/plugin-renderer/tests/canvas-grouping.client.spec.ts) cover measured frames and unique movement, and [clipboard tests](../../../../../../packages/plugin-renderer/tests/canvas-clipboard.client.spec.ts) cover complete and partial group copies. The [browser scenario](../../../../apps/web/tests/convax-canvas-interactions.e2e.ts) verifies the assembled canvas interactions.
