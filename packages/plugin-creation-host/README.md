---
description: "Configure image, video and audio generation for connected Convax Chats, and recover automatically delivered media."
kind: "package-reference"
---

# @deepseek-ai/dsh-convax-plugin-creation-host

English | [中文](README.zh.md)

## Summary

Create images, videos and audio from a Chat connected to a Creation workbench. Choose a Provider and model independently for each media kind on the workbench; connected Chats use those choices. Completed media becomes an ordinary Chat deliverable and an existing file node connected to its source Chat. Generation can incur charges from the selected Provider.

## Table of Contents

- [Use this package](#use-this-package)
- [Configure Providers](#configure-providers)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>

## Use this package

Creation is included in the [Convax composition](../plugin-renderer/cordis.patch.yml). It does not require a separate plugin installation. The [Creation renderer](../plugin-creation-renderer/README.md) supplies the workbench card; Chat and file nodes retain their existing interfaces.

1. Add a Creation workbench to a canvas and open its settings.
2. Choose **Connect services**, select a Provider, and enter its required settings and models once. **Connect and apply** checks the connection and applies its supported capabilities to unconfigured media routes in one operation. Describe size, duration and other generation requirements in Chat.
3. Click **New Chat** on the workbench to create and connect an ordinary Chat, or connect an existing Chat. A Chat uses exactly one connected Creation workbench.
4. Ask the Chat to generate media. Open **Tasks** to review any required quotes and confirm the displayed batch once. The same panel retains generation progress and completed results. Successful outputs are automatically imported and connected to the originating Chat.
5. Use a delivered file or an output asset ID as a reference in a subsequent generation, where the Provider supports that media role.

The workbench shows the service and model for each media kind. Open a row, choose its Provider first, then choose a model from that Provider. An unconnected Provider offers its connection form for that media kind. For example, images can use LibTV while videos use Jimeng. Changing one row preserves the other routes and previously submitted tasks. Chat has no second Provider configuration. Removing an output from the canvas does not ask the Provider to generate it again.

The Host composition accepts two resource limits. Provider connection settings are configured separately in the workbench.

| Field | Default | Meaning |
| --- | --- | --- |
| `maxBytes` | `536870912` | Maximum bytes per imported media file or reference. |
| `pollMs` | `3000` | Delay between observations of a running asynchronous task. |

<a id="configure-providers"></a>

## Configure Providers

Each connection owns its settings and optional credential reference. Enter API keys in the credential field, not in a URL, model ID or route defaults. CLI setup detects an existing executable and login. When the executable is missing, **Install CLI** downloads the supported official release into the Host's private directory. Installation starts only from that button; it does not start a login flow.

Installation progress and retry remain in the connection dialog. Closing the dialog leaves an accepted installation running; reopening reads its current status. Success triggers another readiness check, which can still report that login is required. Installed executables remain available after restarting the Host, without changing the user's shell configuration.

Managed installations use Jimeng `1_0_0_60` and LibTV `1.2.0`, stored below `DSH_HOME/creation/cli`, without automatic upgrades. Existing PATH executables take precedence; explicit executable paths remain authoritative. The installer selects a platform artifact, validates it before promotion and leaves existing installations intact on failure. Unsupported platforms retain the custom-path field and official installation link. Host shutdown stops unfinished downloads; the next attempt can retry.

Setup checks CLI installation and login separately from generation settings. Model discovery returns choices compatible with the adapter; manual model IDs remain available. Connection and workbench changes commit together. Unavailable Providers leave the form editable without publishing a new connection. Existing routes retain their selected connection; editing that connection updates its models without a second route-level model selection.

| Provider | Media | Required setup |
| --- | --- | --- |
| `jimeng-cli` | Image, video and audio generation according to the selected model catalog | Authorize the CLI and select at least one of `imageModel`, `videoModel` or `audioModel`. The Host manages `projectId` automatically. Optional nonnegative integer `creditCeiling`, `executable`, absolute `cwd`, and `profile`. |
| `libtv-cli` | Image, video, audio according to the selected model schema | `projectUuid`, boolean `watermark`, and at least one model field. Optional `executable`, absolute `cwd`, and a LibTV token credential. Existing CLI login also works. |
| `openai` | GPT Image generation/editing and speech synthesis | API key and `imageModel` and/or `audioModel`. Optional `baseUrl`, default `https://api.openai.com/v1`. |
| `volcengine-ark` | Video generation | API key and `videoModel` (model ID or Endpoint ID). Optional `baseUrl`, default `https://ark.cn-beijing.volces.com/api/v3`. |

Jimeng's default executable is `dreamina-canvas`. The authorization button opens its official consent page; the Host waits for the device authorization exchange and loads model display names after success. Closing settings stops observation, not the authorization. Expired or rejected requests can be restarted explicitly. **Connect and apply** creates the Provider canvas internally after validating the selected models, using a stable identity across retries. Existing connections retain their canvas; users do not select or name it.

Jimeng saves each generation draft and requests its actual credit quote before running it. Without an explicit credit ceiling, **Tasks** shows the pending prompts and total maximum cost. **Confirm batch and generate** approves only the quotes displayed at that click; new or higher quotes require another confirmation. A configured ceiling permits automatic execution only within that limit. Approval resumes the same saved node and submission identity. Restart and retry never grant consent.

Jimeng model choices are independent: configure only the media kinds you need. `creation_describe` reports the selected model's current modes, parameter limits and reference requirements. Supported modes include image `t2i`/`i2i`, video `t2v`/`first_last_frame`/`m2v`, and audio `tts`/`music`, where the catalog permits them. First/last-frame video uses `reference` images in first-frame then last-frame order. Text-reading speech requires one catalog voice, supplied as `voice-id` or `voice-name`; the adapter discovers voices for the selected model. Other speech scenarios follow their catalog reference requirements. Voice, duration and other generation choices belong in Chat, not in a second model configuration.

LibTV's default executable is `libtv`. Use a working directory without an active LibTV group binding. `watermark` asserts the download's community-watermark status: `true` for a nonmember account and `false` for a member account. The CLI checks membership; the adapter does not bypass this check. This adapter imports one output per generation and rejects models that require a batch.

OpenAI speech requires `voice`; optional `response_format` is `mp3`, `opus`, `aac`, `flac` or `wav`. GPT Image accepts `reference` images for edits and exposes `n`, `size`, `quality`, `background` and `output_format`. Its outputs are saved locally before automatic delivery. OpenAI video is not advertised because the official Videos API is retired.

Ark creates an asynchronous video task. It accepts `first-frame` and `last-frame` image references; a last frame requires a first frame. Parameters use the documented API names, including `duration`, `ratio` and `resolution`. The selected model remains authoritative for its supported combinations. Local video/audio references are not exposed by this adapter.

<a id="understand-the-implementation"></a>

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The workbench stores routes, while Host-owned connection records hold Provider settings and credential references. A native DSH tool invocation supplies the real Session, turn and call identity. The Host captures that invocation's origin and connection revision before submitting background work. Provider implementations receive a cancellation signal, a private per-job directory, byte limits and an awaited durable-checkpoint callback.

External plugins implement `CreationProvider` from [types.ts](src/types.ts) and register an instance with `ctx.convaxCreation.registerProvider`. The owning plugin must await the returned unregister function during disposal. `describe` advertises actual capabilities and schemas; `submit` starts one generation; `reconcile` reads the original task; `collect` writes the supplied staging path. `cancel` must report what the Provider actually supports. Credentials and temporary download URLs must not enter checkpoints or canvas data.

Jimeng checkpoints explicit node and submit IDs before generation. LibTV creates a fresh node, checkpoints its key, and runs that node once. Ark checkpoints the returned task ID. OpenAI saves synchronous response bytes and a local receipt; recovery reads that receipt. If a submission response is lost before a usable recovery identity or receipt is saved, the task remains uncertain. Recovery never silently submits a replacement generation.

Jimeng collects all three media kinds through the same official `resource get` and `resource download` path. It verifies the resource identity, media kind and completion state before download, then checks the returned resource ID, destination path, byte count and SHA-256 against the actual file. Media inspection verifies the container and media kind before import. A failed transfer or verification remains recoverable through the existing task; it does not submit a replacement generation.

The Host verifies collected media, publishes it through DSH's existing deliverable path, and lets Convax's existing delivery projection create the file node and Chat connection. Publication and projection retries reuse durable identities. Cancellation suppresses future automatic delivery; already delivered files remain.

| Source | Responsibility |
| --- | --- |
| [service.ts](src/service.ts) | Workbench routes, scoped invocation context, connections and reference preparation. |
| [runner.ts](src/runner.ts) | Durable task recovery, collection and delivery. |
| [providers](src/providers/index.ts) | Built-in Provider construction and external API/CLI adapters. |
| [adapter tests](tests/providers/adapters.spec.ts) | Local HTTP and real subprocess fixtures, including uncertain-submission recovery. |

The [live collection smoke](tests/jimeng-download.e2e.ts) exercises the production Jimeng collection adapter using existing resources that you own or are authorized to access. From the repository root:

```sh
pnpm exec vitest run --config libs/dsh/vitest.e2e.config.ts packages/plugin-creation-host/tests/jimeng-download.e2e.ts
```

Without resource settings, all three cases skip; a skipped run is not evidence of successful live collection. To enable a case, set `CONVAX_JIMENG_EXECUTABLE` to an absolute installed CLI path, `CONVAX_JIMENG_PROJECT_ID` to your canvas UUID, and the matching `CONVAX_JIMENG_IMAGE_RESOURCE_ID`, `CONVAX_JIMENG_VIDEO_RESOURCE_ID` or `CONVAX_JIMENG_AUDIO_RESOURCE_ID` to an existing successful resource. Use the same authorized profile and working directory through optional `CONVAX_JIMENG_PROFILE` and `CONVAX_JIMENG_CWD`; their defaults are `default` and the current directory. `CONVAX_JIMENG_MAX_BYTES` defaults to 512 MiB. The test does not log in or generate media. It checks the resource type, file container, size and SHA-256, prints only nonsecret media facts, and removes its temporary download.

</details>

<a id="further-exploration"></a>

## Further Exploration

- [Convax Host](../plugin-host/README.md) — existing Chat bindings, graph transactions and delivery projection.
- [DSH architecture](../../libs/dsh/docs/architecture.md) — Host composition and plugin lifetimes.
- [Official Jimeng CLI skill](https://jimeng.jianying.com/canvas-cli/install/1_0_0_60/skill.tar.gz) and [LibTV CLI skill](https://liblibai-web-static.liblib.cloud/cli/1.2.0/libtv-cli-skill.zip) — verified command and schema references.
- [OpenAI Images](https://developers.openai.com/api/reference/resources/images/methods/generate) and [Speech](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create) — model API contracts.
- [Ark video generation](https://docs.volcengine.com/docs/ark/video-generation-tutorial) and [cancel/delete semantics](https://docs.volcengine.com/docs/ark/cancel-or-delete-video-generation-tasks-api) — task lifecycle and remote cancellation constraints.

<a id="model-experience"></a>

## Model Experience

### Connected Chat context

#### What the model sees

A Chat bound to one Creation workbench receives its workbench context; a Chat with existing jobs retains task context after disconnection. The context identifies configured media routes and recent jobs, including available asset IDs and paths. [service.ts](src/service.ts) owns the dynamic fields and their caps.

##### Generation instruction

```markdown
Creation uses the connected workbench. Generated files are delivered automatically; do not present them again.
```

#### Token effect

The context adds a stable instruction and bounded, changing workbench/job data to model requests for connected Chats.

#### KV Cache effect

Changing routes or recent job state replaces context tokens and can invalidate the request prefix from that point. Chats without a workbench or existing jobs receive no Creation context.

### Creation tools

#### What the model sees

The [tool schemas](../../libs/dsh/docs/tool-catalog.md#deepseek-aidsh-convax-plugin-creation-host) expose capability discovery and generation while the Chat has one Creation workbench. Task status, recovery and cancellation remain available to Chats owning existing jobs. The Host derives the source Chat from the actual invocation; the model does not supply canvas or account identities.

#### Token effect

Eligible requests include tool schemas. Tool results add task state, output identifiers and recovery information to the conversation.

#### KV Cache effect

Connecting or disconnecting a workbench changes the available tool set and can invalidate reuse of the tool-schema prefix. Results grow the conversation after each tool call.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Provider availability, account entitlements and model support are checked through their APIs or CLIs. Local fixture tests cover adapter behavior; live authenticated generation is not exercised by those tests.
- Built-in adapters do not cancel remote generation. Ark's DELETE also deletes completed task records, so it cannot safely implement conditional cancellation. A cancelled Convax task may still incur Provider charges.
- OpenAI cannot recover bytes lost before its local receipt is saved. LibTV's interrupted `--run` may leave remote results unwritten. Both cases preserve uncertainty instead of charging for an automatic replacement.
- Jimeng's CLI controls its download byte limit; the adapter checks the Host's `maxBytes` after transfer, before import. The Host limit is not a CLI download flag.
- LibTV imports single-output nodes. Ark exposes first/last-frame image inputs only. Model schemas can reject parameters that the endpoint-level schema permits.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
