import type { AutocompleteItem, SlashCommand } from "@mariozechner/pi-tui";
import { suggestModels } from "./model-suggestions.js";
import type { ModelSuggestionSource } from "./model-suggestions.js";
import { suggestProviders } from "./provider-suggestions.js";

/**
 * The interactive slash-command family, shared between the CLI interceptor
 * and the footer autocomplete so suggestions can never drift from behavior.
 * The exact strings here are the source of truth for `handleInteractiveCommand`.
 */

/** The name of every interactive slash command, for the usage help text. */
export const INTERACTIVE_COMMAND_NAMES = [
  "/session [<session-id>]",
  "/model [manager|sidekick] [<provider-id> <model-id>]",
  "/provider [<provider-id>]",
  "/memory add user <text>",
  "/memory add project <text>",
  "/memory search <query>",
  "/help",
] as const;

/** Options accepted by the /model and /provider commands' second position. */
const ROLE_OPTIONS: AutocompleteItem[] = [
  { value: "manager ", label: "manager", description: "Switch the manager role" },
  { value: "sidekick ", label: "sidekick", description: "Switch the sidekick role" },
];

/**
 * Model dropdown for /model <role>. Aggregates models across configured
 * providers (provider visible for disambiguation). Falls back to the role's
 * current provider only when no provider source is wired.
 */
function modelIdCompletions(
  role: "manager" | "sidekick",
  providerOf: RoleProviderResolver,
  suggest: ModelSuggestionSource,
  suggestProvidersSource?: ProviderSuggestionSource,
): (prefix: string) => Promise<AutocompleteItem[] | null> {
  return async (argumentPrefix: string): Promise<AutocompleteItem[] | null> => {
    const prefix = argumentPrefix.trim();
    let providers: string[];
    if (suggestProvidersSource) {
      const configured = (await suggestProvidersSource()).filter((item) => item.configured);
      providers = configured.length > 0
        ? configured.map((item) => item.id)
        : [providerOf(role)].filter((value) => value.length > 0);
    } else {
      const current = providerOf(role);
      providers = current ? [current] : [];
    }

    const results = await Promise.all(providers.map(async (provider) => {
      try {
        return await suggest(provider);
      } catch {
        return [];
      }
    }));
    const items = results.flat().map((item) => ({
      value: `${item.provider} ${item.id}`,
      label: item.id,
      description: [item.provider, item.description].filter(Boolean).join(" · "),
    }));
    const filtered = prefix.length === 0
      ? items
      : items.filter((item) =>
        `${item.value} ${item.label}`.toLowerCase().includes(prefix.toLowerCase()),
      );
    return filtered.length > 0 ? filtered : null;
  };
}

/** Resolve a role's current provider for the /model dropdown. */
export type RoleProviderResolver = (role: "manager" | "sidekick") => string;

/** Provider suggestions for the /provider dropdown. */
export type ProviderSuggestionSource = () => Promise<
  { id: string; label?: string; description?: string; configured?: boolean }[]
>;

/** Session suggestions for the /session dropdown (manager or sidekick). */
export type SessionSuggestionSource = (role: "manager" | "sidekick") => Promise<
  { id: string; label?: string; description?: string }[]
>;

/** Fetch the provider dropdown for the /provider command. */
function providerIdCompletions(
  suggest: ProviderSuggestionSource,
): (prefix: string) => Promise<AutocompleteItem[] | null> {
  return async (argumentPrefix: string): Promise<AutocompleteItem[] | null> => {
    const prefix = argumentPrefix.trim();
    const suggestions = await suggest();
    const items = suggestions.map((item) => {
      const description = [
        ...(item.description ? [item.description] : []),
        ...(item.configured ? ["configured"] : []),
      ].join(" · ");
      return {
        value: item.id,
        label: item.id,
        ...(description ? { description } : {}),
      };
    });
    const filtered = prefix.length === 0
      ? items
      : items.filter((item) => item.value.toLowerCase().includes(prefix.toLowerCase()));
    return filtered.length > 0 ? filtered : null;
  };
}

/**
 * Slash commands offered by the footer autocomplete. The /model dropdown is
 * built lazily: the role pick is static, and the model list is fetched from
 * the selected role's provider on demand (never at startup).
 */
export function createSlashCommands(
  suggest: ModelSuggestionSource,
  providerOf: RoleProviderResolver,
  sessionSource?: SessionSuggestionSource,
  suggestProvidersSource?: ProviderSuggestionSource,
): SlashCommand[] {
  const providers = suggestProvidersSource ?? (async () => []);
  return [
    {
      name: "/help",
      description: "Show the interactive command family",
    },
    {
      name: "/session",
      description: "Restore a previous manager session",
      getArgumentCompletions(
        argumentPrefix: string,
      ): AutocompleteItem[] | Promise<AutocompleteItem[] | null> | null {
        if (!sessionSource) return null;
        const prefix = argumentPrefix.trim();
        return sessionSource("manager").then((sessions) => {
          const items = sessions
            .filter((item) => item.id.includes(prefix))
            .map((item) => ({
              value: item.id,
              label: item.label ?? item.id,
              ...(item.description ? { description: item.description } : {}),
            }));
          return items.length > 0 ? items : null;
        });
      },
    },
    {
      name: "/model",
      description: "Switch the manager or sidekick model",
      argumentHint: "manager|sidekick [<provider-id> <model-id>]",
      getArgumentCompletions(
        argumentPrefix: string,
      ): AutocompleteItem[] | Promise<AutocompleteItem[] | null> | null {
        const prefix = argumentPrefix.trim();
        // After the role pick ("/model manager" or "/model manager <id>"),
        // offer models from configured providers, fetched live.
        const role = /^manager(\s|$)/.test(argumentPrefix)
          ? "manager"
          : /^sidekick(\s|$)/.test(argumentPrefix)
            ? "sidekick"
            : undefined;
        if (role) {
          const modelPrefix = prefix.slice(role.length).trimStart();
          return modelIdCompletions(role, providerOf, suggest, providers)(modelPrefix);
        }
        // Role pick: manager | sidekick.
        const filtered = ROLE_OPTIONS.filter((option) => option.value.startsWith(prefix));
        return filtered.length > 0 ? filtered : null;
      },
    },
    {
      name: "/provider",
      description: "List providers with credential hints",
      getArgumentCompletions(
        argumentPrefix: string,
      ): AutocompleteItem[] | Promise<AutocompleteItem[] | null> | null {
        const prefix = argumentPrefix.trim();
        return providerIdCompletions(providers)(prefix);
      },
    },
    {
      name: "/memory",
      description: "Explicit memory operations",
      argumentHint: "add user|project <text> | search <query>",
      getArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
        const prefix = argumentPrefix.trim();
        const options: AutocompleteItem[] = [
          { value: "add user ", label: "add user <text>", description: "Save a user-scoped memory" },
          { value: "add project ", label: "add project <text>", description: "Save a project-scoped memory" },
          { value: "search ", label: "search <query>", description: "Search user and project memory" },
        ];
        const filtered = options.filter((option) => option.value.startsWith(prefix));
        return filtered.length > 0 ? filtered : null;
      },
    },
  ];
}

/** The default command set, wired to the standard model suggestions. */
export const SLASH_COMMANDS: SlashCommand[] = createSlashCommands(
  suggestModels,
  () => "commandcode",
  undefined,
  suggestProviders,
);
