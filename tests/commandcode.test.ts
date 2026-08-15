import { describe, expect, test } from "bun:test";
import { stream } from "@mariozechner/pi-ai";
import {
  COMMANDCODE_API,
  COMMANDCODE_API_KEY_ENV_VAR,
  COMMANDCODE_BASE_URL,
  COMMANDCODE_CLAUDE_API,
  COMMANDCODE_CLAUDE_BASE_URL,
  COMMANDCODE_PROVIDER,
  commandCodeApiForModel,
  commandCodeBaseUrlForModel,
  commandCodeModel,
  isCommandCodeClaudeModel,
  isCommandCodeProvider,
} from "../src/agent/commandcode.js";
import {
  COMMANDCODE_METADATA,
  commandCodeCredentials,
  modelFromRole,
  resolveConfiguredModel,
} from "../src/agent/model.js";

describe("commandcode provider metadata", () => {
  test("metadata matches the documented OpenAI-compatible and Anthropic-compatible endpoints", () => {
    expect(COMMANDCODE_METADATA.provider).toBe("commandcode");
    expect(COMMANDCODE_METADATA.baseUrl).toBe("https://api.commandcode.ai/provider/v1");
    expect(COMMANDCODE_METADATA.claudeBaseUrl).toBe("https://api.commandcode.ai/provider");
    expect(COMMANDCODE_METADATA.api).toBe("openai-completions");
    expect(COMMANDCODE_METADATA.claudeApi).toBe("anthropic-messages");
    expect(COMMANDCODE_METADATA.apiKeyEnvVar).toBe("COMMANDCODE_API_KEY");
  });

  test("provider id and api constants are stable", () => {
    expect(COMMANDCODE_PROVIDER).toBe("commandcode");
    expect(COMMANDCODE_API).toBe("openai-completions");
    expect(COMMANDCODE_CLAUDE_API).toBe("anthropic-messages");
    expect(COMMANDCODE_BASE_URL).toBe("https://api.commandcode.ai/provider/v1");
    expect(COMMANDCODE_CLAUDE_BASE_URL).toBe("https://api.commandcode.ai/provider");
    expect(COMMANDCODE_API_KEY_ENV_VAR).toBe("COMMANDCODE_API_KEY");
    expect(isCommandCodeProvider("commandcode")).toBe(true);
    expect(isCommandCodeProvider("anthropic")).toBe(false);
  });

  test("claude model identification and API routing helper", () => {
    expect(isCommandCodeClaudeModel("claude-sonnet-4-6")).toBe(true);
    expect(isCommandCodeClaudeModel("claude-opus-4-6")).toBe(true);
    expect(isCommandCodeClaudeModel("claude-haiku-4-5")).toBe(true);
    expect(isCommandCodeClaudeModel("gpt-5.5")).toBe(false);
    expect(isCommandCodeClaudeModel("deepseek/deepseek-v4-flash")).toBe(false);
    expect(isCommandCodeClaudeModel("Qwen/Qwen3.8-Max")).toBe(false);

    expect(commandCodeApiForModel("claude-sonnet-4-6")).toBe("anthropic-messages");
    expect(commandCodeApiForModel("gpt-5.5")).toBe("openai-completions");

    expect(commandCodeBaseUrlForModel("claude-sonnet-4-6")).toBe("https://api.commandcode.ai/provider");
    expect(commandCodeBaseUrlForModel("gpt-5.5")).toBe("https://api.commandcode.ai/provider/v1");
  });
});

describe("commandcode model metadata", () => {
  test("resolves a non-Claude model id to openai-completions with /provider/v1 baseUrl", () => {
    const model = commandCodeModel("deepseek/deepseek-v4-flash");
    expect(model.id).toBe("deepseek/deepseek-v4-flash");
    expect(model.provider).toBe("commandcode");
    expect(model.api).toBe("openai-completions");
    expect(model.baseUrl).toBe("https://api.commandcode.ai/provider/v1");
    expect(model.reasoning).toBe(true);
    expect(model.input).toEqual(["text"]);
    expect(model.contextWindow).toBe(128_000);
    expect(model.maxTokens).toBe(16_384);
    expect(model.cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  test("resolves a claude-* model id to anthropic-messages protocol with /provider baseUrl", () => {
    const model = commandCodeModel("claude-sonnet-4-6");
    expect(model.id).toBe("claude-sonnet-4-6");
    expect(model.provider).toBe("commandcode");
    expect(model.api).toBe("anthropic-messages");
    expect(model.baseUrl).toBe("https://api.commandcode.ai/provider");
    expect(model.reasoning).toBe(true);
    expect(model.input).toEqual(["text"]);
    expect(model.contextWindow).toBe(128_000);
    expect(model.maxTokens).toBe(16_384);
    expect(model.cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  test("unknown model ids are accepted without hardcoding", () => {
    const model = commandCodeModel("vendor/brand-new-model");
    expect(model.id).toBe("vendor/brand-new-model");
    expect(model.api).toBe("openai-completions");
    expect(model.provider).toBe("commandcode");
  });
});

describe("commandcode model resolution", () => {
  test("resolveConfiguredModel returns a runtime commandcode model for OpenAI-compatible IDs", () => {
    const model = resolveConfiguredModel("commandcode", "gpt-5.5");
    expect(model.provider).toBe("commandcode");
    expect(model.api).toBe("openai-completions");
    expect(model.id).toBe("gpt-5.5");
    expect(model.baseUrl).toBe("https://api.commandcode.ai/provider/v1");
  });

  test("resolveConfiguredModel returns a runtime commandcode model for Claude IDs", () => {
    const model = resolveConfiguredModel("commandcode", "claude-sonnet-4-6");
    expect(model.provider).toBe("commandcode");
    expect(model.api).toBe("anthropic-messages");
    expect(model.id).toBe("claude-sonnet-4-6");
    expect(model.baseUrl).toBe("https://api.commandcode.ai/provider");
  });

  test("modelFromRole resolves a commandcode role through the default resolver", () => {
    const model = modelFromRole({
      provider: "commandcode",
      model: "gpt-5.4",
      thinking: "medium",
    });
    expect(model.provider).toBe("commandcode");
    expect(model.id).toBe("gpt-5.4");
    expect(model.api).toBe("openai-completions");

    const claudeModel = modelFromRole({
      provider: "commandcode",
      model: "claude-opus-4-6",
      thinking: "high",
    });
    expect(claudeModel.provider).toBe("commandcode");
    expect(claudeModel.id).toBe("claude-opus-4-6");
    expect(claudeModel.api).toBe("anthropic-messages");
  });
});

describe("commandcode credential resolution", () => {
  test("returns apiKey from COMMANDCODE_API_KEY for the commandcode provider", () => {
    const creds = commandCodeCredentials("commandcode", {
      COMMANDCODE_API_KEY: "sk-commandcode-123",
    });
    expect(creds).toEqual({ apiKey: "sk-commandcode-123" });
  });

  test("trims the key value", () => {
    expect(
      commandCodeCredentials("commandcode", {
        COMMANDCODE_API_KEY: "  sk-trimmed  ",
      }),
    ).toEqual({ apiKey: "sk-trimmed" });
  });

  test("throws a clear missing-key error naming COMMANDCODE_API_KEY", () => {
    expect(() => commandCodeCredentials("commandcode", {})).toThrow(
      /COMMANDCODE_API_KEY/,
    );
    expect(() =>
      commandCodeCredentials("commandcode", { COMMANDCODE_API_KEY: "   " }),
    ).toThrow(/COMMANDCODE_API_KEY/);
  });

  test("never reads a key from any other env var", () => {
    expect(() =>
      commandCodeCredentials("commandcode", {
        OPENAI_API_KEY: "sk-openai",
        ANTHROPIC_API_KEY: "sk-ant",
        CMD_API_KEY: "sk-cmd",
      }),
    ).toThrow(/COMMANDCODE_API_KEY/);
  });
});

describe("credential isolation for built-in providers", () => {
  test("built-in provider receives no apiKey even when COMMANDCODE_API_KEY is set", () => {
    expect(
      commandCodeCredentials("anthropic", {
        COMMANDCODE_API_KEY: "sk-commandcode-leak-test",
        ANTHROPIC_API_KEY: "sk-ant-ok",
      }),
    ).toEqual({});
    expect(
      commandCodeCredentials("openai", {
        COMMANDCODE_API_KEY: "sk-commandcode-leak-test",
      }),
    ).toEqual({});
  });

  test("built-in provider never requires COMMANDCODE_API_KEY", () => {
    expect(commandCodeCredentials("anthropic", {})).toEqual({});
  });
});

describe("built-in provider regression", () => {
  test("resolveConfiguredModel still resolves built-in pi-ai models", () => {
    const model = resolveConfiguredModel("anthropic", "claude-sonnet-4-6");
    expect(model.provider).toBe("anthropic");
    expect(model.api).toBe("anthropic-messages");
    expect(model.id).toBe("claude-sonnet-4-6");
  });

  test("unknown built-in models still throw", () => {
    expect(() => resolveConfiguredModel("anthropic", "no-such-model")).toThrow(
      /Unknown pi-ai model/,
    );
  });

  test("modelFromRole keeps the resolver injectable for tests", () => {
    const resolver = (provider: string, modelId: string) =>
      commandCodeModel(`${provider}:${modelId}`);
    const model = modelFromRole(
      { provider: "commandcode", model: "gpt-5.5", thinking: "low" },
      resolver,
    );
    expect(model.id).toBe("commandcode:gpt-5.5");
  });

  test("modelFromRole inherits the fallback role's model when providers match", () => {
    const resolver = (provider: string, modelId: string) =>
      commandCodeModel(`${provider}:${modelId}`);
    // Sidekick has an empty model; the manager's model is the fallback.
    const model = modelFromRole(
      { provider: "commandcode", model: "", thinking: "low" },
      resolver,
      { provider: "commandcode", model: "gpt-5.6-sol", thinking: "medium" },
    );
    expect(model.id).toBe("commandcode:gpt-5.6-sol");
  });

  test("modelFromRole with an empty model and no fallback uses the provider default", () => {
    // A built-in provider's first registered model is used as the default.
    const model = modelFromRole({ provider: "anthropic", model: "", thinking: "low" });
    expect(model.provider).toBe("anthropic");
    expect(model.id.length).toBeGreaterThan(0);
  });
});

describe("commandcode claude-* network protocol contract", () => {
  test("sends an Anthropic-compatible POST /provider/v1/messages request with expected headers and payload", async () => {
    let capturedRequest: {
      method: string;
      path: string;
      headers: Record<string, string>;
      body: Record<string, unknown>;
    } | null = null;

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => {
          headers[k] = v;
        });
        const body = (await req.json()) as Record<string, unknown>;
        capturedRequest = {
          method: req.method,
          path: url.pathname,
          headers,
          body,
        };

        const encoder = new TextEncoder();
        const readable = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_mock_001","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-6","usage":{"input_tokens":12,"output_tokens":1}}}\n\n' +
                'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
                'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Command Code Anthropic contract ok"}}\n\n' +
                'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
                'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":6}}\n\n' +
                'event: message_stop\ndata: {"type":"message_stop"}\n\n',
              ),
            );
            controller.close();
          },
        });

        return new Response(readable, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          },
        });
      },
    });

    try {
      const model = {
        ...commandCodeModel("claude-sonnet-4-6"),
        baseUrl: `http://localhost:${server.port}/provider`,
      };

      const responseStream = stream(
        model,
        {
          messages: [
            {
              role: "user",
              content: "ping contract test",
              timestamp: Date.now(),
            },
          ],
        },
        { apiKey: "test-commandcode-secret" },
      );

      const events: unknown[] = [];
      for await (const event of responseStream) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);
      expect(capturedRequest).not.toBeNull();
      expect(capturedRequest!.method).toBe("POST");
      expect(capturedRequest!.path).toBe("/provider/v1/messages");
      expect(capturedRequest!.headers["x-api-key"]).toBe("test-commandcode-secret");
      expect(capturedRequest!.headers["anthropic-version"]).toBe("2023-06-01");
      expect(capturedRequest!.headers["content-type"]).toContain("application/json");
      expect(capturedRequest!.body.model).toBe("claude-sonnet-4-6");
      expect(capturedRequest!.body.stream).toBe(true);
      expect(Array.isArray(capturedRequest!.body.messages)).toBe(true);
      const msgs = capturedRequest!.body.messages as Array<{
        role: string;
        content: Array<{ type: string; text: string }>;
      }>;
      expect(msgs[0]?.role).toBe("user");
      expect(msgs[0]?.content[0]?.type).toBe("text");
      expect(msgs[0]?.content[0]?.text).toBe("ping contract test");
    } finally {
      server.stop();
    }
  });

  test("sends an OpenAI-compatible POST /provider/v1/chat/completions request for non-Claude models", async () => {
    let capturedRequest: {
      method: string;
      path: string;
      headers: Record<string, string>;
      body: Record<string, unknown>;
    } | null = null;

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => {
          headers[k] = v;
        });
        const body = (await req.json()) as Record<string, unknown>;
        capturedRequest = {
          method: req.method,
          path: url.pathname,
          headers,
          body,
        };

        const encoder = new TextEncoder();
        const readable = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"id":"chatcmpl_mock","object":"chat.completion.chunk","created":123,"model":"gpt-5.5","choices":[{"index":0,"delta":{"content":"OpenAI ok"},"finish_reason":null}]}\n\n' +
                'data: {"id":"chatcmpl_mock","object":"chat.completion.chunk","created":123,"model":"gpt-5.5","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
                'data: [DONE]\n\n',
              ),
            );
            controller.close();
          },
        });

        return new Response(readable, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          },
        });
      },
    });

    try {
      const model = {
        ...commandCodeModel("gpt-5.5"),
        baseUrl: `http://localhost:${server.port}/provider/v1`,
      };

      const responseStream = stream(
        model,
        {
          messages: [
            {
              role: "user",
              content: "ping openai contract test",
              timestamp: Date.now(),
            },
          ],
        },
        { apiKey: "test-commandcode-secret" },
      );

      const events: unknown[] = [];
      for await (const event of responseStream) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);
      expect(capturedRequest).not.toBeNull();
      expect(capturedRequest!.method).toBe("POST");
      expect(capturedRequest!.path).toBe("/provider/v1/chat/completions");
      expect(capturedRequest!.headers["authorization"]).toBe("Bearer test-commandcode-secret");
      expect(capturedRequest!.headers["content-type"]).toContain("application/json");
      expect(capturedRequest!.body.model).toBe("gpt-5.5");
      expect(capturedRequest!.body.stream).toBe(true);
      expect(Array.isArray(capturedRequest!.body.messages)).toBe(true);
    } finally {
      server.stop();
    }
  });
});
