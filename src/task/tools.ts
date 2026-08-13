import { Type } from "@mariozechner/pi-ai";
import type {
  AnyAgentTool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "../agent/types.js";
import { TaskBoard } from "./task.js";
import { applyReview, isReviewDecision, type ReviewCommand } from "./review.js";

export interface TaskReviewToolOptions {
  board: TaskBoard;
  /** Maximum review/revision cycles per task before accept/fail is forced. */
  maxReviewIterations: number;
}

/**
 * Manager-side review tool. The manager calls it after a sidekick reports
 * completion for a task to record accept/revise/reject. Code enforces the
 * iteration budget; the manager stays read-only (this tool never edits).
 */
export function createTaskReviewTool(options: TaskReviewToolOptions): AnyAgentTool {
  const { board, maxReviewIterations } = options;
  return {
    name: "task_review",
    description:
      "Record a review decision for a task after a sidekick finished. Accept completes the task; revise sends the same sidekick a focused correction (requires specific feedback); reject fails the task. Review iterations are capped; when the budget is exhausted only accept or reject are allowed.",
    parameters: Type.Object({
      taskId: Type.String({ minLength: 1, description: "Task id, e.g. T01" }),
      decision: Type.String({ description: "accept | revise | reject" }),
      feedback: Type.Optional(
        Type.String({
          description: "Required for revise: specific feedback for the same sidekick",
        }),
      ),
    }),
    execute: async (
      rawArguments: Record<string, unknown>,
      _context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> => {
      const args = rawArguments as unknown as {
        taskId: string;
        decision: string;
        feedback?: string;
      };
      if (!isReviewDecision(args.decision)) {
        return {
          text: `Invalid decision ${JSON.stringify(args.decision)}. Use accept, revise, or reject.`,
          isError: true,
        };
      }
      const command: ReviewCommand = {
        taskId: args.taskId,
        decision: args.decision,
        ...(args.feedback !== undefined ? { feedback: args.feedback } : {}),
      };
      const outcome = applyReview(board, command, maxReviewIterations);
      if (!outcome.ok) {
        return { text: outcome.error ?? "Review failed", isError: true };
      }
      const task = outcome.task!;
      const lines = [
        `Task ${task.id} → ${task.status}`,
        ...(task.reviewIterations !== undefined
          ? [`Review iterations: ${task.reviewIterations}/${maxReviewIterations}`]
          : []),
      ];
      if (task.status === "revising" && task.pendingFeedback) {
        lines.push(`Feedback for sidekick: ${task.pendingFeedback}`);
      }
      return { text: lines.join("\n"), details: { taskId: task.id, status: task.status } };
    },
  };
}

/** Resolve which task ids exist for display/validation. */
export function taskBoardSummary(board: TaskBoard): {
  pending: number;
  running: number;
  reviewing: number;
  revising: number;
  completed: number;
  failed: number;
} {
  const count = (status: TaskBoard["tasks"][number]["status"]): number =>
    board.tasks.filter((task) => task.status === status).length;
  return {
    pending: count("pending"),
    running: count("running"),
    reviewing: count("reviewing"),
    revising: count("revising"),
    completed: count("completed"),
    failed: count("failed"),
  };
}

export function formatTaskList(board: TaskBoard): string {
  if (board.tasks.length === 0) return "No tasks.";
  const symbol: Record<string, string> = {
    pending: "○",
    running: "●",
    reviewing: "◐",
    revising: "↻",
    completed: "✓",
    failed: "×",
  };
  const lines: string[] = ["Tasks"];
  for (const task of board.tasks) {
    const marker = symbol[task.status] ?? "○";
    const waits = board.incompleteDependencies(task);
    const waitsText =
      waits.length > 0 ? `\n    waits for ${waits.join(", ")}` : "";
    const sidekick =
      task.sidekickId && (task.status === "running" || task.status === "revising")
        ? `\n    ${task.sidekickId}`
        : "";
    lines.push(`${marker} ${task.id} ${task.title}${sidekick}${waitsText}`);
  }
  return lines.join("\n");
}

export function formatTaskDetail(board: TaskBoard, taskId: string): string {
  const task = board.get(taskId);
  if (!task) return `Unknown task ${taskId}.`;
  const lines = [
    `${task.id} · ${task.title}`,
    "",
    "Status",
    task.status,
  ];
  if (task.sidekickId) lines.push("", "Sidekick", task.sidekickId);
  if (task.dependsOn && task.dependsOn.length > 0) {
    lines.push("", "Depends on", task.dependsOn.join(", "));
  }
  if (task.lastResult) {
    lines.push("", "Result", task.lastResult.summary);
    if (task.lastResult.filesChanged.length > 0) {
      lines.push("", "Files changed", task.lastResult.filesChanged.join("\n"));
    }
    if (task.lastResult.verification.length > 0) {
      lines.push(
        "",
        "Verification",
        ...task.lastResult.verification.map(
          (entry) => `${entry.status === "passed" ? "✓" : "×"} ${entry.command}`,
        ),
      );
    }
    if (task.lastResult.concerns && task.lastResult.concerns.length > 0) {
      lines.push("", "Concerns", ...task.lastResult.concerns);
    }
  } else if (task.status === "pending") {
    lines.push("", "Verification", "not started");
  }
  if (task.pendingFeedback) lines.push("", "Pending feedback", task.pendingFeedback);
  return lines.join("\n");
}
