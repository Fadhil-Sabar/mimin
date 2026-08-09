import { truncateToWidth, type Component } from "@mariozechner/pi-tui";
import { sanitizeText } from "./header.js";
import { cyan, dim, green, yellow } from "./theme.js";

/** Local structural event accepted without importing agent or pi-ai types. */
export interface LocalToolEvent {
  type: string;
  turn?: number;
  toolCall?: {
    name?: unknown;
    arguments?: unknown;
  };
  result?: {
    isError?: unknown;
    text?: unknown;
    details?: unknown;
  };
}

interface ToolRow {
  name: string;
  status: "running" | "ok" | "failed";
  /** Safe detail parsed from tool_start arguments (path/command). */
  detail?: string;
  /** Error summary appended on failure. */
  error?: string;
}

/** Tools represented by sidekick cards; their rows are suppressed. */
const CARD_REPRESENTED = new Set(["delegate"]);

/** Title-case labels aligned to the widest label for a compact column. */
const LABELS: Record<string, string> = {
  read: "Read",
  edit: "Edit",
  bash: "Bash",
  memory_search: "Memory",
  session_search: "History",
  verification: "Verify",
  delegate: "Delegate",
};

const LABEL_WIDTH = 7;

function nameOf(value: unknown): string {
  return sanitizeText(value, false).trim() || "tool";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function labelOf(name: string): string {
  const fallback = name[0]?.toUpperCase() + name.slice(1);
  return LABELS[name] ?? (fallback || name);
}

/** Parse a safe argument detail at tool_start: path for read/edit, command for bash. */
function startDetail(name: string, args: unknown): string | undefined {
  const object = record(args);
  if (!object) return undefined;
  if (name === "read" || name === "edit") {
    return compact(object.path, 60);
  }
  if (name === "bash") {
    return compact(object.command, 60);
  }
  return undefined;
}

function compact(value: unknown, limit: number): string {
  const text = sanitizeText(value, false).trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * Compact tool rows for the manager run. Labels are title-case and aligned,
 * success shows only the parsed path/command (no debug text), failures append
 * a `✗` summary. Delegate is represented by its sidekick card, so its row is
 * suppressed. Raw stdout/transcripts never reach the UI.
 */
export class ToolActivity implements Component {
  private readonly rows: ToolRow[] = [];

  apply(event: LocalToolEvent): void {
    const type = typeof event.type === "string" ? event.type : "";
    const toolCall = record(event.toolCall);
    const name = nameOf(toolCall?.name);
    if (CARD_REPRESENTED.has(name)) return;
    if (type === "tool_start") {
      this.rows.push({
        name,
        status: "running",
        detail: startDetail(name, toolCall?.arguments),
      });
      return;
    }
    if (type === "tool_end") {
      const row = this.rows
        .slice()
        .reverse()
        .find((candidate) => candidate.name === name && candidate.status === "running");
      if (!row) return;
      const result = record(event.result);
      const isError = result?.isError === true;
      row.status = isError ? "failed" : "ok";
      if (isError) row.error = compact(result?.text, 60);
    }
  }

  clear(): void {
    this.rows.length = 0;
  }

  invalidate(): void {
    // Rendering derives from the small whitelisted row state.
  }

  render(width: number): string[] {
    if (width <= 0 || this.rows.length === 0) return [];
    return this.rows.map((row) => {
      const label = labelOf(row.name).padEnd(LABEL_WIDTH);
      const detail = row.detail ? ` ${dim(row.detail)}` : "";
      const failure = row.status === "failed"
        ? ` ${yellow(`✗ ${row.error ?? "failed"}`)}`
        : "";
      const suffix = row.status === "running" ? cyan(" …") : "";
      return truncateToWidth(`  ${label}${detail}${failure}${suffix}`, width);
    });
  }
}
