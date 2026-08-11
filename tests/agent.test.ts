import { describe, expect, test } from "bun:test";
import {
  createAssistantMessageEventStream,
  Type,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Message,
  type Model,
} from "@mariozechner/pi-ai";
import { runAgent, type AgentStreamFactory } from "../src/agent/run.js";
import type {
  AgentMessageSession,
  AnyAgentTool,
} from "../src/agent/types.js";

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

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  timestamp: number,
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
    timestamp,
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

describe("runAgent", () => {
  test("preserves thinking and signatures in the session and tool follow-up context", async () => {
    const first = assistant(
      [
        {
          type: "thinking",
          thinking: "private provider reasoning",
          thinkingSignature: "provider-thinking-signature",
          redacted: false,
        },
        { type: "text", text: "I will inspect the value." },
        {
          type: "toolCall",
          id: "call-inspect",
          name: "inspect",
          arguments: {},
        },
      ],
      "toolUse",
      2,
    );
    const second = assistant([{ type: "text", text: "inspection complete" }], "stop", 4);
    const responses = [first, second];
    const contexts: Message[][] = [];
    const session: AgentMessageSession = {
      messages: [{ role: "user", content: "inspect this", timestamp: 1 }],
      async append(message) {
        this.messages.push(message);
      },
    };
    const inspect: AnyAgentTool = {
      name: "inspect",
      description: "Inspect a value",
      parameters: Type.Object({}),
      execute: () => "inspected",
    };

    const result = await runAgent({
      model,
      session,
      tools: [inspect],
      stream: (_model, context) => {
        contexts.push(structuredClone(context.messages));
        const response = responses.shift();
        if (!response) throw new Error("Unexpected model turn");
        return completedStream(response);
      },
    });

    expect(result.status).toBe("completed");
    expect(session.messages[1]).toBe(first);
    expect(session.messages[1]).toEqual(first);
    expect(contexts[1]?.[1]).toEqual(first);
    expect(contexts[1]?.[1]?.content[0]).toEqual({
      type: "thinking",
      thinking: "private provider reasoning",
      thinkingSignature: "provider-thinking-signature",
      redacted: false,
    });
  });

  test("executes only injected tools and sends their result into the next turn", async () => {
    const first = assistant(
      [
        {
          type: "toolCall",
          id: "call-echo",
          name: "echo",
          arguments: { value: "hello" },
        },
      ],
      "toolUse",
      2,
    );
    const second = assistant([{ type: "text", text: "finished" }], "stop", 4);
    const responses = [first, second];
    const contexts: Message[][] = [];
    const definitions: Context["tools"][] = [];
    let executions = 0;

    const stream: AgentStreamFactory = (_model, context) => {
      contexts.push(structuredClone(context.messages));
      definitions.push(context.tools);
      const response = responses.shift();
      if (!response) throw new Error("Unexpected model turn");
      return completedStream(response);
    };
    const echo: AnyAgentTool = {
      name: "echo",
      description: "Return the supplied value",
      parameters: Type.Object({ value: Type.String() }),
      execute: (args: Record<string, unknown>) => {
        executions += 1;
        return `tool said: ${String(args.value)}`;
      },
    };
    const messages: Message[] = [
      { role: "user", content: "Use echo", timestamp: 1 },
    ];

    const result = await runAgent({
      model,
      systemPrompt: "Test prompt",
      messages,
      tools: [echo],
      stream,
    });

    expect(result.status).toBe("completed");
    expect(result.turns).toBe(2);
    expect(result.toolCalls).toBe(1);
    expect(executions).toBe(1);
    expect(definitions[0]?.map((tool) => tool.name)).toEqual(["echo"]);
    expect(contexts[0]).toHaveLength(1);
    expect(contexts[1]).toHaveLength(3);
    expect(contexts[1]?.[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "call-echo",
      toolName: "echo",
      content: [{ type: "text", text: "tool said: hello" }],
      isError: false,
    });
    expect(messages).toHaveLength(4);
  });

  test("aborting mid-stream returns aborted promptly without waiting for the provider", async () => {
    // A stream that yields one delta, then hangs forever (never ends). The
    // abort check inside the for-await loop must return "aborted" without
    // waiting for the stream to finish or reject.
    const streamFactory: AgentStreamFactory = (_model, _context) => {
      const stream = createAssistantMessageEventStream();
      const partial = assistant([], "toolUse", 1);
      stream.push({ type: "text_start", contentIndex: 0, partial });
      stream.push({
        type: "text_delta",
        contentIndex: 0,
        delta: "partial",
        partial,
      });
      // Deliberately never call stream.end(): a stuck provider.
      return stream;
    };
    const controller = new AbortController();
    const messages: Message[] = [
      { role: "user", content: "hello", timestamp: 1 },
    ];

    const runPromise = runAgent({
      model,
      systemPrompt: "Test prompt",
      messages,
      stream: streamFactory,
      signal: controller.signal,
    });

    // Let the stream yield its first event, then abort.
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const result = await runPromise;
    expect(result.status).toBe("aborted");
    expect(result.turns).toBe(1);
  });

  test("loops past the former 8-turn cap and stops only by completion", async () => {
    // Ten tool-calling turns then a final stop: the loop must never hit a
    // hidden turn limit (maxTurns was removed end-to-end).
    const responses: AssistantMessage[] = [];
    for (let index = 0; index < 10; index += 1) {
      responses.push(assistant(
        [
          {
            type: "toolCall",
            id: `call-${index}`,
            name: "echo",
            arguments: { value: `step ${index}` },
          },
        ],
        "toolUse",
        index + 2,
      ));
    }
    responses.push(assistant([{ type: "text", text: "done" }], "stop", 12));
    const stream = (_model: Model<Api>, _context: Context) => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected turn");
      return completedStream(response);
    };
    const messages: Message[] = [
      { role: "user", content: "keep going", timestamp: 1 },
    ];

    const result = await runAgent({
      model,
      systemPrompt: "Test prompt",
      messages,
      tools: [{
        name: "echo",
        description: "echo",
        parameters: Type.Object({ value: Type.String() }),
        execute: () => "ok",
      }],
      stream,
    });

    expect(result.status).toBe("completed");
    expect(result.turns).toBe(11);
    expect(result.toolCalls).toBe(10);
  });

  test("loops past the former 8-turn cap and aborts cleanly on signal", async () => {
    const responses: AssistantMessage[] = [];
    for (let index = 0; index < 12; index += 1) {
      responses.push(assistant(
        [
          {
            type: "toolCall",
            id: `call-${index}`,
            name: "echo",
            arguments: { value: `step ${index}` },
          },
        ],
        "toolUse",
        index + 2,
      ));
    }
    const controller = new AbortController();
    let calls = 0;
    const stream = (_model: Model<Api>, _context: Context) => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected turn");
      calls += 1;
      // After the loop is provably past the old cap, abort.
      if (calls === 10) controller.abort();
      return completedStream(response);
    };
    const messages: Message[] = [
      { role: "user", content: "keep going", timestamp: 1 },
    ];

    const result = await runAgent({
      model,
      systemPrompt: "Test prompt",
      messages,
      tools: [{
        name: "echo",
        description: "echo",
        parameters: Type.Object({ value: Type.String() }),
        execute: () => "ok",
      }],
      stream,
      signal: controller.signal,
    });

    expect(result.status).toBe("aborted");
    // The loop ran well beyond the old 8-turn limit before aborting.
    expect(result.turns).toBeGreaterThan(8);
  });
});
