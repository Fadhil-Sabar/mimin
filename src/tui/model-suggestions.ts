import { getModels } from "@mariozechner/pi-ai";
import type { Api, Model } from "@mariozechner/pi-ai";
import { COMMANDCODE_BASE_URL, isCommandCodeProvider } from "../agent/commandcode.js";

/** A model choice offered by the /model command. */
export interface ModelSuggestion {
  /** The exact model ID to configure. */
  id: string;
  /** Optional hint shown beside the label (e.g. context size). */
  description?: string;
}

/** Model suggestions for a provider; never throws for unknown providers. */
export type ModelSuggestionSource = (provider: string) => Promise<ModelSuggestion[]>;

/**
 * Model suggestions for a provider. Built-in providers come from pi-ai's
 * static registry; Command Code's live catalog is fetched from its public
 * /models endpoint (empty on any failure — never blocks the TUI).
 */
export const suggestModels: ModelSuggestionSource = async (provider) => {
  if (isCommandCodeProvider(provider)) {
    return suggestCommandCodeModels();
  }
  try {
    const dynamicGetModels = getModels as unknown as (configured: string) => Model<Api>[];
    const known = dynamicGetModels(provider);
    if (!Array.isArray(known)) return [];
    return known.map((model) => ({
      id: model.id,
      description: model.contextWindow > 0
        ? `${Math.round(model.contextWindow / 1_000)}k ctx`
        : undefined,
    }));
  } catch {
    return [];
  }
};

/** Command Code's catalog is live; fetched from its public /models endpoint. */
export async function suggestCommandCodeModels(): Promise<ModelSuggestion[]> {
  try {
    const response = await fetch(`${COMMANDCODE_BASE_URL}/models`, {
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) return [];
    const payload = await response.json() as {
      data?: { id?: unknown }[];
    };
    const ids = (payload.data ?? [])
      .map((entry) => typeof entry.id === "string" ? entry.id : "")
      .filter((id) => id.length > 0);
    return ids.map((id) => ({ id }));
  } catch {
    return [];
  }
}
