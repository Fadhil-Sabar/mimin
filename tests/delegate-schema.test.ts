import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { Api, Model, ToolCall } from "@mariozechner/pi-ai";
import { validateToolCall } from "@mariozechner/pi-ai";
import { createManagerTools } from "../src/agent/manager.js";
import type { AgentConfig } from "../src/config.js";
import type { AnyAgentTool, ToolExecutionContext } from "../src/agent/types.js";
import { createDelegateTool } from "../src/tools/delegate.js";
import type { SidekickResult } from "../src/agent/sidekick.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function fixture(): Promise<{ workspace: string; dataDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "mimin-delegate-schema-"));
  temporaryDirectories.push(root);
  const workspace = join(root, "workspace");
  const dataDir = join(root, "data");
  await Bun.write(join(workspace, ".keep"), "fixture");
  return { workspace, dataDir };
}

const model: Model<Api> = {
  id: "fake", name: "Fake", api: "fake", provider: "fake", baseUrl: "http://invalid",
  reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000, maxTokens: 100,
};

const config = (dataDir: string): AgentConfig => ({
  dataDir,
  manager: { provider: "fake-provider", model: "manager", thinking: "off" },
  sidekick: { provider: "fake-provider", model: "sidekick", thinking: "off" },
});

function executionContext(toolName: string): ToolExecutionContext {
  const toolCall: ToolCall = {
    type: "toolCall",
    id: `call-${toolName}`,
    name: toolName,
    arguments: {},
  };
  return { model, turn: 1, toolCall };
}

async function execute(tool: AnyAgentTool, args: Record<string, unknown>) {
  try {
    return await tool.execute(args, executionContext(tool.name));
  } catch (error) {
    // Mirror runAgent.executeTool: a throwing tool becomes an isError result.
    return {
      text: `Tool ${tool.name} failed: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

/** Validate args through pi-ai's generic tool-call validation (provider path). */
function validatePath(tool: AnyAgentTool, args: Record<string, unknown>): void {
  validateToolCall([tool], {
    type: "toolCall",
    id: `call-${tool.name}`,
    name: tool.name,
    arguments: args,
  });
}

/** Assert the exact provider requirement: top-level `type: "object"`, no union root. */
function expectObjectRoot(schema: Record<string, unknown>): void {
  expect(schema.type).toBe("object");
  expect(schema).not.toHaveProperty("anyOf");
  expect(schema).not.toHaveProperty("oneOf");
  expect(schema).not.toHaveProperty("allOf");
}

function result(status: SidekickResult["status"], summary: string): SidekickResult {
  return { status, summary, filesChanged: [], verification: [], sessionId: "s" };
}

describe("delegate tool schema root (provider compatibility)", () => {
  test("delegate.parameters is a top-level JSON Schema object", () => {
    const delegate = createDelegateTool({
      run: async (task) => result("complete", task),
    });
    expectObjectRoot(delegate.parameters as Record<string, unknown>);
    // The nested union on the `task` property must not leak to the root.
    const rootKeys = Object.keys(delegate.parameters);
    expect(rootKeys).toContain("type");
    expect(rootKeys).toContain("properties");
    expect(rootKeys).not.toContain("anyOf");
  });

  test("every production manager tool has a top-level object schema", async () => {
    const { workspace, dataDir } = await fixture();
    const tools = createManagerTools({
      workspace,
      config: config(dataDir),
      sidekickModel: model,
    });
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expectObjectRoot(tool.parameters as Record<string, unknown>);
    }
  });

  test("serialized JSON through pi-ai keeps delegate.parameters.type === \"object\"", () => {
    const delegate = createDelegateTool({
      run: async (task) => result("complete", task),
    });
    // pi-ai sends `tool.parameters` directly as JSON Schema; JSON round-trip
    // must not drop or alter the root type.
    const serialized = JSON.parse(JSON.stringify(delegate.parameters)) as Record<string, unknown>;
    expect(serialized.type).toBe("object");
    // Both `task` and `tasks` are optional so the alias survives generic
    // validation; exactly-one is enforced at runtime.
    expect(serialized.required ?? []).toEqual([]);
    const props = serialized.properties as Record<string, unknown>;
    expect(props.task).toBeDefined();
    expect(props.tasks).toBeDefined();
  });
});

describe("delegate contract acceptance", () => {
  test("single task via { task: string }", async () => {
    const seen: string[] = [];
    const delegate = createDelegateTool({
      run: async (task) => {
        seen.push(task);
        return result("complete", task);
      },
    });
    const output = await execute(delegate, { task: "implement feature" });
    const parsed = JSON.parse((output as { text: string }).text) as SidekickResult;
    expect(seen).toEqual(["implement feature"]);
    expect(parsed.status).toBe("complete");
    expect(parsed.summary).toBe("implement feature");
  });

  test("parallel batch via { task: string[] } preserves order and runs bounded", async () => {
    let active = 0;
    let maximumActive = 0;
    const delegate = createDelegateTool({
      maxConcurrency: 99,
      run: async (task, context) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Bun.sleep((6 - context.index) * 5);
        active -= 1;
        return result("complete", `result-${context.index}:${task}`);
      },
    });
    const output = await execute(delegate, {
      task: ["a", "b", "c", "d"],
    });
    const parsed = JSON.parse((output as { text: string }).text) as SidekickResult[];
    expect(maximumActive).toBeLessThanOrEqual(3);
    expect(maximumActive).toBeGreaterThan(1);
    expect(parsed.map((entry) => entry.summary)).toEqual([
      "result-0:a",
      "result-1:b",
      "result-2:c",
      "result-3:d",
    ]);
  });

  test("legacy alias { tasks: string[] } still works", async () => {
    const seen: string[] = [];
    const delegate = createDelegateTool({
      run: async (task) => {
        seen.push(task);
        return result("complete", task);
      },
    });
    await execute(delegate, { tasks: ["x", "y"] });
    expect(seen).toEqual(["x", "y"]);
  });
});

describe("delegate generic validation path (pi-ai validateToolCall)", () => {
  test("single { task: string } passes generic validation", () => {
    const delegate = createDelegateTool({
      run: async (task) => result("complete", task),
    });
    expect(() => validatePath(delegate, { task: "implement" })).not.toThrow();
  });

  test("batch { task: string[] } passes generic validation", () => {
    const delegate = createDelegateTool({
      run: async (task) => result("complete", task),
    });
    expect(() => validatePath(delegate, { task: ["a", "b"] })).not.toThrow();
  });

  test("legacy alias { tasks: string[] } passes generic validation", () => {
    const delegate = createDelegateTool({
      run: async (task) => result("complete", task),
    });
    expect(() => validatePath(delegate, { tasks: ["x", "y"] })).not.toThrow();
  });

  test("empty {} passes generic validation (runtime exactly-one rejects it)", async () => {
    const delegate = createDelegateTool({
      run: async (task) => result("complete", task),
    });
    expect(() => validatePath(delegate, {})).not.toThrow();
    const output = await execute(delegate, {});
    expect((output as { isError: boolean }).isError).toBe(true);
  });

  test("both task and tasks passes schema but is rejected at runtime", async () => {
    const delegate = createDelegateTool({
      run: async (task) => result("complete", task),
    });
    expect(() => validatePath(delegate, { task: "a", tasks: ["b"] })).not.toThrow();
    const output = await execute(delegate, { task: "a", tasks: ["b"] });
    expect((output as { isError: boolean }).isError).toBe(true);
    expect((output as { text: string }).text).toContain("exactly one");
  });

  test("oversized batch is rejected by generic validation", () => {
    const delegate = createDelegateTool({
      run: async (task) => result("complete", task),
    });
    const oversized = Array.from({ length: 101 }, (_, i) => `task-${i}`);
    expect(() => validatePath(delegate, { task: oversized })).toThrow(
      /Validation failed for tool "delegate"/,
    );
  });

  test("empty array is rejected by generic validation", () => {
    const delegate = createDelegateTool({
      run: async (task) => result("complete", task),
    });
    expect(() => validatePath(delegate, { task: [] })).toThrow(
      /Validation failed for tool "delegate"/,
    );
  });
});

describe("delegate contract rejection", () => {
  test("empty arguments are rejected", async () => {
    const delegate = createDelegateTool({
      run: async (task) => result("complete", task),
    });
    const output = await execute(delegate, {});
    expect((output as { isError: boolean }).isError).toBe(true);
    expect((output as { text: string }).text).toContain("delegate requires");
  });

  test("both task and tasks are rejected (exactly-one)", async () => {
    const delegate = createDelegateTool({
      run: async (task) => result("complete", task),
    });
    const output = await execute(delegate, {
      task: ["a"],
      tasks: ["b"],
    });
    expect((output as { isError: boolean }).isError).toBe(true);
    expect((output as { text: string }).text).toContain("exactly one");
  });

  test("exactly-one is enforced at runtime even when schema allows both", async () => {
    const delegate = createDelegateTool({
      run: async (task) => result("complete", task),
    });
    // Schema accepts either field (each is valid); the tool itself must reject
    // the ambiguous combination before any sidekick runs.
    const output = await execute(delegate, {
      task: "a",
      tasks: ["b"],
    });
    expect((output as { isError: boolean }).isError).toBe(true);
    expect((output as { text: string }).text).toContain("exactly one");
  });

  test("empty task array is rejected", async () => {
    const delegate = createDelegateTool({
      run: async (task) => result("complete", task),
    });
    const output = await execute(delegate, { task: [] });
    expect((output as { isError: boolean }).isError).toBe(true);
  });

  test("oversized batch is rejected by schema validation", async () => {
    const delegate = createDelegateTool({
      run: async (task) => result("complete", task),
    });
    const oversized = Array.from({ length: 101 }, (_, i) => `task-${i}`);
    // The provider path validates with pi-ai's validateToolCall against the
    // TypeBox schema; maxItems=100 must reject before execution.
    expect(() =>
      validateToolCall([delegate], {
        type: "toolCall",
        id: "call-oversized",
        name: "delegate",
        arguments: { task: oversized },
      }),
    ).toThrow(/Validation failed for tool "delegate"/);
    // The schema itself must expose the 100 cap for provider compatibility.
    const schema = delegate.parameters as Record<string, unknown>;
    const taskProp = (schema.properties as Record<string, unknown>).task as Record<string, unknown>;
    const arrayBranch = (taskProp.anyOf as Array<Record<string, unknown>>)[1]!;
    expect(arrayBranch.maxItems).toBe(100);
  });
});

describe("delegate event presentation metadata", () => {
  test("delegation_started and delegation_finished carry task and model", async () => {
    const events: Array<Record<string, unknown>> = [];
    const delegate = createDelegateTool({
      sidekick: {
        workspace: "/tmp",
        config: { provider: "commandcode", model: "gpt-5.5", thinking: "low" },
      },
      run: async (task) => result("complete", task),
      onEvent: (event) => {
        events.push(event as unknown as Record<string, unknown>);
      },
    });
    await execute(delegate, { task: "implement feature" });

    const started = events.find((event) => event.type === "delegation_started");
    const finished = events.find((event) => event.type === "delegation_finished");
    expect(started).toMatchObject({
      type: "delegation_started",
      index: 0,
      taskCount: 1,
      task: "implement feature",
      model: "gpt-5.5",
    });
    expect(finished).toMatchObject({
      type: "delegation_finished",
      index: 0,
      taskCount: 1,
      task: "implement feature",
      model: "gpt-5.5",
      result: { status: "complete", summary: "implement feature" },
    });
  });

  test("batch delegation carries per-task titles and the sidekick model", async () => {
    const events: Array<Record<string, unknown>> = [];
    const delegate = createDelegateTool({
      sidekick: {
        workspace: "/tmp",
        config: { provider: "commandcode", model: "deepseek-v4-flash", thinking: "low" },
      },
      run: async (task) => result("complete", task),
      onEvent: (event) => {
        events.push(event as unknown as Record<string, unknown>);
      },
    });
    await execute(delegate, { task: ["a", "b"] });

    const started = events.filter((event) => event.type === "delegation_started");
    expect(started).toHaveLength(2);
    expect(started[0]).toMatchObject({ index: 0, task: "a", model: "deepseek-v4-flash" });
    expect(started[1]).toMatchObject({ index: 1, task: "b", model: "deepseek-v4-flash" });
    // sidekick_activity events are unchanged (no new fields).
    const activity = events.find((event) => event.type === "sidekick_activity");
    expect(activity).toBeUndefined();
  });
});
