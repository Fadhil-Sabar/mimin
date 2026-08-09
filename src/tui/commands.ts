import type { AutocompleteItem, SlashCommand } from "@mariozechner/pi-tui";
import { suggestModels } from "./model-suggestions.js";
import type { ModelSuggestionSource } from "./model-suggestions.js";

/**
 * The interactive slash-command family, shared between the CLI interceptor
 * and the footer autocomplete so suggestions can never drift from behavior.
 * The exact strings here are the source of truth for `handleInteractiveCommand`.
 */

/** The name of every interactive slash command, for the usage help text. */
export const INTERACTIVE_COMMAND_NAMES = [
  "/session [<session-id>]",
  "/model [manager|sidekick] [<model-id>]",
  "/memory add user <text>",
  "/memory add project <text>",
  "/memory search <query>",
  "/help",
] as const;

/** Options accepted by the /model command's second position. */
const MODEL_ROLE_OPTIONS: AutocompleteItem[] = [
  { value: "manager ", label: "manager", description: "Switch the manager model" },
  { value: "sidekick ", label: "sidekick", description: "Switch the sidekick model" },
];

/** Fetch the model dropdown for a role's current provider. */
function modelIdCompletions(
  provider: string,
  suggest: ModelSuggestionSource,
): (prefix: string) => Promise<AutocompleteItem[] | null> {
  return async (argumentPrefix: string): Promise<AutocompleteItem[] | null> => {
    const prefix = argumentPrefix.trim();
    const suggestions = await suggest(provider);
    const items = suggestions.map((item) => ({
      value: item.id,
      label: item.id,
      ...(item.description ? { description: item.description } : {}),
    }));
    const filtered = prefix.length === 0
      ? items
      : items.filter((item) => item.value.toLowerCase().includes(prefix.toLowerCase()));
    return filtered.length > 0 ? filtered : null;
  };
}

/** Resolve a role's current provider for the /model dropdown. */
export type RoleProviderResolver = (role: "manager" | "sidekick") => string;

/** Session suggestions for the /session dropdown (manager or sidekick). */
export type SessionSuggestionSource = (role: "manager" | "sidekick") => Promise<
  { id: string; label?: string; description?: string }[]
>;

/**
 * Slash commands offered by the footer autocomplete. The /model dropdown is
 * built lazily: the role pick is static, and the model list is fetched from
 * the selected role's provider on demand (never at startup).
 */
export function createSlashCommands(
  suggest: ModelSuggestionSource,
  providerOf: RoleProviderResolver,
  sessionSource?: SessionSuggestionSource,
): SlashCommand[] {
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
      argumentHint: "manager|sidekick [<model-id>]",
      getArgumentCompletions(
        argumentPrefix: string,
      ): AutocompleteItem[] | Promise<AutocompleteItem[] | null> | null {
        const prefix = argumentPrefix.trim();
        // After the role pick ("/model manager" or "/model manager <id>"),
        // offer that role's provider's model IDs, fetched live from the
        // catalog. A bare role name (with or without trailing space) already
        // switches to model-id completion.
        const role = /^manager(\s|$)/.test(argumentPrefix)
          ? "manager"
          : /^sidekick(\s|$)/.test(argumentPrefix)
            ? "sidekick"
            : undefined;
        if (role) {
          const provider = providerOf(role);
          if (!provider) return null;
          const modelPrefix = prefix.slice(role.length).trimStart();
          return modelIdCompletions(provider, suggest)(modelPrefix);
        }
        // Role pick: manager | sidekick.
        const filtered = MODEL_ROLE_OPTIONS.filter((option) => option.value.startsWith(prefix));
        return filtered.length > 0 ? filtered : null;
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
);
