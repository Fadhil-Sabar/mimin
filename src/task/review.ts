import type { Task, TaskBoard } from "./task.js";

/**
 * Manager review decisions and iteration-limit enforcement for the
 * delegate → review → revise → accept loop.
 */

export type ReviewDecision = "accept" | "revise" | "reject";

export interface ReviewCommand {
  taskId: string;
  decision: ReviewDecision;
  /** Required for `revise`: specific, actionable feedback for the sidekick. */
  feedback?: string;
}

export function isReviewDecision(value: unknown): value is ReviewDecision {
  return value === "accept" || value === "revise" || value === "reject";
}

export interface ReviewOutcome {
  ok: boolean;
  error?: string;
  task?: Task;
}

/** Enforce the review iteration budget before allowing another revision. */
export function canRevise(board: TaskBoard, task: Task, maxReviewIterations: number): boolean {
  return (task.reviewIterations ?? 0) < maxReviewIterations;
}

/**
 * Apply a review decision to a task. Returns an error when the decision is
 * invalid for the task's current state (e.g. revising an already-completed
 * task, or exceeding the iteration limit).
 */
export function applyReview(
  board: TaskBoard,
  command: ReviewCommand,
  maxReviewIterations: number,
): ReviewOutcome {
  const task = board.get(command.taskId);
  if (!task) return { ok: false, error: `Unknown task id ${JSON.stringify(command.taskId)}` };

  if (command.decision === "accept") {
    if (task.status === "completed") return { ok: false, error: `Task ${task.id} is already completed` };
    board.transition(task.id, "completed");
    return { ok: true, task: board.get(task.id) };
  }

  if (command.decision === "reject") {
    if (task.status === "completed") return { ok: false, error: `Task ${task.id} is already completed` };
    board.transition(task.id, "failed");
    return { ok: true, task: board.get(task.id) };
  }

  // revise
  if (task.status === "completed" || task.status === "failed") {
    return { ok: false, error: `Cannot revise task ${task.id} in state ${task.status}` };
  }
  if (!canRevise(board, task, maxReviewIterations)) {
    return {
      ok: false,
      error:
        `Review budget exhausted for ${task.id} (${task.reviewIterations ?? 0}/${maxReviewIterations}). ` +
        `Accept the result or reject the task.`,
    };
  }
  if (!command.feedback || command.feedback.trim().length === 0) {
    return { ok: false, error: "revise requires specific feedback for the sidekick" };
  }
  board.recordReviewIteration(task.id);
  // Keep the pending revision feedback on the task so the next dispatch can
  // build the continuation contract from it.
  task.pendingFeedback = command.feedback.trim();
  board.transition(task.id, "revising");
  return { ok: true, task: board.get(task.id) };
}

/** Contract for a revision: continue the same sidekick with the feedback. */
export function revisionContract(task: Task): string {
  const feedback = task.pendingFeedback ?? "";
  return [
    `Revision requested by the manager for task ${task.id}: ${task.title}`,
    "",
    `Feedback: ${feedback}`,
    "Fix the issues above, re-verify, and return the same structured result JSON.",
  ].join("\n");
}

/** Contract for a fresh task dispatch. */
export function dispatchContract(task: Task): string {
  return [
    `Task ${task.id}: ${task.title}`,
    "",
    task.description,
    "",
    "Implement exactly this scope. Return the structured result JSON.",
  ].join("\n");
}
