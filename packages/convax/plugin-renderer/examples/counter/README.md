---
description: "Run a small DSH bundle that registers a Convax counter, creates cards and saves node data through graph commands."
kind: "package-bundle"
---

# Example: Connect a counter to Convax

English | [中文](README.zh.md)

## Summary

Install this local bundle into an application with Convax already enabled. It adds a counter node and a small creation panel. Create a card, change its value, reopen the canvas and restore the plugin without losing the saved node. The example uses the same APIs available to another DSH plugin, needs no model or API key, and has no build step.

## Table of Contents

- [Run from zero to one](#run-from-zero-to-one)
- [Understand the implementation](#understand-the-implementation)
- [Verify the example](#verify-the-example)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="run-from-zero-to-one"></a>
## Run from zero to one

Start with a running Convax Web or Desktop application. The [product README](../../README.md#use-this-package) owns enabling and launching Convax; this example does not enable it implicitly. DSH plugin packaging and installation conventions are described by the [DSH authoring reference](../../../../preset/agent-preset/skills/cordis-plugin-development/references/host-plugin.md).

1. Open **Plugins** and add this package's absolute directory, ending in `packages/convax/plugin-renderer/examples/counter`. A local `link:/absolute/path/to/counter` source is also accepted. No install or compile command is needed inside this directory: the Host ESM entry and browser factory are provided files.
2. Check the installation/application result. Enable the bundle if necessary and complete a restart if the manager reports one.
3. Open an empty canvas. In the upper-right **Counter example** panel, select **Refresh** to update the list, then choose that **Target canvas**.
4. Select **Add counter**. A card containing `0` appears on the selected canvas. Use **Fit canvas** if the current viewport does not show its position.
5. Select **+** or **−**. The card sends `update-node` and adopts the committed snapshot; it does not save to component state or a second database.
6. Restart the application and reopen that canvas. The saved value and node position remain.
7. Disable and re-enable this example bundle through **Plugins**, following any reported restart requirement. Saved nodes remain recoverable while the provider/display is unavailable, then return with the same value.

The example panel selects its target explicitly because node renderer registration does not add a generic creation-dock contribution. When there is no canvas, create one with the existing Convax controls and refresh the panel.

If creation returns a conflict, refresh before creating a new request. If a transport failure leaves the result unknown, **Retry creation** reuses the exact request and operation identity. **Refresh** can reconcile a node that was committed before the reply was lost. The panel retains an unresolved request rather than silently creating another counter.

<a id="understand-the-implementation"></a>
## Understand the implementation

These files show the Convax adapter added to an ordinary DSH bundle. Read them in order; no private renderer import or additional plugin runtime is required.

| File | Convax integration |
|---|---|
| [package.json](package.json), [cordis.patch.yml](cordis.patch.yml) | Ordinary DSH activation and browser module discovery. |
| [index.js](index.js) | Optional `convax` injection; effect-owned registration of `example.convax.counter`. |
| [client.js](client.js) — node registration | Optional `convaxRenderer` injection; a component for payload version 1. |
| [client.js](client.js) — creation panel | Existing DSH `shell.overlay` entry and Convax `workspace`/`execute` Remote calls. |
| [client.js](client.js) — counter actions | The supplied node `command` callback updates the complete `{ value }` payload. |
| [locale/](locale), [icon.svg](icon.svg) | Plugin inventory metadata and artwork; UI text belongs to the Client locale dictionary. |

The Host parser accepts a safe integer and returns `{ value }`. This small counter belongs entirely to its node, so Convax owns its persistence. A reusable business entity would instead keep its own service and store only its entity identity in the node. The counter has no ports and does not pretend to produce a file/folder reference.

The creation panel passes the selected canvas id, current revision and a unique operation identity to `execute`. Card updates use the `command` callback supplied by Convax, which adds the envelope. Host and Client registrations use independent Cordis lifetimes; the Client aborts write calls and drains tracked requests when its scope is released.

<a id="verify-the-example"></a>
## Verify the example

The repository owns automated checks for the actual example files. These commands run from the repository root without a model key:

```sh
pnpm exec vitest run packages/convax/plugin-host/tests/counter-example-loader.spec.ts packages/convax/plugin-renderer/tests/counter-example.host.spec.ts packages/convax/plugin-renderer/tests/counter-example.client.spec.tsx
```

The Loader check runs a real isolated profile, saves `0 → 1`, rejects fractional data without writes, removes/restores the provider and reopens the Host against the persisted graph. Client checks load the provided browser factory and exercise its card and creation actions. The run steps above additionally check the installed application's actual entry and presentation.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Convax integration guide](../../../../../docs/cookbook/convax-plugin-development.md) — capabilities and the complete adapter walkthrough.
- [Convax Host](../../../plugin-host/README.md) — commands, resources, migration and failure behavior.
- [DSH plugin authoring](../../../../preset/agent-preset/skills/cordis-plugin-development/SKILL.md) — ordinary bundle conventions.

<a id="model-experience"></a>
## Model Experience

No tools, prompts or conversation input are added by this example. Existing Convax graph-query tools can include its saved nodes and type metadata when explicitly called; clicking the counter starts no model turn.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

This is a canvas-only example. Without the Convax services, it contributes no card or creation panel. It demonstrates registration, explicit creation and persisted payload updates; use the owning Convax APIs for resource references, Chat integration or version migrations.

The native creation dock has no generic third-party registration API. The sample's panel is its own DSH UI contribution and does not modify the product dock. Card frame, interaction and labels are provided by the example; node registration alone does not supply all built-in card controls.

<a id="dev-note"></a>
### Dev Note

None.
