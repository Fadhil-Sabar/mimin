import {
  Input,
  TruncatedText,
  truncateToWidth,
  type Component,
  type Focusable,
} from "@mariozechner/pi-tui";
import { sanitizeText } from "./header.js";

export interface ContextUsage {
  used: number;
  limit: number;
}

export type ContextSummary = string | ContextUsage;

export interface FooterOptions {
  managerModel: string;
  thinking?: string;
  context?: ContextSummary;
  onSubmit?: (line: string) => void | Promise<void>;
  onCancel?: () => void | Promise<void>;
  onSubmitError?: (error: unknown) => void;
  requestRender?: () => void;
}

function contextText(context: ContextSummary | undefined): string {
  if (typeof context === "string") return sanitizeText(context, false) || "--";
  if (!context) return "--";
  const used = Number.isFinite(context.used) ? Math.max(0, Math.floor(context.used)) : 0;
  const limit = Number.isFinite(context.limit) ? Math.max(0, Math.floor(context.limit)) : 0;
  if (limit === 0) return `${used}`;
  return `${used}/${limit} (${Math.min(999, Math.round((used / limit) * 100))}%)`;
}

/** Status plus a real pi-tui single-line Input primitive. */
export class Footer implements Component, Focusable {
  readonly input = new Input();
  private status = new TruncatedText("");
  private model: string;
  private thinking: string;
  private context?: ContextSummary;

  constructor(options: FooterOptions) {
    this.model = sanitizeText(options.managerModel, false) || "unknown";
    this.thinking = sanitizeText(options.thinking ?? "off", false) || "off";
    this.context = options.context;
    this.refresh();

    this.input.onSubmit = (value) => {
      const line = sanitizeText(value, false).trim();
      if (!line) return;
      this.input.setValue("");
      options.requestRender?.();
      void Promise.resolve(options.onSubmit?.(line))
        .catch((error: unknown) => options.onSubmitError?.(error))
        .finally(() => options.requestRender?.());
    };
    this.input.onEscape = () => {
      void Promise.resolve(options.onCancel?.())
        .catch((error: unknown) => options.onSubmitError?.(error));
    };
  }

  get focused(): boolean {
    return this.input.focused;
  }

  set focused(value: boolean) {
    this.input.focused = value;
  }

  setStatus(update: {
    managerModel?: string;
    thinking?: string;
    context?: ContextSummary;
  }): void {
    if (update.managerModel !== undefined) {
      this.model = sanitizeText(update.managerModel, false) || "unknown";
    }
    if (update.thinking !== undefined) {
      this.thinking = sanitizeText(update.thinking, false) || "off";
    }
    if (update.context !== undefined) this.context = update.context;
    this.refresh();
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
  }

  invalidate(): void {
    this.status.invalidate();
    this.input.invalidate();
  }

  render(width: number): string[] {
    if (width <= 0) return ["", ""];
    // Input rejects controls from normal key events, but bracketed paste and
    // programmatic values are also untrusted and need the same boundary.
    const value = this.input.getValue();
    const safeValue = sanitizeText(value, false);
    if (safeValue !== value) this.input.setValue(safeValue);
    return [
      ...this.status.render(width),
      ...this.input.render(width).map((line) => truncateToWidth(line, width)),
    ];
  }

  private refresh(): void {
    this.status = new TruncatedText(
      `model ${this.model} | thinking ${this.thinking} | context ${contextText(this.context)}`,
    );
  }
}
