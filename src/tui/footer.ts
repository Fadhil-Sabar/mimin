import {
  CombinedAutocompleteProvider,
  Editor,
  TruncatedText,
  truncateToWidth,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type Component,
  type Focusable,
} from "@mariozechner/pi-tui";
import { sanitizeText } from "./header.js";
import { SLASH_COMMANDS } from "./commands.js";
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
 * Wraps the pi-tui CombinedAutocompleteProvider so slash-command items apply
 * their bare name (the provider prepends "/" itself, which would otherwise
 * produce "//memory"). The menu still shows the "/"-prefixed labels.
 */
function slashAwareProvider(
  commands: (AutocompleteItem | import("@mariozechner/pi-tui").SlashCommand)[] | undefined,
  workspace: string,
): AutocompleteProvider {
  const base = new CombinedAutocompleteProvider(commands, workspace) as unknown as AutocompleteProvider;
  return {
    async getSuggestions(
      lines: string[],
      cursorLine: number,
      cursorCol: number,
      options: { signal: AbortSignal; force?: boolean },
    ): Promise<AutocompleteSuggestions | null> {
      const suggestions = await base.getSuggestions(lines, cursorLine, cursorCol, options);
      if (!suggestions) return null;
      const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
      const isSlashCommand = before.trimStart().startsWith("/") && !before.trimStart().includes(" ");
      if (!isSlashCommand) return suggestions;
      return {
        ...suggestions,
        items: suggestions.items.map((item: AutocompleteItem) => ({
          ...item,
          value: item.value.replace(/^\//, ""),
        })),
      };
    },
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
      base.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
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
    this.editor.setAutocompleteProvider(
      slashAwareProvider(
        SLASH_COMMANDS as never,
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
    this.handleEscape = (data: string): void => {
      if (data === "\u001b") {
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
