import { mkdir, realpath } from "node:fs/promises";
import { Type } from "@mariozechner/pi-ai";
import type {
  AnyAgentTool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "../agent/types.js";
import { assertWorkspaceCommand } from "./path.js";

const DEFAULT_OUTPUT_LIMIT = 64 * 1024;
const MAX_OUTPUT_LIMIT = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 10 * 60_000;

interface BashArguments {
  command: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

interface BoundedStreamResult {
  text: string;
  truncated: boolean;
}

async function readBounded(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
  limit: number,
): Promise<BoundedStreamResult> {
  if (!stream || typeof stream === "number") {
    return { text: "", truncated: false };
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  let truncated = false;

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const bytes = chunk.value;
      if (bytesRead < limit) {
        const remaining = limit - bytesRead;
        const selected = bytes.byteLength <= remaining ? bytes : bytes.slice(0, remaining);
        text += decoder.decode(selected, { stream: true });
        bytesRead += selected.byteLength;
        if (selected.byteLength < bytes.byteLength) truncated = true;
      } else {
        truncated = true;
      }
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  return { text, truncated };
}

function formatOutput(stdout: string, stderr: string, exitCode: number | null): string {
  const sections = [`exitCode: ${exitCode === null ? "unknown" : exitCode}`];
  if (stdout) sections.push(`stdout:\n${stdout}`);
  if (stderr) sections.push(`stderr:\n${stderr}`);
  return sections.join("\n");
}

/** Create a bounded Bun.spawn-backed shell tool rooted at `workspace`. */
export function createBashTool(workspace: string): AnyAgentTool {
  return {
    name: "bash",
    description:
      "Run a bounded bash command with the configured workspace as its working directory; explicit outside-workspace paths are rejected.",
    parameters: Type.Object({
      command: Type.String({ minLength: 1, description: "Command to run" }),
      timeoutMs: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_TIMEOUT_MS,
          description: "Optional process timeout in milliseconds",
        }),
      ),
      maxOutputBytes: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_OUTPUT_LIMIT,
          description: "Maximum bytes captured from each output stream",
        }),
      ),
    }),
    execute: async (
      rawArguments: Record<string, unknown>,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> => {
      const args = rawArguments as unknown as BashArguments;
      assertWorkspaceCommand(args.command);
      await mkdir(workspace, { recursive: true });
      const workspaceRoot = await realpath(workspace);
      const outputLimit = Math.min(
        args.maxOutputBytes ?? DEFAULT_OUTPUT_LIMIT,
        MAX_OUTPUT_LIMIT,
      );
      const timeoutMs = Math.min(
        args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        MAX_TIMEOUT_MS,
      );

      const controller = new AbortController();
      const abort = (): void => controller.abort();
      if (context.signal?.aborted) controller.abort();
      context.signal?.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      let process: Bun.Subprocess | undefined;
      try {
        process = Bun.spawn(["bash", "-c", args.command], {
          cwd: workspaceRoot,
          env: {
            ...processEnv(),
            // Keep shell startup and directory conveniences from redirecting
            // execution through inherited paths outside the workspace.
            HOME: workspaceRoot,
            PWD: workspaceRoot,
            OLDPWD: workspaceRoot,
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          signal: controller.signal,
        });

        const [stdout, stderr] = await Promise.all([
          readBounded(process.stdout, outputLimit),
          readBounded(process.stderr, outputLimit),
        ]);
        const exitCode = await process.exited;
        const timedOut = controller.signal.aborted && !context.signal?.aborted;
        const aborted = controller.signal.aborted;
        const isError = aborted || exitCode !== 0;
        const details = {
          exitCode,
          stdout: stdout.text,
          stderr: stderr.text,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          timedOut,
          aborted,
          cwd: ".",
        };

        return {
          text: formatOutput(stdout.text, stderr.text, exitCode),
          isError,
          details,
        };
      } catch (error) {
        const aborted = controller.signal.aborted;
        if (!aborted) throw error;
        return {
          text: formatOutput("", error instanceof Error ? error.message : String(error), null),
          isError: true,
          details: {
            exitCode: process?.exitCode ?? null,
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            stdoutTruncated: false,
            stderrTruncated: false,
            timedOut: !context.signal?.aborted,
            aborted: true,
            cwd: ".",
          },
        };
      } finally {
        clearTimeout(timeout);
        context.signal?.removeEventListener("abort", abort);
      }
    },
  };
}

function processEnv(): Record<string, string> {
  const environment: Record<string, string> = {};
  const blocked = new Set(["BASH_ENV", "CDPATH", "ENV", "OLDPWD", "PWD"]);
  for (const [key, value] of Object.entries(Bun.env)) {
    if (
      value !== undefined &&
      !blocked.has(key) &&
      !key.startsWith("BASH_FUNC_")
    ) {
      environment[key] = value;
    }
  }
  return environment;
}

export const bashTool = createBashTool;
