---
name: convax-plugin-development
description: Use when developing, configuring, or debugging a Convax canvas plugin or node; reuse ordinary DSH plugin packaging and installation with optional canvas adaptation.
---

# Develop a Convax plugin

Use the existing `cordis-plugin-development` workflow for package creation and installation. Convax adds node providers and renderers; it does not define another package format, installer, Session runtime, or global input protocol.

## Inspect the current package

Read the installed Convax Host and renderer package READMEs and public `lib/types` declarations. `cordis_inspect_query` can locate each package through its live Config entry and `packageDir`. A static Service directory is not proof that a service is active, and a missing Convax entry is not proof that the plugin cannot run. Confirm the live Loader entry and canvas node slot as needed.

The packaged Host `README.md` and `lib/types/index.d.ts` own current registration semantics. The renderer's `lib/types/client/index.d.ts` owns the Client registration and node props. Avoid imports from another package's private `src` or a complete renderer runtime import just to obtain declarations.

## Choose the contribution

Keep reusable business entities in their owning feature service. A canvas adapter stores an entity id and presentation settings. Small node-only state may remain in node data. Session messages, drafts and execution stay with DSH. Graph edges do not execute tasks or add hidden message context.

Use optional `ctx.inject(['convax'], ...)` for Host node adaptation and independent `ctx.inject(['convaxRenderer'], ...)` for the Client display. A canvas-only feature has no canvas UI without Convax; do not promise a native fallback it does not implement. Installing a business plugin must not implicitly activate the entire Convax product bundle.

## Start from the runnable example

The package root contains `templates/canvas-note/`, at `../../templates/canvas-note/` relative to this skill directory. Read each file with the Host file-read tool and write copies into a normal workspace directory. Packaged Desktop resources may be inside `app.asar`; do not use shell commands or install the template in place. Copy these files:

- `package.json`
- `cordis.patch.yml`
- `index.js`
- `client.js`
- `locale/en.json`
- `locale/zh.json`
- `icon.svg`
- `README.md`
- `README.zh.md`
- `README.i18n.yaml`

This is a canvas-only editable note example. Its explicit `convax_note_create` tool creates a node; registering the node does not add a creation-dock entry. Rename the package, node type, tool, and locale namespace together. Empty ports are deliberate: note text is not an implicit file/folder reference.

Host definitions use stable type ids, `dataVersion`, parsers, optional pure migrations and named ports. Client registration uses the same id and exact payload version. Schema or migration failures retain the saved node and expose an explicit problem. Respect cancellation and effect-owned unregistering.

Publish `description` and a JSON Schema `dataSchema` so `convax_graph` can describe node creation without a provider-specific tool. Use `convax_commit` with `node.add` or `node.set`, retaining the complete request and operation identity for retries. Replacement data replaces the full payload. Each ordered batch uses one canvas revision and one history record; `history` must appear alone. The template's creation tool remains a convenience adapter.

## Install and verify

Write source in the workspace and use `plugin_manager` with `action: install_bundle` and the absolute directory. Do not write profile manifests or install under `$DSH_HOME` directly. Follow the returned application/restart outcome.

Verify the actual card and save action in the target canvas, restart persistence, missing-service behavior, and disable/re-enable recovery. Installation alone does not establish visible canvas behavior. For an AI authoring conversation in Convax, use Creator (`cordis`) from a Chat's mode selector so the authoring Session remains in that Chat.
