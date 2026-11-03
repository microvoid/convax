# Cookbook: Add a Convax adapter to a DSH plugin

English | [中文](convax-plugin-development.zh.md)

## Summary

Add a canvas representation to an existing DSH capability through Convax's Host node registry, Client renderer registry and revisioned graph commands. This page maps the available Convax APIs, then follows a runnable counter example from registration to creation, saving and unload recovery. Ordinary DSH plugin packaging and authoring remain documented by DSH.

## Table of Contents

- [Prerequisites](#choose-the-contribution)
- [Reference: available Convax capabilities](#convax-capabilities)
- [Tutorial: run and adapt the counter example](#counter-example)
- [Reference: compatibility and current limits](#compatibility-limits)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="choose-the-contribution"></a>
## Prerequisites

Start with a DSH plugin or familiarity with the [DSH plugin tutorial](../user/develop/basic/index.md), [Client module packaging](../../packages/client/modules/README.md) and [bundle installation](../user/develop/basic/publish.md). Those references own ordinary plugin authoring, package/build setup and installation mechanics. Convax uses the same plugin runtime and bundle format; this guide covers only the adapter and canvas capabilities added to that base.

For an existing business plugin, retain its service and native entry. Add optional Host `ctx.inject(['convax'], scope => ...)` and Client `ctx.inject(['convaxRenderer'], scope => ...)` scopes for its canvas adapter. A canvas node can reference the existing business entity instead of duplicating it. A canvas-only plugin need not invent a native feature; the counter example below deliberately stores its small state only in the node.

<a id="convax-capabilities"></a>
## Reference: available Convax capabilities

These APIs exist in this checkout. The table identifies the entry to use and its important limit; the linked package and source own complete declarations.

| Capability | Current entry | Adapter use and limit |
|---|---|---|
| Node definition | Host `ctx.convax.registerNodeType` and [provider definitions](../../../../packages/plugin-host/src/registry.ts) | Supply a stable type ID, payload version, parser, optional migrations and named ports; registration does not create a node. |
| Node display | Client `ctx.convaxRenderer.registerNodeRenderer` and [node owner props](../../../../packages/plugin-renderer/src/client/props.ts) | Render the matching type and exact data version; supplied callbacks mutate the owning graph. The component supplies its own card UI. |
| Graph UI composition | The Client `convax.graph` Factory declared in [owner props](../../../../packages/plugin-renderer/src/client/props.ts) | Reuse graph rendering within DSH's UI composition with its declared props and stores; this is not a standalone embedding SDK. |
| Canvas state and mutations | `workspace`, `watch`, `execute` in the [Host API](../../../../packages/plugin-host/src/index.ts), with [command types](../../../../packages/plugin-host/src/types.ts) | Read saved canvases and submit revisioned node/connection edits, including atomic `add-subgraph`; no direct database writes. |
| Named connections | Provider `ports` and Host connection validation | Output and input `valueKind` must match exactly. An edge records a relationship; it does not run downstream work. |
| Files, folders and previews | Host `describe`, directory/content reads and watches, `readDocument`, `mediaSource` | Reuse composed filesystem access and resource previews; absolute paths are checked and reading does not create a Session. See [resource behavior](../../../../packages/plugin-host/README.md). |
| Composer references | Host `prepareReference` and provider `prepareInput` | Resolve an explicit source into a validated file/folder resource. Resolution does not send a prompt; input insertion and retention belong to the existing composer. |
| Chat and threads | Built-in `convax.chat`, Host `createThread` and [Chat coordinator](../../../../packages/plugin-host/src/chats.ts) | Create/fork durable DSH Session bindings; the existing conversation and composer render them. A graph-only Chat node is not a created Session. |
| Persistence and upgrades | Convax's [repository](../../../../packages/plugin-host/src/repository.ts) and [migration coordinator](../../../../packages/plugin-host/src/migrations.ts) | Persist graph envelopes independently of renderer lifetime; pure adjacent node upgrades preserve original data on failure. |
| Agent graph operations | The five [graph tools](../../../../packages/plugin-host/src/tools.ts) registered by the Host | Query canvases, add existing files, connect, move and arrange nodes without an open view. Custom node creation still needs its own action or tool. |

<a id="connect-data-and-user-actions"></a>
### Graph and input semantics

Graph requests carry `canvasId`, `expectedRevision` and `operationId`. An identical retry uses the same operation identity; a rejected revision requires reading current state before submitting a revised intent. Keep an unknown outcome distinct from a confirmed rejection. A graph transaction does not include arbitrary business-service or filesystem writes; [Host command semantics](../../../../packages/plugin-host/README.md#use-this-package) describe the receipts and atomic operations.

For reusable entities, store an entity ID and presentation fields in the node, and save the entity through its business service. Small node-only values can use `update-node`. DSH owns Session messages, drafts and reference submission. Removing a composer reference leaves the edge intact; graph connections must not supply hidden model context or expand writable project roots.

<a id="counter-example"></a>
## Tutorial: run and adapt the counter example

The example lives at [examples/counter](../../../../packages/plugin-renderer/examples/counter/README.md). It is a standalone local DSH bundle nested inside the renderer package, not another workspace package. Its plain ESM Host and browser artifacts need no transpilation. It adds one custom counter node and an explicit creation panel using existing public APIs; it does not add a generic creation-dock extension.

<a id="install-the-development-bundle"></a>
### 1. Load the example in an enabled Convax profile

Use a running Web or Desktop profile with Convax already enabled. In **Plugins**, add the absolute directory of `packages/plugin-renderer/examples/counter` as a local package. Apply any reported restart requirement before exercising the card. Loading this example does not install or enable Convax itself; the [example README](../../../../packages/plugin-renderer/examples/counter/README.md) owns its complete setup and verification instructions.

In the top-right **Counter example** panel, press **Refresh**, select **Target canvas**, then **Add counter**. A new empty canvas is convenient; open the selected canvas and use **Fit canvas** if the card is outside the current view. The panel chooses an explicit canvas ID; it does not guess a target from global UI focus or call an unimplemented creation registry.

<a id="organize-the-package"></a>
### 2. Locate the adapter files

| Example file | Convax responsibility |
|---|---|
| [package.json](../../../../packages/plugin-renderer/examples/counter/package.json) | Ordinary bundle and Client entry declarations; no separate Convax package format. |
| [cordis.patch.yml](../../../../packages/plugin-renderer/examples/counter/cordis.patch.yml) | Activate this example's own plugin row. |
| [index.js](../../../../packages/plugin-renderer/examples/counter/index.js) | Optional Host node provider and current counter payload validation. |
| [client.js](../../../../packages/plugin-renderer/examples/counter/client.js) | Optional versioned card renderer, creation panel, graph reads and command submissions. |

Read these files together with the example README. To adapt an existing DSH plugin, keep its original business entry and attach the relevant optional registrations rather than replacing the application workspace or duplicating the feature's service.

<a id="register-the-host-node-type"></a>
### 3. Register the Host definition

The example's Host entry waits for `convax` and registers `example.convax.counter` with `scope.effect(() => scope.convax.registerNodeType(definition))`. The definition accepts a safe-integer `value` at data version one. It declares no ports because counter state is not a filesystem resource or an implicit conversation reference.

Publish `description` and JSON Schema `dataSchema` with the parser so `convax_graph` can describe your node to an Agent. Create it through `convax_commit` with `node.add`, using the discovered type, data version and payload schema; update through `node.set`. A dedicated creation tool is optional. The [graph-tool reference](../subsystems/convax-graph-tools.md) defines replacement, transaction and retry behavior.

Replace the example's type ID and parser together when defining another node. Add stable named ports only for a meaningful supported connection, and add adjacent pure migrations when changing saved payloads. The registration's asynchronous disposer cancels and drains provider work; unloading it preserves saved node records and relationships.

<a id="register-the-optional-canvas-display"></a>
### 4. Register and save through the Client adapter

The browser entry waits for `convaxRenderer` and the existing `remote.convax` contribution, then registers the same type ID and `dataVersion`. The card reads its value from `props.node.data`; its **−** and **+** actions submit `update-node` through the supplied `command` callback. The canvas owns the revisioned save, so the card does not write SQLite or retain an independent authoritative copy of the counter value.

The example's creation panel reads `remote.convax.workspace` and submits `add-node` through `remote.convax.execute` for the chosen canvas revision. This is the example's own visible action, not functionality implied by renderer registration. Port rendering, card actions and additional injected state must follow their actual APIs; the example avoids a runtime import of the complete renderer merely to obtain helpers.

<a id="verify-and-contribute"></a>
### 5. Observe persistence and adapter removal

Create a counter, change its value, refresh the graph and reopen the canvas. Confirm the saved value returns. Disable and re-enable the example without deleting its nodes: the missing-provider/display placeholder should return to the original counter card. Restart persistence is a separate observation; perform it through the supported application path when it is part of the example verification.

Run the automated checks in the example README’s [verification steps](../../../../packages/plugin-renderer/examples/counter/README.md#verify-the-example), then use the supported application to verify the visible entry, saving and recovery.

<a id="compatibility-limits"></a>
## Reference: compatibility and current limits

The counter is a canvas-only adapter example. With Convax services absent, its optional registrations do not run; it provides no native counter UI. For a plugin that already has useful native DSH behavior, preserve that behavior and make only its canvas adapter optional. Installing the same package in two applications does not make their storage homes or business databases shared.

Convax owns its configured graph database, independently of DSH's storage routes. The current product composition uses `storages/convax-canvas.sqlite`; the Convax Desktop wrapper supplies its development home. Feature plugins use their owning service for business persistence rather than hardcoding `.convax` or writing that graph database. See [Host storage behavior](../../../../packages/plugin-host/README.md) and [Convax development launch](../../../../packages/plugin-renderer/README.md).

Generic third-party creation-dock items, card-toolbar actions and resource-intake contributions remain proposed extensions. The current node registration APIs do not add those entries. The Client `NodePorts` helper is a runtime renderer export, not a standalone public UI SDK. Use explicit supported primitives or a deliberately added shared API rather than private component imports.

Host and Client availability are independent. Missing providers/renderers and incompatible data retain recoverable placeholders; new business-data operations need a compatible provider. Client metadata does not replace Cordis service injection. The static Host Service catalog is not proof of an active service, and the current Client Service discovery catalog omits `convaxRenderer`; its actual declarations remain available in the package.

<a id="debug-by-owning-source"></a>
### When the example does not appear or save

Check the creation action and target canvas first, then the active Host type, matching renderer/data version and command outcome. The example's **Retry creation** retains the uncertain request identity; **Refresh** checks whether its node was already committed. A confirmed revision conflict calls for a fresh snapshot; a failed payload upgrade calls for a repaired migration and supported retry, preserving source data. Do not erase nodes, invent a new operation identity for uncertain work, or bypass the registry by writing directly into the `convax.node` slot.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Counter example](../../../../packages/plugin-renderer/examples/counter/README.md) — runnable adapter and example-specific instructions.
- [Convax Host](../../../../packages/plugin-host/README.md) and [renderer](../../../../packages/plugin-renderer/README.md) — complete current behavior.
- [Convax integration architecture](../developer/convax-plugin-contributing.md) — architecture and integration sequence.
- [Convax development skill](../../../../packages/plugin-host/skills/convax-plugin-development/SKILL.md) and [note template](../../../../packages/plugin-host/templates/canvas-note/README.md) — integration resources for the existing DSH Creator workflow.
- [Extension proposal](../../.agents/notes/proposed/architecture/2026-10-30-convax-plugin-development.md) — proposed capabilities beyond the current APIs.

<a id="dev-note"></a>
## Dev Note

None.
