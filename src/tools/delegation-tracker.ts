import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";

export const MAX_NO_PROGRESS_DELEGATION_ATTEMPTS = 3;
const MAX_UNTRACKED_FILES = 100;
const MAX_UNTRACKED_FILE_BYTES = 256 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_UNTRACKED_LIST_BYTES = 1024 * 1024;

export interface WorkspaceStateReader {
  read(): Promise<string | undefined>;
}

export interface DelegationReservation {
  readonly fingerprint: string;
  readonly task: string;
}

export interface DelegationAttempt extends DelegationReservation {
  readonly beforeWorkspaceState: string | undefined;
  readonly attempt: number;
  readonly executionId: number;
}

function isDelegationAttempt(item: DelegationReservation): item is DelegationAttempt {
  return "executionId" in item && typeof (item as { executionId?: unknown }).executionId === "number";
}

export type DelegationReserveResult =
  | { allowed: true; reservation: DelegationReservation }
  | { allowed: false; reason: "duplicate_active" | "duplicate_turn"; noProgressAttempts: number };

export type DelegationStartResult =
  | { allowed: true; attempt: DelegationAttempt }
  | { allowed: false; reason: "retry_budget_exhausted"; noProgressAttempts: number };

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

function hashBytes(bytes: Uint8Array, initial = 2_166_136_261): number {
  let hash = initial;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash;
}

function fingerprintBytes(bytes: Uint8Array): string {
  return `${bytes.byteLength}:${(hashBytes(bytes) >>> 0).toString(16)}`;
}

async function commandFingerprint(workspace: string, command: string[]): Promise<string | undefined> {
  try {
    const process = Bun.spawn(command, { cwd: workspace, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const reader = process.stdout.getReader();
    let hash = 2_166_136_261;
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        hash = hashBytes(chunk.value, hash);
        size += chunk.value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    return await process.exited === 0 ? `${size}:${(hash >>> 0).toString(16)}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One bounded `git ls-files --others --exclude-standard -z` pass. The retained
 * byte window covers the path entries this pass actually fingerprints (which
 * would otherwise be a TOCTOU against a second spawn), while the full-stream
 * fingerprint keeps later list changes detectable without retaining the list.
 */
interface UntrackedList {
  paths: string[];
  listFingerprint: string;
  totalPaths: number;
  truncated: boolean;
}

async function untrackedList(workspace: string): Promise<UntrackedList | undefined> {
  const command = ["git", "ls-files", "--others", "--exclude-standard", "-z"];
  try {
    const process = Bun.spawn(command, { cwd: workspace, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const reader = process.stdout.getReader();
    // Keep exactly one fixed-size window for paths we might inspect. Continue
    // draining and hashing the full stream so git can exit normally, but never
    // construct the complete listing (or an unbounded list of parsed paths).
    const retainedPaths = new Uint8Array(MAX_UNTRACKED_LIST_BYTES);
    let retained = 0;
    let hash = 2_166_136_261;
    let size = 0;
    let pathStart = 0;
    let retainPath = true;
    let totalPaths = 0;
    const paths: string[] = [];
    const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        hash = hashBytes(chunk.value, hash);
        size += chunk.value.byteLength;
        for (const byte of chunk.value) {
          if (retainPath && retained < MAX_UNTRACKED_LIST_BYTES) {
            retainedPaths[retained] = byte;
            retained += 1;
          } else {
            retainPath = false;
          }
          if (byte !== 0) continue;
          totalPaths += 1;
          if (retainPath) {
            const path = decoder.decode(retainedPaths.subarray(pathStart, retained - 1));
            if (path) paths.push(path);
          }
          pathStart = retained;
          retainPath = paths.length < MAX_UNTRACKED_FILES && retained < MAX_UNTRACKED_LIST_BYTES;
        }
      }
    } finally {
      reader.releaseLock();
    }
    if (await process.exited !== 0) return undefined;
    const listFingerprint = `${size}:${(hash >>> 0).toString(16)}`;
    return {
      paths,
      listFingerprint,
      totalPaths,
      truncated: paths.length < totalPaths,
    };
  } catch {
    return undefined;
  }
}

async function untrackedContentsFingerprint(workspace: string): Promise<string | undefined> {
  const listed = await untrackedList(workspace);
  if (listed === undefined) return undefined;
  // Preserve a fingerprint of Git's complete list, even when content reading is bounded.
  const records: string[] = [
    `list:${listed.listFingerprint}`,
    `listed:${listed.totalPaths}`,
    `truncated:${listed.truncated}`,
  ];
  let totalRead = 0;
  for (const relative of listed.paths.slice(0, MAX_UNTRACKED_FILES)) {
    const pathBytes = new TextEncoder().encode(relative);
    try {
      const absolute = join(workspace, relative);
      const stat = await lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        records.push(`path:${fingerprintBytes(pathBytes)}:nonregular`);
        continue;
      }
      const remaining = MAX_UNTRACKED_TOTAL_BYTES - totalRead;
      const readLimit = Math.max(0, Math.min(MAX_UNTRACKED_FILE_BYTES, remaining));
      if (readLimit === 0) {
        records.push(`path:${fingerprintBytes(pathBytes)}:bounded:${stat.size}`);
        continue;
      }
      const handle = await open(absolute, "r");
      let selected: Uint8Array;
      try {
        const buffer = new Uint8Array(readLimit);
        const { bytesRead } = await handle.read(buffer, 0, readLimit, 0);
        selected = buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
      totalRead += selected.byteLength;
      const truncated = stat.size > selected.byteLength;
      // Content beyond the cap must not influence the fingerprint: only the
      // bounded prefix (and whether it was truncated) is compared.
      records.push(`path:${fingerprintBytes(pathBytes)}:size:${Math.min(stat.size, selected.byteLength)}:content:${fingerprintBytes(selected)}${truncated ? ":truncated" : ""}`);
    } catch {
      // Races and inaccessible paths must not disrupt manager orchestration.
      records.push(`path:${fingerprintBytes(pathBytes)}:unreadable`);
    }
  }
  if (listed.totalPaths > listed.paths.length) records.push(`files-bounded:${listed.totalPaths - listed.paths.length}`);
  return fingerprintBytes(new TextEncoder().encode(records.join("\n")));
}

/** Read a fixed, internal Git representation without exposing workspace contents. */
export function gitWorkspaceState(workspace: string): WorkspaceStateReader {
  return {
    async read(): Promise<string | undefined> {
      let cwd: string;
      try { cwd = await realpath(workspace); } catch { return undefined; }
      const [status, unstaged, staged, untracked] = await Promise.all([
        commandFingerprint(cwd, ["git", "status", "--porcelain", "--untracked-files=normal"]),
        commandFingerprint(cwd, ["git", "diff", "--no-ext-diff", "--binary", "--"]),
        commandFingerprint(cwd, ["git", "diff", "--cached", "--no-ext-diff", "--binary", "--"]),
        untrackedContentsFingerprint(cwd),
      ]);
      if ([status, unstaged, staged, untracked].some((value) => value === undefined)) return undefined;
      return JSON.stringify({ status, unstaged, staged, untracked });
    },
  };
}

/** Per-manager-run state for repeat delegation policy. */
export class DelegationTracker {
  private readonly states = new Map<string, DelegationAttemptState>();
  private readonly maxNoProgressAttempts: number;
  private readonly activeExecutions = new Set<number>();
  private readonly ambiguousExecutions = new Set<number>();
  private nextExecutionId = 1;

  constructor(private readonly options: DelegationTrackerOptions = {}) {
    const configured = options.maxNoProgressAttempts;
    this.maxNoProgressAttempts = Number.isFinite(configured) ? Math.max(1, Math.floor(configured as number)) : MAX_NO_PROGRESS_DELEGATION_ATTEMPTS;
  }

  reserve(
    task: string,
    turn?: number,
    /** Optional explicit identity. Continuations pass `sessionId + task`. */
    fingerprint?: string,
  ): DelegationReserveResult {
    const key = fingerprint ?? normalizeDelegationTask(task);
    const state = this.states.get(key) ?? { attempts: 0, noProgressAttempts: 0, active: false };
    this.states.set(key, state);
    if (turn !== undefined && state.lastTurn === turn) return { allowed: false, reason: "duplicate_turn", noProgressAttempts: state.noProgressAttempts };
    if (state.active) return { allowed: false, reason: "duplicate_active", noProgressAttempts: state.noProgressAttempts };
    state.active = true;
    state.lastTurn = turn;
    return { allowed: true, reservation: { fingerprint: key, task } };
  }

  async start(reservation: DelegationReservation): Promise<DelegationStartResult> {
    const state = this.states.get(reservation.fingerprint);
    if (!state) return { allowed: false, reason: "retry_budget_exhausted", noProgressAttempts: 0 };
    const beforeWorkspaceState = await this.options.workspaceState?.read();
    if (beforeWorkspaceState !== undefined && state.lastWorkspaceState !== undefined && beforeWorkspaceState !== state.lastWorkspaceState) state.noProgressAttempts = 0;
    if (state.noProgressAttempts >= this.maxNoProgressAttempts) {
      state.active = false;
      return { allowed: false, reason: "retry_budget_exhausted", noProgressAttempts: state.noProgressAttempts };
    }
    state.attempts += 1;
    const executionId = this.nextExecutionId++;
    if (this.activeExecutions.size > 0) {
      for (const activeExecution of this.activeExecutions) this.ambiguousExecutions.add(activeExecution);
      this.ambiguousExecutions.add(executionId);
    }
    this.activeExecutions.add(executionId);
    return { allowed: true, attempt: { ...reservation, beforeWorkspaceState, attempt: state.attempts, executionId } };
  }

  async finish(attempt: DelegationAttempt): Promise<DelegationCompletion> {
    const state = this.states.get(attempt.fingerprint);
    if (!state) return { madeProgress: undefined, noProgressAttempts: 0 };
    state.active = false;
    this.activeExecutions.delete(attempt.executionId);
    const ambiguous = this.ambiguousExecutions.delete(attempt.executionId);
    if (ambiguous) return { madeProgress: undefined, noProgressAttempts: state.noProgressAttempts };
    const afterWorkspaceState = await this.options.workspaceState?.read();
    if (attempt.beforeWorkspaceState === undefined || afterWorkspaceState === undefined) return { madeProgress: undefined, noProgressAttempts: state.noProgressAttempts };
    state.lastWorkspaceState = afterWorkspaceState;
    if (afterWorkspaceState !== attempt.beforeWorkspaceState) {
      state.noProgressAttempts = 0;
      return { madeProgress: true, noProgressAttempts: 0 };
    }
    state.noProgressAttempts += 1;
    return { madeProgress: false, noProgressAttempts: state.noProgressAttempts };
  }

  /** Release a reserved or started task without treating cancellation as failed work. */
  cancel(item: DelegationReservation): void {
    const state = this.states.get(item.fingerprint);
    if (state) state.active = false;
    if (isDelegationAttempt(item)) {
      this.activeExecutions.delete(item.executionId);
      this.ambiguousExecutions.delete(item.executionId);
    }
  }

  retryLimit(): number { return this.maxNoProgressAttempts; }
}
