import { Type } from "@mariozechner/pi-ai";
import type {
  AnyAgentTool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "../agent/types.js";
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
}

interface DelegateArguments {
  task?: string | string[];
  tasks?: string[];
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
  tasks: readonly string[],
  limit: number,
  runner: SidekickRunner,
  signal: AbortSignal | undefined,
  onEvent: DelegateEventCallback | undefined,
  presentation?: { model?: string },
): Promise<SidekickResult[]> {
  const results = new Array<SidekickResult>(tasks.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      if (signal?.aborted) {
        // Fill every not-yet-started slot with a blocked result so the
        // manager never sees nulls for aborted tasks.
        while (nextIndex < tasks.length) {
          const index = nextIndex;
          nextIndex += 1;
          results[index] = {
            status: "blocked",
            summary: "Aborted by the manager.",
            filesChanged: [],
            verification: [],
            sessionId: "unavailable",
          };
        }
        return;
      }
      const index = nextIndex;
      nextIndex += 1;
      const task = tasks[index];
      if (task === undefined) return;
      await onEvent?.({
        type: "delegation_started",
        index,
        taskCount: tasks.length,
        task,
        model: presentation?.model,
      });
      let result: SidekickResult;
      try {
        result = managerFacingResult(
          await runner(task, {
            index,
            signal,
            onActivity: (activity) =>
              onEvent?.({
                type: "sidekick_activity",
                index,
                taskCount: tasks.length,
                activity,
              }),
          }),
        );
      } catch (error) {
        result = failedResult(error);
      }
      results[index] = result;
      await onEvent?.({
        type: "delegation_finished",
        index,
        taskCount: tasks.length,
        result,
        task,
        model: presentation?.model,
      });
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, () => worker()),
  );
  return results;
}

/** Create the manager's bounded one-level delegation tool. */
export function createDelegateTool(
  options: CreateDelegateToolOptions,
): AnyAgentTool {
  const limit = concurrencyLimit(options.maxConcurrency);
  const runner = options.run ?? productionRunner(options.sidekick);
  return {
    name: "delegate",
    description:
      "Delegate implementation. Call with { task: \"one contract\" } for a single task, or { task: [\"a\", \"b\"] } (or the legacy { tasks: [...] }) for independent parallel tasks. Exactly one of `task`/`tasks`; never both. Each task runs in a fresh isolated sidekick session; results are compact reports; max 3 concurrent.",
    parameters: delegateParameters,
    execute: async (
      rawArguments: Record<string, unknown>,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> => {
      const args = rawArguments as DelegateArguments;
      const tasks = resolveTasks(args);
      const isSingle = typeof args.task === "string";
      const results = await runBounded(
        tasks,
        limit,
        runner,
        context.signal,
        options.onEvent,
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
