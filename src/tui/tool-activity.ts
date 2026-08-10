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

type ToolStatus = "pending" | "running" | "ok" | "failed";

interface ToolRow {
  name: string;
  status: ToolStatus;
  /** Turn of the tool call, for grouping rows into transcript blocks. */
  turn: number;
  /** Safe detail parsed from tool_start arguments (path/command). */
  detail?: string;
  /** Compact error message shown on failure (name stripped, sanitized). */
  error?: string;
  /** Short safe summary for verification successes (e.g. "81 tests passed"). */
  summary?: string;
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

/** Strip a `Tool "name" failed:`-style prefix, the name is already shown. */
const ERROR_PREFIX = /^Tool\s+"[^"]*"\s+failed:\s*/;

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
  if (name === "verification") {
    return compact(VERIFY_COMMAND[object.action as string] ?? object.action, 60);
  }
  return undefined;
}

/** Friendlier command label for the fixed verification actions. */
const VERIFY_COMMAND: Record<string, string> = {
  git_status: "git status",
  git_diff: "git diff",
  test: "bun test",
  typecheck: "bun run typecheck",
  build: "bun run build",
  all: "test + typecheck + build",
};

/**
 * Short safe verification summary built from the whitelisted result details:
 * each command's ok flag and exit code. Only counts are shown, never output.
 */
function verificationSummary(details: unknown): string | undefined {
  const object = record(details);
  const results = object?.results;
  if (!Array.isArray(results)) return undefined;
  const entries = results.map(record).filter((entry) => entry !== undefined);
  if (entries.length === 0) return undefined;
  const passed = entries.filter((entry) => entry.ok === true).length;
  const failed = entries.length - passed;
  const ok = entries.every((entry) => entry.ok === true);
  if (ok) return entries.length === 1 ? "passed" : `${passed} checks passed`;
  return failed === entries.length
    ? "failed"
    : `${passed}/${entries.length} checks passed`;
}

function compactError(raw: unknown): string | undefined {
  const text = sanitizeText(raw, false).trim();
  if (!text) return undefined;
  // "Tool "read" failed: Path "src" is not a regular file" -> "Path …"
  const stripped = text.replace(ERROR_PREFIX, "");
  return compact(stripped || text, 60);
}

function compact(value: unknown, limit: number): string {
  const text = sanitizeText(value, false).trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * Compact tool rows for the manager run, styled as an activity stream:
 * pending/running/completed/failed states with status glyphs, title-case
 * labels in a stable column, dim completed routine work, a short error line
 * under failed rows, and a safe one-line summary for verification successes.
 * Raw stdout/transcripts never reach the UI. Delegate is represented by its
 * sidekick card, so its row is suppressed.
 */
export class ToolActivity implements Component {
  private readonly rows: ToolRow[] = [];
  /** Turn of the most recent tool_start, for grouping rows into blocks. */
  private currentTurn = 0;

  /** Apply a tool event; returns false when the tool is card-represented. */
  apply(event: LocalToolEvent): boolean {
    const type = typeof event.type === "string" ? event.type : "";
    const toolCall = record(event.toolCall);
    const name = nameOf(toolCall?.name);
    if (CARD_REPRESENTED.has(name)) return false;

    if (type === "tool_start") {
      const turn = typeof event.turn === "number" ? event.turn : 0;
      this.rows.push({
        name,
        status: "running",
        detail: startDetail(name, toolCall?.arguments),
        turn,
      });
      this.currentTurn = turn;
      return true;
    }

    if (type === "tool_end") {
      const row = this.rows
        .slice()
        .reverse()
        .find((candidate) => candidate.name === name && candidate.status === "running");
      if (!row) return false;
      const result = record(event.result);
      const isError = result?.isError === true;
      row.status = isError ? "failed" : "ok";
      if (isError) {
        row.error = compactError(result?.text);
      } else if (name === "verification") {
        row.summary = verificationSummary(result?.details);
      }
      return true;
    }
    return false;
  }

  /** True when a tool block exists for the given turn. */
  hasTurn(turn: number): boolean {
    return this.rows.some((row) => row.turn === turn);
  }

  /** Live renderer for one turn's tool rows (in-place updates on apply). */
  rendererForTurn(turn: number): (width: number) => string[] {
    return (width: number) => this.renderTurn(width, turn);
  }

  /** The rows belonging to a turn, as standalone renderable lines. */
  renderTurn(width: number, turn: number): string[] {
    const lines: string[] = [];
    for (const row of this.rows) {
      if (row.turn !== turn) continue;
      lines.push(...this.renderRow(row, width));
    }
    return lines;
  }

  clear(): void {
    this.rows.length = 0;
    this.currentTurn = 0;
  }

  invalidate(): void {
    // Rendering derives from the small whitelisted row state.
  }

  render(width: number): string[] {
    if (width <= 0 || this.rows.length === 0) return [];
    return this.rows.flatMap((row) => this.renderRow(row, width));
  }

  /** One tool row (plus an error sub-line when failed) as rendered lines. */
  private renderRow(row: ToolRow, width: number): string[] {
    const label = labelOf(row.name).padEnd(LABEL_WIDTH);
    const glyph = STATUS_GLYPHS[row.status];
    const styledGlyph = row.status === "failed"
      ? yellow(glyph)
      : row.status === "ok"
        ? green(glyph)
        : cyan(glyph);
    const detail = row.detail ? ` ${dim(row.detail)}` : "";
    const suffix = row.status === "running" ? ` ${cyan("…")}` : "";
    const summary = row.status === "ok" && row.summary
      ? ` ${green(`· ${row.summary}`)}`
      : "";
    const line = truncateToWidth(
      ` ${styledGlyph} ${label}${detail}${suffix}${summary}`,
      width,
    );
    if (row.status !== "failed" || !row.error) return [line];
    // Failed rows get a quiet second line with the error, keeping the
    // failure readable without dumping raw tool output into the stream.
    const errorLine = truncateToWidth(`  ${dim("·")} ${yellow(row.error)}`, width);
    return [line, errorLine];
  }
}

const STATUS_GLYPHS: Record<ToolStatus, string> = {
  pending: "○",
  running: "●",
  ok: "✓",
  failed: "✕",
};
