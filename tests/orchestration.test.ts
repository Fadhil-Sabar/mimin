import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ToolCall,
} from "@mariozechner/pi-ai";
import type { AgentConfig } from "../src/config.js";
import { createManagerTools, runManager } from "../src/agent/manager.js";
import {
  createSidekickTools,
  parseSidekickResult,
  runSidekick,
  type SidekickResult,
} from "../src/agent/sidekick.js";
import { SessionStore } from "../src/session/session.js";
import { createDelegateTool } from "../src/tools/delegate.js";
import type { AnyAgentTool, ToolExecutionContext } from "../src/agent/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function fixture(): Promise<{ workspace: string; dataDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "mimin-orchestration-"));
  temporaryDirectories.push(root);
  const workspace = join(root, "workspace");
  const dataDir = join(root, "data");
  await Bun.write(join(workspace, ".keep"), "fixture");
  return { workspace, dataDir };
}

const model: Model<Api> = {
  id: "fake-model",
  name: "Fake Model",
  api: "fake-api",
  provider: "fake-provider",
  baseUrl: "http://localhost.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096,
  maxTokens: 1024,
};

const config = (dataDir: string): AgentConfig => ({
  dataDir,
  manager: { provider: "fake-provider", model: "manager", thinking: "off" },
  sidekick: { provider: "fake-provider", model: "sidekick", thinking: "off" },
  memory: { auto: true },
});

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function completedStream(message: AssistantMessage): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  stream.push({
    type: "done",
    reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
    message,
  });
  return stream;
}

function result(
  status: SidekickResult["status"],
  sessionId: string,
  summary: string = status,
): SidekickResult {
  return {
    status,
    summary,
    filesChanged: status === "complete" ? [`${sessionId}.ts`] : [],
    verification: [],
    sessionId,
  };
}

function executionContext(
  toolName: string,
  signal?: AbortSignal,
): ToolExecutionContext {
  const toolCall: ToolCall = {
    type: "toolCall",
    id: `call-${toolName}`,
    name: toolName,
    arguments: {},
  };
  return { model, turn: 1, toolCall, ...(signal ? { signal } : {}) };
}

async function execute(
  tool: AnyAgentTool,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) {
  return tool.execute(args, executionContext(tool.name, signal));
}

describe("role permission boundaries", () => {
  test("manager production tools are exactly read, delegate, retrieval, and verification", async () => {
    const { workspace, dataDir } = await fixture();
    const names = createManagerTools({
      workspace,
      config: config(dataDir),
      sidekickModel: model,
    }).map((tool) => tool.name);

    expect(names).toEqual([
      "read",
      "delegate",
      "memory_search",
      "session_search",
      "verification",
    ]);
    expect(names).not.toContain("edit");
    expect(names).not.toContain("write");
    expect(names).not.toContain("bash");
  });

  test("sidekick production tools are exactly read, edit, and bash", async () => {
    const { workspace } = await fixture();
    const names = createSidekickTools(workspace).map((tool) => tool.name);

    expect(names).toEqual(["read", "edit", "bash"]);
    expect(names).not.toContain("delegate");
  });
});

describe("isolated compact sidekick results", () => {
  test("every delegation creates a distinct session with only its task as inherited input", async () => {
    const { workspace, dataDir } = await fixture();
    const store = new SessionStore({ root: join(dataDir, "sessions") });
    const manager = await store.createSession("manager");
    await manager.append({ role: "user", content: "manager secret", timestamp: 1 });
    const stream = (_model: Model<Api>, context: Context) => {
      const task = context.messages[0]?.role === "user"
        ? String(context.messages[0].content)
        : "missing";
      return completedStream(
        assistant([{ type: "text", text: JSON.stringify({
          status: "complete",
          summary: `done ${task}`,
          filesChanged: [],
          verification: [],
        }) }]),
      );
    };

    const first = await runSidekick({
      task: "task one",
      workspace,
      config: config(dataDir).sidekick,
      sessionStore: store,
      model,
      stream,
    });
    const second = await runSidekick({
      task: "task two",
      workspace,
      config: config(dataDir).sidekick,
      sessionStore: store,
      model,
      stream,
    });

    expect(first.sessionId).not.toBe(second.sessionId);
    const firstMessages = (await store.loadSession("sidekick", first.sessionId)).messages;
    const secondMessages = (await store.loadSession("sidekick", second.sessionId)).messages;
    expect(firstMessages[0]).toMatchObject({ role: "user", content: "task one" });
    expect(secondMessages[0]).toMatchObject({ role: "user", content: "task two" });
    expect(JSON.stringify(firstMessages)).not.toContain("manager secret");
    expect(JSON.stringify(secondMessages)).not.toContain("manager secret");
  });

  test("delegate whitelists compact fields and drops transcripts and logs", async () => {
    const leaked = result("complete", "sidekick-1", "safe summary") as SidekickResult & {
      messages: unknown[];
      commandLogs: string;
      fileContents: string;
    };
    leaked.messages = [{ role: "assistant", content: "SIDEKICK TRANSCRIPT" }];
    leaked.commandLogs = "FULL COMMAND LOG";
    leaked.fileContents = "PRIVATE FILE CONTENT";
    const delegate = createDelegateTool({ run: async () => leaked });
    const output = await execute(delegate, { task: "self-contained task" });
    const serialized = JSON.stringify(output);

    expect(serialized).toContain("safe summary");
    expect(serialized).not.toContain("SIDEKICK TRANSCRIPT");
    expect(serialized).not.toContain("FULL COMMAND LOG");
    expect(serialized).not.toContain("PRIVATE FILE CONTENT");
  });

  test("normalizes all statuses and gracefully falls back for invalid JSON", () => {
    for (const status of [
      "complete",
      "partial",
      "blocked",
      "needs_decision",
    ] as const) {
      expect(
        parseSidekickResult(
          JSON.stringify({
            status,
            summary: `status ${status}`,
            filesChanged: ["src/a.ts"],
            verification: [{ command: "bun test", status: "passed" }],
          }),
          { sessionId: `session-${status}`, runStatus: "completed" },
        ),
      ).toMatchObject({
        status,
        summary: `status ${status}`,
        filesChanged: ["src/a.ts"],
        verification: [{ command: "bun test", status: "passed" }],
      });
    }

    expect(
      parseSidekickResult("not-json", {
        sessionId: "fallback",
        runStatus: "completed",
        observedFiles: ["src/observed.ts"],
      }),
    ).toMatchObject({
      status: "partial",
      filesChanged: ["src/observed.ts"],
      sessionId: "fallback",
      detail: "The final response was not valid sidekick result JSON.",
    });
    expect(
      parseSidekickResult("", {
        sessionId: "failed",
        runStatus: "error",
        runError: "provider failed",
      }),
    ).toMatchObject({ status: "blocked", error: "provider failed" });
  });
});

describe("manager correction and bounded delegation", () => {
  test("two sequential delegate calls can perform a model-driven correction loop", async () => {
    const { workspace, dataDir } = await fixture();
    const delegatedTasks: string[] = [];
    let sidekickCall = 0;
    const sidekickRunner = async (task: string): Promise<SidekickResult> => {
      delegatedTasks.push(task);
      sidekickCall += 1;
      return sidekickCall === 1
        ? result("partial", "sidekick-first", "test failed")
        : result("complete", "sidekick-correction", "fixed and verified");
    };
    const responses = [
      assistant([
        {
          type: "toolCall",
          id: "delegate-first",
          name: "delegate",
          arguments: { task: "Implement feature and run tests" },
        },
      ], "toolUse"),
      assistant([
        {
          type: "toolCall",
          id: "delegate-correction",
          name: "delegate",
          arguments: { task: "Correct the failed test and verify the feature" },
        },
      ], "toolUse"),
      assistant([{ type: "text", text: "Reviewed correction; complete." }]),
    ];
    const managerContexts: Context[] = [];
    const stream = (_model: Model<Api>, context: Context) => {
      managerContexts.push(structuredClone(context));
      const response = responses.shift();
      if (!response) throw new Error("unexpected manager turn");
      return completedStream(response);
    };

    const managerResult = await runManager({
      input: "Build the feature",
      workspace,
      config: config(dataDir),
      model,
      stream,
      sidekickRunner,
    });

    expect(managerResult.status).toBe("completed");
    expect(managerResult.toolCalls).toBe(2);
    expect(delegatedTasks).toEqual([
      "Implement feature and run tests",
      "Correct the failed test and verify the feature",
    ]);
    expect(JSON.stringify(managerContexts[1]?.messages)).toContain('"status":"partial"');
    expect(JSON.stringify(managerContexts[2]?.messages)).toContain('"status":"complete"');
    expect(managerResult.finalText).toBe("Reviewed correction; complete.");
  });

  test("task arrays run concurrently, preserve order, and hard-cap at three", async () => {
    let active = 0;
    let maximumActive = 0;
    const completionOrder: number[] = [];
    const delegate = createDelegateTool({
      maxConcurrency: 99,
      run: async (_task, context) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Bun.sleep((6 - context.index) * 5);
        completionOrder.push(context.index);
        active -= 1;
        return result("complete", `session-${context.index}`, `result-${context.index}`);
      },
    });

    const output = await execute(delegate, {
      task: Array.from({ length: 7 }, (_, index) => `task-${index}`),
    });
    if (typeof output === "string") throw new Error("expected structured tool output");
    const parsed = JSON.parse(output.text) as SidekickResult[];

    expect(maximumActive).toBe(3);
    expect(completionOrder).not.toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(parsed.map((entry) => entry.summary)).toEqual([
      "result-0",
      "result-1",
      "result-2",
      "result-3",
      "result-4",
      "result-5",
      "result-6",
    ]);
  });

  test("aborting the manager signal stops the delegate from dispatching further tasks", async () => {
    const controller = new AbortController();
    const started: number[] = [];
    const delegate = createDelegateTool({
      maxConcurrency: 3,
      run: async (_task, context) => {
        started.push(context.index);
        await Bun.sleep(50);
        return result("complete", `session-${context.index}`, `result-${context.index}`);
      },
    });

    const outputPromise = execute(
      delegate,
      { task: Array.from({ length: 9 }, (_, index) => `task-${index}`) },
      controller.signal,
    );
    // Let the first three start, then abort.
    await Bun.sleep(10);
    controller.abort();
    const output = await outputPromise;
    if (typeof output === "string") throw new Error("expected structured tool output");
    const parsed = JSON.parse(output.text) as SidekickResult[];

    // Aborted tasks are never dispatched; the workers stop after the signal.
    expect(started.length).toBeLessThan(9);
    expect(parsed.some((entry) => entry.status === "blocked")).toBe(true);
  });
});

describe("commandcode env credential forwarding", () => {
  test("runManager forwards COMMANDCODE_API_KEY into run options", async () => {
    const { workspace, dataDir } = await fixture();
    const previous = process.env.COMMANDCODE_API_KEY;
    process.env.COMMANDCODE_API_KEY = "sk-manager-test";
    let received: Record<string, unknown> | undefined;
    try {
      const managerResult = await runManager({
        input: "forward the key",
        workspace,
        config: {
          dataDir,
          manager: { provider: "commandcode", model: "gpt-5.5", thinking: "off" },
          sidekick: { provider: "anthropic", model: "claude-sonnet-4-6", thinking: "low" },
          memory: { auto: true },
        },
        modelResolver: () => ({
          id: "gpt-5.5",
          name: "Command Code gpt-5.5",
          api: "openai-completions",
          provider: "commandcode",
          baseUrl: "https://api.commandcode.ai/provider/v1",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 16_384,
        }),
        run: async (options) => {
          received = options.config as Record<string, unknown>;
          return {
            status: "completed",
            turns: 1,
            toolCalls: 0,
            messages: [],
          };
        },
      });
      expect(managerResult.status).toBe("completed");
    } finally {
      if (previous === undefined) {
        delete process.env.COMMANDCODE_API_KEY;
      } else {
        process.env.COMMANDCODE_API_KEY = previous;
      }
    }
    expect(received?.apiKey).toBe("sk-manager-test");
  });

  test("built-in manager receives no apiKey even with COMMANDCODE_API_KEY set", async () => {
    const { workspace, dataDir } = await fixture();
    const previous = process.env.COMMANDCODE_API_KEY;
    process.env.COMMANDCODE_API_KEY = "sk-must-not-leak";
    let received: Record<string, unknown> | undefined;
    try {
      const managerResult = await runManager({
        input: "isolate the credential",
        workspace,
        config: {
          dataDir,
          manager: { provider: "anthropic", model: "claude-sonnet-4-6", thinking: "off" },
          sidekick: { provider: "anthropic", model: "claude-sonnet-4-6", thinking: "low" },
          memory: { auto: true },
        },
        modelResolver: () => ({
          id: "claude-sonnet-4-6",
          name: "Claude Sonnet 4.6",
          api: "anthropic-messages",
          provider: "anthropic",
          baseUrl: "https://api.anthropic.com",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 64_000,
        }),
        run: async (options) => {
          received = options.config as Record<string, unknown>;
          return {
            status: "completed",
            turns: 1,
            toolCalls: 0,
            messages: [],
          };
        },
      });
      expect(managerResult.status).toBe("completed");
    } finally {
      if (previous === undefined) {
        delete process.env.COMMANDCODE_API_KEY;
      } else {
        process.env.COMMANDCODE_API_KEY = previous;
      }
    }
    expect(received?.apiKey).toBeUndefined();
  });

  test("built-in sidekick receives no apiKey even with COMMANDCODE_API_KEY set", async () => {
    const { workspace, dataDir } = await fixture();
    const previous = process.env.COMMANDCODE_API_KEY;
    process.env.COMMANDCODE_API_KEY = "sk-must-not-leak";
    let received: Record<string, unknown> | undefined;
    try {
      const result = await runSidekick({
        task: "isolate the credential",
        workspace,
        config: { provider: "anthropic", model: "claude-sonnet-4-6", thinking: "off" },
        dataDir,
        modelResolver: () => ({
          id: "claude-sonnet-4-6",
          name: "Claude Sonnet 4.6",
          api: "anthropic-messages",
          provider: "anthropic",
          baseUrl: "https://api.anthropic.com",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 64_000,
        }),
        run: async (options) => {
          received = options.config as Record<string, unknown>;
          return {
            status: "completed",
            turns: 1,
            toolCalls: 0,
            messages: [],
            finalMessage: {
              role: "assistant",
              content: [{ type: "text", text: JSON.stringify({
                status: "complete",
                summary: "done",
                filesChanged: [],
                verification: [],
              }) }],
              api: "anthropic-messages",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "stop",
              timestamp: Date.now(),
            },
          };
        },
      });
      expect(result.status).toBe("complete");
    } finally {
      if (previous === undefined) {
        delete process.env.COMMANDCODE_API_KEY;
      } else {
        process.env.COMMANDCODE_API_KEY = previous;
      }
    }
    expect(received?.apiKey).toBeUndefined();
  });

  test("runSidekick uses a stored key for a commandcode sidekick when env is absent", async () => {
    const { workspace, dataDir } = await fixture();
    const previous = process.env.COMMANDCODE_API_KEY;
    delete process.env.COMMANDCODE_API_KEY;
    let received: Record<string, unknown> | undefined;
    try {
      const result = await runSidekick({
        task: "use the stored key",
        workspace,
        config: { provider: "commandcode", model: "gpt-5.5", thinking: "off" },
        dataDir,
        authKey: "sk-stored-sidekick",
        modelResolver: () => ({
          id: "gpt-5.5",
          name: "Command Code gpt-5.5",
          api: "openai-completions",
          provider: "commandcode",
          baseUrl: "https://api.commandcode.ai/provider/v1",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 16_384,
        }),
        run: async (options) => {
          received = options.config as Record<string, unknown>;
          return {
            status: "completed",
            turns: 1,
            toolCalls: 0,
            messages: [],
            finalMessage: {
              role: "assistant",
              content: [{ type: "text", text: JSON.stringify({
                status: "complete",
                summary: "done",
                filesChanged: [],
                verification: [],
              }) }],
              api: "openai-completions",
              provider: "commandcode",
              model: "gpt-5.5",
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "stop",
              timestamp: Date.now(),
            },
          };
        },
      });
      expect(result.status).toBe("complete");
    } finally {
      if (previous === undefined) {
        delete process.env.COMMANDCODE_API_KEY;
      } else {
        process.env.COMMANDCODE_API_KEY = previous;
      }
    }
    // The stored sidekick key reaches the run config without an env var.
    expect(received?.apiKey).toBe("sk-stored-sidekick");
  });

  test("createManagerTools forwards sidekickAuthKey into the delegated sidekick run", async () => {
    const { workspace, dataDir } = await fixture();
    const previous = process.env.COMMANDCODE_API_KEY;
    delete process.env.COMMANDCODE_API_KEY;
    let sidekickConfig: Record<string, unknown> | undefined;
    const sidekickRun = async (options: {
      config?: Record<string, unknown>;
    }) => {
      sidekickConfig = options.config as Record<string, unknown>;
      return {
        status: "completed",
        turns: 1,
        toolCalls: 0,
        messages: [],
        finalMessage: {
          role: "assistant",
          content: [{ type: "text", text: JSON.stringify({
            status: "complete",
            summary: "done",
            filesChanged: [],
            verification: [],
          }) }],
          api: "openai-completions",
          provider: "commandcode",
          model: "gpt-5.5",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        },
      };
    };
    try {
      const managerTools = createManagerTools({
        workspace,
        config: {
          dataDir,
          manager: { provider: "commandcode", model: "gpt-5.5", thinking: "off" },
          sidekick: { provider: "commandcode", model: "gpt-5.5", thinking: "off" },
          memory: { auto: true },
        },
        sidekickAuthKey: "sk-sidekick-only",
        sidekickRun: sidekickRun as never,
      });
      const delegateTool = managerTools.find((tool) => tool.name === "delegate");
      expect(delegateTool).toBeDefined();
      // Drive the delegate tool so the runner calls runSidekick with authKey.
      await (delegateTool!.execute as (
        args: Record<string, unknown>,
        context: ToolExecutionContext,
      ) => Promise<unknown>)(
        { task: "use the stored key" },
        {
          model: {} as never,
          turn: 1,
          toolCall: {} as never,
        } as ToolExecutionContext,
      );
      expect(sidekickConfig?.apiKey).toBe("sk-sidekick-only");
    } finally {
      if (previous === undefined) {
        delete process.env.COMMANDCODE_API_KEY;
      } else {
        process.env.COMMANDCODE_API_KEY = previous;
      }
    }
  });

  test("createManagerTools forwards only the sidekick's own key (provider isolation)", async () => {
    const { workspace, dataDir } = await fixture();
    const previous = process.env.COMMANDCODE_API_KEY;
    delete process.env.COMMANDCODE_API_KEY;
    let sidekickConfig: Record<string, unknown> | undefined;
    const sidekickRun = async (options: {
      config?: Record<string, unknown>;
    }) => {
      sidekickConfig = options.config as Record<string, unknown>;
      return {
        status: "completed",
        turns: 1,
        toolCalls: 0,
        messages: [],
        finalMessage: {
          role: "assistant",
          content: [{ type: "text", text: JSON.stringify({
            status: "complete",
            summary: "done",
            filesChanged: [],
            verification: [],
          }) }],
          api: "openai-completions",
          provider: "commandcode",
          model: "gpt-5.5",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        },
      };
    };
    try {
      const managerTools = createManagerTools({
        workspace,
        config: {
          dataDir,
          manager: { provider: "anthropic", model: "claude-sonnet-4-6", thinking: "off" },
          sidekick: { provider: "commandcode", model: "gpt-5.5", thinking: "off" },
          memory: { auto: true },
        },
        // The tools layer only ever forwards the sidekick's own key; the
        // manager's key never enters this path (it lives on runManager).
        sidekickAuthKey: "sk-sidekick-key",
        sidekickRun: sidekickRun as never,
      });
      const delegateTool = managerTools.find((tool) => tool.name === "delegate");
      expect(delegateTool).toBeDefined();
      await (delegateTool!.execute as (
        args: Record<string, unknown>,
        context: ToolExecutionContext,
      ) => Promise<unknown>)(
        { task: "isolate keys" },
        {
          model: {} as never,
          turn: 1,
          toolCall: {} as never,
        } as ToolExecutionContext,
      );
      // The sidekick receives ONLY its own stored key, never the manager's.
      expect(sidekickConfig?.apiKey).toBe("sk-sidekick-key");
    } finally {
      if (previous === undefined) {
        delete process.env.COMMANDCODE_API_KEY;
      } else {
        process.env.COMMANDCODE_API_KEY = previous;
      }
    }
  });
});
