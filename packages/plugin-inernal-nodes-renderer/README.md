---
description: "Default node displays for Convax"
kind: "package-reference"
---

# @deepseek-ai/dsh-convax-plugin-inernal-nodes-renderer

English | [中文](README.zh.md)

## Summary

Preview files and folders, work in native DSH conversations with multiple threads, and connect selected application-window mirrors to Chats. The canvas remains available when these displays are disabled. Saved cards become placeholders with their positions and connections intact.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The [Convax product composition](../plugin-renderer/cordis.patch.yml) mounts this display plugin independently of the [node Host](../plugin-inernal-nodes-host/README.md). To compose it manually, mount the following row beside the canvas renderer and node Host. Installing this plugin does not activate the complete product bundle.

```yaml
- id: convax-inernal-nodes-renderer
  name: '@deepseek-ai/dsh-convax-plugin-inernal-nodes-renderer'
```

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Registration and lifetime</summary>

Node displays, creation actions, file previews, media playback, window captures and Chat-to-DSH composition belong to this plugin. It contributes through the public canvas renderer registry, using the same presentation and creation APIs as third-party nodes. The canvas kernel retains generic graph gestures, persistence commands and missing-plugin placeholders.

Disabling the plugin releases preview readers, media players and live window capture. Native DSH drafts and running tasks remain owned by DSH. Re-enabling restores node displays. Windows require explicit selection when no live binding remains. The plugin preserves composer reference ownership, send-time screenshots and native mode selection, without changing Computer Use mounting rules.

</details>

<a id="model-experience"></a>
## Model Experience

### Nodes and messages

#### What the model sees

The model receives native DSH user messages. Retained file and folder references remain native references. Retained window references add fresh immutable `PNG` screenshots when submitted. Previewing or connecting a card does not itself send a message.

#### Token effect

Window images and retained reference text increase the submitted input size. Card geometry, creation controls and previews add no model input.

#### KV Cache effect

Admitted messages and screenshots retain their native history and retry identity. Changing card layout or unloading a display does not rewrite the request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Window mirroring remains read-only and requires macOS Desktop capture permission. Capture selection and Computer Use authorization remain separate. Browser and operating-system codec support limits audio and video playback. Unsupported sources retain the system-open action.

<a id="dev-note"></a>
### Dev Note

None.
