# AGENTS.md

Convax is a pnpm workspace orchestrated by Turborepo. Product packages live directly in `packages/`; the retained DeepSeek Harness source is in `libs/dsh/`.

- Read [the DSH architecture](libs/dsh/docs/architecture.md) and [package rules](libs/dsh/packages/AGENTS.md) before changing DSH or its plugins.
- [DSH upgrade notes](libs/DSH_UPGRADE.md) pin the upstream commit and track local integrations. Record new DSH adaptations there.
- Install dependencies only at the repository root with `pnpm install`. The root workspace and lockfile own both Convax and DSH packages.
- Root `build`, `typecheck`, `lint`, and `test` use Turbo. DSH remains the owner of its Typert, Host, Client, and Web build sequence; include the external Convax packages in that sequence.
- Preserve package names and runtime user data. Root `.env` supplies API test credentials; `.convax/` owns local Desktop state. Never commit either.
- Follow [DSH testing policy](libs/dsh/docs/testing.md); run focused Convax tests and relevant browser E2E after behavior changes. Run `pnpm build:check` after the latest `pnpm build:artifacts`.
- Documentation under DSH follows [its documentation rules](libs/dsh/docs/AGENTS.md). Keep Convax README pairs in sync.
- Use the configured Git author and append `Co-authored-by: Codex <codex@openai.com>` when committing.
