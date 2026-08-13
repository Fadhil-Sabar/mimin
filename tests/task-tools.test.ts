import { describe, expect, test } from "bun:test";
import type { Api, Model, ToolCall } from "@mariozechner/pi-ai";
import type { ToolExecutionContext } from "../src/agent/types.js";
import { TaskBoard } from "../src/task/task.js";
import { createTaskReviewTool, formatTaskDetail, formatTaskList } from "../src/task/tools.js";

const model: Model<Api> = {
  id: "fake",
  name: "Fake",
  api: "fake",
  provider: "fake",
  baseUrl: "http://localhost.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096,
  maxTokens: 1024,
};

function context(toolName: string): ToolExecutionContext {
  const toolCall: ToolCall = {
    type: "toolCall",
    id: "call-1",
    name: toolName,
    arguments: {},
  };
  return { model, turn: 1, toolCall };
}

async function executeTool(
  tool: ReturnType<typeof createTaskReviewTool>,
  args: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean; details?: unknown }> {
  return (await tool.execute(args, context(tool.name))) as {
    text: string;
    isError?: boolean;
    details?: unknown;
  };
}

describe("createTaskReviewTool", () => {
  test("accept completes the task", async () => {
    const board = new TaskBoard();
    const task = board.create({ title: "A", description: "a" });
    board.transition(task.id, "reviewing");
    const tool = createTaskReviewTool({ board, maxReviewIterations: 2 });

    const result = await executeTool(tool, { taskId: task.id, decision: "accept" });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("T01 → completed");
    expect(board.get(task.id)!.status).toBe("completed");
  });

  test("revise transitions to revising with feedback and enforces the same sidekick continuation", async () => {
    const board = new TaskBoard();
    const task = board.create({ title: "A", description: "a" });
    board.transition(task.id, "reviewing");
    board.bindSidekick(task.id, "sidekick-1");
    const tool = createTaskReviewTool({ board, maxReviewIterations: 2 });

    const result = await executeTool(tool, {
      taskId: task.id,
      decision: "revise",
      feedback: "cover expired refresh tokens",
    });
    expect(result.isError).toBeUndefined();
    expect(board.get(task.id)!.status).toBe("revising");
    expect(board.get(task.id)!.sidekickId).toBe("sidekick-1");
    expect(board.get(task.id)!.pendingFeedback).toBe("cover expired refresh tokens");
    expect(board.get(task.id)!.reviewIterations).toBe(1);
  });

  test("reject fails the task", async () => {
    const board = new TaskBoard();
    const task = board.create({ title: "A", description: "a" });
    board.transition(task.id, "reviewing");
    const tool = createTaskReviewTool({ board, maxReviewIterations: 2 });

    const result = await executeTool(tool, { taskId: task.id, decision: "reject" });
    expect(result.isError).toBeUndefined();
    expect(board.get(task.id)!.status).toBe("failed");
  });

  test("invalid decision returns an error", async () => {
    const board = new TaskBoard();
    const task = board.create({ title: "A", description: "a" });
    board.transition(task.id, "reviewing");
    const tool = createTaskReviewTool({ board, maxReviewIterations: 2 });

    const result = await executeTool(tool, { taskId: task.id, decision: "maybe" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Invalid decision");
  });

  test("iteration budget blocks further revisions", async () => {
    const board = new TaskBoard();
    const task = board.create({ title: "A", description: "a" });
    board.transition(task.id, "reviewing");
    const tool = createTaskReviewTool({ board, maxReviewIterations: 1 });

    await executeTool(tool, {
      taskId: task.id,
      decision: "revise",
      feedback: "first",
    });
    board.transition(task.id, "reviewing");
    const result = await executeTool(tool, {
      taskId: task.id,
      decision: "revise",
      feedback: "second",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("budget");
  });
});

describe("task formatting", () => {
  test("formatTaskList renders symbols and dependencies", () => {
    const board = new TaskBoard();
    const t1 = board.create({ title: "investigate", description: "i" });
    const t2 = board.create({
      title: "implement",
      description: "impl",
      dependsOn: [t1.id],
    });
    board.transition(t1.id, "completed");
    board.transition(t2.id, "running");
    board.bindSidekick(t2.id, "sidekick-1");

    const list = formatTaskList(board);
    expect(list).toContain("✓ T01 investigate");
    expect(list).toContain("● T02 implement");
    expect(list).toContain("sidekick-1");
  });

  test("formatTaskDetail shows status, sidekick, files, verification", () => {
    const board = new TaskBoard();
    const task = board.create({ title: "Fix auth", description: "d" });
    board.transition(task.id, "reviewing");
    board.bindSidekick(task.id, "sidekick-9");
    board.attachResult(task.id, {
      status: "completed",
      summary: "fixed",
      filesChanged: ["src/auth.ts"],
      verification: [{ command: "bun test", status: "passed" }],
    });

    const detail = formatTaskDetail(board, task.id);
    expect(detail).toContain("T01 · Fix auth");
    expect(detail).toContain("reviewing");
    expect(detail).toContain("sidekick-9");
    expect(detail).toContain("src/auth.ts");
    expect(detail).toContain("bun test");
  });

  test("formatTaskDetail reports unknown tasks", () => {
    const board = new TaskBoard();
    expect(formatTaskDetail(board, "T99")).toContain("Unknown task");
  });
});
