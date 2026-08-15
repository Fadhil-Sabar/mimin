import { join, resolve } from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import type { ManagerResult, RunManagerOptions } from "./agent/manager.js";
import { runManager } from "./agent/manager.js";
import { AgentRuntime } from "./agent/runtime.js";
import type { AgentEvent } from "./agent/types.js";
import type { AgentConfig } from "./config.js";
import { ConfigValidationError, loadConfig } from "./config.js";
import { AuthStore } from "./auth.js";
import { COMMANDCODE_API_KEY_ENV_VAR, isCommandCodeProvider } from "./agent/commandcode.js";
import { MemoryStore } from "./memory/store.js";
import { autoMemoryEnabled, learnFromTurn } from "./memory/auto.js";
import { MemoryLearner } from "./memory/learner.js";
import type { MemorySearchResult } from "./memory/search.js";
import { SessionStore } from "./session/session.js";
import { AgentTui } from "./tui/app.js";
import type { AgentTuiOptions, LocalManagerEvent } from "./tui/app.js";
import { INTERACTIVE_COMMAND_NAMES } from "./tui/commands.js";
import type { ContextSummary } from "./tui/footer.js";
import { sessionSuggestionsFromStore } from "./tui/session-suggestions.js";
import type { ModelSuggestion, ModelSuggestionSource } from "./tui/model-suggestions.js";
import { suggestModels, suggestModelsAcrossConfiguredProviders } from "./tui/model-suggestions.js";
import type { LocalDelegateEvent } from "./tui/sidekick.js";
import { sanitizeText } from "./tui/header.js";
import { suggestProviders, suggestProvidersWithAuth } from "./tui/provider-suggestions.js";
import { credentialAvailable } from "./tui/provider-suggestions.js";
import type { ProviderSuggestionSource } from "./tui/provider-suggestions.js";
import {
  boardForSession,
  formatTaskCounts,
  formatTaskDetail,
  formatTaskList,
  taskStatusCounts,
} from "./tui/task-board.js";
import { readGitChanges } from "./task/git-changes.js";
import type { TaskBoard } from "./task/task.js";

export const CLI_VERSION = "0.5.0";

export type ParsedCliArguments =
  | { mode: "help" }
  | { mode: "version" }
  | { mode: "interactive"; continue: boolean }
  | { mode: "direct"; continue: boolean; task: string };

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface CliTui {
  start(): void;
  stop(): void;
  addInfo(text: string): string;
  addError(text: string): string;
  addManager(text: string): string;
  handleManagerEvent(event: LocalManagerEvent): void;
  handleDelegateEvent(event: LocalDelegateEvent): void;
  setStatus(update: {
    context?: ContextSummary;
    turn?: number;
    /** Bare manager model id (no provider prefix). */
    managerModel?: string;
    /** Bare sidekick model id (no provider prefix). */
    sidekickModel?: string;
    /** Active manager session id (header chip). */
    sessionId?: string;
  }): void;
  /** Flip the header/footer run indicator immediately on submit/cancel. */
  setRunning(running: boolean): void;
  /** Clear the editor's draft input (idle Escape). */
  clearInput(): void;
  /** Begin a masked API-key prompt for a provider. */
  promptForKey(provider: string): void;
  /** Cancel the active masked key prompt. */
  cancelKeyPrompt(): void;
  /** Clear the transcript and replay a restored session's history. */
  restoreSession(entries: { role: "user" | "manager"; text: string }[]): void;
}

export interface CliDependencies {
  cwd?: string;
  version?: string;
  io?: CliIo;
  loadConfig?: (options: { cwd: string }) => Promise<AgentConfig>;
  runManager?: (options: RunManagerOptions) => Promise<ManagerResult>;
  createSessionStore?: (config: AgentConfig) => SessionStore;
  createMemoryStore?: (config: AgentConfig, workspace: string) => MemoryStore;
  createTui?: (options: AgentTuiOptions) => CliTui;
  /** Injectable model suggestions for /model (defaults to pi-ai + Command Code). */
  suggestModels?: ModelSuggestionSource;
  /** Injectable provider suggestions for /provider (defaults to pi-ai + Command Code). */
  suggestProviders?: ProviderSuggestionSource;
  /** Injectable credential store; defaults to AuthStore at <dataDir>/auth.json. */
  createAuthStore?: (config: AgentConfig) => AuthStore;
}

export interface InteractiveCommandOptions {
  memory: MemoryStore;
  workspace: string;
  runtime: AgentRuntime;
  showInfo(text: string): void;
  showError(text: string): void;
  /** Update the TUI header/footer model chips after a switch. */
  refreshTui?(): void;
  /** Injectable model suggestions for /model; defaults to pi-ai + Command Code. */
  suggestModels?: ModelSuggestionSource;
  /**
   * Aggregate model suggestions across configured providers for /model;
   * defaults to cross-provider discovery over configured providers.
   */
  aggregateModels?: (providerSource: () => Promise<{ id: string; configured?: boolean }[]>) => Promise<ModelSuggestion[]>;
  /** Injectable provider suggestions for /provider; defaults to pi-ai + Command Code. */
  suggestProviders?: ProviderSuggestionSource;
  /** Credential store for /provider key setup (auth.json). */
  auth?: AuthStore;
  /** Begin a masked API-key prompt (TUI only). */
  promptForKey?(provider: string): void;
  /** Cancel the active masked key prompt. */
  cancelKeyPrompt?(): void;
  /** Restore a previous manager session: load its history and switch to it. */
  restoreSession?(sessionId: string): Promise<string | undefined>;
  /** Live task board for /tasks, /task, and /status (task tracking active). */
  taskBoard?(): TaskBoard | undefined;
}

const USAGE = `Usage: mimin [--continue] ["task"]

Commands:
  mimin                    Start an interactive manager conversation
  mimin "task"             Run one manager task and stream the answer
  mimin --help             Show this help
  mimin --version          Show the version
  mimin --continue         Resume the newest manager session interactively
  mimin --continue "task"  Resume it for one direct task

Interactive commands:
  ${INTERACTIVE_COMMAND_NAMES.join("\n  ")}
`;

function defaultIo(): CliIo {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

function terminalText(value: unknown, limit = 8_000): string {
  const text = sanitizeText(value, true);
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

export function parseCliArgs(args: readonly string[]): ParsedCliArguments {
  let shouldContinue = false;
  let special: "help" | "version" | undefined;
  const positional: string[] = [];
  for (const argument of args) {
    if (argument === "--continue") {
      if (shouldContinue) throw new CliUsageError("--continue may be specified only once");
      shouldContinue = true;
    } else if (argument === "--help" || argument === "-h") {
      if (special) throw new CliUsageError("Only one of --help or --version may be used");
      special = "help";
    } else if (argument === "--version" || argument === "-v") {
      if (special) throw new CliUsageError("Only one of --help or --version may be used");
      special = "version";
    } else if (argument.startsWith("-")) {
      throw new CliUsageError(`Unknown option: ${argument}`);
    } else {
      positional.push(argument);
    }
  }
  if (special) {
    if (shouldContinue || positional.length > 0) {
      throw new CliUsageError(`--${special} cannot be combined with a task or --continue`);
    }
    return { mode: special };
  }
  const task = positional.join(" ").trim();
  return task
    ? { mode: "direct", continue: shouldContinue, task }
    : { mode: "interactive", continue: shouldContinue };
}

function formatConfigError(error: unknown, workspace: string): string {
  const detail = error instanceof ConfigValidationError
    ? error.issues.join("; ")
    : error instanceof Error
      ? error.message
      : String(error);
  return [
    `Configuration error: ${terminalText(detail, 2_000)}`,
    `Create ~/.mimin/config.json or ${join(workspace, ".mimin", "config.json")}.`,
    "See config.example.json and configure both manager and sidekick models.",
  ].join("\n");
}

async function newestManagerSession(store: SessionStore): Promise<string | undefined> {
  return (await store.listSessions("manager"))[0]?.id;
}

function contextFromMessage(message: Message): ContextSummary | undefined {
  if (message.role !== "assistant") return undefined;
  return { used: message.usage.totalTokens, limit: 0 };
}

function compactMemoryResults(results: MemorySearchResult[]): string {
  if (results.length === 0) return "No matching memories.";
  return results.slice(0, 10).map((result, index) =>
    `${index + 1}. [${result.scope}] ${terminalText(result.snippet, 240)}`
  ).join("\n");
}

const ROLES = ["manager", "sidekick"] as const;
type ModelRole = (typeof ROLES)[number];

/** The role's effective provider: its own, or the other role's (global). */
function runtimeProvider(runtime: AgentRuntime, role: ModelRole): string {
  const self = runtime[role].provider;
  if (self.length > 0) return self;
  const other = role === "manager" ? runtime.sidekick : runtime.manager;
  return other.provider;
}

function modelRole(value: string | undefined): ModelRole | undefined {
  return ROLES.find((role) => role === value);
}

/**
 * Show every known provider with credential hints and availability. An exact
 * provider id triggers the interactive key-setup flow (masked input persisted
 * to auth.json); anything else filters the list. /provider never switches a
 * role's provider or model.
 */
async function handleProviderCommand(
  query: string | undefined,
  options: InteractiveCommandOptions,
): Promise<void> {
  const providerSource = options.suggestProviders ?? suggestProviders;
  const providers = await providerSource();
  const exact = query ? providers.find((item) => item.id === query) : undefined;

  // Exact provider id: offer key setup when not configured.
  if (exact) {
    const configured = await isProviderConfigured(exact.id, options.auth);
    if (configured) {
      options.showInfo(`Provider ${exact.id} is configured. Credentials come from the environment or auth.json.`);
      return;
    }
    if (!options.auth) {
      options.showInfo(
        `Provider ${exact.id} is not configured. Set its environment variable (see /provider) and restart mimin.`,
      );
      return;
    }
    if (!options.promptForKey) {
      // No interactive TUI (e.g. direct mode): cannot prompt for a key.
      options.showInfo(
        `Provider ${exact.id} is not configured. Set its environment variable and restart mimin.`,
      );
      return;
    }
    // Register the pending key write, then show the masked prompt.
    pendingKeyProvider = exact.id;
    options.showInfo(`Enter the API key for ${exact.id} (masked input):`);
    options.promptForKey(exact.id);
    return;
  }

  const filtered = query
    ? providers.filter((item) => item.id.toLowerCase().includes(query.toLowerCase()))
    : providers;
  const rows = filtered.map((item) => {
    const state = item.configured ? "configured" : "not configured";
    const hint = item.description ? ` — ${item.description}` : "";
    return `  ${item.id.padEnd(28)}${state}${hint}`;
  });
  options.showInfo([
    ...(query ? [`Providers matching ${terminalText(query, 100)}:`] : ["Providers:"]),
    ...(rows.length > 0 ? rows : ["  (no matching providers)"]),
    "",
    `Configured in config.json: manager ${roleLabel(options.runtime.manager)} · ` +
      `sidekick ${roleLabel(options.runtime.sidekick)}`,
    "Credentials come from the environment, native provider auth, or auth.json. " +
      "Run /provider <provider-id> to set up a key; use /model <role> to pick a role's model.",
  ].join("\n"));
}

/** The provider id whose key prompt is currently pending (masked input). */
let pendingKeyProvider: string | undefined;

/** Whether a provider has usable credentials (env or auth.json). */
async function isProviderConfigured(
  provider: string,
  auth?: AuthStore,
): Promise<boolean> {
  if (isCommandCodeProvider(provider)) {
    const envKey = process.env[COMMANDCODE_API_KEY_ENV_VAR];
    if (typeof envKey === "string" && envKey.trim().length > 0) return true;
    if (auth) {
      try {
        return await auth.hasKey(provider);
      } catch {
        return false;
      }
    }
    return false;
  }
  // Built-in providers: their own env var or native auth (pi-ai detection).
  const known = credentialAvailableForProvider(provider);
  return known;
}

/** Resolve whether a built-in provider appears configured (env/native). */
function credentialAvailableForProvider(provider: string): boolean {
  try {
    return credentialAvailable(provider);
  } catch {
    return false;
  }
}

/** Switch the manager or sidekick model at runtime (interactive only). */
async function handleModelCommand(
  line: string,
  options: InteractiveCommandOptions,
): Promise<void> {
  const rest = line.slice("/model".length).trim();
  const parts = rest.split(/\s+/).filter(Boolean);
  const first = parts[0];
  const role = modelRole(first);

  // Bare /model: show both roles' current provider + model.
  if (role === undefined) {
    options.showInfo([
      "Usage: /model manager [<provider-id> <model-id>] or /model sidekick [<provider-id> <model-id>]",
      `Manager: ${roleLabel(options.runtime.manager)}`,
      `Sidekick: ${roleLabel(options.runtime.sidekick)}`,
      "Browse models from configured providers; selecting a model also selects its provider.",
    ].join("\n"));
    return;
  }

  const args = parts.slice(1);
  const argText = args.join(" ").trim();
  const suggest = options.suggestModels ?? suggestModels;

  // Aggregated suggestions across configured providers (lazy, bounded).
  const aggregate = options.aggregateModels ??
    ((providerSource) => suggestModelsAcrossConfiguredProviders(providerSource, suggest));

  // No model args: show the aggregated dropdown (all configured providers).
  if (args.length === 0) {
    const suggestions = await aggregate(() =>
      (options.suggestProviders ?? suggestProviders)(),
    );
    const list = suggestions.length > 0
      ? suggestions
        .map((item) => `  ${item.id}${item.description ? ` (${item.description})` : ""}  [${item.provider}]`)
        .join("\n")
      : "  (no configured providers with discoverable models)";
    options.showInfo([
      `Usage: /model ${role} <provider-id> <model-id>`,
      `Current ${role}: ${roleLabel(options.runtime[role])}`,
      "Available models from configured providers:",
      list,
    ].join("\n"));
    return;
  }

  // Determine provider + model. Canonical: <provider> <model>. Back-compat:
  // a single <model> is interpreted against the role's current provider.
  let provider: string;
  let modelId: string;
  if (args.length === 1) {
    provider = runtimeProvider(options.runtime, role);
    modelId = args[0]!;
  } else {
    provider = args[0]!;
    modelId = args.slice(1).join(" ").trim();
  }
  if (!modelId) {
    options.showError(`Usage: /model ${role} <provider-id> <model-id>`);
    return;
  }

  // Validate the provider/model pair against the aggregated catalog so an
  // unknown provider or mismatched model never silently persists.
  const suggestions = await aggregate(() =>
    (options.suggestProviders ?? suggestProviders)(),
  );
  const match = suggestions.find(
    (item) => item.provider === provider && item.id === modelId,
  );
  if (!match) {
    options.showError(
      `Model ${terminalText(modelId, 100)} is not available on provider ${terminalText(provider, 100)}. ` +
      `Run /model ${role} to browse models from configured providers.`,
    );
    return;
  }

  const previous = roleLabel(options.runtime[role]);
  options.runtime[role] = {
    ...options.runtime[role],
    provider: match.provider,
    model: match.id,
  };
  options.showInfo(`Switched ${role}: ${previous} → ${roleLabel(options.runtime[role])}`);
  options.refreshTui?.();
}

function roleLabel(role: { provider: string; model: string }): string {
  return `${role.provider}/${role.model}`;
}

/** Restore a previous manager session (interactive only). */
async function handleSessionCommand(
  line: string,
  options: InteractiveCommandOptions,
): Promise<void> {
  const sessionId = line.slice("/session".length).trim();
  if (!sessionId) {
    options.showInfo([
      "Usage: /session <session-id>",
      "Use Tab to pick from the dropdown of previous sessions.",
    ].join("\n"));
    return;
  }
  if (!options.restoreSession) {
    options.showError("Session restore is unavailable in this context.");
    return;
  }
  const restored = await options.restoreSession(sessionId);
  if (!restored) {
    options.showError(`No manager session found with id ${terminalText(sessionId, 100)}.`);
    return;
  }
  options.showInfo(`Restored manager session ${terminalText(restored, 100)}.`);
}

/** Extended status: version, roles, task/sidekick/changes summary (interactive). */
async function handleStatusCommand(options: InteractiveCommandOptions): Promise<void> {
  const lines = [
    `mimin v${CLI_VERSION}`,
    "",
    "Manager",
    roleLabel(options.runtime.manager),
    "",
    "Sidekick",
    roleLabel(options.runtime.sidekick),
  ];
  const board = await options.taskBoard?.();
  if (board) {
    const counts = taskStatusCounts(board);
    lines.push(
      "",
      "Tasks",
      formatTaskCounts(board) || "no tasks",
    );
    const active = counts.running + counts.revising;
    lines.push("", "Sidekicks", `${active} active`);
    const changed = board.tasks
      .flatMap((task) => task.lastResult?.filesChanged ?? [])
      .filter((value, index, all) => all.indexOf(value) === index);
    if (changed.length > 0) {
      lines.push("", "Changes", `${changed.length} file${changed.length === 1 ? "" : "s"} changed`);
      lines.push(changed.slice(0, 8).join("\n"));
    }
    const reviewing = counts.reviewing + counts.revising;
    if (reviewing > 0) lines.push("", "Review", `${reviewing} pending`);
  }
  // Live workspace changes (bounded, best-effort, read-only).
  try {
    const changes = await readGitChanges(options.workspace);
    if (!changes.unavailable && (
      changes.modified.length > 0 ||
      changes.added.length > 0 ||
      changes.deleted.length > 0
    )) {
      const paths = [
        ...changes.modified.map((path) => `M ${path}`),
        ...changes.added.map((path) => `A ${path}`),
        ...changes.deleted.map((path) => `D ${path}`),
      ];
      lines.push("", "Workspace", ...paths.slice(0, 10));
    }
  } catch {
    // Workspace git state is best-effort; never break /status on it.
  }
  options.showInfo(lines.join("\n"));
}

/** Intercept the deliberately tiny interactive command family before model invocation. */
export async function handleInteractiveCommand(
  line: string,
  options: InteractiveCommandOptions,
): Promise<boolean> {
  if (line === "/help") {
    options.showInfo([
      "Interactive commands:",
      ...INTERACTIVE_COMMAND_NAMES,
    ].join("\n"));
    return true;
  }
  if (line === "/model" || line.startsWith("/model ")) {
    await handleModelCommand(line, options);
    return true;
  }
  if (line === "/provider" || line.startsWith("/provider ")) {
    const query = line.slice("/provider".length).trim();
    await handleProviderCommand(query.length > 0 ? query : undefined, options);
    return true;
  }
  if (line === "/session" || line.startsWith("/session ")) {
    await handleSessionCommand(line, options);
    return true;
  }
  if (line === "/tasks") {
    const board = await options.taskBoard?.();
    if (!board) {
      options.showInfo("No task tracking is active in this session.");
      return true;
    }
    options.showInfo(formatTaskList(board));
    return true;
  }
  if (line.startsWith("/task ")) {
    const board = await options.taskBoard?.();
    if (!board) {
      options.showInfo("No task tracking is active in this session.");
      return true;
    }
    const id = line.slice("/task".length).trim();
    if (!id) {
      options.showInfo("Usage: /task <id>  (e.g. /task T01)");
      return true;
    }
    options.showInfo(formatTaskDetail(board, id));
    return true;
  }
  if (line === "/status") {
    await handleStatusCommand(options);
    return true;
  }
  if (!line.startsWith("/memory")) return false;

  const add = line.match(/^\/memory\s+add\s+(user|project)\s+(.+)$/s);
  if (add?.[1] && add[2]?.trim()) {
    try {
      const scope = add[1] as "user" | "project";
      const result = await options.memory.add(add[2].trim(), {
        scope,
        ...(scope === "project" ? { workspace: options.workspace } : {}),
      });
      options.showInfo(
        result.filtered
          ? `Saved ${scope} memory with ${result.redactionCount} secret redaction(s).`
          : `Saved ${scope} memory (no redaction needed).`,
      );
    } catch (error) {
      options.showError(`Could not save memory: ${terminalText(error instanceof Error ? error.message : error)}`);
    }
    return true;
  }

  const search = line.match(/^\/memory\s+search\s+(.+)$/s);
  if (search?.[1]?.trim()) {
    try {
      const query = search[1].trim();
      const results = (await Promise.all([
        options.memory.search(query, { scope: "user", limit: 10, snippetLength: 220 }),
        options.memory.search(query, {
          scope: "project",
          workspace: options.workspace,
          limit: 10,
          snippetLength: 220,
        }),
      ])).flat()
        .sort((left, right) => right.score - left.score || right.timestamp - left.timestamp)
        .slice(0, 10);
      options.showInfo(compactMemoryResults(results));
    } catch (error) {
      options.showError(`Could not search memory: ${terminalText(error instanceof Error ? error.message : error)}`);
    }
    return true;
  }

  options.showError(
    "Usage: /memory add user <text>, /memory add project <text>, or /memory search <query>",
  );
  return true;
}

async function runDirect(
  parsed: Extract<ParsedCliArguments, { mode: "direct" }>,
  config: AgentConfig,
  workspace: string,
  store: SessionStore,
  io: CliIo,
  manager: (options: RunManagerOptions) => Promise<ManagerResult>,
  auth?: AuthStore,
): Promise<number> {
  const sessionId = parsed.continue ? await newestManagerSession(store) : undefined;
  if (parsed.continue && !sessionId) {
    io.stderr("No manager session is available to continue. Run mimin first.\n");
    return 1;
  }

  let streamed = false;
  let lastWasNewline = true;
  const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  process.once("SIGINT", interrupt);
  try {
    let authKey: string | undefined;
    let sidekickAuthKey: string | undefined;
    if (auth) {
      try {
        authKey = await auth.effectiveKey(config.manager.provider, COMMANDCODE_API_KEY_ENV_VAR);
      } catch {
        authKey = undefined;
      }
      try {
        sidekickAuthKey = await auth.effectiveKey(config.sidekick.provider, COMMANDCODE_API_KEY_ENV_VAR);
      } catch {
        sidekickAuthKey = undefined;
      }
    }
    const result = await manager({
      input: parsed.task,
      workspace,
      config,
      sessionStore: store,
      ...(sessionId ? { sessionId } : {}),
      ...(authKey ? { authKey } : {}),
      ...(sidekickAuthKey ? { sidekickAuthKey } : {}),
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "model_event" && event.event.type === "text_delta") {
          const delta = terminalText(event.event.delta, 64 * 1024);
          streamed = true;
          lastWasNewline = delta.endsWith("\n");
          io.stdout(delta);
        }
      },
      onDelegateEvent: (event) => {
        if (event.type === "delegation_started") {
          io.stderr(`Sidekick ${event.index + 1}/${event.taskCount} started.\n`);
        } else if (event.type === "delegation_finished") {
          const result = event.result;
          io.stderr(
            `Sidekick ${event.index + 1}/${event.taskCount} ${result.status}: ${terminalText(result.summary, 300)}\n`,
          );
          for (const concern of result.concerns ?? []) {
            io.stderr(`  ! ${terminalText(concern, 200)}\n`);
          }
          for (const step of result.nextSteps ?? []) {
            io.stderr(`  → ${terminalText(step, 200)}\n`);
          }
        }
      },
    });
    if (!streamed && result.finalText) {
      const text = terminalText(result.finalText, 256 * 1024);
      io.stdout(text);
      lastWasNewline = text.endsWith("\n");
    }
    if (!lastWasNewline) io.stdout("\n");
    if (result.status !== "completed") {
      io.stderr(`Manager stopped with status ${result.status}${result.error ? `: ${terminalText(result.error, 2_000)}` : ""}.\n`);
      return result.status === "aborted" ? 130 : 1;
    }
    return 0;
  } catch (error) {
    io.stderr(`Manager error: ${terminalText(error instanceof Error ? error.message : error, 2_000)}\n`);
    return controller.signal.aborted ? 130 : 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
  }
}

async function runInteractive(
  shouldContinue: boolean,
  config: AgentConfig,
  workspace: string,
  store: SessionStore,
  memory: MemoryStore,
  manager: (options: RunManagerOptions) => Promise<ManagerResult>,
  createTui: (options: AgentTuiOptions) => CliTui,
  io: CliIo,
  suggestModelsSource?: ModelSuggestionSource,
  suggestProvidersSource?: ProviderSuggestionSource,
  auth?: AuthStore,
): Promise<number> {
  const providers: ProviderSuggestionSource = suggestProvidersSource ??
    (async () => suggestProvidersWithAuth(auth));
  let sessionId = shouldContinue ? await newestManagerSession(store) : undefined;
  if (shouldContinue && !sessionId) {
    io.stderr("No manager session is available to continue. Run mimin first.\n");
    return 1;
  }
  if (!sessionId) sessionId = (await store.createSession("manager")).id;

  // Live task-board cache for /tasks, /task, and /status. Refreshed from the
  // manager session's persisted `task_board` events after every run and on
  // session restore, so the commands always show the newest state. The option
  // is synchronous because the cache is in-memory.
  let liveBoard = await boardForSession(store, sessionId);

  const runtime = new AgentRuntime(config);
  let app: CliTui | undefined;
  let running = false;
  let activeController: AbortController | undefined;
  let exited = false;
  let resolveExit!: (code: number) => void;
  const exitedPromise = new Promise<number>((resolvePromise) => {
    resolveExit = resolvePromise;
  });
  const finish = (code: number): void => {
    if (exited) return;
    exited = true;
    activeController?.abort();
    app?.stop();
    resolveExit(code);
  };

  app = createTui({
    managerModel: config.manager.model,
    sidekickModel: config.sidekick.model,
    sessionId,
    workspace,
    thinking: config.manager.thinking,
    roleProviders: (role) => runtimeProvider(runtime, role),
    suggestProviders: providers,
    sessionSource: sessionSuggestionsFromStore(store),
    onExit: () => finish(0),
    onCancel: () => {
      if (activeController) {
        activeController.abort();
        return;
      }
      // Idle: Escape clears the draft input.
      app?.clearInput();
    },
    onSubmitKey: async (provider, key) => {
      if (!auth || pendingKeyProvider !== provider) return;
      pendingKeyProvider = undefined;
      try {
        await auth.setKey(provider, key);
        app?.addInfo(`Saved API key for ${provider} to auth.json (never shown again).`);
      } catch (error) {
        app?.addError(`Could not save key for ${provider}: ${terminalText(error instanceof Error ? error.message : error, 500)}`);
      }
    },
    onCancelKey: () => {
      if (pendingKeyProvider) {
        app?.addInfo(`Key entry for ${pendingKeyProvider} cancelled.`);
        pendingKeyProvider = undefined;
      }
    },
    onSubmit: async (line) => {
      if (await handleInteractiveCommand(line, {
        memory,
        workspace,
        runtime,
        showInfo: (text) => { app?.addInfo(text); },
        showError: (text) => { app?.addError(text); },
        refreshTui: () => {
          app?.setStatus({
            managerModel: runtime.manager.model,
            sidekickModel: runtime.sidekick.model,
          });
        },
        suggestModels: suggestModelsSource,
        suggestProviders: providers,
        auth,
        promptForKey: (provider) => app?.promptForKey(provider),
        cancelKeyPrompt: () => app?.cancelKeyPrompt(),
        taskBoard: () => liveBoard,
        restoreSession: async (id) => {
          try {
            const session = await store.loadSession("manager", id);
            const entries: { role: "user" | "manager"; text: string }[] = [];
            for (const message of session.messages) {
              if (message.role === "user" && typeof message.content === "string") {
                entries.push({ role: "user", text: message.content });
              } else if (message.role === "assistant") {
                const text = message.content
                  .filter((block) => block.type === "text")
                  .map((block) => block.text)
                  .join("\n")
                  .trim();
                if (text) entries.push({ role: "manager", text });
              }
            }
            sessionId = id;
            liveBoard = await boardForSession(store, sessionId);
            app?.setStatus({ sessionId });
            app?.restoreSession(entries);
            return id;
          } catch {
            return undefined;
          }
        },
      })) return;
      if (running) {
        app?.addError("A manager run is already active; wait or press Escape to cancel it.");
        return;
      }
      running = true;
      app?.setRunning(true);
      const controller = new AbortController();
      activeController = controller;
      let receivedManagerText = false;
      let completed = false;
      let authKey: string | undefined;
      let sidekickAuthKey: string | undefined;
      try {
        const managerProvider = runtimeProvider(runtime, "manager");
        const sidekickProvider = runtimeProvider(runtime, "sidekick");
        if (auth) {
          try {
            authKey = await auth.effectiveKey(
              managerProvider,
              COMMANDCODE_API_KEY_ENV_VAR,
            );
          } catch {
            authKey = undefined;
          }
          try {
            sidekickAuthKey = await auth.effectiveKey(
              sidekickProvider,
              COMMANDCODE_API_KEY_ENV_VAR,
            );
          } catch {
            sidekickAuthKey = undefined;
          }
        }
        const result = await manager({
          input: line,
          workspace,
          config: runtime.toConfig(),
          sessionStore: store,
          sessionId,
          ...(authKey ? { authKey } : {}),
          ...(sidekickAuthKey ? { sidekickAuthKey } : {}),
          signal: controller.signal,
          onEvent: (event: AgentEvent) => {
            app?.handleManagerEvent(event);
            if (
              event.type === "model_event" &&
              (event.event.type === "text_start" ||
                event.event.type === "text_delta" ||
                event.event.type === "text_end")
            ) receivedManagerText = true;
            if (event.type === "message_appended") {
              const context = contextFromMessage(event.message);
              app?.setStatus({
                context,
                turn: event.turn,
              });
            }
          },
          onDelegateEvent: (event) => app?.handleDelegateEvent(event),
        });
        sessionId = result.sessionId;
        liveBoard = await boardForSession(store, sessionId);
        app?.setStatus({ sessionId });
        completed = result.status === "completed";
        if (result.status === "aborted") {
          app?.addInfo("× cancelled");
        } else if (!completed) {
          app?.addError(
            `Manager stopped with status ${result.status}${result.error ? `: ${terminalText(result.error, 2_000)}` : ""}.`,
          );
        } else if (result.finalText && !receivedManagerText) {
          app?.addManager(terminalText(result.finalText, 256 * 1024));
        }
      } catch (error) {
        if (controller.signal.aborted) app?.addInfo("× cancelled");
        else app?.addError(`Manager error: ${terminalText(error instanceof Error ? error.message : error, 2_000)}`);
      } finally {
        if (activeController === controller) activeController = undefined;
        running = false;
        app?.setRunning(false);
        // Post-turn automatic memory learning. Bounded, non-blocking, and
        // best-effort: it runs after the interactive response completes and
        // only from user-authored turn text (never tool output or external
        // content). One review per completed turn. Any failure (unknown
        // provider, no credentials, model error) is swallowed — learning must
        // never break or delay the interactive loop.
        if (completed && autoMemoryEnabled(runtime.toConfig())) {
          const role = runtime.manager;
          let learner: MemoryLearner | undefined;
          try {
            learner = new MemoryLearner({ role, ...(authKey ? { apiKey: authKey } : {}) });
          } catch {
            learner = undefined;
          }
          if (learner) {
            void learnFromTurn(learner, memory, workspace, [line], controller.signal).then(
              (result) => {
                if (result.learned > 0) {
                  app?.addInfo(`Memory learned · ${result.learned} new fact${result.learned === 1 ? "" : "s"}`);
                }
              },
              () => undefined,
            );
          }
        }
      }
    },
  });
  if (shouldContinue) app.addInfo(`Continuing manager session ${terminalText(sessionId, 100)}.`);
  if (!exited) app.start();
  return exitedPromise;
}

/** Testable CLI entry point. Production uses Bun/pi-ai/pi-tui through defaults. */
export async function runCli(
  args: readonly string[] = Bun.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<number> {
  const io = dependencies.io ?? defaultIo();
  let parsed: ParsedCliArguments;
  try {
    parsed = parseCliArgs(args);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\nRun mimin --help for usage.\n`);
    return 2;
  }
  if (parsed.mode === "help") {
    io.stdout(USAGE);
    return 0;
  }
  if (parsed.mode === "version") {
    io.stdout(`${dependencies.version ?? CLI_VERSION}\n`);
    return 0;
  }

  const workspace = resolve(dependencies.cwd ?? process.cwd());
  let config: AgentConfig;
  try {
    config = await (dependencies.loadConfig ?? loadConfig)({ cwd: workspace });
  } catch (error) {
    io.stderr(`${formatConfigError(error, workspace)}\n`);
    return 2;
  }
  const store = dependencies.createSessionStore?.(config) ?? new SessionStore({
    root: join(config.dataDir, "sessions"),
  });
  const manager = dependencies.runManager ?? runManager;
  const auth = (await dependencies.createAuthStore?.(config)) ?? new AuthStore({ dataDir: config.dataDir });

  if (parsed.mode === "direct") {
    return runDirect(parsed, config, workspace, store, io, manager, auth);
  }
  const memory = dependencies.createMemoryStore?.(config, workspace) ?? new MemoryStore({
    dataDir: config.dataDir,
    workspace,
  });
  try {
    return await runInteractive(
      parsed.continue,
      config,
      workspace,
      store,
      memory,
      manager,
      dependencies.createTui ?? ((options) => new AgentTui(options)),
      io,
      dependencies.suggestModels,
      dependencies.suggestProviders,
      auth,
    );
  } catch (error) {
    io.stderr(`Could not start interactive mode: ${terminalText(error instanceof Error ? error.message : error, 2_000)}\n`);
    return 1;
  }
}

export const main = runCli;
