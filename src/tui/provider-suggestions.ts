import { findEnvKeys, getProviders } from "@mariozechner/pi-ai";
import {
  COMMANDCODE_API_KEY_ENV_VAR,
  COMMANDCODE_PROVIDER,
} from "../agent/commandcode.js";

/** A provider choice offered by the /provider command. */
export interface ProviderSuggestion {
  /** The exact provider ID to configure. */
  id: string;
  /** Hint shown beside the label (credential requirement or state). */
  description?: string;
  /** Whether credentials appear available (never reveals credential values). */
  configured?: boolean;
}

/** Provider suggestions; never throws for unknown providers. */
export type ProviderSuggestionSource = () => Promise<ProviderSuggestion[]>;

/** Human-readable label for a provider's required credential source. */
function credentialLabel(provider: string): string | undefined {
  if (provider === COMMANDCODE_PROVIDER) {
    return `requires ${COMMANDCODE_API_KEY_ENV_VAR}`;
  }
  if (provider === "google-vertex") {
    return "requires GOOGLE_CLOUD_API_KEY or ADC";
  }
  if (provider === "amazon-bedrock") {
    return "requires AWS credentials (profile, keys, or role)";
  }
  const keys = findEnvKeys(provider);
  if (keys && keys.length > 0) return `requires ${keys.join(" or ")}`;
  return undefined;
}

/**
 * Provider suggestions for /provider. Built-in providers come from pi-ai's
 * static registry; `commandcode` is mimin's custom provider. Credential
 * detection only inspects whether the expected environment variable (or
 * native auth source) appears available — never its value.
 */
export const suggestProviders: ProviderSuggestionSource = async () => {
  const providers = [...getProviders(), COMMANDCODE_PROVIDER];
  return providers.map((provider) => {
    const description = credentialLabel(provider);
    return {
      id: provider,
      ...(credentialAvailable(provider) ? { configured: true } : {}),
      ...(description ? { description } : {}),
    };
  });
};

/** True when the provider's expected credential source appears available. */
export function credentialAvailable(
  provider: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (provider === COMMANDCODE_PROVIDER) {
    const value = env[COMMANDCODE_API_KEY_ENV_VAR];
    return typeof value === "string" && value.trim().length > 0;
  }
  // pi-ai's findEnvKeys inspects the environment (or native sources like
  // Vertex ADC) and returns the found key NAMES only — never values.
  const found = findEnvKeys(provider);
  return Array.isArray(found) && found.length > 0;
}
