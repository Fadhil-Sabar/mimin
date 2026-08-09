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
      maxTurns: 3,
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
});
