---
description: "Add an editable canvas-only note through ordinary DSH plugin installation."
kind: "package-bundle"
---

# Canvas note example

English | [中文](README.zh.md)

## Summary

Add an editable note to a Convax canvas. This ordinary DSH bundle uses optional Host and Client registrations. Without Convax, it loads without adding a canvas interface or creation tool. It does not enable the Convax product bundle.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Copy this package into a workspace, rename its package/type/tool/locale identifiers, and install the absolute directory through Plugin Manager. The plain JavaScript Client factory uses the shipped DSH Creator packaging format and needs no build step.

Use `convax_graph` with `include: ["nodeTypes"]` to discover `local.note`, then `convax_commit` with `node.add`, `dataVersion: 1` and `data: {text: "..."}`. The optional `convax_note_create` convenience tool accepts the target id/revision, stable operation/node ids, text and coordinates. Save applies a revisioned update. Remove deletes the card while preserving unrelated nodes.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The patch inserts one Host row. Its optional Convax scope owns the node provider and creation tool; its Client module optionally registers the matching renderer. Note text remains node-only data. Empty ports are deliberate and do not create implicit input references or start conversations.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Host provider and tool](index.js).
- [Client factory](client.js).
- [Bundle patch](cordis.patch.yml).

<a id="model-experience"></a>
## Model Experience

The creation tool appends an ordinary tool interaction. The note text is graph data and does not become hidden conversation context.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The node is not added to the built-in creation dock. Saved notes remain placeholders while a compatible provider or renderer is absent. This example has no native DSH note view. Before distributing a derived plugin, verify save/conflict feedback, restart, disable/re-enable recovery and translated metadata; replace the example artwork when it no longer describes the feature.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
