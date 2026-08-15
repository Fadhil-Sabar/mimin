/**
 * Lightweight task representation for the manager review loop.
 *
 * A task is a unit of work produced by decomposing a manager request. It is
 * deliberately NOT a project-management system: simple requests produce one
 * task, complex requests a small chain. Dependencies are a simple
 * `dependsOn` array; the scheduler is a single pass over pending tasks.
 */

export type TaskStatus =
  | "pending"
  | "running"
  | "reviewing"
  | "revising"
  | "completed"
  | "failed";

export interface TaskHistoryEvent {
  timestamp: number;
  from?: TaskStatus;
  to: TaskStatus;
  sidekickId?: string;
  detail?: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  /** Sidekick session id when the task is/was bound to one. */
  sidekickId?: string;
  /** Ids of tasks that must be completed before this one can run. */
  dependsOn?: string[];
  /** Files this task is expected to touch; used for overlap detection. */
  files?: string[];
  /** Number of review/revision cycles completed (bounded by maxReviewIterations). */
  reviewIterations?: number;
  /** Feedback from the last `revise` decision, consumed by the next dispatch. */
  pendingFeedback?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  /** Chronological event history for status transitions and sidekick bindings. */
  events?: TaskHistoryEvent[];
  /** Compact sidekick result kept for the manager review and /task view. */
  lastResult?: TaskResultSummary;
}

/** Compact result summary attached to a task after a sidekick finishes. */
export interface TaskResultSummary {
  status: "completed" | "partial" | "blocked" | "needs_decision";
  summary: string;
  filesChanged: string[];
  verification: { command: string; status: string; summary?: string }[];
  concerns?: string[];
  nextSteps?: string[];
  /** Git change delta attributed to the task's sidekick run. */
  gitChanges?: {
    modified: string[];
    added: string[];
    deleted: string[];
    insertions?: number;
    deletions?: number;
    unavailable?: boolean;
  };
}

/** Assignment of a task to a sidekick invocation. */
export interface TaskDispatch {
  task: Task;
  /** Fresh sidekick or continuation of an existing sidekick session. */
  sessionId?: string;
  /** The task contract sent to the sidekick. */
  contract: string;
}

export interface TaskBoardOptions {
  now?: () => number;
  /** Maximum concurrent sidekicks (kept at the existing 3-sidekick limit). */
  maxConcurrent?: number;
}

/**
 * Session event record for one complete task board snapshot. Appended to the
 * manager session via `appendEvent`; `latestFromEvents` restores the newest
 * snapshot when the session is resumed.
 */
export interface TaskBoardEvent {
  type: "task_board";
  version: 1;
  tasks: Task[];
  [key: string]: unknown;
}

/** Human-readable sequential ids: T01, T02, ... */
export function taskId(index: number): string {
  return `T${String(index + 1).padStart(2, "0")}`;
}

const VALID_STATUSES: readonly TaskStatus[] = [
  "pending",
  "running",
  "reviewing",
  "revising",
  "completed",
  "failed",
];

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (VALID_STATUSES as readonly string[]).includes(value);
}

export interface TaskCreateInput {
  title: string;
  description: string;
  dependsOn?: string[];
  /** Files this task is expected to touch (used for overlap detection). */
  files?: string[];
}

/** In-memory task board with deterministic status transitions. */
export class TaskBoard {
  readonly tasks: Task[] = [];
  private readonly now: () => number;
  readonly maxConcurrent: number;

  constructor(options: TaskBoardOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxConcurrent = options.maxConcurrent ?? 3;
  }

  create(input: TaskCreateInput): Task {
    const id = taskId(this.tasks.length);
    const now = this.now();
    const task: Task = {
      id,
      title: input.title,
      description: input.description,
      status: "pending",
      ...(input.dependsOn && input.dependsOn.length > 0
        ? { dependsOn: [...input.dependsOn] }
        : {}),
      ...(input.files && input.files.length > 0
        ? { files: input.files.map((file) => TaskBoard.normalizeFile(file)).filter(Boolean) }
        : {}),
      createdAt: now,
      events: [
        {
          timestamp: now,
          to: "pending",
          detail: "created",
        },
      ],
    };
    this.tasks.push(task);
    return task;
  }

  /**
   * Normalize a file path for overlap comparison: strip a leading `./`,
   * resolve internal `.`/`..` segments lexically, and drop empty strings.
   * A trailing slash is preserved (it marks a directory claim, which must
   * still match file paths beneath it via prefix).
   */
  static normalizeFile(path: string): string {
    const clean = path.trim().replace(/^\.\//, "");
    if (!clean) return "";
    const isDirectory = clean.endsWith("/");
    const parts = clean.replace(/\/+$/, "").split("/");
    const resolved: string[] = [];
    for (const part of parts) {
      if (part === "." || part === "") continue;
      if (part === "..") {
        resolved.pop();
        continue;
      }
      resolved.push(part);
    }
    const joined = resolved.join("/");
    if (!joined) return "";
    return isDirectory ? `${joined}/` : joined;
  }

  /**
   * True when two task file claims overlap. Conservative by design: a claim
   * wins when either side is a path prefix of the other (directory claims
   * cover everything beneath them), and exact matches always overlap.
   * Empty or unset claims never overlap with anything.
   */
  static filesOverlap(left: string, right: string): boolean {
    const a = TaskBoard.normalizeFile(left);
    const b = TaskBoard.normalizeFile(right);
    if (!a || !b) return false;
    if (a === b) return true;
    // Strip trailing slashes for the prefix comparison so a directory claim
    // `src/` still matches `src/a.ts` (and vice versa).
    const aPrefix = a.replace(/\/+$/, "");
    const bPrefix = b.replace(/\/+$/, "");
    if (aPrefix === bPrefix) return true;
    // A trailing slash marks a directory claim, which covers every path
    // beneath it even when the other side is not slash-terminated.
    const aIsDirectory = a.endsWith("/");
    const bIsDirectory = b.endsWith("/");
    return (
      (aPrefix.startsWith(`${bPrefix}/`) || (aPrefix.startsWith(bPrefix) && bIsDirectory)) ||
      (bPrefix.startsWith(`${aPrefix}/`) || (bPrefix.startsWith(aPrefix) && aIsDirectory))
    );
  }

  /** True when any file claim of `left` overlaps any claim of `right`. */
  static tasksOverlap(left: Task, right: Task): boolean {
    const leftFiles = left.files ?? [];
    const rightFiles = right.files ?? [];
    if (leftFiles.length === 0 || rightFiles.length === 0) return false;
    return leftFiles.some((leftFile) =>
      rightFiles.some((rightFile) => TaskBoard.filesOverlap(leftFile, rightFile)),
    );
  }

  get(id: string): Task | undefined {
    return this.tasks.find((task) => task.id === id);
  }

  byStatus(status: TaskStatus): Task[] {
    return this.tasks.filter((task) => task.status === status);
  }

  /** True when every dependency of `task` is completed. */
  dependenciesComplete(task: Task): boolean {
    if (!task.dependsOn || task.dependsOn.length === 0) return true;
    return task.dependsOn.every((id) => {
      const dependency = this.get(id);
      return dependency !== undefined && dependency.status === "completed";
    });
  }

  /** List the ids of not-yet-completed dependencies (for display). */
  incompleteDependencies(task: Task): string[] {
    if (!task.dependsOn) return [];
    return task.dependsOn.filter((id) => {
      const dependency = this.get(id);
      return dependency === undefined || dependency.status !== "completed";
    });
  }

  /** Unfinished tasks whose dependencies are satisfied and pool has capacity. */
  dispatchable(): Task[] {
    return this.tasks.filter(
      (task) =>
        task.status === "pending" &&
        this.dependenciesComplete(task),
    );
  }

  runningCount(): number {
    return this.tasks.filter(
      (task) => task.status === "running" || task.status === "revising",
    ).length;
  }

  /** Whether a new sidekick can start under the concurrency cap. */
  hasCapacity(): boolean {
    return this.runningCount() < this.maxConcurrent;
  }

  /**
   * Simple scheduler: the next batch of tasks to dispatch.
   *
   * Returns dispatchable tasks (pending with completed dependencies) filling
   * the remaining pool slots (`maxConcurrent - runningCount`). Overlap is
   * handled conservatively: when a dispatchable task shares a file claim with
   * a task that is already running (or was selected earlier in this batch),
   * it is skipped so the overlapping work stays sequential. A single pass
   * over pending tasks in creation order; capacity is the only other gate.
   */
  schedule(): Task[] {
    if (!this.hasCapacity()) return [];
    const slots = this.maxConcurrent - this.runningCount();
    const selected: Task[] = [];
    for (const task of this.dispatchable()) {
      if (selected.length >= slots) break;
      if (this.overlapsRunning(task) || selected.some((other) => TaskBoard.tasksOverlap(task, other))) {
        continue;
      }
      selected.push(task);
    }
    return selected;
  }

  /** True when any running/revising task overlaps a file claim of `task`. */
  private overlapsRunning(task: Task): boolean {
    return this.tasks.some(
      (other) =>
        other.id !== task.id &&
        (other.status === "running" || other.status === "revising") &&
        TaskBoard.tasksOverlap(task, other),
    );
  }

  transition(id: string, to: TaskStatus, detail?: string): Task {
    const task = this.get(id);
    if (!task) throw new Error(`Unknown task id ${JSON.stringify(id)}`);
    const from = task.status;
    const now = this.now();
    task.status = to;

    if (to === "running" || to === "revising") {
      if (!task.startedAt) {
        task.startedAt = now;
      }
    }

    if (to === "completed" || to === "failed") {
      task.completedAt = now;
      if (task.startedAt) {
        task.durationMs = Math.max(0, task.completedAt - task.startedAt);
      }
    }

    if (!task.events) {
      task.events = [];
    }
    task.events.push({
      timestamp: now,
      from,
      to,
      ...(task.sidekickId ? { sidekickId: task.sidekickId } : {}),
      ...(detail ? { detail } : {}),
    });

    return task;
  }

  bindSidekick(id: string, sidekickId: string): Task {
    const task = this.get(id);
    if (!task) throw new Error(`Unknown task id ${JSON.stringify(id)}`);
    task.sidekickId = sidekickId;
    if (!task.events) task.events = [];
    task.events.push({
      timestamp: this.now(),
      from: task.status,
      to: task.status,
      sidekickId,
      detail: `bound sidekick ${sidekickId}`,
    });
    return task;
  }

  attachResult(id: string, result: TaskResultSummary): Task {
    const task = this.get(id);
    if (!task) throw new Error(`Unknown task id ${JSON.stringify(id)}`);
    task.lastResult = result;
    return task;
  }

  recordReviewIteration(id: string): number {
    const task = this.get(id);
    if (!task) throw new Error(`Unknown task id ${JSON.stringify(id)}`);
    task.reviewIterations = (task.reviewIterations ?? 0) + 1;
    return task.reviewIterations;
  }

  /** Serialize to plain records for session event persistence. */
  toJSON(): Task[] {
    return this.tasks.map((task) => ({
      ...task,
      ...(task.events ? { events: task.events.map((e) => ({ ...e })) } : {}),
    }));
  }

  /** Rebuild a board from persisted records. */
  static fromJSON(records: unknown[], options: TaskBoardOptions = {}): TaskBoard {
    const board = new TaskBoard(options);
    for (const raw of records) {
      if (typeof raw !== "object" || raw === null) continue;
      const record = raw as Record<string, unknown>;
      if (
        typeof record.id !== "string" ||
        typeof record.title !== "string" ||
        typeof record.description !== "string" ||
        !isTaskStatus(record.status) ||
        typeof record.createdAt !== "number"
      ) {
        continue;
      }
      const task: Task = {
        id: record.id,
        title: record.title,
        description: record.description,
        status: record.status,
        createdAt: record.createdAt,
      };
      if (typeof record.sidekickId === "string") task.sidekickId = record.sidekickId;
      if (Array.isArray(record.dependsOn)) {
        task.dependsOn = record.dependsOn.filter(
          (value): value is string => typeof value === "string",
        );
      }
      if (Array.isArray(record.files)) {
        task.files = record.files.filter(
          (value): value is string => typeof value === "string",
        );
      }
      if (typeof record.reviewIterations === "number") {
        task.reviewIterations = record.reviewIterations;
      }
      if (typeof record.pendingFeedback === "string") {
        task.pendingFeedback = record.pendingFeedback;
      }
      if (typeof record.startedAt === "number") task.startedAt = record.startedAt;
      if (typeof record.completedAt === "number") task.completedAt = record.completedAt;
      if (typeof record.durationMs === "number") task.durationMs = record.durationMs;
      if (Array.isArray(record.events)) {
        task.events = record.events.filter(
          (e): e is TaskHistoryEvent =>
            typeof e === "object" &&
            e !== null &&
            typeof (e as any).timestamp === "number" &&
            isTaskStatus((e as any).to),
        );
      }
      if (typeof record.lastResult === "object" && record.lastResult !== null) {
        task.lastResult = record.lastResult as TaskResultSummary;
      }
      board.tasks.push(task);
    }
    return board;
  }

  /** One complete board snapshot as a session event record. */
  toEvent(): TaskBoardEvent {
    return { type: "task_board", version: 1, tasks: this.toJSON() };
  }

  /**
   * Restore the newest valid board snapshot from a session's event records.
   * Snapshots are append-only, so later records win. Events that are not
   * `task_board` records (tool activity, sidekick lifecycle) are ignored.
   * Returns an empty board when the session has no valid snapshot yet.
   */
  static fromEvents(events: readonly { type: string; [key: string]: unknown }[], options: TaskBoardOptions = {}): TaskBoard {
    let latest: Task[] | undefined;
    for (const event of events) {
      if (event.type !== "task_board") continue;
      if (!Array.isArray(event.tasks)) continue;
      const version = event.version;
      if (typeof version !== "number" || version !== 1) continue;
      latest = event.tasks;
    }
    return latest ? TaskBoard.fromJSON(latest, options) : new TaskBoard(options);
  }
}

/**
 * Conservative recovery for interrupted sessions: a task bound to a sidekick
 * that no longer exists (or that never produced a result) is reset to a safe
 * state instead of being left `running` forever. Revision cycles that were
 * interrupted reset to pending so they can be retried cleanly.
 *
 * Invariant after recovery: no task is `running`, `reviewing`, or `revising`
 * while bound to a sidekick session that does not exist. Tasks in those
 * states without any sidekick binding are failed (nothing can ever complete
 * them); tasks bound to an invalid sidekick become `failed` (`running`,
 * `reviewing`) or `pending` (`revising`, so the revision can be retried).
 */
export function recoverTasks(
  board: TaskBoard,
  validSidekickIds: ReadonlySet<string>,
): string[] {
  const recovered: string[] = [];
  const activeStatuses: readonly TaskStatus[] = ["running", "reviewing", "revising"];
  for (const task of board.tasks) {
    if (!activeStatuses.includes(task.status)) continue;
    const sidekickInvalid = task.sidekickId !== undefined && !validSidekickIds.has(task.sidekickId);
    if (sidekickInvalid || !task.sidekickId) {
      // Revising can be retried cleanly (pending); running/reviewing cannot
      // resume without a live sidekick, so they fail.
      task.status = task.status === "revising" ? "pending" : "failed";
      if (task.status === "failed") task.completedAt = Date.now();
      recovered.push(task.id);
    }
  }
  return recovered;
}
