import type { Api, Model } from "@mariozechner/pi-ai";

/**
 * Command Code provider integration.
 *
 * Command Code exposes two endpoints:
 *   1. OpenAI-compatible Chat Completions API:
 *      target endpoint: POST https://api.commandcode.ai/provider/v1/chat/completions
 *      client baseUrl:  https://api.commandcode.ai/provider/v1
 *      protocol:        openai-completions
 *      auth:            Authorization: Bearer <key>
 *   2. Anthropic-compatible Messages API (for `claude-*` model IDs):
 *      target endpoint: POST https://api.commandcode.ai/provider/v1/messages
 *      client baseUrl:  https://api.commandcode.ai/provider (pi-ai's Anthropic client appends /v1/messages)
 *      protocol:        anthropic-messages
 *      auth:            x-api-key: <key> (with anthropic-version: 2023-06-01)
 *
 * Auth key for both endpoints is supplied via COMMANDCODE_API_KEY.
 * The /models endpoint is public and returns a dynamic catalog of model IDs
 * (e.g. `gpt-5.5`, `deepseek/deepseek-v4-flash`, `claude-sonnet-4-6`, `Qwen/Qwen3.8-Max`).
 * Model IDs are accepted as configured without a static registry.
 */

export const COMMANDCODE_PROVIDER = "commandcode" as const;
export const COMMANDCODE_BASE_URL = "https://api.commandcode.ai/provider/v1" as const;
export const COMMANDCODE_CLAUDE_BASE_URL = "https://api.commandcode.ai/provider" as const;
export const COMMANDCODE_API = "openai-completions" as const;
export const COMMANDCODE_CLAUDE_API = "anthropic-messages" as const;
/** Environment variable that must supply the Command Code API key. */
export const COMMANDCODE_API_KEY_ENV_VAR = "COMMANDCODE_API_KEY" as const;

/**
 * Conservative metadata used for any configured model ID. The live catalog
 * reports per-model context lengths (e.g. 200,000 for gpt-5.5/GLM-5,
 * 1,050,000 for gpt-5.6-sol), but mimin performs no startup network
 * discovery, so arbitrary IDs get a safe floor that cannot overflow.
 */
const COMMANDCODE_CONTEXT_WINDOW = 128_000;
const COMMANDCODE_MAX_TOKENS = 16_384;

export function isCommandCodeProvider(provider: string): boolean {
  return provider === COMMANDCODE_PROVIDER;
}

export function isCommandCodeClaudeModel(modelId: string): boolean {
  return modelId.startsWith("claude-");
}

export function commandCodeApiForModel(
  modelId: string,
): typeof COMMANDCODE_CLAUDE_API | typeof COMMANDCODE_API {
  return isCommandCodeClaudeModel(modelId) ? COMMANDCODE_CLAUDE_API : COMMANDCODE_API;
}

export function commandCodeBaseUrlForModel(
  modelId: string,
): typeof COMMANDCODE_CLAUDE_BASE_URL | typeof COMMANDCODE_BASE_URL {
  return isCommandCodeClaudeModel(modelId) ? COMMANDCODE_CLAUDE_BASE_URL : COMMANDCODE_BASE_URL;
}

/**
 * pi-ai's Model registry only knows built-in providers, so Command Code
 * models are resolved at runtime with explicit, safe metadata. The API protocol
 * and base URL route dynamically: `claude-*` model IDs use `anthropic-messages`
 * (client baseUrl https://api.commandcode.ai/provider -> POST /provider/v1/messages)
 * while all other model IDs use `openai-completions`
 * (client baseUrl https://api.commandcode.ai/provider/v1 -> POST /provider/v1/chat/completions).
 */
export function commandCodeModel(modelId: string): Model<Api> {
  const api = commandCodeApiForModel(modelId);
  const baseUrl = commandCodeBaseUrlForModel(modelId);
  return {
    id: modelId,
    name: `Command Code ${modelId}`,
    api,
    provider: COMMANDCODE_PROVIDER,
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: COMMANDCODE_CONTEXT_WINDOW,
    maxTokens: COMMANDCODE_MAX_TOKENS,
  };
}

/** Resolve a Command Code model to a generic pi-ai Model. */
export function resolveCommandCodeModel(modelId: string): Model<Api> {
  return commandCodeModel(modelId);
}
