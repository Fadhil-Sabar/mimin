import { truncateToWidth, type Component } from "@mariozechner/pi-tui";
import { sanitizeText } from "./header.js";
import { cyan, dim, green, yellow } from "./theme.js";
import { spinnerFrame, type AnimationState } from "./animation.js";

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
  /** Start arguments retained privately for derived summaries (+/- lines). */
  args?: Record<string, unknown>;
  /** Original tool result retained for future detail views; never rendered. */
  resultData?: unknown;
  /** Compact error message shown on failure (name stripped, sanitized). */
  error?: string;
  /** Safe success summary ("81 passed", "2 checks passed"). */
  summary?: string;
  /** Added/removed line counts for successful edit rows (+added -removed). */
  diff?: { added: number; removed: number };
  /** Exit code for bash/verification failures when exposed (details/text). */
  exitCode?: number;
}

/** Tools represented by sidekick cards; their rows are suppressed. */
const CARD_REPRESENTED = new Set(["delegate"]);

/** Lowercase labels aligned to the widest label for a compact column. */
const LABELS: Record<string, string> = {
  read: "read",
  edit: "edit",
  bash: "bash",
  memory_search: "search",
  session_search: "search",
  verification: "verify",
};

const LABEL_WIDTH = 6;

/** Strip a `Tool "name" failed:`-style prefix, the name is already shown. */
const ERROR_PREFIX = /^Tool\s+"[^"]*"\s+failed:\s*/;

/** Match a test-count summary: "81 pass", "81 passed", "81 tests passed". */
const TEST_COUNT = /(\d{1,6})\s+(?:tests?\s+)?pass(?:ed|es)?/i;

/** Match a bash-style "exitCode: N" prefix in the tool result text. */
const EXIT_CODE_TEXT = /exitCode:\s*(-?\d+)/i;

function nameOf(value: unknown): string {
  return sanitizeText(value, false).trim() || "tool";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function labelOf(name: string): string {
  return LABELS[name] ?? name.toLowerCase();
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
 * Meaningful line count of a text value (non-empty lines, capped). Used to
 * derive the +/- diff of a successful edit from its start arguments.
 */
function lineCount(value: unknown): number {
  if (typeof value !== "string") return 0;
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  const meaningful = lines.filter((line) => line.trim().length > 0).length;
  return Math.min(meaningful, 999);
}

/** Derive the +/- diff for a successful edit from its retained start args. */
function editDiff(args: Record<string, unknown> | undefined): { added: number; removed: number } | undefined {
  if (!args) return undefined;
  const added = lineCount(args.newText);
  const removed = lineCount(args.oldText);
  if (added === 0 && removed === 0) return undefined;
  return { added, removed };
}

/** Extract a safe test-count summary from output text ("81 pass" -> "81 passed"). */
function testCount(raw: unknown): string | undefined {
  const text = sanitizeText(raw, false).trim();
  const match = TEST_COUNT.exec(text);
  if (!match || match[1] === undefined) return undefined;
  const count = Number(match[1]);
  if (!Number.isSafeInteger(count) || count < 0) return undefined;
  return `${count} passed`;
}

/**
 * Short safe verification summary built from the whitelisted result details:
 * each command's ok flag. Only counts are shown, never output.
 */
function verificationChecks(details: unknown): string | undefined {
  const object = record(details);
  const results = object?.results;
  if (!Array.isArray(results)) return undefined;
  const entries = results.map(record).filter((entry) => entry !== undefined);
  if (entries.length === 0) return undefined;
  const passed = entries.filter((entry) => entry.ok === true).length;
  const failed = entries.length - passed;
  const ok = entries.every((entry) => entry.ok === true);
  if (ok) return entries.length === 1 ? "passed" : `${passed} checks passed`;
  return failed === entries.length ? "failed" : `${passed}/${entries.length} checks passed`;
}

/** Extract the exit code exposed by details.exitCode or "exitCode: N" text. */
function exitCodeOf(result: Record<string, unknown> | undefined): number | undefined {
  const details = record(result?.details);
  const raw = details?.exitCode;
  if (typeof raw === "number" && Number.isSafeInteger(raw)) return raw;
  const text = sanitizeText(result?.text, false);
  const match = EXIT_CODE_TEXT.exec(text);
  if (match?.[1] !== undefined) {
    const code = Number(match[1]);
    if (Number.isSafeInteger(code)) return code;
  }
  return undefined;
}

function compactError(raw: unknown): string | undefined {
  const text = sanitizeText(raw, false).trim();
  if (!text) return undefined;
  // "Tool "read" failed: Path "src" is not a regular file" -> "Path …";
  // also drop a trailing "exitCode: N" / "stdout:" / "stderr:" preamble
  // (the exit code is already shown inline as `exit N`).
  const stripped = text
    .replace(ERROR_PREFIX, "")
    .replace(/^exitCode:\s*\d+\s*\n?/, "")
    .replace(/^(?:stdout|stderr):\s*\n?/, "");
  return compact(stripped || text, 60);
}

function compact(value: unknown, limit: number): string {
  const text = sanitizeText(value, false).trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * Compact manager tool rows, styled as an inline activity stream:
 * lowercase aligned labels in a stable column, pending/running/completed/
 * failed states with status glyphs, safe path/command detail, dim routine
 * completions, a short error line under failed rows, an `exit N` marker on
 * bash/verification failures when an exit code is exposed, a safe test-count
 * summary on bash/verification successes, and `+added -removed` on successful
 * edits. Raw stdout/transcripts and the original tool result never reach the
 * UI (the result is retained privately for future detail views). Delegate is
 * represented by its sidekick card, so its row is suppressed.
 */
export class ToolActivity implements Component {
  private readonly rows: ToolRow[] = [];
  constructor(private readonly animation?: AnimationState) {}
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
        args: record(toolCall?.arguments),
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
      // Retain the original result privately for future detail views.
      row.resultData = result;
      if (isError) {
        row.error = compactError(result?.text);
        if (name === "bash" || name === "verification") {
          row.exitCode = exitCodeOf(result);
        }
      } else if (name === "edit") {
        row.diff = editDiff(row.args);
      } else if (name === "bash" || name === "verification") {
        // Test-count summary first ("81 pass" -> "81 passed"), then the
        // whitelisted per-command ok flags for verification.
        const text = result?.text;
        const stdout = record(result?.details)?.stdout;
        row.summary =
          testCount(text) ??
          testCount(stdout) ??
          (name === "verification" ? verificationChecks(result?.details) : undefined);
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

  hasRunning(): boolean {
    return this.rows.some((row) => row.status === "running");
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
    const styledGlyph = row.status === "running"
      ? cyan(spinnerFrame(this.animation?.frame ?? 0))
      : row.status === "failed"
        ? yellow(glyph)
        : row.status === "ok"
          ? green(glyph)
          : cyan(glyph);
    const detail = row.detail ? ` ${dim(row.detail)}` : "";
    const suffix = "";
    const exit = row.status === "failed" && row.exitCode !== undefined
      ? ` ${yellow(`· exit ${row.exitCode}`)}`
      : "";
    const summary = row.status === "ok" && row.summary
      ? ` ${green(`· ${row.summary}`)}`
      : "";
    const diff = row.status === "ok" && row.diff
      ? ` ${green(`+${row.diff.added}`)}${row.diff.removed > 0 ? ` ${yellow(`-${row.diff.removed}`)}` : ""}`
      : "";
    const line = truncateToWidth(
      ` ${styledGlyph} ${label}${detail}${suffix}${exit}${summary}${diff}`,
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
  failed: "×",
};
