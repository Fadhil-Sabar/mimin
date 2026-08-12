import { realpath } from "node:fs/promises";

export const MAX_NO_PROGRESS_DELEGATION_ATTEMPTS = 3;

export interface WorkspaceStateReader {
  read(): Promise<string | undefined>;
}

export interface DelegationAttempt {
  readonly fingerprint: string;
  readonly task: string;
  readonly beforeWorkspaceState: string | undefined;
  readonly attempt: number;
}

export type DelegationStartResult =
  | { allowed: true; attempt: DelegationAttempt }
  | {
      allowed: false;
      reason: "duplicate_active" | "duplicate_turn" | "retry_budget_exhausted";
      noProgressAttempts: number;
    };

export interface DelegationCompletion {
  madeProgress: boolean | undefined;
  noProgressAttempts: number;
}

interface DelegationAttemptState {
  attempts: number;
  noProgressAttempts: number;
  active: boolean;
  lastTurn?: number;
  lastWorkspaceState?: string;
}

export interface DelegationTrackerOptions {
  /** Fixed internal workspace state source. Omit outside manager orchestration. */
  workspaceState?: WorkspaceStateReader;
  maxNoProgressAttempts?: number;
}

/** Normalize a delegation contract without attempting semantic similarity. */
export function normalizeDelegationTask(task: string): string {
  return task.trim().replace(/\s+/g, " ").toLowerCase();
}

async function commandFingerprint(
  workspace: string,
  command: string[],
): Promise<string | undefined> {
  try {
    const process = Bun.spawn(command, {
      cwd: workspace,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const reader = process.stdout.getReader();
    // A small, non-cryptographic streaming fingerprint is enough to compare
    // two fixed Git command outputs. It avoids retaining or exposing patch
    // content while still distinguishing same-line-count edits.
    let hash = 2_166_136_261;
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        for (const byte of chunk.value) {
          hash ^= byte;
          hash = Math.imul(hash, 16_777_619);
          size += 1;
        }
      }
    } finally {
      reader.releaseLock();
    }
    const exitCode = await process.exited;
    return exitCode === 0 ? `${size}:${(hash >>> 0).toString(16)}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read a lightweight, fixed Git representation of the workspace. It never
 * exposes a shell surface to the manager and fingerprints only Git's changed
 * patches, never the full workspace or patch contents.
 */
export function gitWorkspaceState(workspace: string): WorkspaceStateReader {
  return {
    async read(): Promise<string | undefined> {
      let cwd: string;
      try {
        cwd = await realpath(workspace);
      } catch {
        return undefined;
      }
      const [status, unstaged, staged] = await Promise.all([
        commandFingerprint(cwd, ["git", "status", "--porcelain", "--untracked-files=normal"]),
        commandFingerprint(cwd, ["git", "diff", "--no-ext-diff", "--binary", "--"]),
        commandFingerprint(cwd, ["git", "diff", "--cached", "--no-ext-diff", "--binary", "--"]),
      ]);
      if (status === undefined || unstaged === undefined || staged === undefined) {
        return undefined;
      }
      return JSON.stringify({ status, unstaged, staged });
    },
  };
}

/**
 * Per-manager-run state for repeat delegation policy. State is deliberately
 * local to the tool collection that owns this tracker, never session-global.
 */
export class DelegationTracker {
  private readonly states = new Map<string, DelegationAttemptState>();
  private readonly maxNoProgressAttempts: number;

  constructor(private readonly options: DelegationTrackerOptions = {}) {
    const configured = options.maxNoProgressAttempts;
    this.maxNoProgressAttempts = Number.isFinite(configured)
      ? Math.max(1, Math.floor(configured as number))
      : MAX_NO_PROGRESS_DELEGATION_ATTEMPTS;
  }

  async begin(task: string, turn?: number): Promise<DelegationStartResult> {
    const fingerprint = normalizeDelegationTask(task);
    const state = this.states.get(fingerprint) ?? {
      attempts: 0,
      noProgressAttempts: 0,
      active: false,
    };
    this.states.set(fingerprint, state);

    // runAgent executes tool calls in a response in order, so a duplicate may
    // no longer be active by the time the later call starts. Keep the response
    // turn as deterministic orchestration state to block that waste as well.
    if (turn !== undefined && state.lastTurn === turn) {
      return {
        allowed: false,
        reason: "duplicate_turn",
        noProgressAttempts: state.noProgressAttempts,
      };
    }
    // Reserve synchronously before reading Git so concurrent duplicate calls
    // cannot start two sidekicks for the same normalized task.
    if (state.active) {
      return {
        allowed: false,
        reason: "duplicate_active",
        noProgressAttempts: state.noProgressAttempts,
      };
    }
    state.active = true;
    state.lastTurn = turn;

    const beforeWorkspaceState = await this.options.workspaceState?.read();
    // A changed baseline means an earlier lack of progress is no longer enough
    // evidence to block this corrective attempt.
    if (
      beforeWorkspaceState !== undefined &&
      state.lastWorkspaceState !== undefined &&
      beforeWorkspaceState !== state.lastWorkspaceState
    ) {
      state.noProgressAttempts = 0;
    }
    if (state.noProgressAttempts >= this.maxNoProgressAttempts) {
      state.active = false;
      return {
        allowed: false,
        reason: "retry_budget_exhausted",
        noProgressAttempts: state.noProgressAttempts,
      };
    }

    state.attempts += 1;
    return {
      allowed: true,
      attempt: {
        fingerprint,
        task,
        beforeWorkspaceState,
        attempt: state.attempts,
      },
    };
  }

  async finish(attempt: DelegationAttempt): Promise<DelegationCompletion> {
    const state = this.states.get(attempt.fingerprint);
    if (!state) return { madeProgress: undefined, noProgressAttempts: 0 };
    state.active = false;

    const afterWorkspaceState = await this.options.workspaceState?.read();
    if (
      attempt.beforeWorkspaceState === undefined ||
      afterWorkspaceState === undefined
    ) {
      return {
        madeProgress: undefined,
        noProgressAttempts: state.noProgressAttempts,
      };
    }

    state.lastWorkspaceState = afterWorkspaceState;
    if (afterWorkspaceState !== attempt.beforeWorkspaceState) {
      state.noProgressAttempts = 0;
      return { madeProgress: true, noProgressAttempts: 0 };
    }

    state.noProgressAttempts += 1;
    return { madeProgress: false, noProgressAttempts: state.noProgressAttempts };
  }

  /** Release a reserved but never-dispatched task without treating it as failed work. */
  cancel(attempt: DelegationAttempt): void {
    const state = this.states.get(attempt.fingerprint);
    if (state) state.active = false;
  }

  retryLimit(): number {
    return this.maxNoProgressAttempts;
  }
}
