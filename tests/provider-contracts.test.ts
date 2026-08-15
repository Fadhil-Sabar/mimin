import { describe, expect, test } from "bun:test";
import { stream, type Api, type Model } from "@mariozechner/pi-ai";
import {
  commandCodeModel,
  COMMANDCODE_BASE_URL,
  COMMANDCODE_CLAUDE_BASE_URL,
} from "../src/agent/commandcode.js";
import { commandCodeCredentials } from "../src/agent/model.js";

describe("generalized provider mock-server contracts", () => {
  test("Command Code Claude (anthropic-messages) sends expected URL, headers, and streams text", async () => {
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
                'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_mock_claude","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-6","usage":{"input_tokens":15,"output_tokens":1}}}\n\n' +
                'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
                'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Streaming from Command Code Claude endpoint"}}\n\n' +
                'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
                'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":8}}\n\n' +
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
      const model: Model<Api> = {
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
        { apiKey: "sk-cmd-mock-key" },
      );

      const events: unknown[] = [];
      for await (const event of responseStream) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);
      expect(capturedRequest).not.toBeNull();
      expect(capturedRequest!.method).toBe("POST");
      expect(capturedRequest!.path).toBe("/provider/v1/messages");
      expect(capturedRequest!.headers["x-api-key"]).toBe("sk-cmd-mock-key");
      expect(capturedRequest!.headers["anthropic-version"]).toBe("2023-06-01");
      expect(capturedRequest!.headers["content-type"]).toContain("application/json");
      expect(capturedRequest!.body.model).toBe("claude-sonnet-4-6");
      expect(capturedRequest!.body.stream).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("Command Code OpenAI (openai-completions) sends expected URL, headers, and streams text", async () => {
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
                'data: {"id":"chatcmpl_mock","object":"chat.completion.chunk","created":123,"model":"deepseek/deepseek-v4-flash","choices":[{"index":0,"delta":{"content":"OpenAI chunk 1"},"finish_reason":null}]}\n\n' +
                'data: {"id":"chatcmpl_mock","object":"chat.completion.chunk","created":123,"model":"deepseek/deepseek-v4-flash","choices":[{"index":0,"delta":{"content":" chunk 2"},"finish_reason":null}]}\n\n' +
                'data: {"id":"chatcmpl_mock","object":"chat.completion.chunk","created":123,"model":"deepseek/deepseek-v4-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
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
      const model: Model<Api> = {
        ...commandCodeModel("deepseek/deepseek-v4-flash"),
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
        { apiKey: "sk-cmd-mock-openai-key" },
      );

      const events: unknown[] = [];
      for await (const event of responseStream) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);
      expect(capturedRequest).not.toBeNull();
      expect(capturedRequest!.method).toBe("POST");
      expect(capturedRequest!.path).toBe("/provider/v1/chat/completions");
      expect(capturedRequest!.headers["authorization"]).toBe("Bearer sk-cmd-mock-openai-key");
      expect(capturedRequest!.headers["content-type"]).toContain("application/json");
      expect(capturedRequest!.body.model).toBe("deepseek/deepseek-v4-flash");
      expect(capturedRequest!.body.stream).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("Anthropic tool call streaming contract", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch() {
        const encoder = new TextEncoder();
        const readable = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_mock_tool","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-6","usage":{"input_tokens":20,"output_tokens":1}}}\n\n' +
                'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_read_001","name":"read","input":{}}}\n\n' +
                'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\": \\"package.json\\"}"}}\n\n' +
                'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
                'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":15}}\n\n' +
                'event: message_stop\ndata: {"type":"message_stop"}\n\n',
              ),
            );
            controller.close();
          },
        });

        return new Response(readable, {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });

    try {
      const model: Model<Api> = {
        ...commandCodeModel("claude-sonnet-4-6"),
        baseUrl: `http://localhost:${server.port}/provider`,
      };

      const responseStream = stream(
        model,
        {
          messages: [
            {
              role: "user",
              content: "read package.json",
              timestamp: Date.now(),
            },
          ],
        },
        { apiKey: "mock-key" },
      );

      const events: Array<{ type?: string; toolCall?: { id?: string; name?: string } }> = [];
      for await (const event of responseStream) {
        events.push(event as any);
      }

      expect(events.length).toBeGreaterThan(0);
    } finally {
      server.stop();
    }
  });

  test("Handles provider error responses (HTTP 401, 429, 500) gracefully", async () => {
    let statusCode = 401;
    const server = Bun.serve({
      port: 0,
      async fetch() {
        return new Response(
          JSON.stringify({
            error: {
              message: `Mock error for status ${statusCode}`,
              type: "invalid_request_error",
            },
          }),
          {
            status: statusCode,
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    });

    try {
      const model: Model<Api> = {
        ...commandCodeModel("claude-sonnet-4-6"),
        baseUrl: `http://localhost:${server.port}/provider`,
      };

      // 401 Unauthorized
      statusCode = 401;
      const events401: any[] = [];
      const s401 = stream(
        model,
        { messages: [{ role: "user", content: "test", timestamp: Date.now() }] },
        { apiKey: "invalid-key" },
      );
      for await (const ev of s401) {
        events401.push(ev);
      }
      expect(events401.some((e) => e.type === "error" && e.error?.errorMessage?.includes("401"))).toBe(true);

      // 429 Rate Limit
      statusCode = 429;
      const events429: any[] = [];
      const s429 = stream(
        model,
        { messages: [{ role: "user", content: "test", timestamp: Date.now() }] },
        { apiKey: "rate-limited-key" },
      );
      for await (const ev of s429) {
        events429.push(ev);
      }
      expect(events429.some((e) => e.type === "error" && e.error?.errorMessage?.includes("429"))).toBe(true);

      // 500 Server Error
      statusCode = 500;
      const events500: any[] = [];
      const s500 = stream(
        model,
        { messages: [{ role: "user", content: "test", timestamp: Date.now() }] },
        { apiKey: "server-err-key" },
      );
      for await (const ev of s500) {
        events500.push(ev);
      }
      expect(events500.some((e) => e.type === "error" && e.error?.errorMessage?.includes("500"))).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("Built-in Anthropic provider sends expected /v1/messages URL and headers", async () => {
    let capturedPath = "";
    let capturedHeaders: Record<string, string> = {};

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        capturedPath = new URL(req.url).pathname;
        req.headers.forEach((v, k) => {
          capturedHeaders[k] = v;
        });
        const encoder = new TextEncoder();
        const readable = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-3-5-sonnet","usage":{"input_tokens":10,"output_tokens":1}}}\n\n' +
                'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"hello"}}\n\n' +
                'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
                'event: message_stop\ndata: {"type":"message_stop"}\n\n',
              ),
            );
            controller.close();
          },
        });
        return new Response(readable, { headers: { "Content-Type": "text/event-stream" } });
      },
    });

    try {
      const model: Model<Api> = {
        id: "claude-3-5-sonnet",
        name: "Claude 3.5 Sonnet",
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl: `http://localhost:${server.port}`,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8192,
      };

      const s = stream(
        model,
        { messages: [{ role: "user", content: "ping", timestamp: Date.now() }] },
        { apiKey: "test-anthropic-key" },
      );
      for await (const _ of s) {}

      expect(capturedPath).toBe("/v1/messages");
      expect(capturedHeaders["x-api-key"]).toBe("test-anthropic-key");
      expect(capturedHeaders["anthropic-version"]).toBe("2023-06-01");
    } finally {
      server.stop();
    }
  });

  test("Built-in OpenAI provider sends expected /v1/chat/completions URL and headers", async () => {
    let capturedPath = "";
    let capturedHeaders: Record<string, string> = {};

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        capturedPath = new URL(req.url).pathname;
        req.headers.forEach((v, k) => {
          capturedHeaders[k] = v;
        });
        const encoder = new TextEncoder();
        const readable = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":123,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n' +
                'data: [DONE]\n\n',
              ),
            );
            controller.close();
          },
        });
        return new Response(readable, { headers: { "Content-Type": "text/event-stream" } });
      },
    });

    try {
      const model: Model<Api> = {
        id: "gpt-4o",
        name: "GPT-4o",
        provider: "openai",
        api: "openai-completions",
        baseUrl: `http://localhost:${server.port}/v1`,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4096,
      };

      const s = stream(
        model,
        { messages: [{ role: "user", content: "ping", timestamp: Date.now() }] },
        { apiKey: "test-openai-key" },
      );
      for await (const _ of s) {}

      expect(capturedPath).toBe("/v1/chat/completions");
      expect(capturedHeaders["authorization"]).toBe("Bearer test-openai-key");
    } finally {
      server.stop();
    }
  });

  test("Credential isolation: COMMANDCODE_API_KEY is isolated to commandcode provider", () => {
    const commandCodeCreds = commandCodeCredentials("commandcode", {
      COMMANDCODE_API_KEY: "sk-cmd-isolated-key",
      ANTHROPIC_API_KEY: "sk-ant-other-key",
    });
    expect(commandCodeCreds.apiKey).toBe("sk-cmd-isolated-key");

    const anthropicCreds = commandCodeCredentials("anthropic", {
      COMMANDCODE_API_KEY: "sk-cmd-isolated-key",
      ANTHROPIC_API_KEY: "sk-ant-other-key",
    });
    expect(anthropicCreds.apiKey).toBeUndefined();

    const openaiCreds = commandCodeCredentials("openai", {
      COMMANDCODE_API_KEY: "sk-cmd-isolated-key",
    });
    expect(openaiCreds.apiKey).toBeUndefined();
  });
});
