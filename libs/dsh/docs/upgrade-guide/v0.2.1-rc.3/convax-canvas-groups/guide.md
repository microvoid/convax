---
kind: upgrade-guide
description: "Convax groups and palette colors require SQLite schema 10, which older Hosts cannot open."
---

# Upgrade Convax group storage

English | [中文](guide.zh.md)

## Change

Convax upgrades its owned repository to schema 10 to retain group identities, titles, palette colors, node membership and their reversible history. Schema-nine groups keep their existing metadata and membership; an absent `color` uses default gray. Existing nodes keep world coordinates. Missing `groups` and `groupId` fields remain valid ungrouped data; no node provider migration is required.

This affects the configured `databasePath`, normally `$DSH_HOME/storages/convax-canvas.sqlite`. The Host accepts schemas 1–9 through its existing upgrade path. Before changing a file-backed database, it writes a consistent recovery copy to `<databasePath>.upgrades/upgrade-*/database.sqlite`. The schema upgrade commits atomically. Older Hosts reject schema 10; changing the stored version number does not make the new graph and history readable by an older build.

The canvas clipboard writes version 3 with group colors. Updated clients still read versions 1 and 2; groups from version 2 use default gray. Older clients cannot read newly copied version-3 selections.

## Migration

1. Stop other Convax Desktop and Host processes before upgrading. Keep a consistent backup of the application home and DSH Session history. Use the same `databasePath` with the updated product bundle; first startup upgrades the owned repository automatically.
2. Check existing canvas titles, card positions, connections and Chat threads. Create a group from two cards, change its color, move it, undo the move and reopen the canvas. Confirm the group name, color and membership remain and the original files and conversations are intact. Retain the pre-upgrade backup until verification is complete.
3. To downgrade, stop all Convax processes and restore the complete pre-upgrade application/data snapshot, including the matching database backup. Keep the newer database separately if its edits need recovery. Do not merge SQLite files or lower the schema number. Edits made after the backup are absent from the restored snapshot; older builds cannot replay new group or color history. See [repository recovery](../convax-owned-storage/guide.md) for predecessor imports and pending Session operations.
