---
description: "Default node providers for Convax"
kind: "package-reference"
---

# @deepseek-ai/dsh-convax-plugin-inernal-nodes-host

English | [中文](README.zh.md)

## Summary

Use file, folder, Chat, terminal, browser and selected-window nodes on existing canvases. Chat threads retain native DSH Sessions, execution and persistence. Removing this plugin retains saved nodes, connections and Session bindings. Re-enabling compatible providers restores their availability.

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

Versioned definitions provide `convax.file`, `convax.folder`, `convax.chat`, `convax.terminal`, `convax.browser` and `convax.window` nodes. Providers use the same public registration API as other node plugins. The canvas Host owns graph transactions, history, migrations and durable ownership records. This plugin owns node validation and the DSH Session and delivery adapters. DSH continues to own messages, drafts and Agent execution.

The canvas stores no new database for these nodes. Stopping this plugin cancels and drains its adapter work without stopping DSH Agents or deleting their logs. New provider-dependent actions remain unavailable until the provider returns. Confirmed deletion retains its separate stop-and-archive behavior.

`remote.convaxTerminal` addresses a terminal by canvas and card identity. Each card owns one user shell through the shared [terminal controller](../../libs/dsh/packages/api/terminal-controller/README.md), without creating or following a Chat Session. Creation uses the latest committed incoming file or folder connection: folders supply their own directory and files supply their parent directory. Without a resource input it uses the canvas directory. Directory changes configure subsequent starts; running shells keep their own process state. Concurrent creates share the card's first committed runtime identity.

Switching canvases, closing a canvas tab and detaching screen views preserve the shell. Removing a card or its canvas uses the shared terminal close path to terminate its process range and drain final output; cleanup failures remain retryable. Undo restores card configuration without reviving the closed process. Host or provider disposal ends owned processes; reopening their cards offers a fresh start rather than replaying commands. Terminal screens and raw output remain outside Session history.

New Chat threads persist the reserved permission preset, sandbox mode and approval policy before their Agent resumes. Retrying a creation retains those values even when the user changes the defaults. Forks retain their source permission history.

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
