import { join, resolve } from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import type { ManagerResult, RunManagerOptions } from "./agent/manager.js";
import { runManager } from "./agent/manager.js";
import { AgentRuntime } from "./agent/runtime.js";
import type { AgentEvent } from "./agent/types.js";
import type { AgentConfig } from "./config.js";
import { ConfigValidationError, loadConfig } from "./config.js";
import { MemoryStore } from "./memory/store.js";
import type { MemorySearchResult } from "./memory/search.js";
import { SessionStore } from "./session/session.js";
import { AgentTui } from "./tui/app.js";
import type { AgentTuiOptions, LocalManagerEvent } from "./tui/app.js";
import { INTERACTIVE_COMMAND_NAMES } from "./tui/commands.js";
import type { ContextSummary } from "./tui/footer.js";
import { sessionSuggestionsFromStore } from "./tui/session-suggestions.js";
import type { ModelSuggestionSource } from "./tui/model-suggestions.js";
import { suggestModels } from "./tui/model-suggestions.js";
import type { LocalDelegateEvent } from "./tui/sidekick.js";
import { sanitizeText } from "./tui/header.js";

export const CLI_VERSION = "0.1.0";

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
  setStatus(update: { context?: ContextSummary; turn?: number; managerModel?: string }): void;
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
  /** Restore a previous manager session: load its history and switch to it. */
  restoreSession?(sessionId: string): Promise<string | undefined>;
}

const USAGE = `Usage: agent [--continue] ["task"]

Commands:
  agent                    Start an interactive manager conversation
  agent "task"             Run one manager task and stream the answer
  agent --help             Show this help
  agent --version          Show the version
  agent --continue         Resume the newest manager session interactively
  agent --continue "task"  Resume it for one direct task

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

function modelRole(value: string | undefined): ModelRole | undefined {
  return ROLES.find((role) => role === value);
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
  if (role === undefined) {
    const current = roleLabel(options.runtime.manager) + " / " + roleLabel(options.runtime.sidekick);
    options.showInfo([
      "Usage: /model manager <model-id> or /model sidekick <model-id>",
      `Current: manager ${roleLabel(options.runtime.manager)} · sidekick ${roleLabel(options.runtime.sidekick)}`,
    ].join("\n"));
    return;
  }
  const modelId = parts.slice(1).join(" ").trim();
  if (!modelId) {
    const suggestions = await (options.suggestModels ?? suggestModels)(options.runtime[role].provider);
    const list = suggestions.length > 0
      ? suggestions.map((item) => `  ${item.id}${item.description ? ` (${item.description})` : ""}`).join("\n")
      : "  (no suggestions available)";
    options.showInfo([
      `Usage: /model ${role} <model-id>`,
      `Current ${role} model: ${roleLabel(options.runtime[role])}`,
      `Available for provider ${options.runtime[role].provider}:`,
      list,
    ].join("\n"));
    return;
  }
  const previous = roleLabel(options.runtime[role]);
  options.runtime[role] = {
    ...options.runtime[role],
    model: modelId,
  };
  options.showInfo(`Switched ${role} model: ${previous} → ${roleLabel(options.runtime[role])}`);
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
  if (line === "/session" || line.startsWith("/session ")) {
    await handleSessionCommand(line, options);
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
): Promise<number> {
  const sessionId = parsed.continue ? await newestManagerSession(store) : undefined;
  if (parsed.continue && !sessionId) {
    io.stderr("No manager session is available to continue. Run agent first.\n");
    return 1;
  }

  let streamed = false;
  let lastWasNewline = true;
  const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  process.once("SIGINT", interrupt);
  try {
    const result = await manager({
      input: parsed.task,
      workspace,
      config,
      sessionStore: store,
      ...(sessionId ? { sessionId } : {}),
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
          io.stderr(
            `Sidekick ${event.index + 1}/${event.taskCount} ${event.result.status}: ${terminalText(event.result.summary, 300)}\n`,
          );
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
): Promise<number> {
  let sessionId = shouldContinue ? await newestManagerSession(store) : undefined;
  if (shouldContinue && !sessionId) {
    io.stderr("No manager session is available to continue. Run agent first.\n");
    return 1;
  }
  if (!sessionId) sessionId = (await store.createSession("manager")).id;

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
    managerModel: `${config.manager.provider}/${config.manager.model}`,
    workspace,
    thinking: config.manager.thinking,
    roleProviders: (role) => runtime[role].provider,
    sessionSource: sessionSuggestionsFromStore(store),
    onExit: () => finish(0),
    onCancel: () => {
      if (activeController) {
        activeController.abort();
        app?.addInfo("Cancelling the active manager run…");
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
            managerModel: `${runtime.manager.provider}/${runtime.manager.model}`,
          });
        },
        suggestModels: suggestModelsSource,
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
      const controller = new AbortController();
      activeController = controller;
      let receivedManagerText = false;
      try {
        const result = await manager({
          input: line,
          workspace,
          config: runtime.toConfig(),
          sessionStore: store,
          sessionId,
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
        if (result.status !== "completed") {
          app?.addError(
            `Manager stopped with status ${result.status}${result.error ? `: ${terminalText(result.error, 2_000)}` : ""}.`,
          );
        } else if (result.finalText && !receivedManagerText) {
          app?.addManager(terminalText(result.finalText, 256 * 1024));
        }
      } catch (error) {
        app?.addError(`Manager error: ${terminalText(error instanceof Error ? error.message : error, 2_000)}`);
      } finally {
        if (activeController === controller) activeController = undefined;
        running = false;
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
    io.stderr(`${error instanceof Error ? error.message : String(error)}\nRun agent --help for usage.\n`);
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

  if (parsed.mode === "direct") {
    return runDirect(parsed, config, workspace, store, io, manager);
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
    );
  } catch (error) {
    io.stderr(`Could not start interactive mode: ${terminalText(error instanceof Error ? error.message : error, 2_000)}\n`);
    return 1;
  }
}

export const main = runCli;
