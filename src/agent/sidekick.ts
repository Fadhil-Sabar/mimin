import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";
import sidekickPrompt from "../../prompts/sidekick.md" with { type: "text" };
import type { RoleConfig } from "../config.js";
import { SessionStore } from "../session/session.js";
import { createBashTool } from "../tools/bash.js";
import { createEditTool } from "../tools/edit.js";
import { createReadTool } from "../tools/read.js";
import { commandCodeCredentials, modelFromRole, type ModelResolver } from "./model.js";
import { runAgent } from "./run.js";
import type {
  AgentEvent,
  AgentRunConfig,
  AnyAgentTool,
} from "./types.js";
import type {
  AgentStreamFactory,
  RunAgentOptions,
  RunAgentResult,
} from "./run.js";

export type SidekickStatus =
  | "complete"
  | "partial"
  | "blocked"
  | "needs_decision";

export type VerificationStatus = "passed" | "failed" | "not_run";

export interface VerificationEntry {
  command: string;
  status: VerificationStatus;
  summary?: string;
}

/** The only sidekick data allowed to cross back into manager context. */
export interface SidekickResult {
  status: SidekickStatus;
  summary: string;
  filesChanged: string[];
  verification: VerificationEntry[];
  sessionId: string;
  detail?: string;
  error?: string;
}

export type SidekickActivityEvent =
  | { type: "sidekick_started"; sessionId: string; timestamp: number }
  | {
      type: "tool_started";
      sessionId: string;
      tool: string;
      timestamp: number;
      /** Whitelisted safe detail parsed from toolCall arguments (path/command). */
      detail?: string;
    }
  | {
      type: "tool_finished";
      sessionId: string;
      tool: string;
      ok: boolean;
      path?: string;
      timestamp: number;
      /** Whitelisted safe detail parsed from toolCall arguments (path/command). */
      detail?: string;
    }
  | {
      type: "sidekick_finished";
      sessionId: string;
      status: SidekickStatus;
      timestamp: number;
    };

export type SidekickActivityCallback = (
  event: SidekickActivityEvent,
) => void | Promise<void>;

export type SidekickRunFunction = (
  options: RunAgentOptions,
) => Promise<RunAgentResult>;

export interface RunSidekickOptions {
  task: string;
  workspace: string;
  config: RoleConfig;
  /** When omitted, SessionStore uses its environment-based default root. */
  dataDir?: string;
  sessionStore?: SessionStore;
  model?: Model<Api>;
  modelResolver?: ModelResolver;
  stream?: AgentStreamFactory;
  run?: SidekickRunFunction;
  systemPrompt?: string;
  runConfig?: Omit<AgentRunConfig, "thinking">;
  signal?: AbortSignal;
  onActivity?: SidekickActivityCallback;
  now?: () => number;
}

const MAX_COMPACT_TEXT = 2_000;
const MAX_ITEMS = 100;

/** Mechanical sidekick permission boundary. Do not add delegate here. */
export function createSidekickTools(workspace: string): AnyAgentTool[] {
  return [
    createReadTool(workspace),
    createEditTool(workspace),
    createBashTool(workspace),
  ];
}

export function extractAssistantText(
  message: AssistantMessage | undefined,
): string {
  if (!message) return "";
  return message.content
    .filter((block): block is Extract<typeof block, { type: "text" }> =>
      block.type === "text"
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function compactText(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  if (normalized.length <= MAX_COMPACT_TEXT) return normalized;
  return `${normalized.slice(0, MAX_COMPACT_TEXT - 1)}…`;
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => compactText(item))
        .filter(Boolean)
        .slice(0, MAX_ITEMS),
    ),
  ];
}

function normalizeVerification(value: unknown): VerificationEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: VerificationEntry[] = [];
  for (const item of value.slice(0, MAX_ITEMS)) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const status = record.status;
    if (
      status !== "passed" &&
      status !== "failed" &&
      status !== "not_run"
    ) {
      continue;
    }
    const command = compactText(record.command);
    if (!command) continue;
    const summary = compactText(record.summary);
    entries.push({
      command,
      status,
      ...(summary ? { summary } : {}),
    });
  }
  return entries;
}

function parseObject(text: string): Record<string, unknown> | undefined {
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) candidates.push(fenced);
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim()) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next conservative extraction before using the fallback result.
    }
  }
  return undefined;
}

export interface ParseSidekickResultOptions {
  sessionId: string;
  runStatus?: RunAgentResult["status"];
  runError?: string;
  observedFiles?: string[];
}

/** Normalize untrusted final model text without exposing its transcript. */
export function parseSidekickResult(
  text: string,
  options: ParseSidekickResultOptions,
): SidekickResult {
  const parsed = parseObject(text);
  const observedFiles = uniqueStrings(options.observedFiles ?? []);
  const parsedStatus = parsed?.status;
  const statusIsValid =
    parsedStatus === "complete" ||
    parsedStatus === "partial" ||
    parsedStatus === "blocked" ||
    parsedStatus === "needs_decision";

  if (!parsed || !statusIsValid) {
    const terminalFailure =
      options.runStatus === "error" || options.runStatus === "aborted";
    const runError = compactText(options.runError);
    return {
      status: terminalFailure ? "blocked" : "partial",
      summary: terminalFailure
        ? "Sidekick run did not complete."
        : "Sidekick did not return a valid structured result.",
      filesChanged: observedFiles,
      verification: [],
      sessionId: options.sessionId,
      detail: "The final response was not valid sidekick result JSON.",
      ...(runError ? { error: runError } : {}),
    };
  }

  const summary = compactText(parsed.summary, "Sidekick returned no summary.");
  const filesChanged = uniqueStrings([
    ...uniqueStrings(parsed.filesChanged),
    ...observedFiles,
  ]);
  const detail = compactText(parsed.detail);
  const parsedError = compactText(parsed.error);
  const runError = compactText(options.runError);
  const terminalFailure =
    options.runStatus === "error" || options.runStatus === "aborted";

  const normalizedStatus =
    terminalFailure
      ? "blocked"
      : options.runStatus === "max_turns" && parsedStatus === "complete"
        ? "partial"
        : parsedStatus;

  return {
    status: normalizedStatus,
    summary,
    filesChanged,
    verification: normalizeVerification(parsed.verification),
    sessionId: options.sessionId,
    ...(detail ? { detail } : {}),
    ...(parsedError || runError ? { error: parsedError || runError } : {}),
  };
}

function detailPath(details: unknown): string | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const path = (details as Record<string, unknown>).path;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

/**
 * Whitelisted safe detail from toolCall arguments: path for read/edit,
 * command for bash. Never returns raw output.
 */
function toolCallDetail(name: string, arguments_: Record<string, unknown>): string | undefined {
  if (name === "read" || name === "edit") {
    const path = arguments_.path;
    return typeof path === "string" && path.length > 0 ? path : undefined;
  }
  if (name === "bash") {
    const command = arguments_.command;
    return typeof command === "string" && command.length > 0 ? command : undefined;
  }
  return undefined;
}

/** Run one isolated implementation conversation using the generic agent loop. */
export async function runSidekick(
  options: RunSidekickOptions,
): Promise<SidekickResult> {
  if (!options.task.trim()) throw new Error("Sidekick task must be non-empty");
  const now = options.now ?? Date.now;
  const store =
    options.sessionStore ??
    new SessionStore(
      options.dataDir ? { root: join(options.dataDir, "sessions") } : {},
    );
  const session = await store.createSession("sidekick");
  const observedFiles: string[] = [];

  const activity = async (event: SidekickActivityEvent): Promise<void> => {
    await session.appendEvent(event);
    await options.onActivity?.(event);
  };

  await activity({
    type: "sidekick_started",
    sessionId: session.id,
    timestamp: now(),
  });
  // The isolated history begins with exactly the delegation contract.
  await session.append({
    role: "user",
    content: options.task,
    timestamp: now(),
  });

  let runResult: RunAgentResult;
  try {
    const model =
      options.model ?? modelFromRole(options.config, options.modelResolver);
    const run = options.run ?? ((runOptions) => runAgent(runOptions));
    runResult = await run({
      model,
      systemPrompt: options.systemPrompt ?? sidekickPrompt,
      session,
      tools: createSidekickTools(options.workspace),
      config: {
        ...options.runConfig,
        ...commandCodeCredentials(options.config.provider),
        thinking: options.config.thinking,
      },
      signal: options.signal,
      stream: options.stream,
      onEvent: async (event: AgentEvent) => {
        if (event.type === "tool_start") {
          await activity({
            type: "tool_started",
            sessionId: session.id,
            tool: event.toolCall.name,
            detail: toolCallDetail(
              event.toolCall.name,
              event.toolCall.arguments as Record<string, unknown>,
            ),
            timestamp: now(),
          });
        } else if (event.type === "tool_end") {
          const path = detailPath(event.result.details);
          if (event.toolCall.name === "edit" && !event.result.isError && path) {
            observedFiles.push(path);
          }
          await activity({
            type: "tool_finished",
            sessionId: session.id,
            tool: event.toolCall.name,
            ok: !event.result.isError,
            ...(path ? { path } : {}),
            detail: toolCallDetail(
              event.toolCall.name,
              event.toolCall.arguments as Record<string, unknown>,
            ),
            timestamp: now(),
          });
        }
      },
    });
  } catch (error) {
    runResult = {
      status: "error",
      turns: 0,
      toolCalls: 0,
      messages: session.messages,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const result = parseSidekickResult(extractAssistantText(runResult.finalMessage), {
    sessionId: session.id,
    runStatus: runResult.status,
    runError: runResult.error,
    observedFiles,
  });
  await activity({
    type: "sidekick_finished",
    sessionId: session.id,
    status: result.status,
    timestamp: now(),
  });
  return result;
}
