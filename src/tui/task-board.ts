import type { SessionStore } from "../session/session.js";
import type { Task, TaskBoard, TaskStatus } from "../task/task.js";
import { TaskBoard as TaskBoardClass, isTaskStatus } from "../task/task.js";
import { isTaskBoardEvent } from "../task/persistence.js";

/**
 * Shared read-side helpers for the task board.
 *
 * The task board is persisted as `task_board` event records inside the
 * manager session (see src/task/persistence.ts). Both the interactive
 * commands (`/tasks`, `/task <id>`, `/status`) and the TUI tasks panel read
 * the newest snapshot from the active manager session and rebuild the board.
 * Everything here is read-only: the CLI never mutates board state.
 */

/** One compact row for the /tasks listing and the TUI tasks panel. */
export interface TaskListRow {
  id: string;
  title: string;
  status: TaskStatus;
  /** Sidekick session id when the task is bound to one. */
  sidekickId?: string;
  /** Ids of not-yet-completed dependencies. */
  waitingOn: string[];
  /** Review iterations completed (0 when never revised). */
  reviewIterations: number;
  /** Compact sidekick result summary (completed/failed tasks). */
  summary?: string;
}

/** The one-character status symbol used by /tasks and the TUI panel. */
export const TASK_STATUS_SYMBOLS: Record<TaskStatus, string> = {
  pending: "o",
  running: "r",
  reviewing: "v",
  revising: "x",
  completed: "✓",
  failed: "f",
};

export function taskStatusSymbol(status: TaskStatus): string {
  return TASK_STATUS_SYMBOLS[status] ?? "o";
}

/** Map every task on a board to a compact list row (read-only). */
export function taskListRows(board: TaskBoard): TaskListRow[] {
  return board.tasks.map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    ...(task.sidekickId ? { sidekickId: task.sidekickId } : {}),
    waitingOn: board.incompleteDependencies(task),
    reviewIterations: task.reviewIterations ?? 0,
    ...(task.lastResult?.summary ? { summary: task.lastResult.summary } : {}),
  }));
}

/** Rebuild the newest board snapshot from a manager session's events. */
export function boardFromSessionEvents(
  events: readonly { type: string; [key: string]: unknown }[],
): TaskBoard {
  return TaskBoardClass.fromEvents(events.filter(isTaskBoardEvent));
}

/** Rebuild the board from the active manager session (empty when unknown). */
export async function boardForSession(
  store: SessionStore,
  sessionId: string | undefined,
): Promise<TaskBoard> {
  if (!sessionId) return new TaskBoardClass();
  try {
    const session = await store.loadSession("manager", sessionId);
    return boardFromSessionEvents(session.events);
  } catch {
    return new TaskBoardClass();
  }
}

/** Task ids for the /task autocomplete dropdown. */
export async function taskIdSuggestions(
  store: SessionStore,
  sessionId: string | undefined,
): Promise<string[]> {
  return (await boardForSession(store, sessionId)).tasks.map((task) => task.id);
}

/** Validate a task id shape without trusting it (T01, T02, ...). */
export function isTaskId(value: string): boolean {
  return /^T\d{2,}$/.test(value);
}

/** Safe title/summary text for terminal display. */
export function taskText(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * The /tasks listing: one line per task with a one-character status symbol.
 * Matches the README contract exactly: `o` pending, `r` running, `v`
 * reviewing, `x` revising, `✓` completed, `f` failed. Running/revising
 * tasks show their bound sidekick session id.
 */
export function formatTaskList(board: TaskBoard): string {
  const rows = taskListRows(board);
  if (rows.length === 0) return "No tasks.";
  const lines = rows.map((row) => {
    const symbol = taskStatusSymbol(row.status);
    const active = row.status === "running" || row.status === "revising";
    const sidekick = active && row.sidekickId ? ` · ${row.sidekickId}` : "";
    const waits =
      row.waitingOn.length > 0 ? ` · waits for ${row.waitingOn.join(", ")}` : "";
    return `  ${symbol} ${row.id} ${taskText(row.title, 120)}${sidekick}${waits}`;
  });
  return ["Tasks", ...lines].join("\n");
}

/** The /task <id> detail view (read-only, from the board). */
export function formatTaskDetail(board: TaskBoard, taskId: string): string {
  const task = board.get(taskId);
  if (!task) return `Unknown task ${taskId}.`;
  return formatTaskRecord(task, board);
}

/** Full detail for one task record; shared by /task and the TUI panel. */
export function formatTaskRecord(task: Task, board: TaskBoard): string {
  const lines = [
    `${task.id} · ${taskText(task.title, 160)}`,
    "",
    `Status: ${task.status}${task.reviewIterations ? ` (review ${task.reviewIterations})` : ""}`,
    "",
    "Description",
    taskText(task.description, 400) || "(none)",
  ];
  if (task.sidekickId) lines.push("", `Sidekick: ${task.sidekickId}`);
  const waiting = board.incompleteDependencies(task);
  if (waiting.length > 0) lines.push("", `Waiting for: ${waiting.join(", ")}`);
  else if (task.dependsOn && task.dependsOn.length > 0) {
    lines.push("", `Depends on: ${task.dependsOn.join(", ")}`);
  }
  if (task.lastResult) {
    lines.push("", "Result", taskText(task.lastResult.summary, 300) || "(no summary)");
    if (task.lastResult.filesChanged.length > 0) {
      lines.push("", "Files changed", ...task.lastResult.filesChanged.slice(0, 50));
    }
    if (task.lastResult.verification.length > 0) {
      lines.push(
        "",
        "Verification",
        ...task.lastResult.verification.slice(0, 50).map(
          (entry) => `  ${entry.status === "passed" ? "✓" : "×"} ${taskText(entry.command, 120)}`,
        ),
      );
    }
    if (task.lastResult.concerns && task.lastResult.concerns.length > 0) {
      lines.push("", "Concerns", ...task.lastResult.concerns.slice(0, 20));
    }
    if (task.lastResult.nextSteps && task.lastResult.nextSteps.length > 0) {
      lines.push("", "Next steps", ...task.lastResult.nextSteps.slice(0, 20));
    }
  }
  if (task.pendingFeedback) lines.push("", "Pending feedback", taskText(task.pendingFeedback, 300));
  return lines.join("\n");
}

/** Status counts for the /status summary and the TUI panel badge. */
export interface TaskStatusCounts {
  pending: number;
  running: number;
  reviewing: number;
  revising: number;
  completed: number;
  failed: number;
}

export function taskStatusCounts(board: TaskBoard): TaskStatusCounts {
  const counts: TaskStatusCounts = {
    pending: 0,
    running: 0,
    reviewing: 0,
    revising: 0,
    completed: 0,
    failed: 0,
  };
  for (const task of board.tasks) {
    if (isTaskStatus(task.status)) counts[task.status] += 1;
  }
  return counts;
}

/** "N pending · N running · N reviewing · N revising · N completed · N failed". */
export function formatTaskCounts(board: TaskBoard): string {
  const counts = taskStatusCounts(board);
  const parts: string[] = [];
  const order: TaskStatus[] = ["pending", "running", "reviewing", "revising", "completed", "failed"];
  for (const status of order) {
    const count = counts[status];
    if (count > 0) parts.push(`${count} ${status}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "no tasks";
}
