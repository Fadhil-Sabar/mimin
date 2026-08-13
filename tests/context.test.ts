import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Message } from "@mariozechner/pi-ai";
import { buildContext, estimateMessagesTokens } from "../src/context/context.js";

const assistant = (content: AssistantMessage["content"], timestamp: number): AssistantMessage => ({
  role: "assistant", content, api: "test", provider: "test", model: "test",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop", timestamp,
});

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
    const resultMessage: Message = { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "recent result" }], isError: false, timestamp: 3 };
    const messages: Message[] = [
      { role: "user", content: "old ".repeat(500), timestamp: 1 }, call, resultMessage,
    ];
    const result = buildContext(messages, { maxTokens: 500, reserveTokens: 100 });
    const callIndex = result.messages.findIndex((message) => message === call);
    expect(callIndex).toBeGreaterThanOrEqual(0);
    expect(result.messages[callIndex + 1]).toEqual(resultMessage);
  });

  test("safely truncates oversized recent tool output without altering persisted history", () => {
    const huge = "start " + "x".repeat(30_000) + " end";
    const tool: Message = { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: huge }], isError: false, timestamp: 2 };
    const messages: Message[] = [
      { role: "user", content: "old ".repeat(1_000), timestamp: 1 }, tool,
    ];
    const result = buildContext(messages, { maxTokens: 1_200, reserveTokens: 200 });
    expect(result.compacted).toBe(true);
    const compactTool = result.messages.find((message) => message.role === "toolResult");
    expect(JSON.stringify(compactTool)).toContain("tool result truncated");
    expect(JSON.stringify(tool)).toContain(huge);
    expect(estimateMessagesTokens(result.messages)).toBe(result.estimatedTokens);
  });

  test("is deterministic across repeated builds", () => {
    const messages: Message[] = Array.from({ length: 20 }, (_, index) => ({ role: "user" as const, content: `task ${index} ${"x".repeat(100)}`, timestamp: index }));
    const budget = { maxTokens: 600, reserveTokens: 100 };
    expect(buildContext(messages, budget)).toEqual(buildContext(messages, budget));
  });
});
