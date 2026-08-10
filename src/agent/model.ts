import { getModel, getModels } from "@mariozechner/pi-ai";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { RoleConfig } from "../config.js";
import {
  COMMANDCODE_API,
  COMMANDCODE_API_KEY_ENV_VAR,
  COMMANDCODE_BASE_URL,
  COMMANDCODE_PROVIDER,
  commandCodeModel,
  isCommandCodeProvider,
} from "./commandcode.js";

/** Injectable model lookup used by role entry points. */
export type ModelResolver = (provider: string, modelId: string) => Model<Api>;

/**
 * Resolve a configured model through pi-ai's installed model registry, with
 * Command Code models resolved at runtime (they are not in the built-in
 * registry). Unknown providers/models throw with a helpful message.
 */
export const resolveConfiguredModel: ModelResolver = (provider, modelId) => {
  if (isCommandCodeProvider(provider)) {
    return commandCodeModel(modelId);
  }
  // getModel's public overload is intentionally narrowed to generated IDs,
  // while configuration is runtime data. Preserve its real return semantics.
  const dynamicGetModel = getModel as unknown as (
    configuredProvider: string,
    configuredModelId: string,
  ) => Model<Api> | undefined;
  const model = dynamicGetModel(provider, modelId);
  if (!model) {
    throw new Error(
      `Unknown pi-ai model ${JSON.stringify(provider)}/${JSON.stringify(modelId)}`,
    );
  }
  return model;
};

/** First model pi-ai registers for a provider, or undefined. */
function defaultModelForProvider(provider: string): Model<Api> | undefined {
  if (isCommandCodeProvider(provider)) return undefined;
  try {
    const dynamicGetModels = getModels as unknown as (configured: string) => Model<Api>[];
    const known = dynamicGetModels(provider);
    if (!Array.isArray(known) || known.length === 0) return undefined;
    return known[0]!;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a role's model. An empty model id means "inherit": use the
 * fallback role's model when its provider matches, else the provider's first
 * registered model (pi-ai). Unknown providers/models throw with a helpful
 * message.
 */
export function resolveRoleModel(
  role: RoleConfig,
  fallback?: RoleConfig,
  resolver: ModelResolver = resolveConfiguredModel,
): Model<Api> {
  const provider = role.provider;
  if (role.model.length > 0) {
    return resolver(provider, role.model);
  }
  if (fallback && fallback.provider === provider && fallback.model.length > 0) {
    return resolver(provider, fallback.model);
  }
  const fallbackModel = defaultModelForProvider(provider);
  if (fallbackModel) return fallbackModel;
  throw new Error(
    `No model configured for provider ${JSON.stringify(provider)}. ` +
      `Set a model in config or run /model ${""}to choose one.`,
  );
}

export function modelFromRole(
  role: RoleConfig,
  resolver: ModelResolver = resolveConfiguredModel,
  fallback?: RoleConfig,
): Model<Api> {
  return resolveRoleModel(role, fallback, resolver);
}

export { COMMANDCODE_API_KEY_ENV_VAR };

/**
 * Credential resolution for a role's provider. The Command Code secret is
 * forwarded as the run's `apiKey` ONLY when that exact role uses the
 * `commandcode` provider, so a COMMANDCODE_API_KEY export can never leak
 * into a built-in provider's request. Resolution order: the injected
 * `storedKey` (resolved from auth.json by the CLI layer), then the
 * COMMANDCODE_API_KEY env var. Missing Command Code credentials fail fast
 * with an actionable message; built-in providers never require this and
 * always receive `{}`.
 */
export function commandCodeCredentials(
  provider: string,
  env: Record<string, string | undefined> = process.env,
  storedKey?: string,
): { apiKey?: string } {
  if (!isCommandCodeProvider(provider)) {
    return {};
  }
  // Environment wins (the documented, higher-trust source); the stored key
  // from auth.json is only a fallback.
  const envValue = env[COMMANDCODE_API_KEY_ENV_VAR];
  const value = typeof envValue === "string" && envValue.trim().length > 0
    ? envValue.trim()
    : typeof storedKey === "string" && storedKey.trim().length > 0
      ? storedKey.trim()
      : undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Command Code API key is required. Set ${COMMANDCODE_API_KEY_ENV_VAR} ` +
        `or run /provider commandcode to store one (see https://commandcode.ai).`, 
    );
  }
  return { apiKey: value };
}

/** Metadata describing the Command Code provider, for docs and tests. */
export const COMMANDCODE_METADATA = {
  provider: COMMANDCODE_PROVIDER,
  baseUrl: COMMANDCODE_BASE_URL,
  api: COMMANDCODE_API,
  apiKeyEnvVar: COMMANDCODE_API_KEY_ENV_VAR,
} as const;
