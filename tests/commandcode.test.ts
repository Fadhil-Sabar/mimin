import { describe, expect, test } from "bun:test";
import {
  COMMANDCODE_API,
  COMMANDCODE_API_KEY_ENV_VAR,
  COMMANDCODE_BASE_URL,
  COMMANDCODE_PROVIDER,
  commandCodeModel,
  isCommandCodeProvider,
} from "../src/agent/commandcode.js";
import {
  COMMANDCODE_METADATA,
  commandCodeCredentials,
  modelFromRole,
  resolveConfiguredModel,
} from "../src/agent/model.js";

describe("commandcode provider metadata", () => {
  test("metadata matches the documented OpenAI-compatible endpoint", () => {
    expect(COMMANDCODE_METADATA.provider).toBe("commandcode");
    expect(COMMANDCODE_METADATA.baseUrl).toBe("https://api.commandcode.ai/provider/v1");
    expect(COMMANDCODE_METADATA.api).toBe("openai-completions");
    expect(COMMANDCODE_METADATA.apiKeyEnvVar).toBe("COMMANDCODE_API_KEY");
  });

  test("provider id and api constants are stable", () => {
    expect(COMMANDCODE_PROVIDER).toBe("commandcode");
    expect(COMMANDCODE_API).toBe("openai-completions");
    expect(COMMANDCODE_BASE_URL).toBe("https://api.commandcode.ai/provider/v1");
    expect(COMMANDCODE_API_KEY_ENV_VAR).toBe("COMMANDCODE_API_KEY");
    expect(isCommandCodeProvider("commandcode")).toBe(true);
    expect(isCommandCodeProvider("anthropic")).toBe(false);
  });
});

describe("commandcode model metadata", () => {
  test("resolves an arbitrary configured model id with safe explicit defaults", () => {
    const model = commandCodeModel("deepseek/deepseek-v4-flash");
    expect(model.id).toBe("deepseek/deepseek-v4-flash");
    expect(model.provider).toBe("commandcode");
    expect(model.api).toBe("openai-completions");
    expect(model.baseUrl).toBe("https://api.commandcode.ai/provider/v1");
    expect(model.reasoning).toBe(true);
    expect(model.input).toEqual(["text"]);
    // Conservative floor: the live catalog reports 200k+ for small models,
    // but mimin has no startup network discovery, so arbitrary IDs get a
    // safe context/max-token budget that cannot overflow.
    expect(model.contextWindow).toBe(128_000);
    expect(model.maxTokens).toBe(16_384);
    // Known cost values are zero; unknown models must never guess a price.
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
  test("resolveConfiguredModel returns a runtime commandcode model", () => {
    const model = resolveConfiguredModel("commandcode", "gpt-5.5");
    expect(model.provider).toBe("commandcode");
    expect(model.api).toBe("openai-completions");
    expect(model.id).toBe("gpt-5.5");
    expect(model.baseUrl).toBe("https://api.commandcode.ai/provider/v1");
  });

  test("modelFromRole resolves a commandcode role through the default resolver", () => {
    const model = modelFromRole({
      provider: "commandcode",
      model: "gpt-5.4",
      thinking: "medium",
    });
    expect(model.provider).toBe("commandcode");
    expect(model.id).toBe("gpt-5.4");
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
});
