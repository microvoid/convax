---
kind: upgrade-guide
description: "Convax owns its SQLite repository and thread operations instead of routing them through DSH storage."
---

# Move Convax data to its own repository

English | [中文](guide.zh.md)

## Change

Convax stores graphs and thread Session reservations in `$DSH_HOME/storages/convax-canvas.sqlite`. DSH storage and Session Controller no longer provide Convax transaction or durable-operation extensions.

The product bundle supplies `databasePath` and `legacyDatabasePath`. Migration reads and retains `$DSH_HOME/storages/convax.sqlite`, preserving canvases, bindings, receipts, pending operations and node-upgrade copies. DSH retains Session history. Active predecessor writers, incompatible formats and conflicting Session identities reject migration.

SQLite schema 10 accepts versions 1–9 with a pre-upgrade backup; older Hosts refuse the upgraded database. See [group rollback](../convax-canvas-groups/guide.md). New canvases allocate local directories under `canvasDirectoryRoot` (default `~/Documents/convax`) before graph publication; existing canvases allocate on first use. Saved directory assignments and existing Chat working directories survive upgrades and root configuration changes. Deleting a canvas retains its files. Canvas archive metadata is durable and separate from Session archival. Permanently deleting a canvas removes its graph undo history while retaining Session logs and source files.

## Migration

1. Stop the old Desktop and Host before changing builds. Back up the application home, including Session persistence, with the application stopped or a consistent database backup. Retain the predecessor database and upgrade backups until the migrated state has been verified.
2. Use the updated Convax product bundle. In a source checkout, use the [Convax Desktop launcher](../../../../../../packages/plugin-renderer/README.md) to select `.convax` explicitly; DSH's native Desktop command retains its original development directory. For a manually mounted Host, set an absolute `databasePath` for `convax-canvas.sqlite` and an absolute `legacyDatabasePath` for the predecessor. The paths must identify different files. Set `canvasDirectoryRoot` to an absolute local parent when the default Documents location is unsuitable; the composed filesystem must also permit access. This setting affects only canvases without saved directory assignments. See the [Host configuration](../../../../../../packages/plugin-host/README.md).
3. Remove hand-written `storage-domain` routes for `convax` and `session_operations`, and remove the old Convax-only SQLite provider row. Preserve unrelated storage routes and providers still used by other features. The updated product patch needs neither a DSH transactional domain nor the removed Session Controller methods.
4. Start the updated application. Migration preserves fixed Session identities and fork positions before publication. Reopening never reimports an older graph. Graph undo/redo covers only operations recorded by the new Host; Session bindings and archive state remain intact. Unmatched predecessor operation identities remain in the source and produce a warning.
5. Check existing canvas titles, node connections, Chat threads and their history. Retry unfinished operations through Convax and confirm that the original thread identities remain. A failed or damaged Session stays pending with a diagnostic; it is not replaced by another Session.
6. If startup reports an active writer, close the other Host; do not delete lock files to bypass it. For incompatible or invalid data, keep both databases and repair or restore a consistent backup before retrying. Rollback requires the corresponding application/data snapshot; an older build does not merge edits from the new repository back into the predecessor.
