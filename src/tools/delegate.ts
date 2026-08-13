import { Type } from "@mariozechner/pi-ai";
import type {
  AnyAgentTool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "../agent/types.js";
import {
  DelegationTracker,
  normalizeDelegationTask,
  type DelegationReservation,
} from "./delegation-tracker.js";
import {
  runSidekick,
  type RunSidekickOptions,
  type SidekickActivityEvent,
  type SidekickResult,
} from "../agent/sidekick.js";

export interface SidekickRunnerContext {
  index: number;
  signal?: AbortSignal;
  onActivity?: (event: SidekickActivityEvent) => void | Promise<void>;
  /** Present for continuation invocations only. */
  sessionId?: string;
}

export type SidekickRunner = (
  task: string,
  context: SidekickRunnerContext,
) => Promise<SidekickResult>;

export type SidekickInvocation =
  | { mode: "fresh"; task: string }
  | { mode: "continue"; sessionId: string; task: string };

export type DelegateEvent =
  | {
      type: "delegation_started";
      index: number;
      taskCount: number;
      /** Presentation metadata: the task title sent to this sidekick. */
      task?: string;
      /** Presentation metadata: the sidekick model id. */
      model?: string;
    }
  | {
      type: "sidekick_activity";
      index: number;
      taskCount: number;
      activity: SidekickActivityEvent;
    }
  | {
      type: "delegation_finished";
      index: number;
      taskCount: number;
      result: SidekickResult;
      /** Presentation metadata: the task title sent to this sidekick. */
      task?: string;
      /** Presentation metadata: the sidekick model id. */
      model?: string;
    };

export type DelegateEventCallback = (
  event: DelegateEvent,
) => void | Promise<void>;

export interface CreateDelegateToolOptions {
  /** Production sidekick dependencies. Optional only when a test runner is injected. */
  sidekick?: Omit<RunSidekickOptions, "task" | "onActivity" | "signal">;
  run?: SidekickRunner;
  /** Hard-clamped to 1..3. */
  maxConcurrency?: number;
  onEvent?: DelegateEventCallback;
  /** Per-manager-run loop-protection state. A standalone tool receives local state. */
  tracker?: DelegationTracker;
}

interface DelegateArguments {
  task?: string | string[];
  tasks?: string[];
  sessionId?: string;
}

interface PreparedTask {
  index: number;
  invocation: SidekickInvocation;
  reservation: DelegationReservation;
}

const HARD_MAX_CONCURRENCY = 3;
const MAX_BATCH_TASKS = 100;

/**
 * One self-contained contract, or an array of independent contracts.
 * The root must be an object with a top-level `type: "object"` (providers
 * reject bare anyOf/union roots as `type: null`). Exactly-one semantics are
 * enforced at runtime: `task` (string or array) is the primary field;
 * `tasks` is a legacy alias for an array and is rejected when combined with
 * `task`.
 */
const delegateParameters = Type.Object(
  {
    task: Type.Optional(
      Type.Union(
        [
          Type.String({
            minLength: 1,
            description: "One complete, self-contained implementation contract",
          }),
          Type.Array(Type.String({ minLength: 1 }), {
            minItems: 1,
            maxItems: MAX_BATCH_TASKS,
            description: "Independent self-contained implementation contracts",
          }),
        ],
        {
          description:
            "A single task string, or an array of independent task strings",
        },
      ),
    ),
    tasks: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: MAX_BATCH_TASKS,
        description: "Alias for an array of independent contracts",
      }),
    ),
    sessionId: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 128,
        description:
          "Continue this existing sidekick session (from a prior delegate result) with a focused corrective task. Omit to create a fresh sidekick session. Only a single task may be continued.",
      }),
    ),
  },
  { additionalProperties: false },
);

/** Resolve the exactly-one task contract from validated arguments. */
function resolveTasks(args: DelegateArguments): string[] {
  const hasTask = args.task !== undefined;
  const hasTasks = args.tasks !== undefined;
  if (hasTask && hasTasks) {
    throw new Error(
      "delegate requires exactly one of `task` or `tasks`, not both",
    );
  }
  const tasks = Array.isArray(args.task)
    ? args.task
    : typeof args.task === "string"
      ? [args.task]
      : (args.tasks ?? []);
  if (tasks.length === 0) {
    throw new Error("delegate requires one task or a non-empty task array");
  }
  return tasks;
}

/** Model-supplied session handles must match the store's id grammar only. */
function assertSessionId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id === "." || id === "..") {
    throw new Error("Invalid sidekick session id");
  }
}

/**
 * Resolve invocations from validated arguments. A continuation (`sessionId`)
 * requires a single string task and is never mixed with a batch.
 */
function resolveInvocations(args: DelegateArguments): SidekickInvocation[] {
  const hasSessionId = args.sessionId !== undefined;
  if (!hasSessionId) {
    return resolveTasks(args).map((task) => ({ mode: "fresh", task }));
  }
  if (args.tasks !== undefined || Array.isArray(args.task)) {
    throw new Error("delegate cannot continue a sidekick session with a task batch");
  }
  const task = typeof args.task === "string" ? args.task : undefined;
  if (!task || !task.trim()) {
    throw new Error("delegate continuation requires a single task");
  }
  assertSessionId(args.sessionId!);
  return [{ mode: "continue", sessionId: args.sessionId!, task }];
}

function concurrencyLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return HARD_MAX_CONCURRENCY;
  return Math.max(1, Math.min(HARD_MAX_CONCURRENCY, Math.floor(value)));
}

function compactError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length <= 2_000 ? text : `${text.slice(0, 1_999)}…`;
}

/** Whitelist the compact contract even when a custom runner returns extra data. */
function managerFacingResult(result: SidekickResult): SidekickResult {
  return {
    status: result.status,
    summary: compactError(result.summary),
    filesChanged: result.filesChanged.slice(0, 100).map(compactError),
    verification: result.verification.slice(0, 100).map((entry) => ({
      command: compactError(entry.command),
      status: entry.status,
      ...(entry.summary ? { summary: compactError(entry.summary) } : {}),
    })),
    sessionId: compactError(result.sessionId),
    ...(result.detail ? { detail: compactError(result.detail) } : {}),
    ...(result.error ? { error: compactError(result.error) } : {}),
  };
}

function failedResult(error: unknown): SidekickResult {
  return {
    status: "blocked",
    summary: "Sidekick could not be started or completed.",
    filesChanged: [],
    verification: [],
    sessionId: "unavailable",
    error: compactError(error),
  };
}

function blockedResult(
  reason:
    | "duplicate_active"
    | "duplicate_turn"
    | "retry_budget_exhausted"
    | "session_active",
  noProgressAttempts: number,
  retryLimit: number,
): SidekickResult {
  if (reason === "duplicate_active") {
    return {
      status: "blocked",
      summary: "Delegation skipped: an equivalent task is already active.",
      filesChanged: [],
      verification: [],
      sessionId: "unavailable",
    };
  }
  if (reason === "duplicate_turn") {
    return {
      status: "blocked",
      summary: "Delegation skipped: an equivalent task was already dispatched in this manager response.",
      filesChanged: [],
      verification: [],
      sessionId: "unavailable",
    };
  }
  if (reason === "session_active") {
    return {
      status: "blocked",
      summary: "Continuation blocked: this sidekick session is already active.",
      filesChanged: [],
      verification: [],
      sessionId: "unavailable",
    };
  }
  return {
    status: "blocked",
    summary:
      `Delegation blocked: this corrective task has already been attempted ${noProgressAttempts} times without workspace progress. ` +
      "Inspect the current repository state and choose a different approach or finish with the unresolved issue.",
    filesChanged: [],
    verification: [],
    sessionId: "unavailable",
    detail: `No-progress retry budget: ${noProgressAttempts}/${retryLimit}.`,
  };
}

function withProgressFeedback(
  result: SidekickResult,
  noProgressAttempts: number,
  retryLimit: number,
): SidekickResult {
  const feedback =
    `No workspace progress detected for this corrective task (${noProgressAttempts}/${retryLimit}).`;
  return {
    ...result,
    summary: compactError(`${result.summary} ${feedback}`),
  };
}

function continuationBlocked(summary: string): SidekickResult {
  return {
    status: "blocked",
    summary,
    filesChanged: [],
    verification: [],
    sessionId: "unavailable",
  };
}

function productionRunner(
  sidekick: CreateDelegateToolOptions["sidekick"],
): SidekickRunner {
  if (!sidekick) {
    throw new Error("createDelegateTool requires sidekick options when no runner is injected");
  }
  return async (task, context) => {
    try {
      return await runSidekick({
        ...sidekick,
        task,
        signal: context.signal,
        onActivity: context.onActivity,
        ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      });
    } catch (error) {
      // Continuation lookup failures must stay compact and manager-facing:
      // no filesystem paths or raw storage errors cross back to the manager.
      if (!context.sessionId) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/invalid session id/i.test(message)) {
        return continuationBlocked("Continuation blocked: invalid sidekick session id.");
      }
      if (/does not match|not a sidekick/i.test(message)) {
        return continuationBlocked("Continuation blocked: session is not a sidekick session.");
      }
      return continuationBlocked("Continuation blocked: sidekick session was not found.");
    }
  };
}

async function runBounded(
  tasks: readonly PreparedTask[],
  taskCount: number,
  limit: number,
  runner: SidekickRunner,
  signal: AbortSignal | undefined,
  onEvent: DelegateEventCallback | undefined,
  tracker: DelegationTracker,
  results: SidekickResult[],
  activeSessionIds: Set<string>,
  presentation?: { model?: string },
): Promise<void> {
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const item = tasks[nextIndex];
      if (!item) return;
      nextIndex += 1;
      const invocation = item.invocation;
      const task = invocation.task;
      if (signal?.aborted) {
        tracker.cancel(item.reservation);
        results[item.index] = {
          status: "blocked",
          summary: "Aborted by the manager.",
          filesChanged: [],
          verification: [],
          sessionId: "unavailable",
        };
        continue;
      }
      const started = await tracker.start(item.reservation);
      if (!started.allowed) {
        results[item.index] = blockedResult(
          started.reason,
          started.noProgressAttempts,
          tracker.retryLimit(),
        );
        continue;
      }
      const attempt = started.attempt;
      // Reject a second concurrent continuation of the same sidekick session.
      // The tracker reservation is released so later turns are not wedged.
      if (invocation.mode === "continue" && activeSessionIds.has(invocation.sessionId)) {
        tracker.cancel(attempt);
        results[item.index] = blockedResult(
          "session_active",
          0,
          tracker.retryLimit(),
        );
        continue;
      }
      if (invocation.mode === "continue") activeSessionIds.add(invocation.sessionId);
      await onEvent?.({
        type: "delegation_started",
        index: item.index,
        taskCount,
        task,
        model: presentation?.model,
      });
      let result: SidekickResult;
      try {
        result = managerFacingResult(
          await runner(task, {
            index: item.index,
            signal,
            onActivity: (activity) =>
              onEvent?.({
                type: "sidekick_activity",
                index: item.index,
                taskCount,
                activity,
              }),
            ...(invocation.mode === "continue"
              ? { sessionId: invocation.sessionId }
              : {}),
          }),
        );
      } catch (error) {
        result = failedResult(error);
      }

      if (signal?.aborted) {
        // Cancellation is not evidence that an otherwise retryable task made
        // no progress. Release its reservation without consuming budget.
        tracker.cancel(attempt);
      } else {
        const completion = await tracker.finish(attempt);
        if (completion.madeProgress === false) {
          result = withProgressFeedback(
            result,
            completion.noProgressAttempts,
            tracker.retryLimit(),
          );
        }
      }
      results[item.index] = result;
      // Continuations must never hold the session lock past the finish event,
      // including when the tracker.finish path above rejects or throws.
      if (invocation.mode === "continue") activeSessionIds.delete(invocation.sessionId);
      await onEvent?.({
        type: "delegation_finished",
        index: item.index,
        taskCount,
        result,
        task,
        model: presentation?.model,
      });
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, () => worker()),
  );
}

/** Create the manager's bounded one-level delegation tool. */
export function createDelegateTool(
  options: CreateDelegateToolOptions,
): AnyAgentTool {
  const limit = concurrencyLimit(options.maxConcurrency);
  const runner = options.run ?? productionRunner(options.sidekick);
  const tracker = options.tracker ?? new DelegationTracker();
  const activeSessionIds = new Set<string>();
  return {
    name: "delegate",
    description:
      "Delegate implementation. Call with { task: \"one contract\" } for a single task, or { task: [\"a\", \"b\"] } (or the legacy { tasks: [...] }) for independent parallel tasks. To continue a prior sidekick session with a focused correction, call { task: \"correction\", sessionId: \"<sidekick sessionId>\" }. Exactly one of `task`/`tasks`; never both. Fresh tasks run in isolated sidekick sessions; a continuation resumes that session's own history only. Results are compact reports; max 3 concurrent. Equivalent active tasks and repeated no-progress retries are blocked.",
    parameters: delegateParameters,
    execute: async (
      rawArguments: Record<string, unknown>,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> => {
      const args = rawArguments as DelegateArguments;
      const invocations = resolveInvocations(args);
      const isSingle = invocations.length === 1;
      const results = new Array<SidekickResult>(invocations.length);
      const prepared: PreparedTask[] = [];

      // Reserve identities synchronously before workers begin, so duplicate tasks
      // cannot launch twice. Workspace baselines are deliberately captured by the
      // bounded worker immediately before the sidekick is dispatched. Continuations
      // are fingerprinted by their session identity plus task, so the same task
      // across distinct sidekick sessions stays a valid separate workflow.
      const starts = invocations.map((invocation) =>
        tracker.reserve(
          invocation.task,
          context.turn,
          invocation.mode === "continue"
            ? `continue:${invocation.sessionId}:${normalizeDelegationTask(invocation.task)}`
            : undefined,
        ),
      );
      for (const [index, start] of starts.entries()) {
        const invocation = invocations[index];
        if (invocation === undefined) continue;
        if (start.allowed) {
          prepared.push({ index, invocation, reservation: start.reservation });
        } else {
          results[index] = blockedResult(
            start.reason,
            start.noProgressAttempts,
            tracker.retryLimit(),
          );
        }
      }

      await runBounded(
        prepared,
        invocations.length,
        limit,
        runner,
        context.signal,
        options.onEvent,
        tracker,
        results,
        activeSessionIds,
        { model: options.sidekick?.config.model },
      );
      const compact = isSingle ? results[0] : results;
      return {
        text: JSON.stringify(compact),
        details: compact,
        isError: false,
      };
    },
  };
}

export const MAX_DELEGATE_CONCURRENCY = HARD_MAX_CONCURRENCY;
