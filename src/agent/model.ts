import { getModel } from "@mariozechner/pi-ai";
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

export function modelFromRole(
  role: RoleConfig,
  resolver: ModelResolver = resolveConfiguredModel,
): Model<Api> {
  return resolver(role.provider, role.model);
}

export { COMMANDCODE_API_KEY_ENV_VAR };

/**
 * Credential resolution for a role's provider. The Command Code secret is
 * forwarded as the run's `apiKey` ONLY when that exact role uses the
 * `commandcode` provider, so a COMMANDCODE_API_KEY export can never leak
 * into a built-in provider's request. Missing Command Code credentials
 * fail fast with an actionable message; built-in providers never require
 * this env var and always receive `{}`.
 */
export function commandCodeCredentials(
  provider: string,
  env: Record<string, string | undefined> = process.env,
): { apiKey?: string } {
  if (!isCommandCodeProvider(provider)) {
    return {};
  }
  const value = env[COMMANDCODE_API_KEY_ENV_VAR];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `Command Code API key is required. Set ${COMMANDCODE_API_KEY_ENV_VAR} ` +
        `to your Command Code API key (see https://commandcode.ai).`, 
    );
  }
  return { apiKey: value.trim() };
}

/** Metadata describing the Command Code provider, for docs and tests. */
export const COMMANDCODE_METADATA = {
  provider: COMMANDCODE_PROVIDER,
  baseUrl: COMMANDCODE_BASE_URL,
  api: COMMANDCODE_API,
  apiKeyEnvVar: COMMANDCODE_API_KEY_ENV_VAR,
} as const;
