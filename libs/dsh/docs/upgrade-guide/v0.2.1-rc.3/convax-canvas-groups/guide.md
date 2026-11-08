---
kind: upgrade-guide
description: "Convax group metadata and membership require SQLite schema 9, which older Hosts cannot open."
---

# Upgrade Convax group storage

English | [中文](guide.zh.md)

## Change

Convax upgrades its owned repository from schema 8 to 9 to retain group identities, titles, node membership and their reversible history. Existing nodes keep world coordinates. Missing `groups` and `groupId` fields remain valid ungrouped data; no node provider migration is required.

This affects the configured `databasePath`, normally `$DSH_HOME/storages/convax-canvas.sqlite`. The Host also accepts schemas 1–7 through its existing upgrade path. Before changing a file-backed database, it writes a consistent recovery copy to `<databasePath>.upgrades/upgrade-*/database.sqlite`. The schema upgrade commits atomically. Older Hosts reject schema 9; changing the stored version number does not make the new graph and history readable by an older build.

## Migration

1. Stop other Convax Desktop and Host processes before upgrading. Keep a consistent backup of the application home and DSH Session history. Use the same `databasePath` with the updated product bundle; first startup upgrades the owned repository automatically.
2. Check existing canvas titles, card positions, connections and Chat threads. Create a group from two cards, move it, undo the move and reopen the canvas. Confirm the group name and membership remain and the original files and conversations are intact. Retain the pre-upgrade backup until verification is complete.
3. To downgrade, stop all Convax processes and restore the complete pre-upgrade application/data snapshot, including the matching database backup. Keep the newer database separately if its edits need recovery. Do not merge SQLite files or lower the schema number. Edits made after the backup are absent from the restored snapshot; older builds cannot replay new group history. See [repository recovery](../convax-owned-storage/guide.md) for predecessor imports and pending Session operations.
