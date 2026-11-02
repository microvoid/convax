# Convax

English | [中文](README.zh.md)

An infinite canvas workspace for files, live window mirrors, and multi-threaded AI conversations, powered by [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Arrange your projects and conversations on a canvas, connect the resources a task needs, and work with AI in one workspace. Convax reuses DeepSeek Harness's conversation UI, composer, agent execution, and plugin system.

<a id="features"></a>
## Features

| Feature | What you can do |
|---|---|
| Infinite canvas | Pan, zoom, select multiple cards, snap them into alignment, connect nodes, and undo or redo graph edits. Choose trackpad or mouse navigation. |
| Files and folders | Drag local resources into Desktop, browse folder cards, and expand previews for text, code, Markdown, images, PDF, spreadsheets, audio, and video. |
| AI conversations | Create Chat cards with multiple threads, fork conversations, and use the existing DSH composer, model controls, permissions, and tools. |
| Explicit references | Connect resources to a Chat to add removable references to its input. Sending uses the references in that draft; removing a reference keeps its canvas connection. |
| Window mirrors | Mirror a specific application window on macOS Desktop. Connect it to a Chat to capture a fresh screenshot when you send. |
| Multiple canvases | Switch and reorder browser-style tabs; search, rename, archive, restore, duplicate, or permanently delete saved canvases. |
| Default workspaces | Each canvas gets its own working directory. New Chats use it immediately; Chats created from a folder use that folder instead. |

Window mirrors are read-only. Agent Computer Use is a separate, optional DSH capability that uses PTC mode and its existing application and macOS permissions.

<a id="run"></a>
## Quick start

Convax is a developer preview. Run it from this repository with **Node.js 24.9.0 or newer** and **pnpm 11.28.5**, as declared in [package.json](package.json).

<a id="run-from-source"></a>
### Install and build

Clone this repository, then run these commands from its root:

```sh
pnpm install --frozen-lockfile
pnpm run build
```

<a id="desktop"></a>
### Desktop

Launch the development Desktop application using the built artifacts:

```sh
pnpm --filter @deepseek-ai/dsh-convax-plugin-renderer run desktop
```

Configure your API key in the Desktop welcome screen or settings. Desktop can also inherit `DEEPSEEK_API_KEY` from its launching process.

On a fresh installation, open **Plugins → Add plugin**, install `link:/absolute/path/to/convax/packages/convax/plugin-renderer` using your checkout's actual absolute path, and choose **Enable now**. This activates the Convax Host and canvas renderer. Later launches retain the enabled bundle; the launcher itself only selects the Convax data directories.

To rebuild and launch after source changes:

```sh
pnpm --filter @deepseek-ai/dsh-convax-plugin-renderer run desktop:dev
```

Use Desktop for native file and folder drops and macOS window mirrors. See [Desktop development](apps/desktop/README.md#develop) for platform setup.

<a id="web"></a>
### Web

Create a `.env` file in the repository root for Web conversations and real-API tests:

```dotenv
DEEPSEEK_API_KEY=your-deepseek-api-key
```

Start the Web profile with the Convax overlay:

```sh
pnpm dsh web --patch packages/convax/plugin-renderer/cordis.patch.yml --no-open
```

Open the complete local access URL printed in the terminal; the server defaults to `http://127.0.0.1:3080`. The overlay enables both Convax plugins for this launch. Web runs against the Host filesystem; native window mirrors require macOS Desktop.

<a id="data-and-working-directories"></a>
## Data and working directories

- The Convax Desktop launcher stores its profiles, sessions, and canvas database under the repository's `.convax/` directory, with Electron preferences in `.convax/electron-user-data/`.
- New canvases create a working directory under `~/Documents/convax/canvas-<canvas-id>/` by default. New Chats share their canvas's directory; existing Chats retain their project paths. Renaming a canvas does not move its directory.
- Removing a resource card or deleting a canvas preserves original files. Canvas deletion stops and archives its conversations while retaining Session history.
- `.env` and `.convax/` are ignored by Git. Real-API tests use the API key from the root `.env`; credentials do not belong in source files or test fixtures.

<a id="development-and-documentation"></a>
## Development and documentation

- [Convax packages](packages/convax/README.md): Host persistence and the independently switchable renderer.
- [Canvas UI](packages/convax/plugin-renderer/README.md): interactions, previews, Chat cards, and current limitations.
- [Plugin development](docs/cookbook/convax-plugin-development.md): add custom canvas nodes and tools.
- [Development guide](docs/development.md), [architecture](docs/architecture.md), and [contributing](CONTRIBUTING.md).
- [Agent instructions](AGENTS.md) and [safety notice](SAFETY.md).

Convax is built on DeepSeek Harness and Cordis. Upstream runtime and plugin documentation remains available in this repository.

<a id="license"></a>
## License

[MIT](LICENSE). Third-party dependencies and their licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
