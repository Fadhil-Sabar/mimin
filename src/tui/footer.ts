import {
  CombinedAutocompleteProvider,
  Editor,
  Key,
  matchesKey,
  TruncatedText,
  truncateToWidth,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type Component,
  type Focusable,
} from "@mariozechner/pi-tui";
import { sanitizeText } from "./header.js";
import { createSlashCommands, type RoleProviderResolver } from "./commands.js";
import type { SessionSuggestionSource } from "./commands.js";
import type { ProviderSuggestionSource } from "./commands.js";
import { suggestModels } from "./model-suggestions.js";
import type { ModelSuggestionSource } from "./model-suggestions.js";
import { cyan, dim, green, yellow } from "./theme.js";

export interface ContextUsage {
  used: number;
  limit: number;
}

export type ContextSummary = string | ContextUsage;

export interface FooterOptions {
  managerModel: string;
  thinking?: string;
  context?: ContextSummary;
  /** Presentation metadata: number of sidekicks currently working. */
  sidekickWorking?: number;
  /** Whether a manager run is active (drives the prompt spinner). */
  managerWorking?: boolean;
  /** Workspace root; drives file-path completion in the editor. */
  workspace?: string;
  /** Live role→provider resolution for the /model dropdown. */
  roleProviders?: RoleProviderResolver;
  /** Model suggestions for the /model dropdown; defaults to pi-ai + Command Code. */
  suggestModels?: ModelSuggestionSource;
  /** Provider suggestions for the /provider dropdown; defaults to pi-ai + Command Code. */
  suggestProviders?: ProviderSuggestionSource;
  /** Session suggestions for the /session dropdown. */
  sessionSource?: SessionSuggestionSource;
  onSubmit?: (line: string) => void | Promise<void>;
  onCancel?: () => void | Promise<void>;
  onSubmitError?: (error: unknown) => void;
  requestRender?: () => void;
}

/** Spinner frames shown while a manager run is active. */
const PROMPT_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PROMPT_SPINNER_INTERVAL_MS = 100;

function contextText(context: ContextSummary | undefined): string {
  if (typeof context === "string") return sanitizeText(context, false) || "--";
  if (!context) return "--";
  const used = Number.isFinite(context.used) ? Math.max(0, Math.floor(context.used)) : 0;
  const limit = Number.isFinite(context.limit) ? Math.max(0, Math.floor(context.limit)) : 0;
  if (limit === 0) return `${used}`;
  return `${used}/${limit} (${Math.min(999, Math.round((used / limit) * 100))}%)`;
}

/** Editor accent style: dim borders, matching the app's chrome. */
const EDITOR_THEME = {
  borderColor: dim,
  selectList: {
    selectedPrefix: cyan,
    selectedText: cyan,
    description: dim,
    scrollInfo: dim,
    noMatch: yellow,
  },
} as const;

/**
 * Wraps the pi-tui CombinedAutocompleteProvider so slash commands work fully:
 * - Command-name items apply their bare name (the provider prepends "/"
 *   itself, which would otherwise produce "//memory").
 * - Argument completions after "/command " work even on Tab (the base
 *   provider skips its slash branch when force is set) and when the
 *   completion returns a Promise (the base provider rejects Promises).
 */
function slashAwareProvider(
  commands: (AutocompleteItem | import("@mariozechner/pi-tui").SlashCommand)[] | undefined,
  workspace: string,
): AutocompleteProvider {
  const base = new CombinedAutocompleteProvider(commands, workspace) as unknown as AutocompleteProvider;
  const commandMap = new Map<string, AutocompleteItem | import("@mariozechner/pi-tui").SlashCommand>();
  for (const command of commands ?? []) {
    const name = "name" in command ? command.name : command.value;
    commandMap.set(name, command);
  }
  return {
    async getSuggestions(
      lines: string[],
      cursorLine: number,
      cursorCol: number,
      options: { signal: AbortSignal; force?: boolean },
    ): Promise<AutocompleteSuggestions | null> {
      const currentLine = lines[cursorLine] ?? "";
      const before = currentLine.slice(0, cursorCol);
      const trimmed = before.trimStart();
      if (trimmed.startsWith("/")) {
        const spaceIndex = trimmed.indexOf(" ");
        if (spaceIndex === -1) {
          // Command-name completion (no space yet). Match is fuzzy so "/me"
          // finds both "/model" and "/memory". "/session" shows its session
          // dropdown immediately (the argument list is the whole point).
          const prefix = trimmed.slice(1);
          if (prefix.startsWith("session")) {
            const sessionCommand = commandMap.get("/session");
            const completions = sessionCommand && "getArgumentCompletions" in sessionCommand && sessionCommand.getArgumentCompletions
              ? await sessionCommand.getArgumentCompletions("")
              : null;
            const items = Array.isArray(completions) ? completions : [];
            if (items.length > 0) return { items, prefix: trimmed };
          }
          const items = [...commandMap.entries()]
            .map(([name, command]) => {
              const hint = "argumentHint" in command && command.argumentHint ? command.argumentHint : undefined;
              const desc = "description" in command && command.description ? command.description : "";
              const fullDesc = hint ? (desc ? `${hint} — ${desc}` : hint) : desc;
              return { name, label: name, ...(fullDesc ? { description: fullDesc } : {}) };
            })
            .filter((item) => item.name.slice(1).includes(prefix))
            .map((item) => ({
              value: item.name.replace(/^\//, ""),
              label: item.label,
              ...(item.description ? { description: item.description } : {}),
            }));
          if (items.length === 0) return null;
          return { items, prefix: trimmed };
        }
        // Argument completion after "/command ".
        const commandName = trimmed.slice(1, spaceIndex);
        const argumentText = trimmed.slice(spaceIndex + 1);
        const command = commandMap.get(`/${commandName}`);
        const completions = command && "getArgumentCompletions" in command && command.getArgumentCompletions
          ? await command.getArgumentCompletions(argumentText)
          : null;
        // The command returns items that already match the argument text; do
        // not re-filter by the raw argument (a role name like "sidekick " must
        // not drop model IDs, and a model prefix like "gpt" should narrow).
        const items = Array.isArray(completions) ? completions : [];
        if (items.length === 0) return null;
        return { items, prefix: argumentText };
      }
      return base.getSuggestions(lines, cursorLine, cursorCol, options);
    },
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
      const currentLine = lines[cursorLine] ?? "";
      const before = currentLine.slice(0, cursorCol);
      // When completing a model ID after "/model <role>", keep the role
      // ("/model sidekick gpt-5.5"), otherwise the generic completion would
      // replace the role with the model id.
      const roleMatch = before.match(/^(\s*\/model\s+(?:manager|sidekick))(\s*)(.*)$/);
      if (roleMatch?.[1] !== undefined) {
        const prefixEnd = roleMatch[1].length + (roleMatch[2]?.length ?? 0);
        const separator = (roleMatch[2]?.length ?? 0) > 0 ? "" : " ";
        const newLine = `${before.slice(0, prefixEnd)}${separator}${item.value}${currentLine.slice(cursorCol)}`;
        const newLines = [...lines];
        newLines[cursorLine] = newLine;
        return {
          lines: newLines,
          cursorLine,
          cursorCol: prefixEnd + separator.length + item.value.length,
        };
      }
      // When completing a session ID from "/session" (command name shown as
      // the dropdown trigger), replace the whole command with "/session <id>".
      const sessionTrigger = before.match(/^(\s*\/session\s*)$/);
      if (sessionTrigger?.[1] !== undefined) {
        const newLine = `/session ${item.value}${currentLine.slice(cursorCol)}`;
        const newLines = [...lines];
        newLines[cursorLine] = newLine;
        return {
          lines: newLines,
          cursorLine,
          cursorCol: "/session ".length + item.value.length,
        };
      }
      // /session <id> after the command token: the generic argument
      // completion replaces the id correctly.
      return base.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) =>
      base.shouldTriggerFileCompletion
        ? base.shouldTriggerFileCompletion(lines, cursorLine, cursorCol)
        : true,
  };
}

/** Status plus a multi-line editor with slash-command autocomplete. */
export class Footer implements Component, Focusable {
  readonly editor: Editor;
  private status = new TruncatedText("");
  private model: string;
  private thinking: string;
  private context?: ContextSummary;
  private sidekickWorking = 0;
  private managerWorking = false;
  private frame = 0;
  private timer?: Timer;
  private handleEscape: (data: string) => void;
  private readonly optionsRequestRender?: () => void;

  constructor(options: FooterOptions) {
    this.optionsRequestRender = options.requestRender;
    this.model = sanitizeText(options.managerModel, false) || "unknown";
    this.thinking = sanitizeText(options.thinking ?? "off", false) || "off";
    this.context = options.context;
    this.sidekickWorking = Math.max(0, Math.floor(options.sidekickWorking ?? 0));
    this.managerWorking = options.managerWorking === true;

    // The editor must be constructed with a real TUI for terminal sizing; the
    // test seam supplies its host instead, which exposes the same surface.
    const host = (options as FooterOptions & { tui?: unknown }).tui as
      | { requestRender(): void; terminal: { rows: number } }
      | undefined;
    const tui = host ?? {
      requestRender: () => this.optionsRequestRender?.(),
      terminal: { rows: 24 },
    };
    this.editor = new Editor(
      tui as never,
      EDITOR_THEME as never,
      { autocompleteMaxVisible: 6 },
    );
    const suggest = options.suggestModels ?? suggestModels;
    const providerOf = options.roleProviders ?? (() => "commandcode");
    const providerSuggest = options.suggestProviders;
    this.editor.setAutocompleteProvider(
      slashAwareProvider(
        createSlashCommands(suggest, providerOf, options.sessionSource, providerSuggest) as never,
        sanitizeText(options.workspace ?? "", false) || ".",
      ),
    );

    this.editor.onSubmit = (value) => {
      const line = sanitizeText(value, false).trim();
      if (!line) return;
      this.editor.setText("");
      this.editor.addToHistory(line);
      options.requestRender?.();
      void Promise.resolve(options.onSubmit?.(line))
        .catch((error: unknown) => options.onSubmitError?.(error))
        .finally(() => options.requestRender?.());
    };
    // The Editor has no standalone Escape binding, so intercept Escape in a
    // wrapper before it reaches the editor (an open autocomplete list still
    // consumes Escape itself; this only fires on an idle editor).
    // matchesKey handles both the legacy bare ESC and the CSI-u (Kitty
    // protocol) escape forms, so cancellation works on every terminal.
    this.handleEscape = (data: string): void => {
      if (matchesKey(data, Key.escape)) {
        void Promise.resolve(options.onCancel?.())
          .catch((error: unknown) => options.onSubmitError?.(error));
        return;
      }
      this.editor.handleInput(data);
    };

    this.updateTimer();
    this.refresh();
  }

  /** The editor's text input (set for programmatic values in tests). */
  get input(): Editor {
    return this.editor;
  }

  get focused(): boolean {
    return this.editor.focused;
  }

  set focused(value: boolean) {
    this.editor.focused = value;
  }

  setStatus(update: {
    managerModel?: string;
    thinking?: string;
    context?: ContextSummary;
    sidekickWorking?: number;
    managerWorking?: boolean;
  }): void {
    if (update.managerModel !== undefined) {
      this.model = sanitizeText(update.managerModel, false) || "unknown";
    }
    if (update.thinking !== undefined) {
      this.thinking = sanitizeText(update.thinking, false) || "off";
    }
    if (update.context !== undefined) this.context = update.context;
    if (update.sidekickWorking !== undefined) {
      this.sidekickWorking = Math.max(0, Math.floor(update.sidekickWorking));
    }
    if (update.managerWorking !== undefined) {
      const next = update.managerWorking === true;
      if (this.managerWorking !== next) {
        this.managerWorking = next;
        this.frame = 0;
        this.updateTimer();
      }
    }
    this.refresh();
  }

  handleInput(data: string): void {
    this.handleEscape(data);
  }

  invalidate(): void {
    this.status.invalidate();
    this.editor.invalidate();
  }

  /** Status plus the multi-line editor, separated by a dim rule. */
  render(width: number): string[] {
    if (width <= 0) return ["", ""];
    const rule = width > 0 ? dim("─".repeat(Math.max(1, width))) : "";
    return [
      rule,
      ...this.status.render(width),
      ...this.editor.render(width),
    ];
  }

  private updateTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.managerWorking) {
      this.timer = setInterval(() => {
        this.frame = (this.frame + 1) % PROMPT_SPINNER.length;
        this.refresh();
        this.optionsRequestRender?.();
      }, PROMPT_SPINNER_INTERVAL_MS);
    }
  }

  private refresh(): void {
    const working = this.managerWorking
      ? `${cyan(PROMPT_SPINNER[this.frame % PROMPT_SPINNER.length]!)} working · `
      : "";
    const sidekicks = this.sidekickWorking > 0
      ? ` · ${green(`${this.sidekickWorking} sidekick${this.sidekickWorking === 1 ? "" : "s"} working`)}`
      : ` · ${dim("sidekick: idle")}`;
    this.status = new TruncatedText(
      `${working}${dim("model")} ${cyan(this.model)} · ${dim("context")} ${contextText(this.context)}${sidekicks}`,
    );
  }
}
