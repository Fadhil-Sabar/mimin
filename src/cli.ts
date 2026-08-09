import { join, resolve } from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import type { ManagerResult, RunManagerOptions } from "./agent/manager.js";
import { runManager } from "./agent/manager.js";
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
  setStatus(update: { context?: ContextSummary; turn?: number }): void;
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
}

export interface InteractiveCommandOptions {
  memory: MemoryStore;
  workspace: string;
  showInfo(text: string): void;
  showError(text: string): void;
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
): Promise<number> {
  let sessionId = shouldContinue ? await newestManagerSession(store) : undefined;
  if (shouldContinue && !sessionId) {
    io.stderr("No manager session is available to continue. Run agent first.\n");
    return 1;
  }
  if (!sessionId) sessionId = (await store.createSession("manager")).id;

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
        showInfo: (text) => { app?.addInfo(text); },
        showError: (text) => { app?.addError(text); },
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
          config,
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
    );
  } catch (error) {
    io.stderr(`Could not start interactive mode: ${terminalText(error instanceof Error ? error.message : error, 2_000)}\n`);
    return 1;
  }
}

export const main = runCli;
