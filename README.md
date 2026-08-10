# mimin

A minimal Bun coding agent with one manager and isolated implementation sidekicks. It uses `@mariozechner/pi-ai` for model discovery, provider authentication, tool calling, and streaming, and `@mariozechner/pi-tui` for the interactive terminal UI.

## Setup

Requirements: Bun and credentials for a pi-ai-supported provider.

```sh
bun install
mkdir -p ~/.mimin
cp config.example.json ~/.mimin/config.json
export ANTHROPIC_API_KEY='...'
bun run start
```

Edit the copied config to select installed pi-ai provider/model IDs for both roles. The example contains no credential and is not an active project config. Common API-key variables include `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, and `OPENROUTER_API_KEY`. pi-ai also honors provider-native ambient credentials where supported, such as AWS credentials/profiles for Bedrock and Google Application Default Credentials. mimin stores keys only in `auth.json` (via `/provider`) when you opt in; environment variables take precedence.

### Command Code (custom provider)

[Command Code](https://commandcode.ai) exposes an OpenAI-compatible API, and mimin resolves its models at runtime instead of requiring pi-ai's built-in registry. Configure it by setting the provider id `commandcode` for either role. The API key is read from `COMMANDCODE_API_KEY` (or `~/.mimin/data/auth.json` if set via `/provider commandcode`) — never store the key in config.

```sh
# discover your model IDs (the /models endpoint is public and unauthenticated)
curl https://api.commandcode.ai/provider/v1/models

export COMMANDCODE_API_KEY='...'
```

```json
{
  "manager": { "provider": "commandcode", "model": "gpt-5.5", "thinking": "medium" },
  "sidekick": { "provider": "commandcode", "model": "deepseek/deepseek-v4-flash", "thinking": "low" }
}
```

Model IDs are accepted exactly as configured; pick any non-Claude ID returned by `/models` (e.g. `gpt-5.5`, `gpt-5.4`, `deepseek/deepseek-v4-pro`, `Qwen/Qwen3.8-Max`). Use the same provider for both roles, or mix Command Code with any built-in provider. The `COMMANDCODE_API_KEY` export is forwarded to Command Code only; it is never sent to another provider's endpoint, and built-in providers never require it. If it is missing when a role uses `commandcode`, mimin fails fast with an error naming `COMMANDCODE_API_KEY`.

Since the model catalog is live and mimin performs no startup network discovery, arbitrary IDs use a conservative metadata budget (`contextWindow` 128,000, `maxTokens` 16,384, zero cost) that is safe for every catalog entry.

> **Claude models (initial scope):** Command Code routes `claude-*` model IDs through a separate Anthropic-compatible `POST /messages` endpoint. The initial resolver targets the OpenAI-compatible `POST /chat/completions` path only, so a `claude-*` ID resolves but the request is sent to `/chat/completions` and may be rejected by the provider. Prefer non-Claude IDs until `/messages` support is added and tested.

See `config.example.commandcode.json` for a complete example.

## Configuration

Configuration is merged in this order, with later layers winning:

1. built-in defaults;
2. global `$MIMIN_HOME/config.json` (default `~/.mimin/config.json`);
3. project `<cwd>/.mimin/config.json`;
4. `MIMIN_DATA_DIR` for the persistent data-directory override.

Nested role objects merge, so a project can override only its manager model or thinking level. Each role's `provider` is optional: a role without a `provider` inherits the **other role's** provider (the global provider), so you only ever configure the provider once. The `model` is optional too — a role without a `model` uses the other role's model when providers match, or the provider's first registered model. At least one role must set a `provider`, and each role keeps its own `thinking` and optional `maxTurns` (positive safe integer; default 24 for the manager, 8 for the sidekick) bounding how many model turns one run may take. `provider` accepts any built-in pi-ai provider id (e.g. `anthropic`, `openai`, `openrouter`) or the custom `commandcode` provider described above.

```json
{
  "dataDir": "~/.mimin/data",
  "manager": { "provider": "anthropic", "model": "claude-sonnet-4-6", "thinking": "medium" },
  "sidekick": { "model": "claude-sonnet-4-6", "thinking": "low" }
}
```

The sidekick above inherits the manager's provider (`anthropic`); only one provider is configured.

The current working directory is always the workspace and determines project-memory identity.

Credentials are resolved in this order: **environment variables first, then `auth.json`** (via `/provider`). Stored keys never override an exported environment variable.

An optional `memory` section controls automatic long-term memory learning:

```json
{
  "memory": { "auto": false }
}
```

It defaults to `true` (see [Automatic memory](#automatic-memory-v020) under `/memory`).

## Usage

```sh
mimin                         # new interactive conversation
mimin "implement the task"    # direct task; streams manager text and sidekick status
mimin --continue              # newest manager session, interactive
mimin --continue "next task"  # newest manager session, direct
mimin --help
mimin --version
```

During an interactive run, Escape cancels the active manager request (including running sidekicks and their shell commands) and Ctrl-C exits cleanly. Only one manager turn runs at a time.

### Interactive commands

Slash commands are intercepted in interactive mode before any model call. Typing `/` opens an autocomplete menu; Tab applies a completion, arrow keys move the selection, and Enter confirms.

```text
/help

/model
/model manager <provider-id> <model-id>
/model sidekick <provider-id> <model-id>

/provider
/provider <provider-id>

/session
/session <session-id>

/memory add user <text>
/memory add project <text>
/memory search <query>
```

#### `/model`

Chooses which provider and model actually run for each role during an interactive session.

- Type `/model`, pick a role (`manager` or `sidekick`) from the dropdown, then browse **models from every configured provider** (commandcode, openrouter, openai, …) in one list.
- Each entry shows the model and its provider, so models with the same id across providers stay distinct (e.g. `gpt-5.6-sol` under `commandcode` vs an identically named model under another provider).
- Selecting a model **atomically sets that role's provider and model**. The manager and sidekick stay independent — one can use `commandcode/gpt-5.6-sol` while the other uses `openrouter/anthropic/claude-sonnet-x`.
- Only providers that appear configured (environment, native auth, or `auth.json`) contribute models; unconfigured providers are not shown.
- Filtering is case-insensitive and matches the model id or provider (e.g. `command` finds commandcode models, `sol` finds `gpt-5.6-sol`).

Direct syntax is deterministic:

```text
/model manager  <provider-id> <model-id>
/model sidekick <provider-id> <model-id>
```

A single model id (`/model manager gpt-5.6-sol`) is interpreted against that role's current provider for backward compatibility.

The switch applies to subsequent turns in this session only; it does **not** persist to `~/.mimin/config.json` or the project config. After restart, startup configuration comes from config normally.

#### `/provider`

Configures provider connectivity and credentials. `/provider` is **not** a runtime provider selector — choosing which provider/model runs happens through `/model`.

- Lists every known provider (pi-ai's registry plus mimin's custom `commandcode`) with whether credentials appear configured.
- Each entry shows the environment variable (or native auth source) the provider needs, e.g. `openai — requires OPENAI_API_KEY`.
- Credential detection only checks whether the expected source appears available — it never reads or displays credential values.
- Providers configured only through `auth.json` count as configured and their models appear in `/model`.

##### Setting up a provider key

Run `/provider <provider-id>` (e.g. `/provider commandcode`) to set up that provider's API key interactively. When the provider is not configured, mimin shows a **masked input prompt** (keys are echoed as `•` and never appear in the editor, history, transcript, or session). Press Enter to save, Escape to cancel.

- Saved keys are written to `<dataDir>/auth.json` as plaintext with `chmod 600` (owner-only read/write) — the same convention many CLI tools use.
- Environment variables always win over stored keys, so an existing `COMMANDCODE_API_KEY` export (or any provider's documented env var) takes precedence.
- Built-in pi-ai providers continue to use their env vars or native auth; the interactive prompt is a fallback for providers that need a key.
- Keys are never logged, rendered, or returned — `/provider` only reports `configured` / `not configured`.

Secrets cannot be configured through `config.json`; use the `/provider` key prompt or environment variables. Once a provider is configured, its models are available through `/model manager` and `/model sidekick` — no separate activation step.

#### `/session`

Selects and restores an existing manager session.

- `/session` opens a dropdown of previous manager sessions with their message count and age.
- Selecting one restores that session: the transcript is cleared and replayed from the session's history, and subsequent prompts continue that session.

#### `/memory`

Memory is written explicitly with `/memory` and, since v0.2.0, learned automatically from conversation. All writes always pass through credential-like secret filtering, and the UI reports whether redaction occurred. The manager can retrieve compact ranked memory snippets on demand with its `memory_search` tool, and bounded historical snippets with `session_search`; neither tool returns full records or transcripts.

##### Automatic memory (v0.2.0)

After each completed manager turn, mimin runs a lightweight, post-turn memory review. It uses the manager's currently configured provider/model to extract durable, high-confidence facts from the **latest user-authored turns only**:

- **What is learned**: preferences ("I prefer Bun instead of npm"), corrections ("No, I use Fedora now, not Arch"), project conventions ("For this project always use pnpm"), and stable context ("My production branch is master").
- **User vs project**: each candidate is classified into user memory (general preferences) or project memory (workspace-specific). Classification is conservative — uncertain candidates are not written.
- **Correction behavior**: a correction that matches an existing memory **supersedes** it. The old record is tombstoned so both never surface as equally valid current facts; the new record carries a reference to what it replaced.
- **Deduplication**: before writing, mimin searches existing memory and skips exact or near duplicates.
- **Secret filtering**: every automatic write passes through the same credential filter as `/memory add` — API keys, passwords, tokens, Authorization headers, and credential-like strings never persist, even if the learner suggests them.
- **What is intentionally excluded**: tool output, file/README contents, website content, issue text, dependency docs, and external model output are never automatically persisted. The learner has no workspace access, no tools, and no memory-write ability — it only transforms bounded user text into structured candidates, and application code decides what gets stored.

The review is bounded (only the latest user turn plus compact related-memory matches), runs **after** the response completes (never blocking streaming), and only once per turn. A subtle `Memory learned · N new facts` line appears in the transcript when something is stored — never the candidate text itself.

Automatic learning can be disabled in config:

```json
{
  "memory": { "auto": false }
}
```

It defaults to `true` (safe because learning is limited to user-authored content, filtered, deduplicated, and conservative). Manual `/memory add` and `/memory search` work exactly as before regardless of this setting.

## Architecture and permissions

`runAgent` is the only model/tool loop. The role entry points only select prompts, sessions, models, and exact tool collections.

| Capability | Manager | Sidekick |
|---|---:|---:|
| Read workspace files | yes | yes |
| Edit/create workspace files | no | yes, exact replacement |
| Arbitrary bounded workspace bash | no | yes |
| Delegate | yes, max 3 parallel | no |
| Search user/current-project memory | yes | no |
| Search compact session history | yes | no |
| Verification | fixed actions only | via bounded bash |

Manager verification accepts only git status, git diff, `bun test`, configured `typecheck` and `build` package scripts, or the combined test+typecheck+build action. Commands, arguments, and working directories cannot be supplied by the model. The manager reads delegated files, verifies work, and can re-delegate focused corrections. Every delegation creates a fresh sidekick JSONL session containing only its self-contained task; complete manager and sidekick histories remain role-isolated for provider continuation and are never merged. Delegation results and TUI activity are compact whitelists, while `session_search` searches only user messages and assistant text blocks. Reasoning and tool logs never cross through delegation, the TUI, or `session_search`.

## Storage

By default persistent data is below `~/.mimin/data`:

```text
sessions/manager/*.jsonl
sessions/sidekick/*.jsonl
memory/user.jsonl
memory/projects/*.jsonl
auth.json
```

`auth.json` holds API keys entered via `/provider` (chmod 600; environment variables take precedence).

Manager conversations can be continued, and each complete sidekick history remains isolated for provider-safe continuation. Reasoning and tool logs stay inside their role-scoped histories and are excluded from delegation results, the TUI, and `session_search`. Project memory filenames derive from the canonical workspace path.

## Development and verification

```sh
bun run start -- --help
bun test
bun run typecheck
bun run build
bun run compile
```

`bun run build` creates the Bun-targeted package entry at `dist/index.js`. `bun run compile` creates the standalone Bun executable at `dist/mimin`:

```sh
./dist/mimin --help
./dist/mimin "inspect this repository"
```

`dist/` is generated and gitignored. The project uses the MIT license and adds no provider SDK beyond pi-ai's dependencies.
