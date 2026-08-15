import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { AgentEvent } from "../src/agent/types.js";
import type { ManagerResult, RunManagerOptions } from "../src/agent/manager.js";
import { AgentRuntime } from "../src/agent/runtime.js";
import {
  handleInteractiveCommand,
  parseCliArgs,
  runCli,
  type CliIo,
  type CliTui,
} from "../src/cli.js";
import type { AgentConfig } from "../src/config.js";
import type { ProviderSuggestionSource } from "../src/tui/provider-suggestions.js";
import { AuthStore } from "../src/auth.js";
import { MemoryStore } from "../src/memory/store.js";
import { SessionStore } from "../src/session/session.js";
import type { AgentTuiOptions } from "../src/tui/app.js";
import { TaskBoard } from "../src/task/task.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

async function fixture(): Promise<{ workspace: string; config: AgentConfig }> {
  const workspace = await mkdtemp(join(tmpdir(), "mimin-cli-"));
  temporaryDirectories.push(workspace);
  return {
    workspace,
    config: {
      dataDir: join(workspace, "data"),
      manager: { provider: "fake", model: "manager", thinking: "off" },
      sidekick: { provider: "fake", model: "sidekick", thinking: "off" },
      memory: { auto: true },
      security: { injectionWarning: true },
      review: { maxReviewIterations: 2 },
    },
  };
}

function captureIo(): CliIo & { out: string; err: string } {
  return {
    out: "",
    err: "",
    stdout(text) { this.out += text; },
    stderr(text) { this.err += text; },
  };
}

function completed(sessionId: string, finalText = "done"): ManagerResult {
  return {
    status: "completed",
    turns: 1,
    toolCalls: 0,
    messages: [],
    sessionId,
    finalText,
  };
}

class FakeTui implements CliTui {
  starts = 0;
  stops = 0;
  info: string[] = [];
  errors: string[] = [];
  constructor(
    readonly options: AgentTuiOptions,
    private readonly onStart: (options: AgentTuiOptions) => Promise<void>,
  ) {}
  start(): void {
    this.starts += 1;
    void this.onStart(this.options);
  }
  stop(): void { this.stops += 1; }
  addInfo(text: string): string { this.info.push(text); return String(this.info.length); }
  addError(text: string): string { this.errors.push(text); return String(this.errors.length); }
  addManager(text: string): string { this.info.push(text); return String(this.info.length); }
  handleManagerEvent(): void {}
  handleDelegateEvent(): void {}
  setStatus(): void {}
  running: boolean | undefined;
  setRunning(value: boolean): void { this.running = value; }
  clearInput(): void { this.clearedInput = true; }
  clearedInput = false;
  keyPromptProvider: string | undefined;
  promptForKey(provider: string): void { this.keyPromptProvider = provider; }
  cancelKeyPrompt(): void { this.keyPromptProvider = undefined; }
  restored: { role: "user" | "manager"; text: string }[][] = [];
  restoreSession(entries: { role: "user" | "manager"; text: string }[]): void {
    this.restored.push(entries);
  }
}

describe("CLI argument and noninteractive paths", () => {
  test("parses the deliberately small command surface", () => {
    expect(parseCliArgs([])).toEqual({ mode: "interactive", continue: false });
    expect(parseCliArgs(["ship it"])).toEqual({ mode: "direct", continue: false, task: "ship it" });
    expect(parseCliArgs(["--continue"])).toEqual({ mode: "interactive", continue: true });
    expect(parseCliArgs(["--continue", "fix", "tests"])).toEqual({
      mode: "direct", continue: true, task: "fix tests",
    });
    expect(() => parseCliArgs(["--command", "rm"])).toThrow("Unknown option");
  });

  test("help and version need no config or credentials; unknown options fail clearly", async () => {
    const io = captureIo();
    let loads = 0;
    const help = await runCli(["--help"], {
      io,
      loadConfig: async () => { loads += 1; throw new Error("must not load"); },
    });
    expect(help).toBe(0);
    expect(io.out).toContain("Usage: mimin");
    expect(io.out).toContain("/memory add project");
    expect(loads).toBe(0);

    const versionIo = captureIo();
    expect(await runCli(["--version"], { io: versionIo, version: "9.8.7" })).toBe(0);
    expect(versionIo.out).toBe("9.8.7\n");

    const badIo = captureIo();
    expect(await runCli(["--arbitrary"], { io: badIo })).toBe(2);
    expect(badIo.err).toContain("Unknown option: --arbitrary");
  });

  test("direct tasks stream manager text and concise sidekick progress", async () => {
    const { workspace, config } = await fixture();
    const io = captureIo();
    let received: RunManagerOptions | undefined;
    const code = await runCli(["implement feature"], {
      cwd: workspace,
      io,
      loadConfig: async () => config,
      runManager: async (options) => {
        received = options;
        await options.onDelegateEvent?.({ type: "delegation_started", index: 0, taskCount: 1 });
        await options.onDelegateEvent?.({
          type: "delegation_finished",
          index: 0,
          taskCount: 1,
          result: {
            status: "complete",
            summary: "changed files",
            filesChanged: [],
            verification: [],
            sessionId: "sidekick-safe",
          },
        });
        await options.onEvent?.({
          type: "model_event",
          turn: 1,
          event: { type: "text_delta", delta: "streamed answer" },
        } as AgentEvent);
        return completed("manager-new", "streamed answer");
      },
    });

    expect(code).toBe(0);
    expect(received?.input).toBe("implement feature");
    expect(received?.workspace).toBe(workspace);
    expect(io.out).toBe("streamed answer\n");
    expect(io.err).toContain("Sidekick 1/1 started");
    expect(io.err).toContain("complete: changed files");
    expect(io.err).not.toContain("sidekick-safe");
  });

  test("direct flow resolves a stored commandcode sidekick key separately (no env)", async () => {
    const { workspace } = await fixture();
    const config: AgentConfig = {
      dataDir: join(workspace, "data"),
      manager: { provider: "anthropic", model: "claude-sonnet-4-6", thinking: "off" },
      sidekick: { provider: "commandcode", model: "gpt-5.5", thinking: "off" },
      memory: { auto: true },
      security: { injectionWarning: true },
      review: { maxReviewIterations: 2 },
    };
    const io = captureIo();
    const previous = process.env.COMMANDCODE_API_KEY;
    delete process.env.COMMANDCODE_API_KEY;
    let received: RunManagerOptions | undefined;
    // Store the sidekick key BEFORE runCli so the read is not racing the write.
    const auth = new AuthStore({ dataDir: config.dataDir, env: {} });
    await auth.setKey("commandcode", "sk-stored-sidekick");
    try {
      const code = await runCli(["delegate to commandcode sidekick"], {
        cwd: workspace,
        io,
        loadConfig: async () => config,
        createAuthStore: () => auth,
        runManager: async (options) => {
          received = options;
          return completed(options.sessionId ?? "missing");
        },
      });
      expect(code).toBe(0);
    } finally {
      if (previous === undefined) {
        delete process.env.COMMANDCODE_API_KEY;
      } else {
        process.env.COMMANDCODE_API_KEY = previous;
      }
    }
    // The sidekick receives its OWN stored key; the manager never gets it.
    expect(received?.sidekickAuthKey).toBe("sk-stored-sidekick");
    expect(received?.authKey).toBeUndefined();
  });

  test("direct non-completed status reports the stop reason", async () => {
    const { workspace, config } = await fixture();
    const io = captureIo();
    const code = await runCli(["bounded task"], {
      cwd: workspace,
      io,
      loadConfig: async () => config,
      runManager: async (options) => ({
        status: "error",
        turns: 3,
        toolCalls: 2,
        messages: [],
        sessionId: options.sessionId ?? "manager",
        finalText: "partial answer",
        error: "provider exploded",
      }),
    });
    expect(code).toBe(1);
    // Partial text is still flushed before the stop is reported.
    expect(io.out).toBe("partial answer\n");
    expect(io.err).toContain("stopped with status error");
    expect(io.err).toContain("provider exploded");
    expect(io.err).not.toContain("max_turns");
  });

  test("--continue selects the newest manager session for a direct task", async () => {
    const { workspace, config } = await fixture();
    let tick = 0;
    const store = new SessionStore({
      root: join(config.dataDir, "sessions"),
      now: () => ++tick,
      idFactory: () => `id-${tick}`,
    });
    await store.createSession("manager");
    const newest = await store.createSession("manager");
    let resumed: string | undefined;
    const code = await runCli(["--continue", "next task"], {
      cwd: workspace,
      io: captureIo(),
      loadConfig: async () => config,
      createSessionStore: () => store,
      runManager: async (options) => {
        resumed = options.sessionId;
        return completed(options.sessionId ?? "missing");
      },
    });
    expect(code).toBe(0);
    expect(resumed).toBe(newest.id);
  });

  test("configuration failures are actionable and never start model or TUI", async () => {
    const io = captureIo();
    let managerRuns = 0;
    let tuiRuns = 0;
    const code = await runCli(["task"], {
      cwd: "/work/project",
      io,
      loadConfig: async () => { throw new Error("manager.model is missing"); },
      runManager: async () => { managerRuns += 1; return completed("no"); },
      createTui: () => { tuiRuns += 1; throw new Error("no"); },
    });
    expect(code).toBe(2);
    expect(io.err).toContain("Configuration error");
    expect(io.err).toContain("~/.mimin/config.json");
    expect(io.err).toContain("/work/project/.mimin/config.json");
    expect(io.err).toContain("config.example.json");
    expect(managerRuns).toBe(0);
    expect(tuiRuns).toBe(0);
  });
});

describe("interactive integration", () => {
  test("retains one new manager session across turns using an injected TUI", async () => {
    const { workspace, config } = await fixture();
    const sessions: string[] = [];
    let fakeTui: FakeTui | undefined;
    const code = await runCli([], {

      cwd: workspace,
      io: captureIo(),
      loadConfig: async () => config,
      runManager: async (options) => {
        sessions.push(options.sessionId ?? "missing");
        return completed(options.sessionId ?? "missing", `answer ${sessions.length}`);
      },
      createTui: (options) => {
        fakeTui = new FakeTui(options, async (callbacks) => {
          await callbacks.onSubmit?.("first turn");
          await callbacks.onSubmit?.("second turn");
          await callbacks.onExit?.();
        });
        return fakeTui;
      },
    });

    expect(code).toBe(0);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toStartWith("manager-");
    expect(sessions[1]).toBe(sessions[0]);
    expect(fakeTui?.starts).toBe(1);
    expect(fakeTui?.stops).toBe(1);
  });

  test("interactive non-completed status surfaces the stop reason", async () => {
    const { workspace, config } = await fixture();
    let fakeTui: FakeTui | undefined;
    const code = await runCli([], {
      cwd: workspace,
      io: captureIo(),
      loadConfig: async () => config,
      runManager: async (options) => ({
        status: "error",
        turns: 3,
        toolCalls: 2,
        messages: [],
        sessionId: options.sessionId ?? "manager",
        finalText: "partial interactive answer",
        error: "provider exploded",
      }),
      createTui: (options) => {
        fakeTui = new FakeTui(options, async (callbacks) => {
          await callbacks.onSubmit?.("bounded interactive task");
          await callbacks.onExit?.();
        });
        return fakeTui;
      },
    });
    expect(code).toBe(0);
    // The stop reason surfaces as an error (non-completed statuses no longer
    // have a max_turns branch; partial text is not replayed for errors).
    expect(fakeTui?.errors.some((text) => text.includes("stopped with status error"))).toBe(true);
    expect(fakeTui?.errors.some((text) => text.includes("provider exploded"))).toBe(true);
    expect(fakeTui?.errors).toHaveLength(1);
  });

  test("interactive flow passes a stored commandcode sidekick key, never the manager's", async () => {
    const { workspace } = await fixture();
    const config: AgentConfig = {
      dataDir: join(workspace, "data"),
      manager: { provider: "anthropic", model: "claude-sonnet-4-6", thinking: "off" },
      sidekick: { provider: "commandcode", model: "gpt-5.5", thinking: "off" },
      memory: { auto: true },
      security: { injectionWarning: true },
      review: { maxReviewIterations: 2 },
    };
    const previous = process.env.COMMANDCODE_API_KEY;
    delete process.env.COMMANDCODE_API_KEY;
    // Store the sidekick key BEFORE the run so the read never races the write.
    const auth = new AuthStore({ dataDir: config.dataDir, env: {} });
    await auth.setKey("commandcode", "sk-stored-sidekick");
    let received: RunManagerOptions | undefined;
    try {
      const code = await runCli([], {
        cwd: workspace,
        io: captureIo(),
        loadConfig: async () => config,
        createAuthStore: () => auth,
        runManager: async (options) => {
          received = options;
          return completed(options.sessionId ?? "missing");
        },
        createTui: (options) => {
          return new FakeTui(options, async (callbacks) => {
            await callbacks.onSubmit?.("delegate to commandcode sidekick");
            await callbacks.onExit?.();
          });
        },
      });
      expect(code).toBe(0);
    } finally {
      if (previous === undefined) {
        delete process.env.COMMANDCODE_API_KEY;
      } else {
        process.env.COMMANDCODE_API_KEY = previous;
      }
    }
    // The manager (built-in) receives no key; the sidekick gets its own stored key.
    expect(received?.sidekickAuthKey).toBe("sk-stored-sidekick");
    expect(received?.authKey).toBeUndefined();
  });

  test("/provider autocomplete is wired through the TUI by default", async () => {
    const { workspace, config } = await fixture();
    let tuiSuggestProviders: ProviderSuggestionSource | undefined;
    const code = await runCli([], {
      cwd: workspace,
      io: captureIo(),
      loadConfig: async () => config,
      runManager: async (options) => completed(options.sessionId ?? "missing"),
      createTui: (options) => {
        tuiSuggestProviders = options.suggestProviders;
        return new FakeTui(options, async (callbacks) => {
          await callbacks.onExit?.();
        });
      },
    });

    expect(code).toBe(0);
    // Without an injected source, the real provider list is wired so the
    // /provider dropdown shows providers (including the custom commandcode).
    expect(typeof tuiSuggestProviders).toBe("function");
    const providers = await tuiSuggestProviders?.();
    expect(providers?.some((item) => item.id === "commandcode")).toBe(true);
    expect(providers?.some((item) => item.id === "anthropic")).toBe(true);
  });

  test("Escape cancels an active manager run via the abort signal", async () => {
    const { workspace, config } = await fixture();
    let aborted = false;
    let fakeTui: FakeTui | undefined;
    const code = await runCli([], {
      cwd: workspace,
      io: captureIo(),
      loadConfig: async () => config,
      runManager: async (options) => {
        // Simulate a long-running manager that only settles on abort.
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) {
            aborted = true;
            resolve();
            return;
          }
          options.signal?.addEventListener("abort", () => {
            aborted = true;
            resolve();
          }, { once: true });
        });
        return completed(options.sessionId ?? "missing", "never");
      },
      createTui: (options) => {
        fakeTui = new FakeTui(options, async (callbacks) => {
          // Fire onSubmit (don't await — it hangs) then Escape cancels.
          void callbacks.onSubmit?.("slow task");
          await Bun.sleep(10);
          await callbacks.onCancel?.();
          await callbacks.onExit?.();
        });
        return fakeTui;
      },
    });

    expect(code).toBe(0);
    expect(aborted).toBe(true);
  });

  test("explicit memory commands persist, select project scope, and redact secrets", async () => {
    const { workspace, config } = await fixture();
    const memory = new MemoryStore({ dataDir: config.dataDir, workspace });
    const info: string[] = [];
    const errors: string[] = [];
    const options = {
      memory,
      workspace,
      runtime: new AgentRuntime(config),
      showInfo: (text: string) => { info.push(text); },
      showError: (text: string) => { errors.push(text); },
    };

    expect(await handleInteractiveCommand(
      "/memory add user api_key=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890 remember lighthouse",
      options,
    )).toBe(true);
    expect(await handleInteractiveCommand(
      "/memory add project use lighthouse builds",
      options,
    )).toBe(true);
    expect(await handleInteractiveCommand("/memory search lighthouse", options)).toBe(true);
    expect(await handleInteractiveCommand("ordinary manager task", options)).toBe(false);

    const restarted = new MemoryStore({ dataDir: config.dataDir, workspace });
    const user = await restarted.load("user");
    const project = await restarted.load("project");
    expect(user[0]?.content).toContain("[REDACTED]");
    expect(user[0]?.content).not.toContain("sk-proj-");
    expect(project[0]?.content).toBe("use lighthouse builds");
    expect(info[0]).toContain("secret redaction");
    expect(info.at(-1)).toContain("[user]");
    expect(info.at(-1)).toContain("[project]");
    expect(errors).toEqual([]);
  });

  test("/tasks, /task, and /status render the task board", async () => {
    const { workspace, config } = await fixture();
    const board = new TaskBoard();
    const t1 = board.create({ title: "investigate auth", description: "i" });
    const t2 = board.create({
      title: "implement fix",
      description: "impl",
      dependsOn: [t1.id],
    });
    board.transition(t1.id, "completed");
    board.transition(t2.id, "running");
    board.bindSidekick(t2.id, "sidekick-1");

    const info: string[] = [];
    const errors: string[] = [];
    const options = {
      memory: new MemoryStore({ dataDir: config.dataDir, workspace }),
      workspace,
      runtime: new AgentRuntime(config),
      showInfo: (text: string) => { info.push(text); },
      showError: (text: string) => { errors.push(text); },
      taskBoard: () => board,
    };

    expect(await handleInteractiveCommand("/tasks", options)).toBe(true);
    const list = info.at(-1) ?? "";
    expect(list).toContain("✓ T01 investigate auth");
    expect(list).toContain("r T02 implement fix");
    // Running/revising tasks surface their bound sidekick session id.
    expect(list).toContain("sidekick-1");

    expect(await handleInteractiveCommand("/task T02", options)).toBe(true);
    const detail = info.at(-1) ?? "";
    expect(detail).toContain("T02 · implement fix");
    expect(detail).toContain("running");
    expect(detail).toContain("sidekick-1");

    expect(await handleInteractiveCommand("/task T99", options)).toBe(true);
    expect(info.at(-1)).toContain("Unknown task");

    expect(await handleInteractiveCommand("/status", options)).toBe(true);
    const status = info.at(-1) ?? "";
    expect(status).toContain("mimin v0.5.0");
    expect(status).toContain("1 running · 1 completed");
    expect(status).toContain("Sidekicks");
    expect(status).toContain("1 active");
    expect(errors).toEqual([]);
  });

  test("/tasks reports when no task tracking is active", async () => {
    const { workspace, config } = await fixture();
    const info: string[] = [];
    const options = {
      memory: new MemoryStore({ dataDir: config.dataDir, workspace }),
      workspace,
      runtime: new AgentRuntime(config),
      showInfo: (text: string) => { info.push(text); },
      showError: () => {},
    };
    expect(await handleInteractiveCommand("/tasks", options)).toBe(true);
    expect(info.at(-1)).toContain("No task tracking");
  });

  test("/provider shows credential hints and never renders credential values", async () => {
    const { workspace, config } = await fixture();
    const runtime = new AgentRuntime(config);
    const info: string[] = [];
    const errors: string[] = [];
    const options = {
      memory: new MemoryStore({ dataDir: config.dataDir, workspace }),
      workspace,
      runtime,
      showInfo: (text: string) => { info.push(text); },
      showError: (text: string) => { errors.push(text); },
      suggestProviders: async () => [
        { id: "anthropic", configured: true, description: "requires ANTHROPIC_API_KEY" },
        { id: "openai", configured: false, description: "requires OPENAI_API_KEY" },
        { id: "commandcode", configured: false, description: "requires COMMANDCODE_API_KEY" },
      ],
    };

    // /provider lists every provider with its credential hint and state.
    expect(await handleInteractiveCommand("/provider", options)).toBe(true);
    const output = info.at(-1) ?? "";
    expect(output).toContain("anthropic");
    expect(output).toContain("openai");
    expect(output).toContain("commandcode");
    expect(output).toContain("requires ANTHROPIC_API_KEY");
    expect(output).toContain("requires OPENAI_API_KEY");
    expect(output).toContain("requires COMMANDCODE_API_KEY");
    expect(output).toContain("configured");
    expect(output).toContain("not configured");
    // Credential values never leak; the key name is fine.
    expect(output).not.toContain("sk-");
    expect(output).not.toContain("token");
    // The command is informational: runtime and config are untouched.
    expect(runtime.manager.provider).toBe("fake");
    expect(runtime.sidekick.provider).toBe("fake");
    expect(errors).toEqual([]);
  });

  test("/provider shows the configured roles for reference", async () => {
    const { workspace, config } = await fixture();
    const runtime = new AgentRuntime(config);
    const info: string[] = [];
    const errors: string[] = [];
    const options = {
      memory: new MemoryStore({ dataDir: config.dataDir, workspace }),
      workspace,
      runtime,
      showInfo: (text: string) => { info.push(text); },
      showError: (text: string) => { errors.push(text); },
      suggestProviders: async () => [{ id: "openrouter", configured: true }],
    };

    expect(await handleInteractiveCommand("/provider", options)).toBe(true);
    expect(info.at(-1)).toContain("manager fake/manager · sidekick fake/sidekick");
    expect(errors).toEqual([]);
  });

  test("/provider exact id triggers key setup; never switches roles", async () => {
    const { workspace, config } = await fixture();
    const runtime = new AgentRuntime(config);
    const info: string[] = [];
    const errors: string[] = [];
    const options = {
      memory: new MemoryStore({ dataDir: config.dataDir, workspace }),
      workspace,
      runtime,
      showInfo: (text: string) => { info.push(text); },
      showError: (text: string) => { errors.push(text); },
      suggestProviders: async () => [{ id: "openrouter" }],
    };

    // An exact provider id that is not configured (no auth, no env) explains
    // how to configure it; it never switches a role.
    expect(await handleInteractiveCommand("/provider openrouter", options)).toBe(true);
    expect(runtime.manager.provider).toBe("fake");
    expect(runtime.sidekick.provider).toBe("fake");
    expect(info.at(-1)).toContain("openrouter is not configured");
    expect(errors).toEqual([]);

    // Multi-token input is still treated as a filter, never a switch.
    expect(await handleInteractiveCommand("/provider manager openai", options)).toBe(true);
    expect(runtime.manager.provider).toBe("fake");
    expect(runtime.sidekick.provider).toBe("fake");
    expect(info.at(-1)).toContain("Providers matching manager openai");
    expect(info.at(-1)).toContain("(no matching providers)");
    expect(errors).toEqual([]);
  });

  test("/provider exact id prompts for a key when auth is available", async () => {
    const { workspace, config } = await fixture();
    const runtime = new AgentRuntime(config);
    const info: string[] = [];
    const errors: string[] = [];
    let prompted: string | undefined;
    let cancelled = 0;
    const options = {
      memory: new MemoryStore({ dataDir: config.dataDir, workspace }),
      workspace,
      runtime,
      showInfo: (text: string) => { info.push(text); },
      showError: (text: string) => { errors.push(text); },
      suggestProviders: async () => [{ id: "openrouter" }],
      auth: new AuthStore({ dataDir: config.dataDir, env: {} }),
      promptForKey: (provider: string) => { prompted = provider; },
      cancelKeyPrompt: () => { cancelled += 1; },
    };

    // Not configured → masked prompt for the provider id.
    expect(await handleInteractiveCommand("/provider openrouter", options)).toBe(true);
    expect(prompted).toBe("openrouter");
    expect(runtime.manager.provider).toBe("fake");
    expect(errors).toEqual([]);
    expect(cancelled).toBe(0);
  });

  test("/model switches provider+model atomically per role", async () => {
    const { workspace, config } = await fixture();
    const runtime = new AgentRuntime(config);
    const info: string[] = [];
    const errors: string[] = [];
    let refreshed = 0;
    const options = {
      memory: new MemoryStore({ dataDir: config.dataDir, workspace }),
      workspace,
      runtime,
      showInfo: (text: string) => { info.push(text); },
      showError: (text: string) => { errors.push(text); },
      refreshTui: () => { refreshed += 1; },
      suggestModels: async (provider: string) =>
        provider === "openrouter"
          ? [{ provider: "openrouter", id: "gpt-5.5" }, { provider: "openrouter", id: "deepseek/deepseek-v4-flash" }]
          : [{ provider: "fake", id: "manager" }],
      suggestProviders: async () => [
        { id: "fake", configured: true },
        { id: "openrouter", configured: true },
      ],
    };

    // Bare /model shows usage and current selections; no switch.
    expect(await handleInteractiveCommand("/model", options)).toBe(true);
    expect(info.at(-1)).toContain("Usage: /model manager");
    expect(info.at(-1)).toContain("fake/manager");
    expect(runtime.manager.model).toBe("manager");
    expect(refreshed).toBe(0);

    // /model manager <provider> <model> switches both atomically.
    expect(await handleInteractiveCommand("/model manager openrouter gpt-5.5", options)).toBe(true);
    expect(runtime.manager.provider).toBe("openrouter");
    expect(runtime.manager.model).toBe("gpt-5.5");
    expect(info.at(-1)).toContain("fake/manager → openrouter/gpt-5.5");
    expect(refreshed).toBe(1);

    // /model sidekick <provider> <model> switches the sidekick independently.
    expect(await handleInteractiveCommand("/model sidekick openrouter deepseek/deepseek-v4-flash", options)).toBe(true);
    expect(runtime.sidekick.provider).toBe("openrouter");
    expect(runtime.sidekick.model).toBe("deepseek/deepseek-v4-flash");
    expect(info.at(-1)).toContain("Switched sidekick: fake/sidekick → openrouter/deepseek/deepseek-v4-flash");
    expect(refreshed).toBe(2);

    // /model <role> alone lists aggregated models from configured providers.
    expect(await handleInteractiveCommand("/model manager", options)).toBe(true);
    expect(info.at(-1)).toContain("gpt-5.5");
    expect(info.at(-1)).toContain("deepseek/deepseek-v4-flash");
    expect(info.at(-1)).toContain("openrouter");
    expect(runtime.manager.model).toBe("gpt-5.5");

    // Back-compat single model id: interpreted against the role's current provider.
    // Manager is currently openrouter, so "gpt-5.5" resolves to openrouter/gpt-5.5.
    expect(await handleInteractiveCommand("/model manager gpt-5.5", options)).toBe(true);
    expect(runtime.manager.provider).toBe("openrouter");
    expect(runtime.manager.model).toBe("gpt-5.5");

    // Unknown provider/model pair is rejected; nothing mutates.
    expect(await handleInteractiveCommand("/model manager openai gpt-9.9", options)).toBe(true);
    expect(errors.at(-1)).toContain("is not available on provider openai");
    expect(runtime.manager.provider).toBe("openrouter");
    expect(runtime.manager.model).toBe("gpt-5.5");
    expect(refreshed).toBe(3);
    expect(errors.length).toBe(1);
  });

  test("/model aggregated dropdown only includes configured providers", async () => {
    const { workspace, config } = await fixture();
    const runtime = new AgentRuntime(config);
    const info: string[] = [];
    const errors: string[] = [];
    const options = {
      memory: new MemoryStore({ dataDir: config.dataDir, workspace }),
      workspace,
      runtime,
      showInfo: (text: string) => { info.push(text); },
      showError: (text: string) => { errors.push(text); },
      suggestModels: async (provider: string) =>
        provider === "commandcode"
          ? [{ provider: "commandcode", id: "gpt-5.6-sol" }]
          : provider === "openrouter"
            ? [{ provider: "openrouter", id: "anthropic/claude-sonnet-x" }]
            : [],
      suggestProviders: async () => [
        { id: "commandcode", configured: true },
        { id: "openrouter", configured: true },
        { id: "anthropic", configured: false },
        { id: "openai", configured: false },
      ],
    };

    await handleInteractiveCommand("/model sidekick", options);
    const text = info.at(-1) ?? "";
    // Configured providers' models appear.
    expect(text).toContain("gpt-5.6-sol");
    expect(text).toContain("anthropic/claude-sonnet-x");
    // Unconfigured providers' models are absent.
    expect(text).not.toContain("claude-sonnet-4-6");
    expect(errors).toEqual([]);
  });

  test("/model keeps duplicate model ids distinct by provider", async () => {
    const { workspace, config } = await fixture();
    const runtime = new AgentRuntime(config);
    const info: string[] = [];
    const errors: string[] = [];
    const options = {
      memory: new MemoryStore({ dataDir: config.dataDir, workspace }),
      workspace,
      runtime,
      showInfo: (text: string) => { info.push(text); },
      showError: (text: string) => { errors.push(text); },
      suggestModels: async (provider: string) =>
        provider === "provider-a" || provider === "provider-b"
          ? [{ provider, id: "shared-model" }]
          : [],
      suggestProviders: async () => [
        { id: "provider-a", configured: true },
        { id: "provider-b", configured: true },
      ],
    };

    // Select the same model id on provider-b; provider must be preserved.
    expect(await handleInteractiveCommand("/model manager provider-b shared-model", options)).toBe(true);
    expect(runtime.manager.provider).toBe("provider-b");
    expect(runtime.manager.model).toBe("shared-model");
    // Selecting provider-a's copy moves the provider.
    expect(await handleInteractiveCommand("/model manager provider-a shared-model", options)).toBe(true);
    expect(runtime.manager.provider).toBe("provider-a");
    expect(runtime.manager.model).toBe("shared-model");
    expect(errors).toEqual([]);
  });

  test("/model includes commandcode models when auth.json has the key (no env)", async () => {
    const { workspace, config } = await fixture();
    const runtime = new AgentRuntime(config);
    const info: string[] = [];
    const errors: string[] = [];
    // auth.json holds the commandcode key; no COMMANDCODE_API_KEY env var.
    const auth = new AuthStore({ dataDir: config.dataDir, env: {} });
    await auth.setKey("commandcode", "sk-stored-key");
    const options = {
      memory: new MemoryStore({ dataDir: config.dataDir, workspace }),
      workspace,
      runtime,
      showInfo: (text: string) => { info.push(text); },
      showError: (text: string) => { errors.push(text); },
      auth,
      suggestModels: async (provider: string) =>
        provider === "commandcode"
          ? [{ provider: "commandcode", id: "gpt-5.6-sol" }]
          : [],
      // The default provider source in runInteractive uses suggestProvidersWithAuth;
      // simulate that here.
      suggestProviders: async () => [
        { id: "commandcode", configured: true },
      ],
    };

    await handleInteractiveCommand("/model manager", options);
    const text = info.at(-1) ?? "";
    expect(text).toContain("gpt-5.6-sol");
    expect(text).not.toContain("sk-stored-key");
    expect(errors).toEqual([]);
  });

  test("/model aggregation survives a failing provider catalog", async () => {
    const { workspace, config } = await fixture();
    const runtime = new AgentRuntime(config);
    const info: string[] = [];
    const errors: string[] = [];
    const options = {
      memory: new MemoryStore({ dataDir: config.dataDir, workspace }),
      workspace,
      runtime,
      showInfo: (text: string) => { info.push(text); },
      showError: (text: string) => { errors.push(text); },
      suggestModels: async (provider: string) => {
        if (provider === "broken") throw new Error("catalog down");
        return [{ provider, id: `model-${provider}` }];
      },
      suggestProviders: async () => [
        { id: "broken", configured: true },
        { id: "good", configured: true },
      ],
    };

    await handleInteractiveCommand("/model manager", options);
    const text = info.at(-1) ?? "";
    // The working provider's model is present despite the broken catalog.
    expect(text).toContain("model-good");
    // The broken provider contributes nothing; no error surfaced.
    expect(text).not.toContain("model-broken");
    expect(errors).toEqual([]);
  });

  test("/session restores a previous manager session", async () => {
    const { workspace, config } = await fixture();
    const runtime = new AgentRuntime(config);
    const info: string[] = [];
    const errors: string[] = [];
    let current = "manager-new";
    const options = {
      memory: new MemoryStore({ dataDir: config.dataDir, workspace }),
      workspace,
      runtime,
      showInfo: (text: string) => { info.push(text); },
      showError: (text: string) => { errors.push(text); },
      restoreSession: async (id: string) => {
        if (id === "manager-old") {
          current = id;
          return id;
        }
        return undefined;
      },
    };

    // Bare /session shows usage.
    expect(await handleInteractiveCommand("/session", options)).toBe(true);
    expect(info.at(-1)).toContain("Usage: /session <session-id>");
    expect(current).toBe("manager-new");

    // /session <id> restores an existing session.
    expect(await handleInteractiveCommand("/session manager-old", options)).toBe(true);
    expect(current).toBe("manager-old");
    expect(info.at(-1)).toContain("Restored manager session manager-old");

    // Unknown session shows an error and does not restore.
    expect(await handleInteractiveCommand("/session manager-none", options)).toBe(true);
    expect(current).toBe("manager-old");
    expect(errors.at(-1)).toContain("No manager session found");
  });
});
