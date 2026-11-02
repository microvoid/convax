---
description: "Package map for the Convax canvas Host, file-reference persistence, and independently switchable Desktop renderer."
kind: "package-group"
---

# convax/ — application canvases

English | [中文](README.zh.md)

## Summary

Organize local files, folders and DSH conversations across saved canvases and browser-style tabs. The Host persists graphs and recovers thread operations independently of the renderer; disabling the canvas interface returns to native DSH. Chat nodes reuse native conversation flow and input. Convax owns SQLite transactions, migrations and deletion coordination while using existing DSH Session APIs. Provider definitions, payload upgrades and agent graph tools share the Host's commands. The [Convax design](../../.agents/notes/proposed/feature/2026-10-28-convax-canvas.md) records ownership and recovery decisions.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

These packages share the [Convax subsystem](../../docs/subsystems/convax.md) and keep Host and renderer lifetimes independent.

| Package | Responsibility |
|---|---|
| [plugin-host](plugin-host/README.md) | Owned SQLite graphs, one thread recovery ledger, deletion coordination, explicit references, delivery recovery and typed Remote commands. |
| [plugin-renderer](plugin-renderer/README.md) | Full-window canvases, embedded native conversations, and installable product composition. |

<a id="related-documentation"></a>
## Related documentation

- [Convax integration guide](../../docs/cookbook/convax-plugin-development.md) and [counter example](plugin-renderer/examples/counter/README.md) — register nodes, render cards and save state for an existing DSH plugin.
- [Packaged development skill](plugin-host/skills/convax-plugin-development/SKILL.md) and [canvas-note template](plugin-host/templates/canvas-note/) — author a canvas-only node through existing DSH registration and installation.
- [Plugin architecture proposal](../../.agents/notes/proposed/architecture/2026-10-30-convax-plugin-development.md) — minimal DSH changes, optional adapters and Convax-owned authoring guidance.
- [Slots](../../docs/subsystems/slots.md) — application composition.
- [Storage](../../docs/subsystems/storage.md) — DSH persistence services for reusable business plugins; Convax graphs use their own database.
- [Desktop development](../../apps/desktop/README.md#develop) — local data directories and launch commands.

<a id="dev-note"></a>
## Dev Note

None.
