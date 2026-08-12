import { Type } from "@mariozechner/pi-ai";
import type {
  AnyAgentTool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "../agent/types.js";
import {
  DelegationTracker,
  type DelegationAttempt,
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
}

export type SidekickRunner = (
  task: string,
  context: SidekickRunnerContext,
) => Promise<SidekickResult>;

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
}

interface PreparedTask {
  index: number;
  task: string;
  attempt: DelegationAttempt;
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
  reason: "duplicate_active" | "duplicate_turn" | "retry_budget_exhausted",
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

function productionRunner(
  sidekick: CreateDelegateToolOptions["sidekick"],
): SidekickRunner {
  if (!sidekick) {
    throw new Error("createDelegateTool requires sidekick options when no runner is injected");
  }
  return (task, context) =>
    runSidekick({
      ...sidekick,
      task,
      signal: context.signal,
      onActivity: context.onActivity,
    });
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
  presentation?: { model?: string },
): Promise<void> {
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const item = tasks[nextIndex];
      if (!item) return;
      nextIndex += 1;
      if (signal?.aborted) {
        tracker.cancel(item.attempt);
        results[item.index] = {
          status: "blocked",
          summary: "Aborted by the manager.",
          filesChanged: [],
          verification: [],
          sessionId: "unavailable",
        };
        continue;
      }
      await onEvent?.({
        type: "delegation_started",
        index: item.index,
        taskCount,
        task: item.task,
        model: presentation?.model,
      });
      let result: SidekickResult;
      try {
        result = managerFacingResult(
          await runner(item.task, {
            index: item.index,
            signal,
            onActivity: (activity) =>
              onEvent?.({
                type: "sidekick_activity",
                index: item.index,
                taskCount,
                activity,
              }),
          }),
        );
      } catch (error) {
        result = failedResult(error);
      }

      if (signal?.aborted) {
        // Cancellation is not evidence that an otherwise retryable task made
        // no progress. Release its reservation without consuming budget.
        tracker.cancel(item.attempt);
      } else {
        const completion = await tracker.finish(item.attempt);
        if (completion.madeProgress === false) {
          result = withProgressFeedback(
            result,
            completion.noProgressAttempts,
            tracker.retryLimit(),
          );
        }
      }
      results[item.index] = result;
      await onEvent?.({
        type: "delegation_finished",
        index: item.index,
        taskCount,
        result,
        task: item.task,
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
  return {
    name: "delegate",
    description:
      "Delegate implementation. Call with { task: \"one contract\" } for a single task, or { task: [\"a\", \"b\"] } (or the legacy { tasks: [...] }) for independent parallel tasks. Exactly one of `task`/`tasks`; never both. Each task runs in a fresh isolated sidekick session; results are compact reports; max 3 concurrent. Equivalent active tasks and repeated no-progress retries are blocked.",
    parameters: delegateParameters,
    execute: async (
      rawArguments: Record<string, unknown>,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> => {
      const args = rawArguments as DelegateArguments;
      const tasks = resolveTasks(args);
      const isSingle = typeof args.task === "string";
      const results = new Array<SidekickResult>(tasks.length);
      const prepared: PreparedTask[] = [];

      // Starting each task reserves its normalized identity before the first
      // asynchronous workspace read, preventing same-batch duplicate launches.
      const starts = await Promise.all(
        tasks.map((task) => tracker.begin(task, context.turn)),
      );
      for (const [index, start] of starts.entries()) {
        const task = tasks[index];
        if (task === undefined) continue;
        if (start.allowed) {
          prepared.push({ index, task, attempt: start.attempt });
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
        tasks.length,
        limit,
        runner,
        context.signal,
        options.onEvent,
        tracker,
        results,
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
