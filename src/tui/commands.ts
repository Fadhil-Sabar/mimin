import type { AutocompleteItem, SlashCommand } from "@mariozechner/pi-tui";

/**
 * The interactive slash-command family, shared between the CLI interceptor
 * and the footer autocomplete so suggestions can never drift from behavior.
 * The exact strings here are the source of truth for `handleInteractiveCommand`.
 */

/** The name of every interactive slash command, for the usage help text. */
export const INTERACTIVE_COMMAND_NAMES = [
  "/memory add user <text>",
  "/memory add project <text>",
  "/memory search <query>",
  "/help",
] as const;

/** Slash commands offered by the footer autocomplete. */
export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "/help",
    description: "Show the interactive command family",
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
