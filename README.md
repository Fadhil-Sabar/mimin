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

Edit the copied config to select installed pi-ai provider/model IDs for both roles. The example contains no credential and is not an active project config. Common API-key variables include `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, and `OPENROUTER_API_KEY`. pi-ai also honors provider-native ambient credentials where supported, such as AWS credentials/profiles for Bedrock and Google Application Default Credentials. mimin does not store provider credentials.

### Command Code (custom provider)

[Command Code](https://commandcode.ai) exposes an OpenAI-compatible API, and mimin resolves its models at runtime instead of requiring pi-ai's built-in registry. Configure it by setting the provider id `commandcode` for either role. The API key is read from `COMMANDCODE_API_KEY` only — never store the key in config.

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

Nested role objects merge, so a project can override only its manager model or thinking level. A complete base config needs non-empty `provider`, `model`, and a thinking value (`off`, `minimal`, `low`, `medium`, `high`, or `xhigh`) for both roles. `provider` accepts any built-in pi-ai provider id (e.g. `anthropic`, `openai`, `openrouter`) or the custom `commandcode` provider described above:

```json
{
  "dataDir": "~/.mimin/data",
  "manager": { "provider": "anthropic", "model": "claude-sonnet-4-6", "thinking": "medium" },
  "sidekick": { "provider": "anthropic", "model": "claude-sonnet-4-6", "thinking": "low" }
}
```

The current working directory is always the workspace and determines project-memory identity.

## Usage

```sh
agent                         # new interactive conversation
agent "implement the task"    # direct task; streams manager text and sidekick status
agent --continue              # newest manager session, interactive
agent --continue "next task"  # newest manager session, direct
agent --help
agent --version
```

During an interactive run, Escape cancels the active manager request and Ctrl-C exits cleanly. Only one manager turn runs at a time.

### Explicit memory

Memory is never learned or injected automatically. These commands are intercepted in interactive mode before any model call:

```text
/memory add user <text>
/memory add project <text>
/memory search <query>
/help
```

Writes always pass through credential-like secret filtering, and the UI reports whether redaction occurred. The manager can retrieve compact ranked memory snippets on demand with its `memory_search` tool. It can similarly retrieve bounded historical snippets with `session_search`; neither tool returns full records or transcripts.

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
```

Manager conversations can be continued, and each complete sidekick history remains isolated for provider-safe continuation. Reasoning and tool logs stay inside their role-scoped histories and are excluded from delegation results, the TUI, and `session_search`. Project memory filenames derive from the canonical workspace path.

## Development and verification

```sh
bun run start -- --help
bun test
bun run typecheck
bun run build
bun run compile
```

`bun run build` creates the Bun-targeted package entry at `dist/index.js`. `bun run compile` creates the standalone Bun executable at `dist/agent`:

```sh
./dist/agent --help
./dist/agent "inspect this repository"
```

`dist/` is generated and gitignored. The project uses the MIT license and adds no provider SDK beyond pi-ai's dependencies.
