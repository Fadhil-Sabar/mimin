import type { JsonlSession } from "../session/session.js";
import {
  recoverTasks,
  TaskBoard,
  type TaskBoardEvent,
} from "./task.js";

/**
 * Task-board persistence over a manager session's append-only event stream.
 *
 * The board is serialized as complete snapshots (`task_board` event records)
 * written through the session's `appendEvent` queue. On resume, the newest
 * snapshot is restored and `recoverTasks` is applied so tasks left in an
 * active state (`running`/`reviewing`/`revising`) by a crashed run are moved
 * to a safe state when their sidekick session no longer exists.
 */

export interface TaskBoardPersistence {
  /** The board restored from session events (empty when none persisted). */
  readonly board: TaskBoard;
  /** Task ids recovered by `recoverTasks` on restore (empty on fresh runs). */
  readonly recoveredTaskIds: string[];
  /** Persist a fresh snapshot after any board mutation. */
  persist(): Promise<void>;
}

/** Validate a `task_board` event record without trusting its contents. */
export function isTaskBoardEvent(value: unknown): value is TaskBoardEvent {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === "task_board" &&
    record.version === 1 &&
    Array.isArray(record.tasks)
  );
}

/**
 * Restore a task board from a manager session's event stream and apply
 * conservative recovery for interrupted runs. `validSidekickIds` are the
 * sidekick session ids that still exist in the store; tasks in an active
 * state bound to any other id (or to no id) are recovered to a safe state.
 */
export function restoreTaskBoard(
  session: Pick<JsonlSession, "events">,
  validSidekickIds: ReadonlySet<string>,
  options: ConstructorParameters<typeof TaskBoard>[0] = {},
): { board: TaskBoard; recoveredTaskIds: string[] } {
  const board = TaskBoard.fromEvents(
    session.events.filter(isTaskBoardEvent),
    options,
  );
  const recoveredTaskIds = recoverTasks(board, validSidekickIds);
  return { board, recoveredTaskIds };
}

/**
 * Wrap a board so every mutation persists a fresh snapshot to the manager
 * session. Mutations are funneled through the persisted closure so the
 * append-only event stream always ends with the latest board state.
 */
export function attachTaskBoardPersistence(
  session: JsonlSession,
  board: TaskBoard,
): TaskBoardPersistence {
  const persist = async (): Promise<void> => {
    await session.appendEvent(board.toEvent());
  };
  return {
    board,
    recoveredTaskIds: [],
    persist,
  };
}
