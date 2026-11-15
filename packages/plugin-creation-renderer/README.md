---
description: "Configure media generation on a Convax Creation workbench and connect it to native Chats."
kind: "package-reference"
---

# @deepseek-ai/dsh-convax-plugin-creation-renderer

English | [中文](README.zh.md)

## Summary

Choose a Provider and model independently for images, videos and audio on a Creation workbench. Connect it to ordinary Chat cards and request media through conversation. Completed files appear on the canvas through the existing resource displays. Provider availability and credentials are managed by the paired Host.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The [Convax product composition](../plugin-renderer/cordis.patch.yml) enables this display and its paired Host. No separate installation is required in that composition. To compose it manually, mount this row beside the Creation Host and canvas renderer:

```yaml
- id: convax-creation-renderer
  name: '@deepseek-ai/dsh-convax-plugin-creation-renderer'
```

This plugin has no package-level configuration. Create a workbench, choose **Connect services**, and select a service. Enter its required settings and select each model once. **Connect and apply** saves the connection and applies its supported capabilities to unconfigured workbench routes, then closes the dialog. Existing routes retain their selected services.

CLI setup checks installation and existing login automatically. A missing CLI offers an install button, progress and retry in the same dialog; successful installation checks readiness again. Closing the dialog keeps an accepted installation running in the Host. API services accept a key or an environment-variable reference; model discovery retrieves compatible choices. Advanced settings contain executable paths, working directories and API addresses. A failed connection retains the form for correction. **Manage** edits connection details and the workbench name. Each media row owns its Provider and model choice.

For Jimeng, authorize from the same dialog and select at least one image, video or audio model. Models use their catalog display names. **Connect and apply** manages the Provider canvas internally; no canvas selection or name is required. The workbench shows three independent media rows with their service and model. Each selector lists Providers first and that Provider’s models in a submenu. Choose **Connect {provider}** for a service that is not connected; its form selects only the current media kind, and **Connect and apply** updates that row. Images can use LibTV while videos use Jimeng. Switching one row leaves the other rows and submitted tasks unchanged.

Click **New Chat** on the workbench to create a connected ordinary Chat. The output-port gesture and connections to existing Chats also remain available. Chat inherits the workbench's creation capabilities without another configuration. Ask it to create media. Completed files appear through the existing deliverable and canvas resource presentation, connected to the originating Chat.

Open **Tasks** independently of **Manage** to see pending quotes, generation progress and recent completed results. **Confirm batch and generate** approves the displayed quotes once, with their total maximum credits. Later or increased quotes require another confirmation. A failed item remains visible without hiding the other results. The optional automatic credit ceiling remains under advanced connection settings.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Configuration ownership and verification</summary>

The window-owned [controller](src/client/workbenches.ts) manages drafts, Remote calls and graph revisions. The registered Slot factory renders its observable state. API keys are transient form inputs; the Host stores credentials and returns only whether one is configured. Closing settings or saving a connection clears the input.

Capability connections are distinct from attachment connections. The graph Host validates source declarations and prevents duplicate providers for a capability on one Chat, including during history replay. The renderer derives connection purpose from the source port and offers compatible creation actions.

From the repository root, run the focused configuration and connection tests:

```sh
pnpm exec vitest run --config libs/dsh/vitest.config.ts packages/plugin-creation-renderer/tests/workbenches.spec.ts packages/plugin-renderer/tests/connection-creation.client.spec.tsx
```

The [browser scenarios](../../libs/dsh/apps/web/tests/convax-creation.e2e.ts) retain real settings, native Chat submission and file publication. A fixture Provider covers basic setup; built-in Jimeng and LibTV adapters run against controlled external CLI boundaries for hierarchical model selection, mixed Providers, batch approval and image, video and audio delivery.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Creation Host](../plugin-creation-host/README.md): Providers, credentials and generation lifecycle.
- [Canvas renderer](../plugin-renderer/README.md): graph gestures and extension contracts.
- [Default node displays](../plugin-inernal-nodes-renderer/README.md): native Chats and media previews.

<a id="model-experience"></a>
## Model Experience

### Workbench configuration

#### What the model sees

This Client plugin adds no prompts or tools. The paired Host exposes `creation_describe` and generation tools to eligible Sessions. Saving settings or connecting cards does not itself send a message.

#### Token effect

Workbench configuration and card layout add no model input. The Host owns creation tool schemas and results; native Chat owns submitted conversation content.

#### KV Cache effect

Client layout and configuration editing do not rewrite Session history. The Host owns any change to the available creation tools or generation results.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Settings select connections and models. Generation parameters are supplied through Chat; route defaults are available through the Host API. CLI installation and account authorization use the [Host's supported Provider setup](../plugin-creation-host/README.md#configure-providers). A configured Provider must support the selected media kind and model.

<a id="dev-note"></a>
### Dev Note

None.
