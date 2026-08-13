import { truncateToWidth, type Component } from "@mariozechner/pi-tui";
import { sanitizeText } from "./header.js";
import { cyan, dim, green, yellow } from "./theme.js";
import { isTaskStatus, type TaskBoard, type TaskStatus } from "../task/task.js";
import { taskStatusSymbol } from "./task-board.js";

/**
 * Compact TUI tasks panel.
 *
 * Renders the active task board as a bounded column of one-line rows:
 * `SYM T01 title` with the README status symbols (o/r/v/x/✓/f), plus a
 * footer line with status counts and the active sidekick share. The panel
 * is a plain component fed from outside: the app pushes the live board
 * (from the manager session) via `setBoard`. It never owns board state and
 * never renders task descriptions, sidekick transcripts, or raw results —
 * only the whitelisted id/title/status fields.
 */

/** Maximum rows shown before the panel collapses into a waiting badge. */
const MAX_TASK_ROWS = 6;

interface TaskRow {
  id: string;
  title: string;
  status: TaskStatus;
  /** Bound sidekick session id (running/revising tasks only). */
  sidekickId?: string;
}

export interface TasksPanelOptions {
  /** Initial board (empty when task tracking is inactive). */
  board?: TaskBoard;
}

/** Counts row labels in render order. */
const COUNT_LABELS: { status: string; label: string }[] = [
  { status: "pending", label: "pending" },
  { status: "running", label: "running" },
  { status: "reviewing", label: "review" },
  { status: "revising", label: "revise" },
  { status: "completed", label: "done" },
  { status: "failed", label: "failed" },
];

export class TasksPanel implements Component {
  private board: TaskBoard | undefined;

  constructor(options: TasksPanelOptions = {}) {
    this.board = options.board;
  }

  /** Push the latest board snapshot (the app refreshes after each run). */
  setBoard(board: TaskBoard | undefined): void {
    this.board = board;
  }

  invalidate(): void {
    // Rendering derives directly from the small whitelisted task fields.
  }

  private rows(): TaskRow[] {
    const board = this.board;
    if (!board || board.tasks.length === 0) return [];
    return board.tasks.slice(0, MAX_TASK_ROWS).map((task) => {
      const status: TaskStatus = isTaskStatus(task.status) ? task.status : "pending";
      return {
        id: task.id,
        title: compact(task.title, 80),
        status,
        ...(task.sidekickId &&
          (task.status === "running" || task.status === "revising")
          ? { sidekickId: task.sidekickId }
          : {}),
      };
    });
  }

  /** One-line status summary: counts + sidekick share. */
  private summary(): string | undefined {
    const board = this.board;
    if (!board || board.tasks.length === 0) return undefined;
    const counts = new Map<string, number>();
    for (const task of board.tasks) {
      counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
    }
    const parts = COUNT_LABELS
      .map(({ status, label }) => {
        const count = counts.get(status) ?? 0;
        return count > 0 ? `${count} ${label}` : "";
      })
      .filter(Boolean);
    const active = (counts.get("running") ?? 0) + (counts.get("revising") ?? 0);
    const share = active > 0 ? ` · ${active} sidekick${active === 1 ? "" : "s"} active` : "";
    return `${parts.join(" · ")}${share}`;
  }

  render(width: number): string[] {
    const rows = this.rows();
    if (width <= 0) return rows.length > 0 ? [""] : [];
    if (rows.length === 0) return [];
    const lines: string[] = [];
    for (const row of rows) {
      const marker = colorizeStatus(row.status, taskStatusSymbol(row.status));
      const sidekick = row.sidekickId ? ` ${dim(`· ${row.sidekickId}`)}` : "";
      lines.push(truncateToWidth(
        ` ${marker} ${dim(row.id)} ${row.title}${sidekick}`,
        width,
      ));
    }
    const summary = this.summary();
    if (summary) lines.push(truncateToWidth(` ${dim(summary)}`, width));
    return lines;
  }
}

function compact(value: unknown, limit: number): string {
  const text = sanitizeText(value, false).trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/** Status-colored symbol: active states emphasized, done dimmed. */
function colorizeStatus(status: TaskStatus, symbol: string): string {
  if (status === "completed") return dim("✓");
  if (status === "failed") return yellow("f");
  if (status === "running" || status === "revising") return cyan(symbol);
  return dim(symbol);
}
