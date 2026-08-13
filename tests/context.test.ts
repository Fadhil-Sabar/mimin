import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Message } from "@mariozechner/pi-ai";
import {
  buildContext,
  ContextBudgetExceededError,
  estimateMessagesTokens,
  validateContextToolIntegrity,
} from "../src/context/context.js";

const assistant = (content: AssistantMessage["content"], timestamp: number): AssistantMessage => ({
  role: "assistant", content, api: "test", provider: "test", model: "test",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop", timestamp,
});

const toolResult = (
  id: string,
  name: string,
  text: string,
  timestamp: number,
  details?: Record<string, unknown>,
  isError = false,
): Message => ({
  role: "toolResult", toolCallId: id, toolName: name,
  content: [{ type: "text", text }], ...(details ? { details } : {}), isError, timestamp,
});

const contextText = (messages: readonly Message[]): string => JSON.stringify(messages);

describe("context compaction", () => {
  test("leaves an under-budget history unchanged", () => {
    const messages: Message[] = [{ role: "user", content: "small request", timestamp: 1 }];
    const result = buildContext(messages, { maxTokens: 100, reserveTokens: 20 });
    expect(result.compacted).toBe(false);
    expect(result.messages).toEqual(messages);
    expect(result.messages).not.toBe(messages);
  });

  test("summarizes old history while retaining newest user message verbatim", () => {
    const messages: Message[] = Array.from({ length: 12 }, (_, index) => ({
      role: "user" as const, content: `old requirement ${index}: ${"x".repeat(200)}`, timestamp: index,
    }));
    messages.push({ role: "user", content: "LATEST correction: preserve this exact request", timestamp: 99 });
    const result = buildContext(messages, { maxTokens: 900, reserveTokens: 100 });
    expect(result.compacted).toBe(true);
    expect(result.messages[0]).toMatchObject({ role: "user", content: expect.stringContaining("[Earlier session context compacted]") });
    expect(result.messages.at(-1)).toEqual(messages.at(-1));
    expect(result.estimatedTokens).toBeLessThanOrEqual(result.usableTokens);
    expect(messages).toHaveLength(13);
  });

  test("retains assistant tool calls with all associated results", () => {
    const call = assistant([{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/a.ts" } }], 2);
    const resultMessage = toolResult("read-1", "read", "recent result", 3, { path: "src/a.ts" });
    const messages: Message[] = [
      { role: "user", content: "old ".repeat(500), timestamp: 1 }, call, resultMessage,
    ];
    const result = buildContext(messages, { maxTokens: 500, reserveTokens: 100 });
    const callIndex = result.messages.findIndex((message) => message === call);
    expect(callIndex).toBeGreaterThanOrEqual(0);
    expect(result.messages[callIndex + 1]).toEqual(resultMessage);
    expect(validateContextToolIntegrity(result.messages)).toBe(true);
  });

  test("safely truncates oversized recent tool output without altering persisted history", () => {
    const huge = "start " + "x".repeat(30_000) + " end";
    const call = assistant([{ type: "toolCall", id: "call", name: "read", arguments: { path: "src/huge.ts" } }], 2);
    const tool = toolResult("call", "read", huge, 3, { path: "src/huge.ts", bytes: huge.length });
    const messages: Message[] = [
      { role: "user", content: "old ".repeat(1_000), timestamp: 1 }, call, tool,
    ];
    const result = buildContext(messages, { maxTokens: 1_200, reserveTokens: 200 });
    expect(result.compacted).toBe(true);
    const compactTool = result.messages.find((message) => message.role === "toolResult");
    expect(JSON.stringify(compactTool)).toContain("tool result truncated");
    expect(JSON.stringify(tool)).toContain(huge);
    expect(result.estimatedTokens).toBeLessThanOrEqual(result.usableTokens);
  });

  test("preserves delegate continuation state and manager-facing result fields", () => {
    const delegate = assistant([{ type: "toolCall", id: "delegate-1", name: "delegate", arguments: { task: "Implement auth" } }], 2);
    const details = {
      status: "partial",
      summary: "Implemented refresh-token handling; expiry case still fails.",
      filesChanged: ["src/auth.ts", "tests/auth.test.ts"],
      verification: [{ command: "bun test", status: "failed", summary: "expiry test failed" }],
      sessionId: "sidekick-abc",
      reasoning: "must not leak",
      rawLog: "secret raw output",
    };
    const messages: Message[] = [
      { role: "user", content: "Implement authentication safely", timestamp: 1 },
      delegate,
      toolResult("delegate-1", "delegate", JSON.stringify(details), 3, details),
      ...Array.from({ length: 15 }, (_, index) => ({ role: "user" as const, content: `later ${index} ${"x".repeat(240)}`, timestamp: 10 + index })),
      { role: "user", content: "Fix the remaining verification failure", timestamp: 99 },
    ];
    const built = buildContext(messages, { maxTokens: 900, reserveTokens: 100 });
    const text = contextText(built.messages);
    expect(text).toContain("sidekick-abc");
    expect(text).toContain("src/auth.ts");
    expect(text).toContain("expiry case still fails");
    expect(text).not.toContain("must not leak");
    expect(text).not.toContain("secret raw output");
  });

  test("prioritizes important and tail-biased historical state", () => {
    const messages: Message[] = [{ role: "user", content: "Original goal", timestamp: 1 }];
    messages.push(...Array.from({ length: 20 }, (_, index) => ({ role: "user" as const, content: `ancient ${index} ${"a".repeat(160)}`, timestamp: index + 2 })));
    messages.push({ role: "user", content: "recent historical manager decision", timestamp: 90 });
    messages.push({ role: "user", content: "LATEST correction", timestamp: 100 });
    const built = buildContext(messages, { maxTokens: 550, reserveTokens: 100 });
    const text = contextText(built.messages);
    expect(text).toContain("Original goal");
    expect(text).toContain("recent historical manager decision");
    expect(built.messages.at(-1)).toEqual(messages.at(-1));
  });

  test("keeps sidekick goal, edited file, and latest correction without old raw output", () => {
    const edit = assistant([{ type: "toolCall", id: "edit-1", name: "edit", arguments: {
      path: "src/auth.ts", oldText: "old secret file contents", newText: "new secret file contents",
    } }], 2);
    const messages: Message[] = [
      { role: "user", content: "Implement refresh-token expiry handling", timestamp: 1 },
      edit,
      toolResult("edit-1", "edit", "Updated src/auth.ts", 3, { path: "src/auth.ts", created: false }),
      ...Array.from({ length: 14 }, (_, index) => ({ role: "user" as const, content: `old chatter ${index} ${"z".repeat(220)}`, timestamp: 10 + index })),
      { role: "user", content: "LATEST: handle the zero-second expiry boundary", timestamp: 100 },
    ];
    const built = buildContext(messages, { maxTokens: 800, reserveTokens: 100 });
    const text = contextText(built.messages);
    expect(text).toContain("Implement refresh-token expiry handling");
    expect(text).toContain("src/auth.ts");
    expect(built.messages.at(-1)).toEqual(messages.at(-1));
    expect(text).not.toContain("old secret file contents");
    expect(text).not.toContain("new secret file contents");
  });

  test("throws when the newest user message cannot fit", () => {
    const messages: Message[] = [{ role: "user", content: "x".repeat(4_000), timestamp: 1 }];
    expect(() => buildContext(messages, { maxTokens: 200, reserveTokens: 100 })).toThrow(ContextBudgetExceededError);
  });

  test("accounts for system prompt overflow without truncating the newest user", () => {
    const messages: Message[] = [{ role: "user", content: "required newest request", timestamp: 1 }];
    expect(() => buildContext(messages, {
      maxTokens: 200,
      reserveTokens: 50,
      systemPrompt: "s".repeat(560),
    })).toThrow(ContextBudgetExceededError);
  });

  test("converts incomplete historical tool groups to provider-safe interruption state", () => {
    const incomplete = assistant([
      { type: "toolCall", id: "a", name: "read", arguments: { path: "a.ts" } },
      { type: "toolCall", id: "b", name: "read", arguments: { path: "b.ts" } },
    ], 2);
    const messages: Message[] = [
      { role: "user", content: "Original task", timestamp: 1 }, incomplete,
      toolResult("a", "read", "contents", 3, { path: "a.ts" }),
      ...Array.from({ length: 12 }, (_, index) => ({ role: "user" as const, content: `later ${index} ${"x".repeat(200)}`, timestamp: 10 + index })),
      { role: "user", content: "Continue safely", timestamp: 100 },
    ];
    const built = buildContext(messages, { maxTokens: 700, reserveTokens: 100 });
    expect(contextText(built.messages)).toContain("interrupted");
    expect(contextText(built.messages)).not.toContain('"id":"b"');
    expect(validateContextToolIntegrity(built.messages)).toBe(true);
  });

  test("preserves a complete recent multi-tool group verbatim", () => {
    const call = assistant([
      { type: "toolCall", id: "a", name: "read", arguments: { path: "a.ts" } },
      { type: "toolCall", id: "b", name: "read", arguments: { path: "b.ts" } },
    ], 2);
    const a = toolResult("a", "read", "a", 3, { path: "a.ts" });
    const b = toolResult("b", "read", "b", 4, { path: "b.ts" });
    const messages: Message[] = [{ role: "user", content: "old ".repeat(500), timestamp: 1 }, call, a, b];
    const built = buildContext(messages, { maxTokens: 600, reserveTokens: 100 });
    expect(built.messages.slice(-3)).toEqual([call, a, b]);
    expect(validateContextToolIntegrity(built.messages)).toBe(true);
  });

  test("is deterministic across repeated builds", () => {
    const messages: Message[] = Array.from({ length: 20 }, (_, index) => ({ role: "user" as const, content: `task ${index} ${"x".repeat(100)}`, timestamp: index }));
    const budget = { maxTokens: 600, reserveTokens: 100 };
    expect(buildContext(messages, budget)).toEqual(buildContext(messages, budget));
  });
});
