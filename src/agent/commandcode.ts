import type { Api, Model } from "@mariozechner/pi-ai";

/**
 * Command Code provider integration.
 *
 * Command Code exposes an OpenAI-compatible Chat Completions API:
 *   base URL: https://api.commandcode.ai/provider/v1
 *   endpoint: POST /chat/completions
 *   auth:     Authorization: Bearer <key>  (from COMMANDCODE_API_KEY)
 * The /models endpoint is public and returns a growing list of model IDs
 * (e.g. `gpt-5.5`, `deepseek/deepseek-v4-flash`, `Qwen/Qwen3.8-Max`).
 * Model IDs are accepted as configured without a static registry; the
 * catalog is live and dynamic.
 *
 * Initial resolver scope: this module targets the OpenAI-compatible
 * /chat/completions path only. Command Code routes Claude model IDs
 * (`claude-*`) through a separate Anthropic-compatible POST /messages
 * endpoint, which is not implemented here; configuring a `claude-*` ID will
 * still resolve but the request goes to /chat/completions and may be
 * rejected by the provider. Prefer non-Claude IDs until /messages support
 * is added and tested.
 */

export const COMMANDCODE_PROVIDER = "commandcode" as const;
export const COMMANDCODE_BASE_URL = "https://api.commandcode.ai/provider/v1" as const;
export const COMMANDCODE_API = "openai-completions" as const;
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

/**
 * pi-ai's Model registry only knows built-in providers, so Command Code
 * models are resolved at runtime with explicit, safe metadata. The values
 * keep the OpenAI-completions stream path working (max tokens are only
 * sent when mimin configures them) and give the TUI a conservative,
 * zero-cost budget.
 */
export function commandCodeModel(modelId: string): Model<"openai-completions"> {
  return {
    id: modelId,
    name: `Command Code ${modelId}`,
    api: COMMANDCODE_API,
    provider: COMMANDCODE_PROVIDER,
    baseUrl: COMMANDCODE_BASE_URL,
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
