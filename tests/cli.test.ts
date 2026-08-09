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
import { MemoryStore } from "../src/memory/store.js";
import { SessionStore } from "../src/session/session.js";
import type { AgentTuiOptions } from "../src/tui/app.js";

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
    expect(io.out).toContain("Usage: agent");
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

  test("Escape cancels an active manager run via the abort signal", async () => {
    const { workspace, config } = await fixture();
    let aborted = false;
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
        return new FakeTui(options, async (callbacks) => {
          // Fire onSubmit (don't await — it hangs) then Escape cancels.
          void callbacks.onSubmit?.("slow task");
          await Bun.sleep(10);
          await callbacks.onCancel?.();
          await callbacks.onExit?.();
        });
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

  test("/model switches the manager and sidekick model at runtime", async () => {
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
      suggestModels: async () => [{ id: "gpt-5.5" }, { id: "deepseek/deepseek-v4-flash" }],
    };

    // Bare /model shows usage and current models; no switch.
    expect(await handleInteractiveCommand("/model", options)).toBe(true);
    expect(info.at(-1)).toContain("Usage: /model manager");
    expect(info.at(-1)).toContain("fake/manager");
    expect(runtime.manager.model).toBe("manager");
    expect(refreshed).toBe(0);

    // /model manager <id> switches and refreshes the TUI.
    expect(await handleInteractiveCommand("/model manager gpt-5.5", options)).toBe(true);
    expect(runtime.manager.model).toBe("gpt-5.5");
    expect(runtime.manager.provider).toBe("fake");
    expect(info.at(-1)).toContain("manager → fake/gpt-5.5");
    expect(refreshed).toBe(1);

    // /model sidekick <id> switches the sidekick.
    expect(await handleInteractiveCommand("/model sidekick deepseek/deepseek-v4-flash", options)).toBe(true);
    expect(runtime.sidekick.model).toBe("deepseek/deepseek-v4-flash");
    expect(info.at(-1)).toContain("sidekick → fake/deepseek/deepseek-v4-flash");
    expect(refreshed).toBe(2);

    // /model <role> alone lists suggestions for that role's provider.
    expect(await handleInteractiveCommand("/model sidekick", options)).toBe(true);
    expect(info.at(-1)).toContain("gpt-5.5");
    expect(info.at(-1)).toContain("deepseek/deepseek-v4-flash");
    expect(runtime.sidekick.model).toBe("deepseek/deepseek-v4-flash");

    // Unknown role shows usage, does not switch.
    expect(await handleInteractiveCommand("/model nope whatever", options)).toBe(true);
    expect(info.at(-1)).toContain("Usage: /model manager");
    expect(runtime.manager.model).toBe("gpt-5.5");
    expect(refreshed).toBe(2);
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
