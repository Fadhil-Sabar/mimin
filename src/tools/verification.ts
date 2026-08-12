import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Type } from "@mariozechner/pi-ai";
import type {
  AnyAgentTool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "../agent/types.js";

export const VERIFICATION_ACTIONS = [
  "git_status",
  "git_diff",
  "test",
  "typecheck",
  "build",
  "all",
] as const;

export type VerificationAction = typeof VERIFICATION_ACTIONS[number];

interface VerificationArguments {
  action: VerificationAction;
}

interface VerificationProcess {
  stdout: ReadableStream<Uint8Array> | number | null;
  stderr: ReadableStream<Uint8Array> | number | null;
  exited: Promise<number>;
  exitCode: number | null;
}

export type VerificationSpawn = (
  command: string[],
  options: {
    cwd: string;
    stdin: "ignore";
    stdout: "pipe";
    stderr: "pipe";
    signal: AbortSignal;
  },
) => VerificationProcess;

export interface CreateVerificationToolOptions {
  workspace: string;
  spawn?: VerificationSpawn;
  timeoutMs?: number;
  /** Per-manager-run state when verification feedback must be shared explicitly. */
  failureTracker?: VerificationFailureTracker;
}

interface CommandResult {
  command: string;
  exitCode: number | null;
  ok: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
}

const OUTPUT_LIMIT = 8 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

interface VerificationFailureState {
  fingerprint: string;
  consecutiveFailures: number;
}

/**
 * Tracks only the latest safe, bounded verification outcome per action. It is
 * intentionally in-memory and owned by a single verification tool instance.
 */
export class VerificationFailureTracker {
  private readonly failures = new Map<string, VerificationFailureState>();

  record(
    action: string,
    ok: boolean,
    outcome: unknown,
  ): number | undefined {
    if (ok) {
      this.failures.delete(action);
      return undefined;
    }
    const fingerprint = stableFailureFingerprint(action, outcome);
    const previous = this.failures.get(action);
    const consecutiveFailures = previous?.fingerprint === fingerprint
      ? previous.consecutiveFailures + 1
      : 1;
    this.failures.set(action, { fingerprint, consecutiveFailures });
    return consecutiveFailures > 1 ? consecutiveFailures : undefined;
  }
}

function withRepeatedFailureContext<T extends Record<string, unknown>>(
  details: T,
  consecutiveFailures: number | undefined,
): T & { repeatedFailure?: { consecutiveFailures: number; summary: string } } {
  if (consecutiveFailures === undefined) return details;
  return {
    ...details,
    repeatedFailure: {
      consecutiveFailures,
      summary: `Verification has failed with the same result ${consecutiveFailures} consecutive times.`,
    },
  };
}

function stableFailureSignature(value: unknown): string {
  if (typeof value !== "string") return "";
  return sanitize(value)
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|seconds?)\b/gi, "<time>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 512);
}

function stableFailureFingerprint(action: string, outcome: unknown): string {
  const details = outcome && typeof outcome === "object" ? outcome as Record<string, unknown> : {};
  const results = Array.isArray(details.results) ? details.results : [];
  return JSON.stringify({
    action,
    ok: details.ok === true,
    error: stableFailureSignature(details.error),
    results: results.map((item) => {
      const result = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return {
        command: typeof result.command === "string" ? result.command : "",
        exitCode: typeof result.exitCode === "number" || result.exitCode === null ? result.exitCode : null,
        ok: result.ok === true,
        timedOut: result.timedOut === true,
        signature: stableFailureSignature(result.stderr) || stableFailureSignature(result.stdout),
      };
    }),
  });
}

function sanitize(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

async function readBounded(
  stream: ReadableStream<Uint8Array> | number | null,
): Promise<{ text: string; truncated: boolean }> {
  if (!stream || typeof stream === "number") return { text: "", truncated: false };
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let remaining = OUTPUT_LIMIT;
  let text = "";
  let truncated = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (remaining > 0) {
        const selected = chunk.value.byteLength <= remaining
          ? chunk.value
          : chunk.value.slice(0, remaining);
        text += decoder.decode(selected, { stream: true });
        remaining -= selected.byteLength;
        if (selected.byteLength < chunk.value.byteLength) truncated = true;
      } else {
        truncated = true;
      }
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return { text: sanitize(text), truncated };
}

function commandLabel(command: readonly string[]): string {
  return command.join(" ");
}

async function configuredScript(
  workspace: string,
  name: "typecheck" | "build",
): Promise<string[] | undefined> {
  try {
    const parsed = JSON.parse(await Bun.file(join(workspace, "package.json")).text()) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const scripts = (parsed as Record<string, unknown>).scripts;
    if (typeof scripts !== "object" || scripts === null) return undefined;
    return typeof (scripts as Record<string, unknown>)[name] === "string"
      ? ["bun", "run", name]
      : undefined;
  } catch {
    return undefined;
  }
}

async function commandsFor(
  action: VerificationAction,
  workspace: string,
): Promise<{ commands: string[][]; missing?: string }> {
  if (action === "git_status") return { commands: [["git", "status", "--short"]] };
  if (action === "git_diff") return { commands: [["git", "diff", "--no-ext-diff", "--"]] };
  if (action === "test") return { commands: [["bun", "test"]] };
  if (action === "typecheck" || action === "build") {
    const command = await configuredScript(workspace, action);
    return command
      ? { commands: [command] }
      : { commands: [], missing: `package.json has no ${action} script` };
  }
  const typecheck = await configuredScript(workspace, "typecheck");
  const build = await configuredScript(workspace, "build");
  if (!typecheck || !build) {
    const absent = [!typecheck ? "typecheck" : "", !build ? "build" : ""]
      .filter(Boolean)
      .join(" and ");
    return { commands: [], missing: `package.json has no ${absent} script` };
  }
  return { commands: [["bun", "test"], typecheck, build] };
}

async function executeCommand(
  command: string[],
  cwd: string,
  spawn: VerificationSpawn,
  timeoutMs: number,
  outerSignal: AbortSignal | undefined,
): Promise<CommandResult> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (outerSignal?.aborted) controller.abort();
  outerSignal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, timeoutMs);
  let child: VerificationProcess | undefined;
  try {
    child = spawn(command, {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      readBounded(child.stdout),
      readBounded(child.stderr),
      child.exited,
    ]);
    const timedOut = controller.signal.aborted && !outerSignal?.aborted;
    return {
      command: commandLabel(command),
      exitCode,
      ok: exitCode === 0 && !controller.signal.aborted,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      timedOut,
    };
  } catch (error) {
    return {
      command: commandLabel(command),
      exitCode: child?.exitCode ?? null,
      ok: false,
      stdout: "",
      stderr: sanitize(error instanceof Error ? error.message : String(error)).slice(0, 2_000),
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: controller.signal.aborted && !outerSignal?.aborted,
    };
  } finally {
    clearTimeout(timeout);
    outerSignal?.removeEventListener("abort", abort);
  }
}

/** A closed, Bun.spawn-backed manager verification surface with no command input. */
export function createVerificationTool(
  options: CreateVerificationToolOptions,
): AnyAgentTool {
  const spawn = options.spawn ?? (Bun.spawn as unknown as VerificationSpawn);
  const failureTracker = options.failureTracker ?? new VerificationFailureTracker();
  return {
    name: "verification",
    description:
      "Run one fixed workspace verification action: git status/diff, tests, configured typecheck/build scripts, or all three checks. No command arguments are accepted.",
    parameters: Type.Object(
      {
        action: Type.Union(VERIFICATION_ACTIONS.map((action) => Type.Literal(action))),
      },
      { additionalProperties: false },
    ),
    execute: async (
      rawArguments: Record<string, unknown>,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> => {
      const action = rawArguments.action;
      if (typeof action !== "string" || !VERIFICATION_ACTIONS.includes(action as VerificationAction)) {
        throw new Error(`Unknown verification action: ${JSON.stringify(action)}`);
      }
      if (Object.keys(rawArguments).some((key) => key !== "action")) {
        throw new Error("verification accepts only a fixed action");
      }
      const workspace = await realpath(resolve(options.workspace));
      const selected = await commandsFor(action as VerificationAction, workspace);
      if (selected.missing) {
        const baseDetails = { action, cwd: ".", ok: false, error: selected.missing, results: [] };
        const details = withRepeatedFailureContext(
          baseDetails,
          failureTracker.record(action, false, baseDetails),
        );
        return { text: JSON.stringify(details), details, isError: true };
      }
      const results: CommandResult[] = [];
      for (const command of selected.commands) {
        results.push(await executeCommand(
          command,
          workspace,
          spawn,
          options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          context.signal,
        ));
      }
      const baseDetails = {
        action,
        cwd: ".",
        ok: results.every((result) => result.ok),
        results,
      };
      const details = withRepeatedFailureContext(
        baseDetails,
        failureTracker.record(action, baseDetails.ok, baseDetails),
      );
      return {
        text: JSON.stringify(details),
        details,
        isError: !details.ok,
      };
    },
  };
}
