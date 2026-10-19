# OpenCode Setup

Portable, public OpenCode workflow and tool configuration for OpenCode V2 (`@opencode/cli@2.0.16`).
It keeps **Plan** as the default, supports manual Plan/Build switching, and defines
the Build, Quick, General, Deep, and Visual role workflow. The repository is the
source of truth: installation creates symlinks rather than a copied configuration.

## Prerequisites

- OpenCode V2 (`@opencode/cli@2.0.16` or a compatible later release).
- Node.js `22` or later and npm.
- OpenAI ChatGPT OAuth through the built-in V2 login flow if using the included `openai/...` model choices. No API
  keys, tokens, account data, or provider credentials are stored here.

## Install

Review the exact managed changes first:

```sh
npm ci
node scripts/install.mjs --install --dry-run
```

Install into `${XDG_CONFIG_HOME:-$HOME/.config}/opencode`:

```sh
node scripts/install.mjs --install --yes
```

The installer manages only `opencode.json`, `AGENTS.md`, `agents`, `commands`,
`plugins`, and `bin`. Previously managed context-mode skill and package symlinks
are removed only when they still point to this repository; real files and unrelated
links are left alone. Existing managed files or directories are
moved to a timestamped backup under `~/.local/state/opencode-setup/backups/` before
symlinks are made. It never replaces other `node_modules` packages, OpenCode
databases/session state, context-mode data, `tui.json`, caches, or
notifier/waiting-task state. The context-mode skill source remains in the repository
for a later opt-in reintroduction but is not installed.

The global config explicitly registers RTK and compaction-reasoning by paths
relative to `opencode.json` (`./plugins/*.ts`). The installed config and plugin
directory symlinks share the same parent, so registration resolves from ordinary
projects as well as from the config directory. V2 also auto-discovers these
files; the plugin registry identifies each by its stable ID.

Quit and restart OpenCode after install or after editing any source in `opencode/`.

## Uninstall Or Restore

The latest installer backup can be restored with:

```sh
node scripts/install.mjs --uninstall --dry-run
node scripts/install.mjs --uninstall --yes
```

Restore changes only targets recorded as created, moved, or retired by that
installation. A no-op reinstall does not create a new backup; an older no-op
manifest leaves existing links in place. Retired repository-owned context-mode
links are recreated on rollback, including dangling package links. Backups are
retained after restore. The installer refuses to replace a target that is not
its current repository symlink. Use `--dry-run` before `--yes`; this protects
later local changes. For disposable testing, pass an absolute target:

```sh
node scripts/install.mjs --install --yes --target /absolute/disposable/opencode
```

## Workflow And Models

`plan` remains the default agent and the global default model is `openai/gpt-6-sol`.
Build and General use Sol at medium reasoning, while the PR reviewer uses Sol at high.
Explore and Quick use `openai/gpt-6-luna` at low reasoning, Visual uses Luna at
medium. Deep remains `openai/gpt-6-astra` at xhigh. The configuration preserves
local RTK and compaction-reasoning plugins, standalone usage reporting, and the
ownership-scoped Chrome cleanup policy.

Sol and Luna declare verified 1,050,000-token context and input limits,
128,000-token output limits, text/image input, text output, and `none`, `low`,
`medium`, `high`, `xhigh`, and `max` reasoning variants. Their medium variant is
the default. The retained GPT-5.6 declarations are fallback choices, not deleted
replacements. After restarting OpenCode, run `opencode models openai`: custom
definitions do not establish OAuth provider access. If direct Sol or Luna are not
listed, keep using the corresponding retained GPT-5.6 fallback until the provider
rollout makes the direct IDs available; do not make model requests merely to test
availability.

The config documents OpenAI OAuth model definitions. Authenticate through V2's
built-in ChatGPT OAuth flow; do not add credentials to this repository. No external
OAuth or context-mode plugin is enabled.

## Optional Integrations And Local Overrides

Figma Desktop is enabled at its standard local endpoint
`http://127.0.0.1:3845/mcp`; start the Figma desktop MCP service before using its
tools. Pencil is intentionally not enabled in the default runtime config because
its executable location is machine-specific. Start with
`examples/mcp.local.json` or `examples/local-override.json`, replace placeholders
locally, and load an untracked override with `OPENCODE_CONFIG=/absolute/path.json`.
`OPENCODE_CONFIG_CONTENT` is suitable for a small temporary final override.

Third-party skills with unclear redistribution terms are deliberately excluded.
Install those integrations or skills separately under their own licenses and terms.

## Update And Validate

Edit this repository, then run:

```sh
npm ci
npm run check
node scripts/install.mjs --install --dry-run
node scripts/install.mjs --install --yes
```

`npm ci` is used in CI. The lockfile is deliberate; `node_modules`, runtime state,
local overrides, and operating-system files are ignored. Never commit credentials,
local ports, generated OpenCode data, or the installer backups.

The Chrome helper defaults to a dry-run. `--force` is only for the Build-owned
post-Visual-QA cleanup flow; it targets Chrome processes owned by the current
OpenCode instance, sends `TERM`, then sends `KILL` only to unchanged owned survivors.
