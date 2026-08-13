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
import { VerificationFailureTracker } from "../src/tools/verification.js";
import {
  DelegationTracker,
  gitWorkspaceState,
  normalizeDelegationTask,
  type DelegationAttempt,
  type DelegationCompletion,
  type DelegationReservation,
  type DelegationStartResult,
} from "../src/tools/delegation-tracker.js";
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

async function git(workspace: string, args: string[]): Promise<void> {
  const process = Bun.spawn(["git", ...args], {
    cwd: workspace,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(await process.exited).toBe(0);
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
  turn = 1,
): ToolExecutionContext {
  const toolCall: ToolCall = {
    type: "toolCall",
    id: `call-${toolName}`,
    name: toolName,
    arguments: {},
  };
  return { model, turn, toolCall, ...(signal ? { signal } : {}) };
}

async function execute(
  tool: AnyAgentTool,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  turn?: number,
) {
  return tool.execute(args, executionContext(tool.name, signal, turn));
}

/**
 * Test-only tracker that records every start/finish/cancel transition without
 * changing the production lifecycle semantics. Used to assert the exact
 * bookkeeping surface the delegate worker is allowed to touch.
 */
class RecordingDelegationTracker extends DelegationTracker {
  readonly starts: string[] = [];
  readonly finishes: { fingerprint: string; completion: DelegationCompletion }[] = [];
  readonly cancels: string[] = [];
  readonly failedStarts: { fingerprint: string; reason: string }[] = [];

  override async start(
    reservation: DelegationReservation,
  ): Promise<DelegationStartResult> {
    const outcome = await super.start(reservation);
    if (outcome.allowed) {
      this.starts.push(reservation.fingerprint);
    } else {
      this.failedStarts.push({ fingerprint: reservation.fingerprint, reason: outcome.reason });
    }
    return outcome;
  }

  override async finish(attempt: DelegationAttempt): Promise<DelegationCompletion> {
    const completion = await super.finish(attempt);
    this.finishes.push({ fingerprint: attempt.fingerprint, completion });
    return completion;
  }

  override cancel(item: DelegationReservation): void {
    this.cancels.push(item.fingerprint);
    super.cancel(item);
  }
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
  test("normalizes equivalent task contracts deterministically", () => {
    expect(normalizeDelegationTask("Fix auth tests")).toBe("fix auth tests");
    expect(normalizeDelegationTask("  fix   AUTH tests  ")).toBe("fix auth tests");
  });

  test("detects same-line content changes in the fixed Git workspace signal", async () => {
    const { workspace } = await fixture();
    await git(workspace, ["init", "--quiet"]);
    await git(workspace, ["add", ".keep"]);
    await git(workspace, [
      "-c", "user.name=mimin test",
      "-c", "user.email=mimin@example.invalid",
      "commit", "--quiet", "-m", "initial",
    ]);
    const reader = gitWorkspaceState(workspace);

    await Bun.write(join(workspace, ".keep"), "alpha\n");
    const alpha = await reader.read();
    await Bun.write(join(workspace, ".keep"), "bravo\n");
    const bravo = await reader.read();

    // Both diffs replace one line, so a numstat-only signal would collide.
    expect(alpha).toBeDefined();
    expect(bravo).toBeDefined();
    expect(bravo).not.toBe(alpha);
  });

  test("skips duplicate equivalent tasks in the same parallel delegation batch", async () => {
    let launches = 0;
    const tracker = new DelegationTracker({
      workspaceState: { read: async () => "unchanged" },
    });
    const delegate = createDelegateTool({
      tracker,
      run: async (_task, context) => {
        launches += 1;
        await Bun.sleep(10);
        return result("partial", `session-${context.index}`, "still failing");
      },
    });

    const output = await execute(delegate, {
      task: ["Fix auth tests", "  fix   AUTH tests  "],
    });
    if (typeof output === "string") throw new Error("expected structured tool output");
    const parsed = JSON.parse(output.text) as SidekickResult[];

    expect(launches).toBe(1);
    expect(parsed[0]?.status).toBe("partial");
    expect(parsed[1]).toMatchObject({
      status: "blocked",
      summary: "Delegation skipped: an equivalent task was already dispatched in this manager response.",
    });
  });

  test("blocks the fourth equivalent no-progress delegation but allows three attempts", async () => {
    let launches = 0;
    const tracker = new DelegationTracker({
      workspaceState: { read: async () => "unchanged" },
    });
    const delegate = createDelegateTool({
      tracker,
      run: async (_task, context) => {
        launches += 1;
        return result("partial", `session-${context.index}`, "verification still fails");
      },
    });

    const first = await execute(delegate, { task: "Fix auth tests" }, undefined, 1);
    const second = await execute(delegate, { task: " fix   auth tests " }, undefined, 2);
    const third = await execute(delegate, { task: "FIX AUTH TESTS" }, undefined, 3);
    const blocked = await execute(delegate, { task: "Fix auth tests" }, undefined, 4);

    expect(launches).toBe(3);
    expect(JSON.stringify(first)).toContain("(1/3)");
    expect(JSON.stringify(second)).toContain("(2/3)");
    expect(JSON.stringify(third)).toContain("(3/3)");
    expect(blocked).toMatchObject({ isError: false });
    expect(JSON.stringify(blocked)).toContain("already been attempted 3 times");
  });

  test("keeps retry state scoped to one manager run and returns the block to the manager", async () => {
    const { workspace, dataDir } = await fixture();
    let launches = 0;
    const tracker = new DelegationTracker({
      workspaceState: { read: async () => "unchanged" },
    });
    const responses = [
      "Fix auth tests",
      " fix   AUTH tests ",
      "FIX AUTH TESTS",
      "Fix auth tests",
    ].map((task, index) => assistant([
      {
        type: "toolCall",
        id: `delegate-${index}`,
        name: "delegate",
        arguments: { task },
      },
    ], "toolUse"));
    responses.push(assistant([{ type: "text", text: "Stopped retrying." }]));
    const contexts: Context[] = [];
    const stream = (_model: Model<Api>, context: Context) => {
      contexts.push(structuredClone(context));
      const response = responses.shift();
      if (!response) throw new Error("unexpected manager turn");
      return completedStream(response);
    };

    const output = await runManager({
      input: "Fix the auth tests",
      workspace,
      config: config(dataDir),
      model,
      stream,
      delegationTracker: tracker,
      sidekickRunner: async (_task, context) => {
        launches += 1;
        return result("partial", `session-${context.index}`, "still failing");
      },
    });

    expect(output.status).toBe("completed");
    expect(launches).toBe(3);
    expect(JSON.stringify(contexts[4]?.messages)).toContain(
      "already been attempted 3 times",
    );
  });

  test("uses the default fixed Git signal to block repeated no-progress manager delegation", async () => {
    const { workspace, dataDir } = await fixture();
    await git(workspace, ["init", "--quiet"]);
    await git(workspace, ["add", ".keep"]);
    await git(workspace, [
      "-c", "user.name=mimin test",
      "-c", "user.email=mimin@example.invalid",
      "commit", "--quiet", "-m", "initial",
    ]);
    let launches = 0;
    const responses = Array.from({ length: 4 }, (_, index) => assistant([
      {
        type: "toolCall",
        id: `delegate-${index}`,
        name: "delegate",
        arguments: { task: "Fix auth tests" },
      },
    ], "toolUse"));
    responses.push(assistant([{ type: "text", text: "Stopped retrying." }]));
    const stream = (_model: Model<Api>, _context: Context) => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected manager turn");
      return completedStream(response);
    };

    const output = await runManager({
      input: "Fix the auth tests",
      workspace,
      config: config(dataDir),
      model,
      stream,
      sidekickRunner: async (_task, context) => {
        launches += 1;
        return result("partial", `session-${context.index}`, "still failing");
      },
    });

    expect(output.status).toBe("completed");
    expect(launches).toBe(3);
    expect(JSON.stringify(output.messages)).toContain("already been attempted 3 times");
  });

  test("uses the default fixed Git signal to allow iterative manager corrections that change the workspace", async () => {
    const { workspace, dataDir } = await fixture();
    await git(workspace, ["init", "--quiet"]);
    await git(workspace, ["add", ".keep"]);
    await git(workspace, [
      "-c", "user.name=mimin test",
      "-c", "user.email=mimin@example.invalid",
      "commit", "--quiet", "-m", "initial",
    ]);
    let launches = 0;
    const responses = Array.from({ length: 4 }, (_, index) => assistant([
      {
        type: "toolCall",
        id: `delegate-${index}`,
        name: "delegate",
        arguments: { task: "Fix auth tests" },
      },
    ], "toolUse"));
    responses.push(assistant([{ type: "text", text: "Completed iterative correction." }]));
    const stream = (_model: Model<Api>, _context: Context) => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected manager turn");
      return completedStream(response);
    };

    const output = await runManager({
      input: "Fix the auth tests",
      workspace,
      config: config(dataDir),
      model,
      stream,
      sidekickRunner: async (_task, context) => {
        launches += 1;
        await Bun.write(join(workspace, ".keep"), `correction ${launches}\n`);
        return result("partial", `session-${context.index}`, "made another correction");
      },
    });

    expect(output.status).toBe("completed");
    expect(launches).toBe(4);
    expect(JSON.stringify(output.messages)).not.toContain("Delegation blocked");
    expect(JSON.stringify(output.messages)).not.toContain("No workspace progress detected");
  });

  test("does not launch duplicate equivalent delegate calls from one manager response", async () => {
    const { workspace, dataDir } = await fixture();
    let launches = 0;
    const tracker = new DelegationTracker({
      workspaceState: { read: async () => "unchanged" },
    });
    const responses = [
      assistant([
        {
          type: "toolCall",
          id: "delegate-first",
          name: "delegate",
          arguments: { task: "Fix auth tests" },
        },
        {
          type: "toolCall",
          id: "delegate-duplicate",
          name: "delegate",
          arguments: { task: " fix   AUTH tests " },
        },
      ], "toolUse"),
      assistant([{ type: "text", text: "Handled duplicate." }]),
    ];
    const contexts: Context[] = [];
    const stream = (_model: Model<Api>, context: Context) => {
      contexts.push(structuredClone(context));
      const response = responses.shift();
      if (!response) throw new Error("unexpected manager turn");
      return completedStream(response);
    };

    const output = await runManager({
      input: "Fix auth tests",
      workspace,
      config: config(dataDir),
      model,
      stream,
      delegationTracker: tracker,
      sidekickRunner: async (_task, context) => {
        launches += 1;
        return result("partial", `session-${context.index}`);
      },
    });

    expect(output.status).toBe("completed");
    expect(launches).toBe(1);
    expect(JSON.stringify(contexts[1]?.messages)).toContain(
      "already dispatched in this manager response",
    );
  });

  test("resets an equivalent task retry budget whenever the workspace changes", async () => {
    let launches = 0;
    let workspaceState = "clean";
    const tracker = new DelegationTracker({
      workspaceState: { read: async () => workspaceState },
    });
    const delegate = createDelegateTool({
      tracker,
      run: async (_task, context) => {
        launches += 1;
        workspaceState = `changed-${launches}`;
        return result("partial", `session-${context.index}`, "made a corrective change");
      },
    });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const output = await execute(delegate, { task: "Fix auth tests" }, undefined, attempt + 1);
      expect(JSON.stringify(output)).not.toContain("Delegation blocked");
      expect(JSON.stringify(output)).not.toContain("No workspace progress detected");
    }

    expect(launches).toBe(4);
  });

  test("tracks different corrective tasks independently", async () => {
    const launched: string[] = [];
    const tracker = new DelegationTracker({
      workspaceState: { read: async () => "unchanged" },
    });
    const delegate = createDelegateTool({
      tracker,
      run: async (task, context) => {
        launched.push(task);
        return result("partial", `session-${context.index}`);
      },
    });

    const output = await execute(delegate, {
      task: ["Fix auth tests", "Fix billing tests", "Fix search tests"],
    });

    expect(launched).toEqual(["Fix auth tests", "Fix billing tests", "Fix search tests"]);
    expect(JSON.stringify(output)).not.toContain("Delegation skipped");
  });

  test("cancellation releases a reserved task without consuming its retry budget", async () => {
    const controller = new AbortController();
    let launches = 0;
    const tracker = new DelegationTracker({
      workspaceState: { read: async () => "unchanged" },
    });
    const delegate = createDelegateTool({
      tracker,
      run: async (_task, context) => {
        launches += 1;
        await Bun.sleep(15);
        return result("partial", `session-${context.index}`);
      },
    });

    const cancelled = execute(delegate, { task: "Fix auth tests" }, controller.signal, 1);
    await Bun.sleep(3);
    controller.abort();
    await cancelled;
    const retry = await execute(delegate, { task: " fix auth tests " }, undefined, 2);

    expect(launches).toBe(2);
    expect(JSON.stringify(retry)).not.toContain("Delegation blocked");
    expect(JSON.stringify(retry)).toContain("(1/3)");
  });

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

describe("sidekick corrective continuation", () => {
  test("fresh delegation creates a new session and continuation resumes the same session", async () => {
    const { workspace, dataDir } = await fixture();
    const store = new SessionStore({ root: join(dataDir, "sessions") });
    const stream = (_model: Model<Api>, context: Context) => {
      const messages = context.messages.map((message) =>
        message.role === "user" ? String(message.content) : "assistant",
      );
      return completedStream(
        assistant([{ type: "text", text: JSON.stringify({
          status: "complete",
          summary: "seen " + messages.length + " messages",
          filesChanged: [],
          verification: [],
        }) }]),
      );
    };

    const first = await runSidekick({
      task: "Implement auth refresh",
      workspace,
      config: config(dataDir).sidekick,
      sessionStore: store,
      model,
      stream,
    });
    const second = await runSidekick({
      task: "Fix the failing refresh-token test",
      workspace,
      config: config(dataDir).sidekick,
      sessionStore: store,
      sessionId: first.sessionId,
      model,
      stream,
    });

    expect(second.sessionId).toBe(first.sessionId);
    const messages = (await store.loadSession("sidekick", first.sessionId)).messages;
    // user: task one, assistant, user: correction, assistant.
    expect(messages.filter((message) => message.role === "user").map((m) => m.content))
      .toEqual(["Implement auth refresh", "Fix the failing refresh-token test"]);
    expect(JSON.stringify(messages)).toContain("seen 1 messages");
    expect(JSON.stringify(messages)).toContain("seen 3 messages");
  });

  test("continuation rejects a manager session id", async () => {
    const { workspace, dataDir } = await fixture();
    const store = new SessionStore({ root: join(dataDir, "sessions") });
    const manager = await store.createSession("manager");
    await manager.append({ role: "user", content: "manager history", timestamp: 1 });

    await expect(
      runSidekick({
        task: "correct it",
        workspace,
        config: config(dataDir).sidekick,
        sessionStore: store,
        sessionId: manager.id,
        model,
        stream: () => completedStream(assistant([{ type: "text", text: "{}" }])),
      }),
    ).rejects.toThrow(/does not match|not a sidekick/i);
  });

  test("continuation rejects unknown and malformed ids through the store", async () => {
    const { workspace, dataDir } = await fixture();
    const store = new SessionStore({ root: join(dataDir, "sessions") });

    await expect(
      runSidekick({
        task: "correct it",
        workspace,
        config: config(dataDir).sidekick,
        sessionStore: store,
        sessionId: "sidekick-does-not-exist",
        model,
        stream: () => completedStream(assistant([{ type: "text", text: "{}" }])),
      }),
    ).rejects.toThrow(/ENOENT|Session metadata/);

    await expect(
      runSidekick({
        task: "correct it",
        workspace,
        config: config(dataDir).sidekick,
        sessionStore: store,
        sessionId: "../manager/../secrets",
        model,
        stream: () => completedStream(assistant([{ type: "text", text: "{}" }])),
      }),
    ).rejects.toThrow(/Invalid session id/);
  });

  test("delegate continuation is blocked for an unknown session with a compact result", async () => {
    const delegate = createDelegateTool({
      sidekick: {
        workspace: "/tmp",
        config: { provider: "fake-provider", model: "sidekick", thinking: "off" },
        sessionStore: new SessionStore({ root: "/nonexistent-sessions-root" }),
      },
    });
    const output = await execute(delegate, {
      task: "fix it",
      sessionId: "sidekick-missing",
    });
    expect(output).toMatchObject({ isError: false });
    const serialized = JSON.stringify(output);
    expect(serialized).toContain("blocked");
    expect(serialized).toContain("not found");
  });

  test("the same sidekick session cannot be continued concurrently", async () => {
    const { workspace, dataDir } = await fixture();
    const store = new SessionStore({ root: join(dataDir, "sessions") });
    const delegate = createDelegateTool({
      sidekick: {
        workspace,
        config: config(dataDir).sidekick,
        sessionStore: store,
      },
      run: async (_task, context) => {
        await Bun.sleep(15);
        return result("partial", context.sessionId ?? "missing", "corrected");
      },
    });
    const output = await execute(delegate, {
      task: ["first", "second", "third"],
      sessionId: undefined,
    });
    void output;

    // Two continuations of the same stored sidekick session in one batch must
    // be blocked before the second one can mutate the session concurrently.
    const first = await runSidekick({
      task: "seed",
      workspace,
      config: config(dataDir).sidekick,
      sessionStore: store,
      model,
      stream: () => completedStream(assistant([{ type: "text", text: JSON.stringify({
        status: "complete", summary: "seeded", filesChanged: [], verification: [],
      }) }])),
    });
    const continuing = createDelegateTool({
      sidekick: {
        workspace,
        config: config(dataDir).sidekick,
        sessionStore: store,
      },
      maxConcurrency: 2,
      run: async (_task, context) => {
        await Bun.sleep(20);
        return result("complete", context.sessionId ?? first.sessionId, "done");
      },
    });
    // A batch of two continuations of the same session is rejected by the schema
    // (continuation requires a single task), so drive two single calls raced
    // through one manager turn instead.
    const a = continuing.execute({ task: "fix a", sessionId: first.sessionId }, executionContext("delegate"));
    const b = continuing.execute({ task: "fix b", sessionId: first.sessionId }, executionContext("delegate"));
    const [ra, rb] = await Promise.all([a, b]);
    const statuses = [ra, rb].map((r) => {
      const parsed = JSON.parse((r as { text: string }).text) as SidekickResult;
      return parsed.status;
    }).sort();
    expect(statuses.filter((s) => s === "blocked").length).toBeGreaterThanOrEqual(1);
  });

  test("different sidekick sessions may still run concurrently", async () => {
    const { workspace, dataDir } = await fixture();
    const store = new SessionStore({ root: join(dataDir, "sessions") });
    const sessions: string[] = [];
    const delegate = createDelegateTool({
      sidekick: {
        workspace,
        config: config(dataDir).sidekick,
        sessionStore: store,
      },
      maxConcurrency: 3,
      run: async (_task, context) => {
        await Bun.sleep(15);
        return result("complete", context.sessionId ?? "missing", "done");
      },
    });
    const seeds = await runSidekick({
      task: "seed one",
      workspace,
      config: config(dataDir).sidekick,
      sessionStore: store,
      model,
      stream: () => completedStream(assistant([{ type: "text", text: JSON.stringify({
        status: "complete", summary: "seeded", filesChanged: [], verification: [],
      }) }])),
    });
    sessions.push(seeds.sessionId);
    const seedTwo = await runSidekick({
      task: "seed two",
      workspace,
      config: config(dataDir).sidekick,
      sessionStore: store,
      model,
      stream: () => completedStream(assistant([{ type: "text", text: JSON.stringify({
        status: "complete", summary: "seeded", filesChanged: [], verification: [],
      }) }])),
    });
    sessions.push(seedTwo.sessionId);

    const one = delegate.execute({ task: "fix one", sessionId: sessions[0] }, executionContext("delegate"));
    const two = delegate.execute({ task: "fix two", sessionId: sessions[1] }, executionContext("delegate"));
    const [r1, r2] = await Promise.all([one, two]);
    const parsed = [r1, r2].map((r) => JSON.parse((r as { text: string }).text) as SidekickResult);
    expect(parsed.every((p) => p.status === "complete")).toBe(true);
  });

  test("continuation receives only its own history, not the manager or other sidekicks", async () => {
    const { workspace, dataDir } = await fixture();
    const store = new SessionStore({ root: join(dataDir, "sessions") });

    const manager = await store.createSession("manager");
    await manager.append({ role: "user", content: "manager secret intent", timestamp: 1 });

    const sidekickA = await store.createSession("sidekick");
    await sidekickA.append({ role: "user", content: "Implement auth refresh", timestamp: 2 });
    await sidekickA.append(assistant([{ type: "text", text: "auth work" }]));

    const sidekickB = await store.createSession("sidekick");
    await sidekickB.append({ role: "user", content: "Implement billing", timestamp: 4 });
    await sidekickB.append(assistant([{ type: "text", text: "billing transcript" }]));

    let seenMessages: unknown[] = [];
    const stream = (_model: Model<Api>, context: Context) => {
      seenMessages = structuredClone(context.messages);
      return completedStream(
        assistant([{ type: "text", text: JSON.stringify({
          status: "complete",
          summary: "corrected",
          filesChanged: [],
          verification: [],
        }) }]),
      );
    };

    await runSidekick({
      task: "Fix the failing refresh-token test",
      workspace,
      config: config(dataDir).sidekick,
      sessionStore: store,
      sessionId: sidekickA.id,
      model,
      stream,
    });

    const serialized = JSON.stringify(seenMessages);
    expect(serialized).toContain("Implement auth refresh");
    expect(serialized).toContain("Fix the failing refresh-token test");
    expect(serialized).toContain("auth work");
    expect(serialized).not.toContain("manager secret intent");
    expect(serialized).not.toContain("Implement billing");
    expect(serialized).not.toContain("billing transcript");
  });

  test("continued delegation still obeys the no-progress retry budget", async () => {
    let launches = 0;
    const tracker = new DelegationTracker({
      workspaceState: { read: async () => "unchanged" },
    });
    const delegate = createDelegateTool({
      tracker,
      run: async (_task, context) => {
        launches += 1;
        return result("partial", context.sessionId ?? "s", "no progress");
      },
    });

    let last: string = "";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const output = await execute(
        delegate,
        { task: "Fix refresh test", sessionId: "sidekick-abc" },
        undefined,
        attempt + 1,
      );
      last = JSON.stringify(output);
    }

    expect(launches).toBe(3);
    expect(last).toContain("already been attempted 3 times");
    expect(last).not.toContain("already active");
  });

  test("a failed continuation releases the session lock for a later retry", async () => {
    let calls = 0;
    const delegate = createDelegateTool({
      run: async (_task, context) => {
        calls += 1;
        if (calls === 1) throw new Error("provider failed");
        return result("complete", context.sessionId ?? "s", "ok");
      },
    });

    const first = await execute(
      delegate,
      { task: "fix it", sessionId: "sidekick-abc" },
      undefined,
      1,
    );
    const second = await execute(
      delegate,
      { task: "fix it again", sessionId: "sidekick-abc" },
      undefined,
      2,
    );

    const firstParsed = JSON.parse((first as { text: string }).text) as SidekickResult;
    const secondParsed = JSON.parse((second as { text: string }).text) as SidekickResult;
    expect(firstParsed.status).toBe("blocked");
    expect(secondParsed.status).toBe("complete");
    expect(secondParsed.summary).toBe("ok");
  });

  test("duplicate continuation does not create artificial ambiguity", async () => {
    let workspaceState = "baseline";
    let releaseFirst: (() => void) | undefined;
    const firstRunning = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const tracker = new RecordingDelegationTracker({
      workspaceState: { read: async () => workspaceState },
    });
    const delegate = createDelegateTool({
      tracker,
      maxConcurrency: 2,
      run: async (task, context) => {
        if (task === "first") {
          await firstRunning;
          // The first continuation changes the workspace so it must receive
          // deterministic madeProgress === true, not undefined.
          workspaceState = "changed-by-first";
        } else {
          // The second continuation is the duplicate; it must never run.
          throw new Error("duplicate continuation must not launch");
        }
        return result("partial", context.sessionId ?? "s", "done");
      },
    });

    const first = delegate.execute(
      { task: "first", sessionId: "sidekick-abc" },
      executionContext("delegate"),
    );
    // Ensure the first continuation has reserved + started before the duplicate.
    await Bun.sleep(10);
    const second = delegate.execute(
      { task: "second", sessionId: "sidekick-abc" },
      executionContext("delegate"),
    );
    // Wait until the duplicate has been dispatched (and blocked) while first runs.
    await Bun.sleep(20);
    releaseFirst?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    const firstParsed = JSON.parse((firstResult as { text: string }).text) as SidekickResult;
    const secondParsed = JSON.parse((secondResult as { text: string }).text) as SidekickResult;

    // The duplicate is blocked with the canonical message and never started.
    expect(secondParsed).toMatchObject({
      status: "blocked",
      summary: "Continuation blocked: this sidekick session is already active.",
      sessionId: "unavailable",
    });
    // The first execution's progress attribution is deterministic, not undefined.
    expect(tracker.finishes[0]?.completion).toEqual({ madeProgress: true, noProgressAttempts: 0 });
    expect(firstParsed.summary).not.toContain("No workspace progress detected");
    // Only one execution was ever registered as started.
    expect(tracker.starts.length).toBe(1);
  });

  test("no workspace read for blocked continuation", async () => {
    let reads = 0;
    let releaseFirst: (() => void) | undefined;
    const firstRunning = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const tracker = new RecordingDelegationTracker({
      workspaceState: { read: async () => { reads += 1; return "same"; } },
    });
    const delegate = createDelegateTool({
      tracker,
      maxConcurrency: 2,
      run: async (task, context) => {
        if (task === "first") {
          await firstRunning;
        } else {
          throw new Error("duplicate continuation must not launch");
        }
        return result("partial", context.sessionId ?? "s", "done");
      },
    });

    const first = delegate.execute(
      { task: "first", sessionId: "sidekick-abc" },
      executionContext("delegate"),
    );
    await Bun.sleep(10);
    const firstReads = reads;
    expect(firstReads).toBe(1);

    const second = delegate.execute(
      { task: "second", sessionId: "sidekick-abc" },
      executionContext("delegate"),
    );
    // Let the duplicate be dispatched and blocked while the first is still
    // running. The blocked duplicate must not trigger a workspace baseline read.
    await Bun.sleep(20);
    expect(reads).toBe(firstReads);

    releaseFirst?.();
    await Promise.all([first, second]);

    expect(tracker.starts.length).toBe(1);
    expect(tracker.failedStarts.length).toBe(0);
  });

  test("no attempt consumed", async () => {
    let calls = 0;
    let releaseFirst: (() => void) | undefined;
    const firstRunning = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const tracker = new RecordingDelegationTracker({
      workspaceState: { read: async () => "unchanged" },
    });
    const delegate = createDelegateTool({
      tracker,
      maxConcurrency: 2,
      run: async (task, context) => {
        calls += 1;
        if (task === "second") throw new Error("duplicate continuation must not launch");
        if (task === "first") await firstRunning;
        return result("partial", context.sessionId ?? "s", "no progress");
      },
    });

    const first = delegate.execute(
      { task: "first", sessionId: "sidekick-abc" },
      executionContext("delegate"),
    );
    await Bun.sleep(10);
    const second = delegate.execute(
      { task: "second", sessionId: "sidekick-abc" },
      executionContext("delegate"),
    );
    await Bun.sleep(20);
    releaseFirst?.();
    await Promise.all([first, second]);

    // The duplicate consumed no attempt: the same session can continue later
    // and is neither wedged as active nor budget-exhausted prematurely.
    const later = await execute(
      delegate,
      { task: "later", sessionId: "sidekick-abc" },
      undefined,
      2,
    );
    const laterParsed = JSON.parse((later as { text: string }).text) as SidekickResult;
    expect(laterParsed.status).toBe("partial");
    expect(JSON.stringify(later)).not.toContain("already active");
    expect(JSON.stringify(later)).not.toContain("already been attempted");
    expect(calls).toBe(2);
    // First consumed attempt 1 with no progress; the later one is attempt 2.
    expect(tracker.finishes.filter((f) => f.completion.madeProgress === false).length).toBe(2);
  });

  test("start rejection releases lock", async () => {
    let calls = 0;
    let state = "unchanged";
    const delegate = createDelegateTool({
      tracker: new DelegationTracker({ workspaceState: { read: async () => state } }),
      run: async (_task, context) => {
        calls += 1;
        return result("partial", context.sessionId ?? "s", "no progress");
      },
    });

    // Exhaust the no-progress retry budget so the next start() is rejected.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await execute(
        delegate,
        { task: "Fix auth tests", sessionId: "sidekick-abc" },
        undefined,
        attempt + 1,
      );
    }
    const blocked = await execute(
      delegate,
      { task: "Fix auth tests", sessionId: "sidekick-abc" },
      undefined,
      4,
    );
    expect(JSON.stringify(blocked)).toContain("already been attempted 3 times");

    // Genuine workspace progress resets the budget; the same session must not
    // be blocked as "already active" even though the rejected start() happened
    // while the continuation lock was held.
    state = "changed";
    const resumed = await execute(
      delegate,
      { task: "Fix auth tests", sessionId: "sidekick-abc" },
      undefined,
      5,
    );
    const resumedParsed = JSON.parse((resumed as { text: string }).text) as SidekickResult;
    expect(resumedParsed.status).toBe("partial");
    expect(JSON.stringify(resumed)).toContain("(1/3)");
    expect(JSON.stringify(resumed)).not.toContain("already active");
    expect(calls).toBe(4);
  });

  test("cancellation releases session lock", async () => {
    const controller = new AbortController();
    let calls = 0;
    const tracker = new RecordingDelegationTracker({
      workspaceState: { read: async () => "unchanged" },
    });
    const delegate = createDelegateTool({
      tracker,
      run: async (_task, context) => {
        calls += 1;
        await Bun.sleep(20);
        return result("partial", context.sessionId ?? "s", "done");
      },
    });

    const cancelled = execute(
      delegate,
      { task: "fix it", sessionId: "sidekick-abc" },
      controller.signal,
      1,
    );
    await Bun.sleep(5);
    controller.abort();
    await cancelled;

    // The cancelled continuation released both the session lock and the tracker
    // execution, so a later continuation of the same session is allowed.
    const later = await execute(
      delegate,
      { task: "fix it again", sessionId: "sidekick-abc" },
      undefined,
      2,
    );
    const laterParsed = JSON.parse((later as { text: string }).text) as SidekickResult;
    expect(laterParsed.status).toBe("partial");
    expect(JSON.stringify(later)).not.toContain("already active");
    expect(calls).toBe(2);
  });
});

describe("dispatch-time workspace progress tracking", () => {
  test("marks every overlapping execution attribution-unknown without changing retry state", async () => {
    let workspaceState = "initial";
    const tracker = new DelegationTracker({ workspaceState: { read: async () => workspaceState } });

    const firstReservation = tracker.reserve("Fix auth", 1);
    if (!firstReservation.allowed) throw new Error("expected first reservation");
    const firstStarted = await tracker.start(firstReservation.reservation);
    if (!firstStarted.allowed) throw new Error("expected first start");
    const secondReservation = tracker.reserve("Fix billing", 1);
    if (!secondReservation.allowed) throw new Error("expected second reservation");
    const secondStarted = await tracker.start(secondReservation.reservation);
    if (!secondStarted.allowed) throw new Error("expected second start");

    workspaceState = "changed-by-first-sidekick";
    expect(await tracker.finish(firstStarted.attempt)).toEqual({ madeProgress: undefined, noProgressAttempts: 0 });
    expect(await tracker.finish(secondStarted.attempt)).toEqual({ madeProgress: undefined, noProgressAttempts: 0 });

    // Once the overlapping attempts have ended, an isolated unchanged retry is
    // deterministically counted as its first no-progress attempt.
    const retryReservation = tracker.reserve("Fix billing", 2);
    if (!retryReservation.allowed) throw new Error("expected retry reservation");
    const retryStarted = await tracker.start(retryReservation.reservation);
    if (!retryStarted.allowed) throw new Error("expected retry start");
    expect(await tracker.finish(retryStarted.attempt)).toEqual({ madeProgress: false, noProgressAttempts: 1 });
  });

  test("an ambiguous overlap neither resets nor increments accumulated no-progress attempts", async () => {
    let workspaceState = "unchanged";
    const tracker = new DelegationTracker({ workspaceState: { read: async () => workspaceState } });
    for (let turn = 1; turn <= 2; turn += 1) {
      const reservation = tracker.reserve("Fix billing", turn);
      if (!reservation.allowed) throw new Error("expected reservation");
      const started = await tracker.start(reservation.reservation);
      if (!started.allowed) throw new Error("expected start");
      expect(await tracker.finish(started.attempt)).toMatchObject({ madeProgress: false, noProgressAttempts: turn });
    }

    const billingReservation = tracker.reserve("Fix billing", 3);
    if (!billingReservation.allowed) throw new Error("expected billing reservation");
    const billingStarted = await tracker.start(billingReservation.reservation);
    if (!billingStarted.allowed) throw new Error("expected billing start");
    const authReservation = tracker.reserve("Fix auth", 3);
    if (!authReservation.allowed) throw new Error("expected auth reservation");
    const authStarted = await tracker.start(authReservation.reservation);
    if (!authStarted.allowed) throw new Error("expected auth start");
    workspaceState = "changed-by-auth";

    expect(await tracker.finish(billingStarted.attempt)).toEqual({ madeProgress: undefined, noProgressAttempts: 2 });
    expect(await tracker.finish(authStarted.attempt)).toEqual({ madeProgress: undefined, noProgressAttempts: 0 });
  });

  test("fingerprints untracked file content changes without exposing contents", async () => {
    const { workspace } = await fixture();
    await git(workspace, ["init", "--quiet"]);
    const reader = gitWorkspaceState(workspace);
    await Bun.write(join(workspace, "new.ts"), "export const value = 1;\n");
    const created = await reader.read();
    await Bun.write(join(workspace, "new.ts"), "export const value = 2;\n");
    const changed = await reader.read();
    const unchanged = await reader.read();

    expect(changed).toBeDefined();
    expect(changed).not.toBe(created);
    expect(unchanged).toBe(changed);
    expect(changed).not.toContain("export const");
  });

  test("keeps the untracked contents fingerprint bounded for oversized files", async () => {
    const { workspace } = await fixture();
    await git(workspace, ["init", "--quiet"]);
    const reader = gitWorkspaceState(workspace);
    const large = "x".repeat(300 * 1024);
    await Bun.write(join(workspace, "big.bin"), large);
    const first = await reader.read();
    // Content beyond the per-file limit must not change the fingerprint.
    await Bun.write(join(workspace, "big.bin"), `${large}y`);
    const second = await reader.read();
    const still = await reader.read();

    expect(first).toBeDefined();
    if (first === undefined || second === undefined) throw new Error("expected a defined workspace state");
    expect(first).toBe(second);
    expect(still).toBe(first);
    expect(first.length).toBeLessThan(1_000);
  });

  test("keeps a large untracked listing compact, stable, and sensitive to retained paths", async () => {
    const { workspace } = await fixture();
    await git(workspace, ["init", "--quiet"]);
    const reader = gitWorkspaceState(workspace);
    await Promise.all(Array.from({ length: 150 }, async (_, index) => {
      await Bun.write(join(workspace, `entry-${String(index).padStart(3, "0")}.ts`), `export const value = ${index};\n`);
    }));
    const first = await reader.read();
    const stable = await reader.read();
    await Bun.write(join(workspace, "entry-000.ts"), "export const value = changed;\n");
    const changed = await reader.read();
    await Bun.write(join(workspace, "entry-150.ts"), "export const value = added;\n");
    const laterPathChanged = await reader.read();

    expect(first).toBeDefined();
    expect(first).toBe(stable);
    expect(first?.length).toBeLessThan(1_000);
    expect(changed).not.toBe(first);
    // Paths past the first 100 are not content-inspected, but the streaming
    // full-list fingerprint still detects their addition without retaining it.
    expect(laterPathChanged).not.toBe(changed);
  });

  test("captures a queued task baseline only when its bounded worker dispatches", async () => {
    let state = "initial";
    let reads = 0;
    let releaseFirst: (() => void) | undefined;
    const firstRunning = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const tracker = new DelegationTracker({ workspaceState: { read: async () => { reads += 1; return state; } } });
    const delegate = createDelegateTool({
      tracker,
      maxConcurrency: 1,
      run: async (task, context) => {
        if (context.index === 0) {
          await firstRunning;
          state = "changed-by-first";
        }
        return result("partial", `session-${context.index}`, task);
      },
    });
    const pending = execute(delegate, { task: ["first", "second"] });
    await Bun.sleep(5);
    expect(reads).toBe(1);
    releaseFirst?.();
    const output = await pending;
    expect(JSON.stringify(output)).toContain("No workspace progress detected for this corrective task (1/3)");
  });

  test("does not eagerly read workspace state for a large bounded batch", async () => {
    let reads = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tracker = new DelegationTracker({ workspaceState: { read: async () => { reads += 1; return "same"; } } });
    const delegate = createDelegateTool({
      tracker,
      maxConcurrency: 3,
      run: async () => { await gate; return result("complete", "session"); },
    });
    const pending = execute(delegate, { task: Array.from({ length: 20 }, (_, index) => `task ${index}`) });
    await Bun.sleep(5);
    expect(reads).toBe(3);
    release?.();
    await pending;
  });

  test("queued cancellation releases the reservation without consuming an attempt or budget", async () => {
    const controller = new AbortController();
    let launches = 0;
    let state = "clean";
    let reads = 0;
    let releaseFirst: (() => void) | undefined;
    const firstRunning = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const tracker = new DelegationTracker({
      workspaceState: { read: async () => { reads += 1; return state; } },
    });
    const delegate = createDelegateTool({
      tracker,
      maxConcurrency: 1,
      run: async (_task, context) => {
        launches += 1;
        if (context.index === 0) {
          await firstRunning;
          state = "changed-by-first";
        }
        return result("partial", `session-${context.index}`, "still failing");
      },
    });
    const pending = execute(delegate, {
      task: ["first", "second", "third"],
    }, controller.signal, 1);
    // First task is running; second and third are reserved but queued.
    await Bun.sleep(5);
    expect(launches).toBe(1);
    expect(reads).toBe(1);
    controller.abort();
    releaseFirst?.();
    await pending;

    // A fresh tracker-free run after cancellation starts a new attempt at 1/3:
    // the queued task never consumed an attempt or no-progress budget.
    const retry = await execute(delegate, { task: "second" }, undefined, 2);
    expect(JSON.stringify(retry)).not.toContain("Delegation blocked");
    expect(JSON.stringify(retry)).toContain("(1/3)");
  });

  test("running cancellation clears overlapping execution bookkeeping", async () => {
    const controller = new AbortController();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tracker = new DelegationTracker({ workspaceState: { read: async () => "unchanged" } });
    const delegate = createDelegateTool({
      tracker,
      maxConcurrency: 2,
      run: async (_task, context) => {
        if (context.index < 2) await gate;
        return result("partial", `session-${context.index}`, "cancelled work");
      },
    });
    const pending = execute(delegate, { task: ["Fix auth", "Fix billing"] }, controller.signal, 1);
    await Bun.sleep(5);
    controller.abort();
    release?.();
    await pending;

    // A later isolated retry is neither blocked as active nor left ambiguous.
    const retry = await execute(delegate, { task: "Fix auth" }, undefined, 2);
    expect(JSON.stringify(retry)).toContain("No workspace progress detected for this corrective task (1/3)");
    expect(JSON.stringify(retry)).not.toContain("already active");
  });

  test("retry-budget rejection releases the reservation for a later corrected task", async () => {
    let launches = 0;
    let state = "unchanged";
    const tracker = new DelegationTracker({
      workspaceState: { read: async () => state },
    });
    const delegate = createDelegateTool({
      tracker,
      run: async (_task, context) => {
        launches += 1;
        return result("partial", `session-${context.index}`, "no progress");
      },
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const output = await execute(delegate, { task: "Fix auth tests" }, undefined, attempt + 1);
      expect(JSON.stringify(output)).toContain(`(${attempt + 1}/3)`);
    }
    // Fourth equivalent task is rejected at start time; the reservation must be
    // released so a genuinely different task can still launch afterwards.
    const blocked = await execute(delegate, { task: "FIX AUTH TESTS" }, undefined, 4);
    expect(JSON.stringify(blocked)).toContain("already been attempted 3 times");
    // A workspace change resets the budget, and the same task must be able to
    // launch again: the blocked start() must not have left it active.
    state = "changed";
    const resumed = await execute(delegate, { task: "Fix auth tests" }, undefined, 5);
    expect(launches).toBe(4);
    expect(JSON.stringify(resumed)).toContain("(1/3)");
    expect(JSON.stringify(resumed)).not.toContain("already active");
  });

  test("untracked file content modification counts as delegation progress", async () => {
    const { workspace } = await fixture();
    await git(workspace, ["init", "--quiet"]);
    await git(workspace, ["add", ".keep"]);
    await git(workspace, [
      "-c", "user.name=mimin test",
      "-c", "user.email=mimin@example.invalid",
      "commit", "--quiet", "-m", "initial",
    ]);
    let launches = 0;
    const tracker = new DelegationTracker({ workspaceState: gitWorkspaceState(workspace) });
    const delegate = createDelegateTool({
      tracker,
      run: async (_task, context) => {
        launches += 1;
        await Bun.write(join(workspace, "new.ts"), `export const value = ${launches};\n`);
        return result("partial", `session-${context.index}`, "made a change");
      },
    });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const output = await execute(delegate, { task: "Fix auth tests" }, undefined, attempt + 1);
      // Rewriting the same untracked file changes its contents, so each
      // corrective attempt counts as progress and never blocks.
      expect(JSON.stringify(output)).not.toContain("Delegation blocked");
      expect(JSON.stringify(output)).not.toContain("No workspace progress detected");
    }
    expect(launches).toBe(4);
  });

  test("unchanged untracked file counts as no progress and exhausts the budget", async () => {
    const { workspace } = await fixture();
    await git(workspace, ["init", "--quiet"]);
    await git(workspace, ["add", ".keep"]);
    await git(workspace, [
      "-c", "user.name=mimin test",
      "-c", "user.email=mimin@example.invalid",
      "commit", "--quiet", "-m", "initial",
    ]);
    await Bun.write(join(workspace, "untouched.ts"), "export const value = 1;\n");
    let launches = 0;
    const tracker = new DelegationTracker({ workspaceState: gitWorkspaceState(workspace) });
    const delegate = createDelegateTool({
      tracker,
      run: async (_task, context) => {
        launches += 1;
        return result("partial", `session-${context.index}`, "nothing changed");
      },
    });

    const first = await execute(delegate, { task: "Fix auth tests" }, undefined, 1);
    const second = await execute(delegate, { task: "Fix auth tests" }, undefined, 2);
    const third = await execute(delegate, { task: "Fix auth tests" }, undefined, 3);
    const blocked = await execute(delegate, { task: "Fix auth tests" }, undefined, 4);
    expect(launches).toBe(3);
    expect(JSON.stringify(first)).toContain("(1/3)");
    expect(JSON.stringify(second)).toContain("(2/3)");
    expect(JSON.stringify(third)).toContain("(3/3)");
    expect(JSON.stringify(blocked)).toContain("already been attempted 3 times");
  });
});

describe("stable verification failure tracking", () => {
  test("treats timing-only output differences as the same failure", () => {
    const tracker = new VerificationFailureTracker();
    const first = { ok: false, results: [{ command: "bun test", exitCode: 1, ok: false, timedOut: false, stderr: "Tests failed in 1.42s" }] };
    const second = { ok: false, results: [{ command: "bun test", exitCode: 1, ok: false, timedOut: false, stderr: "Tests failed in 1.47s" }] };

    expect(tracker.record("test", false, first)).toBeUndefined();
    expect(tracker.record("test", false, second)).toBe(2);
  });

  test("resets distinct failures and clears state after success", () => {
    const tracker = new VerificationFailureTracker();
    const failure = (exitCode: number, stderr: string) => ({ ok: false, results: [{ command: "bun test", exitCode, ok: false, timedOut: false, stderr }] });

    tracker.record("test", false, failure(1, "assertion failed"));
    expect(tracker.record("test", false, failure(2, "process crashed"))).toBeUndefined();
    tracker.record("test", true, { ok: true, results: [] });
    expect(tracker.record("test", false, failure(2, "process crashed"))).toBeUndefined();
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
