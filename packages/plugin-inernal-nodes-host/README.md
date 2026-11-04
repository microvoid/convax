---
description: "Default node providers for Convax"
kind: "package-reference"
---

# @deepseek-ai/dsh-convax-plugin-inernal-nodes-host

English | [中文](README.zh.md)

## Summary

Use file, folder, Chat and selected-window nodes on existing canvases. Chat threads retain native DSH Sessions, execution and persistence. Removing this plugin retains saved nodes, connections and Session bindings. Re-enabling compatible providers restores their availability.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The [Convax product composition](../plugin-renderer/cordis.patch.yml) mounts this provider separately from the canvas Host and node renderer. To compose it manually, mount the following row beside an existing Convax Host. It does not activate the canvas interface.

```yaml
- id: convax-inernal-nodes-host
  name: '@deepseek-ai/dsh-convax-plugin-inernal-nodes-host'
```

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Registration and lifetime</summary>

Four versioned definitions retain the existing `convax.file`, `convax.folder`, `convax.chat` and `convax.window` identities and payloads. Providers use the same public registration API as other node plugins. The canvas Host owns graph transactions, history, migrations and durable ownership records. This plugin owns node validation and the DSH Session and delivery adapters. DSH continues to own messages, drafts and Agent execution.

The canvas stores no new database for these nodes. Stopping this plugin cancels and drains its adapter work without stopping DSH Agents or deleting their logs. New provider-dependent actions remain unavailable until the provider returns. Confirmed deletion retains its separate stop-and-archive behavior.

</details>

<a id="model-experience"></a>
## Model Experience

### Nodes and messages

#### What the model sees

Node descriptions and payload schemas are available through `convax_graph`. Graph edges do not add hidden message context. Native messages contain only the references retained in their composers.

#### Token effect

Requested node metadata and explicit references contribute tokens through existing tools and messages. Registering a provider does not add per-send graph text.

#### KV Cache effect

Graph edits and provider restarts do not rewrite admitted messages. DSH retains the request prefix and persisted Session history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Native window capture requires the node renderer and supported Desktop permissions. Stopping node providers does not grant, revoke or change Computer Use authorization or preset defaults.

<a id="dev-note"></a>
### Dev Note

None.
