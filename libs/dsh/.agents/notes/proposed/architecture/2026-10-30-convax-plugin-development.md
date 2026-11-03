# Agent Note: Convax plugin development and DSH compatibility

Status: proposed

English | [中文](2026-10-30-convax-plugin-development.zh.md)

## Problem

Developers need one contribution path for reusable DSH capabilities and Convax cards. AI authors need the same supported APIs and installation path. Requiring every plugin to load the complete canvas or maintain separate business implementations would make native DSH compatibility fragile.

The [canvas proposal](../feature/2026-10-28-convax-canvas.md) owns the product and graph semantics. This proposal extends its plugin-development decision; it retains DSH's existing [plugin management](../../implemented/architecture/2026-09-14-current-profile-plugin-management.md) and [Client loading](../../implemented/architecture/2026-07-23-client-plugin-loading-model.md) decisions.

## Proposal

Keep DSH as the plugin runtime, installer, dependency resolver and AI authoring workflow. Convax contributes optional canvas APIs and owns product-specific coordination. Existing APIs and ordinary plugin registration are the default; a DSH change needs a separately demonstrated defect or independently justified generic requirement. A name such as `dsh-convax-notes` does not establish compatibility.

Use current public Host and Client registrations first. The Host packages a [development skill](../../../../../../packages/plugin-host/skills/convax-plugin-development/SKILL.md) and [canvas-note template](../../../../../../packages/plugin-host/templates/canvas-note/). They reuse DSH's existing filesystem skill provider and Plugin Manager installation. A declaration-only helper package or portable Notes feature with native UI remains optional follow-up work. The [developer manual](../../../../docs/cookbook/convax-plugin-development.md) owns the authoring procedure.

### Contribution and package topology

Third-party features can live in their own repositories and publish ordinary DSH bundles. Changes to shared Convax APIs and built-in behavior enter this repository through pull requests. Neither contribution path requires publishing through a separate Convax marketplace.

Use one business plugin package by default, with Host logic, reusable Client components, a native DSH entry and an optional canvas adapter. Split packages only for independently maintained capabilities or lifetimes. An existing DSH plugin can add a separate Convax bridge without moving its business data.

| Plugin composition | Native DSH | Convax |
|---|---|---|
| Host tools or business service | Available when its DSH dependencies are composed | Same capability |
| Native panel only | Native entry | Requires an entry supported by the active canvas layout |
| Canvas adapter only | No canvas presentation without Convax | Canvas card |
| Business service with native and canvas adapters | Native entry | Canvas card using the same service |

Host adapters use optional Cordis injection of `convax`; Client adapters independently inject `convaxRenderer`. Registrations follow the contributing scope's lifetime. Portable business plugins do not declare the whole plugin as waiting on either service.

Use type-only imports for Convax declarations. Shared UI primitives may have ordinary runtime imports; importing the entire Convax renderer for a helper is not the portable adapter design. Installing a business feature does not automatically enable the complete Convax product bundle.

### Existing APIs and optional contributions

The current [Host registry](../../../../../../packages/plugin-host/src/registry.ts) accepts a stable type id, payload version, parser, named ports, adjacent pure migrations and optional cancellable resource preparation. The [Client registry](../../../../../../packages/plugin-renderer/src/client/node-renderers.tsx) registers a component for the same id and an exact payload version. Host and Client registrations have independent lifetimes.

Authors can use exported node declarations without private product imports. Extract reusable card or port primitives only when actual consumers need them; documenting existing registration does not require a new Factory or helper package. Native Conversation embedding uses its existing Factory, with Convax owning the surrounding layout.

| Optional future contribution | Responsibility |
|---|---|
| Node creation contribution | Localized title, icon and explicit initializer; integrate with existing creation controls, menus or commands |
| Node toolbar contribution | Register supported actions above the selected card with consistent focus and accessibility |
| Resource intake contribution | Recognize supported dropped resources and choose their node provider |
| Embedded preview adapter | Reuse existing preview providers; add an interface only when an actual consumer cannot use the existing Factory |
| Portable feature example and compatibility tests | Add a native UI and shared business owner beyond the packaged canvas-only note template |

Current node registration does not implement these optional registries. The packaged skill and template do not depend on them. Keep bottom-center project, file and Chat controls and avoid a generic “Add node” primary button. Creation or toolbar metadata must not silently execute a node.

### Data, connections and execution

| Data | Owner |
|---|---|
| Notes, jobs and other reusable business entities | Business plugin, using DSH storage or its own implementation according to its requirements |
| Node id, type, payload version, geometry, edges and Chat coordination | Convax Host and its owned SQLite repository |
| Session messages, execution, drafts and composer references | Existing DSH services; Convax owns only thread membership and recovery records |
| Selection and window presentation preferences | Client presentation owner |
| Credentials | DSH credential services on the Host |

For an existing business entity, save its id and presentation settings in the node. Small node-only state can live in its payload. Mutate graphs through Convax commands with revisions and operation identities, never through another graph writer. The Convax-owned SQLite repository also owns the single thread ledger, Session reservations and deletion intentions; DSH storage and Session Controller need no transaction or durable-operation extension.

Convax development composition supplies repository `.convax` through DSH's existing application-home override; plugins use their persistence owners rather than hardcoding that path. Native DSH and Convax can have separate homes. Package compatibility does not imply shared databases; cross-installation sharing needs an explicit service or import/export operation and exclusive writer ownership.

An edge stores a relationship. A composer reference belongs to its input draft and can be removed without cutting the edge. Retained composer references determine the next message's input. Buttons, messages or explicit tools trigger execution; connecting nodes does not start an automatic workflow.

Current port compatibility requires equal `valueKind` strings, and resource preparation produces validated file or folder references. Other artifacts need an explicit reference protocol before becoming conversation inputs. Native send and queue protocols remain unchanged; Convax uses `agent/pre-step` to reject model steps for deleting Chats and their subagent lineage. Model-visible additions remain reconstructable from the Session log.

### Lifecycle and compatibility

Unloading an adapter unregisters its contributions and cancels and drains owned asynchronous work. It does not delete nodes, business entities or Session history. Missing providers or renderers retain recoverable placeholders; reactivation uses the saved payload and supported migrations.

The npm release version and node payload version have different purposes. Failed node migrations preserve source data; Convax database upgrades retain recovery copies and advance monotonically. Declare actual supported DSH and Convax API versions in metadata and documentation rather than implying that an unpublished helper package enforces compatibility.

Host plugins execute as trusted Host code, and Client contributions are not sandboxed third-party widgets. A separate permission or isolation system would require its own design. This proposal reuses the current DSH trust model.

### AI-generated plugin compatibility

DSH's current [Creator authoring skill](../../../../packages/preset/agent-preset/skills/cordis-plugin-development/SKILL.md) writes ordinary workspace bundle files and installs their absolute directory through `plugin_manager` with `install_bundle`. Installation persists across restart. Convax reuses this path without editing the central Creator skill or API catalog generator.

The [Host registration](../../../../../../packages/plugin-host/src/development.ts) optionally injects `skills` and mounts the original `@deepseek-ai/dsh-skill-filesystem` provider as `convax-development`, with `includeDefaultRoots: false`, an explicit bundled skill directory and `watch: false`. The packaged `skills/convax-plugin-development/SKILL.md` teaches current node registrations and points to `templates/canvas-note/`. Provider registration follows the Host lifetime; default user/project skill discovery remains with its existing provider. Neither the central Creator skill nor the DSH skill protocol is modified.

Discover the active Host and Client APIs before choosing an extension. If Convax is absent, a portable feature can use its native entry; a canvas-only request reports that Convax must be enabled. AI authoring must not implicitly activate the whole canvas when the user only requested a business plugin.

Discover capabilities through current Loader configuration, live slots, optional injection and Convax's README, skill and template. Static catalogs do not establish service activation. Missing central `convaxRenderer` discovery does not justify changing DSH's generator when the plugin can document and inspect its existing registrations.

Canvas Chat forwards native preset selection into thread creation, so authors can explicitly create a `cordis` thread and reuse Creator. The global [Create your plugin entry](../../../../packages/client/ui-agent-preset/src/client/index.ts) retains native navigation. Do not assume this creates a bound Chat or change it solely for Convax; verify the canvas entry through Convax thread commands.

Generated packages should use the same optional service injection, storage ownership, payload versions, localized metadata and effect cleanup as manually authored packages. Keep plugin source in the workspace; use Plugin Manager for profile installation rather than writing profile manifests or application-home files directly.

The packaged `@local/convax-note` template is a canvas-only editable note. Independent optional Host/Client adapters register `local.note`; the explicit `convax_note_create` tool creates a card through revisioned commands. It provides no native note UI or creation-dock entry and does not activate Convax. After installation, verify the card, saving, restart and disable/re-enable behavior; installation alone does not establish visible compatibility. Additional creation or toolbar contributions remain separate design work.

### Delivery sequence

1. Document exported registrations and optional Host/Client injection; validate a minimal canvas template with required services present and absent.
2. Use the packaged Convax-owned skill and canvas-note template through ordinary DSH registration; verify Plugin Manager installation and actual canvas behavior without changing the central Creator or generator.
3. Consider a portable Notes example, shared declarations, creation, toolbar or intake contributions only when actual consumers need them; each addition carries compatibility and recovery tests.

## Alternatives considered

**A separate Convax plugin runtime and AI generator.** This duplicates installation, dependency resolution, trust and lifecycle handling while making AI output specific to one shell. Optional adapters preserve one runtime and authoring path.

**Require every plugin to install the entire Convax bundle.** This makes a reusable business feature change native DSH's workspace and prevents independent canvas deactivation. Business dependencies and product activation remain separate.

**Store a duplicate business record inside each card.** This makes edits through native DSH and Convax diverge and complicates deletion. Entity references retain one business owner; node-only state stays with the node.

**Expose private card components as a public extension API.** This couples plugins to product layout and dynamic imports. Current declarations and optional adapters avoid that dependency; shared primitives can follow demonstrated reuse.

## Acceptance criteria

- A developer can install a reusable business bundle in native DSH and Convax, use the same business owner through either adapter, and retain native behavior with both Convax services absent.
- Host-only and renderer-only deactivation leave the expected remaining capability usable. Re-enabling restores nodes without recreating entities or losing graph relationships.
- Existing node definitions and renderers register through public APIs. Future creation, toolbar or intake contributions need implementation and tests before documentation claims they exist.
- Restart, source migration failure, cancelled asynchronous preparation and plugin replacement preserve committed data and reject stale results.
- The Convax-owned skill guides generation through current APIs, Plugin Manager installation and actual canvas verification. Native-only generation remains functional without modifying DSH's central authoring assets.
- No parallel Session runtime, installer, DSH operation ledger, global input-preparation protocol, implicit edge execution or hidden graph-derived message context is introduced.

## Risks

The APIs are pre-stable. Templates teaching private imports, unavailable registries or assumed UI placement create fragile plugins. Verify exports, actual composition and lifecycle behavior before publishing authoring guidance.

Native DSH and Convax can expose different UI hosts and use different storage homes. Compatibility promises cover supported capabilities and adapters, not automatic UI placement or transparent cross-application data synchronization.
