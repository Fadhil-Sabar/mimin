import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { redactSecrets } from "../memory/secrets.js";

/** Input budget after output/tool headroom has been reserved. */
export interface ContextBudget {
  maxTokens: number;
  reserveTokens: number;
  /** Optional provider limit. It is only used to cap the configured maximum. */
  modelContextWindow?: number;
  /** System prompt is provider input too and consumes this budget. */
  systemPrompt?: string;
}

export interface ContextDiagnostics {
  originalMessages: number;
  contextMessages: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  compacted: boolean;
}

export interface CompactedContext {
  messages: Message[];
  compacted: boolean;
  estimatedTokens: number;
  usableTokens: number;
  diagnostics: ContextDiagnostics;
}

export class ContextBudgetExceededError extends Error {
  readonly requiredTokens: number;
  readonly availableTokens: number;

  constructor(requiredTokens: number, availableTokens: number) {
    super(`Current required context exceeds the available model context budget (required: ${requiredTokens} estimated tokens, available: ${availableTokens}).`);
    this.name = "ContextBudgetExceededError";
    this.requiredTokens = requiredTokens;
    this.availableTokens = availableTokens;
  }
}

const MESSAGE_OVERHEAD = 8;
const RECENT_RESULT_CHARS = 3_000;
const MIN_RESULT_CHARS = 96;
const SUMMARY_CHARS = 6_000;
const MAX_FILES = 8;
const MAX_VERIFICATIONS = 4;
const MAX_SEARCH_MATCHES = 3;
const HISTORICAL_TAIL = 8;

const IMPORTANT_EVENT_CAPS = {
  delegate: 3,
  verification: 4,
  edit: 6,
  failure: 4,
  other: 2,
} as const;
const MAX_OLDER_IMPORTANT_EVENTS = 4;
const PROVIDER_DETAIL_STRING_LIMIT = 320;
const PROVIDER_DETAIL_MATCH_LIMIT = 160;

/** Lightweight, deterministic approximation used only for input budgeting. */
export function estimateMessageTokens(message: Message): number {
  return Math.ceil(JSON.stringify(message).length / 4) + MESSAGE_OVERHEAD;
}

export function estimateMessagesTokens(messages: readonly Message[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

export function usableContextTokens(budget: ContextBudget): number {
  const maximum = budget.modelContextWindow === undefined
    ? budget.maxTokens
    : Math.min(budget.maxTokens, budget.modelContextWindow);
  return maximum - budget.reserveTokens;
}

function toolCalls(message: Message): ToolCall[] {
  if (message.role !== "assistant") return [];
  return (message as AssistantMessage).content.filter(
    (block): block is ToolCall => block.type === "toolCall",
  );
}

interface MessageGroup {
  messages: Message[];
  start: number;
  end: number;
  complete: boolean;
  interrupted: boolean;
  orphan: boolean;
}

function interruptionMessage(orphan = false): Message {
  return {
    role: "user",
    content: orphan
      ? "[A previous tool result could not be matched to its tool call and was omitted from provider context.]"
      : "[Previous tool execution was interrupted. Some requested tool calls did not complete.]",
    timestamp: 0,
  };
}

/** Group calls with results and replace structurally invalid history provider-side only. */
function groups(messages: readonly Message[]): MessageGroup[] {
  const result: MessageGroup[] = [];
  for (let index = 0; index < messages.length;) {
    const message = messages[index]!;
    if (message.role === "toolResult") {
      result.push({ messages: [interruptionMessage(true)], start: index, end: index + 1, complete: false, interrupted: false, orphan: true });
      index += 1;
      continue;
    }
    const calls = toolCalls(message);
    if (calls.length === 0) {
      result.push({ messages: [message], start: index, end: index + 1, complete: true, interrupted: false, orphan: false });
      index += 1;
      continue;
    }
    const ids = new Set(calls.map((call) => call.id));
    const expectedNames = new Map(calls.map((call) => [call.id, call.name]));
    const found = new Map<string, number>();
    let mismatched = false;
    let end = index + 1;
    while (end < messages.length) {
      const candidate = messages[end]!;
      if (candidate.role !== "toolResult" || !ids.has(candidate.toolCallId)) break;
      found.set(candidate.toolCallId, (found.get(candidate.toolCallId) ?? 0) + 1);
      if (candidate.toolName !== expectedNames.get(candidate.toolCallId)) mismatched = true;
      end += 1;
    }
    const complete = !mismatched && calls.every((call) => found.get(call.id) === 1);
    result.push({
      messages: complete ? messages.slice(index, end) : [interruptionMessage()],
      start: index,
      end,
      complete,
      interrupted: !complete,
      orphan: false,
    });
    index = end;
  }
  return result;
}

export function validateContextToolIntegrity(messages: readonly Message[]): boolean {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "toolResult") return false;
    const calls = toolCalls(message);
    if (calls.length === 0) continue;
    const expected = new Map(calls.map((call) => [call.id, call.name]));
    const found = new Map<string, number>();
    let cursor = index + 1;
    while (cursor < messages.length) {
      const candidate = messages[cursor]!;
      if (candidate.role !== "toolResult" || !expected.has(candidate.toolCallId)) break;
      if (candidate.toolName !== expected.get(candidate.toolCallId)) return false;
      found.set(candidate.toolCallId, (found.get(candidate.toolCallId) ?? 0) + 1);
      cursor += 1;
    }
    if ([...expected.keys()].some((id) => found.get(id) !== 1)) return false;
    index = cursor - 1;
  }
  return true;
}

function textOf(message: Message): string {
  if (message.role === "user") {
    return typeof message.content === "string"
      ? message.content
      : message.content.map((block) => block.type === "text" ? block.text : "").join("\n");
  }
  if (message.role === "toolResult") {
    return message.content.map((block) => block.type === "text" ? block.text : "").join("\n");
  }
  if (message.role === "assistant") {
    return message.content.map((block) => block.type === "text" ? block.text : "").join("\n");
  }
  return "";
}

function compactSnippet(value: string, limit = 400): string {
  const normalized = redactSecrets(value).content.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function detailsOf(message: Message): Record<string, unknown> | undefined {
  if (message.role !== "toolResult") return undefined;
  const direct = objectOf((message as ToolResultMessage).details);
  if (direct) return direct;
  try {
    return objectOf(JSON.parse(textOf(message)));
  } catch {
    return undefined;
  }
}

function safeString(value: unknown, limit = 240): string | undefined {
  return typeof value === "string" && value.trim() ? compactSnippet(value, limit) : undefined;
}

function stringList(value: unknown, limit: number): string[] {
  return Array.isArray(value)
    ? value.map((item) => safeString(item, 160)).filter((item): item is string => Boolean(item)).slice(0, limit)
    : [];
}

function callForResult(messages: readonly Message[], resultIndex: number): ToolCall | undefined {
  for (let index = resultIndex - 1; index >= 0; index -= 1) {
    const candidate = messages[index]!;
    if (candidate.role === "toolResult") continue;
    return toolCalls(candidate).find((call) => call.id === (messages[resultIndex] as Message & { toolCallId?: string }).toolCallId);
  }
  return undefined;
}

function delegateLines(details: Record<string, unknown> | undefined): string[] {
  if (!details) return ["- Delegation completed; detailed continuation state was unavailable."];
  const values = Array.isArray(details) ? details : Array.isArray(details.results) ? details.results : [details];
  const lines: string[] = [];
  for (const value of values.slice(0, 3)) {
    const item = objectOf(value);
    if (!item) continue;
    const sessionId = safeString(item.sessionId, 128);
    const status = safeString(item.status, 40) ?? "completed";
    lines.push(`- Delegated sidekick${sessionId ? ` ${sessionId}` : ""}: ${status}.`);
    const summary = safeString(item.summary, 320);
    if (summary) lines.push(`  Summary: ${summary}`);
    const files = stringList(item.filesChanged, MAX_FILES);
    if (files.length) lines.push(`  Files: ${files.join(", ")}.`);
    const verification = Array.isArray(item.verification) ? item.verification.slice(0, MAX_VERIFICATIONS) : [];
    for (const raw of verification) {
      const entry = objectOf(raw);
      if (!entry) continue;
      const command = safeString(entry.command, 120);
      const state = safeString(entry.status, 40);
      const summaryText = safeString(entry.summary, 180);
      if (command || state || summaryText) lines.push(`  Verification: ${[command, state, summaryText].filter(Boolean).join(" — ")}.`);
    }
  }
  return lines.length ? lines : ["- Delegation completed; detailed continuation state was unavailable."];
}

function verificationLines(details: Record<string, unknown> | undefined, isError: boolean): string[] {
  const action = safeString(details?.action, 60) ?? "verification";
  const ok = details?.ok === true && !isError;
  const results = Array.isArray(details?.results) ? details.results : [];
  const failed = results.map(objectOf).find((item) => item && item.ok !== true);
  const command = safeString(failed?.command, 140) ?? action;
  const signature = safeString(failed?.stderr, 180) ?? safeString(failed?.stdout, 180) ?? safeString(details?.error, 180);
  return [`- Verification ${ok ? "passed" : "failed"}: ${command}.`, ...(!ok && signature ? [`  Failure: ${signature}`] : [])];
}

function toolSummary(messages: readonly Message[], resultIndex: number): string[] {
  const message = messages[resultIndex]!;
  if (message.role !== "toolResult") return [];
  const name = message.toolName ?? "result";
  const details = detailsOf(message);
  const call = callForResult(messages, resultIndex);
  if (name === "delegate") return delegateLines(details);
  if (name === "verification") return verificationLines(details, message.isError === true);
  if (name === "edit") {
    const path = safeString(details?.path, 180) ?? safeString(call?.arguments?.path, 180);
    return [`- Edited ${path ?? "a workspace file"}.`];
  }
  if (name === "read") {
    const path = safeString(details?.path, 180) ?? safeString(call?.arguments?.path, 180);
    return [`- Inspected ${path ?? "a workspace file"}.`];
  }
  if (name === "bash") {
    const command = safeString(call?.arguments?.command, 160) ?? "workspace command";
    const exitCode = details?.exitCode;
    const failed = message.isError === true || (typeof exitCode === "number" && exitCode !== 0);
    const signature = failed ? safeString(details?.stderr, 180) : undefined;
    return [`- Ran \`${command.replace(/`/g, "'")}\`: ${failed ? "failed" : "passed"}.`, ...(signature ? [`  Failure: ${signature}`] : [])];
  }
  if (name === "memory_search" || name === "session_search") {
    const count = typeof details?.count === "number" ? details.count : undefined;
    const label = name === "memory_search" ? "memory" : "session history";
    const lines = [`- Searched ${label}${count === undefined ? "" : `; ${count} match${count === 1 ? "" : "es"}`}.`];
    const matches = Array.isArray(details?.matches) ? details.matches.slice(0, MAX_SEARCH_MATCHES) : [];
    for (const raw of matches) {
      const item = objectOf(raw);
      const snippet = safeString(item?.snippet, 160) ?? (Array.isArray(item?.snippets) ? safeString(item.snippets[0], 160) : undefined);
      if (snippet) lines.push(`  Match: ${snippet}`);
    }
    return lines;
  }
  return [`- Tool ${compactSnippet(name, 60)} ${message.isError ? "failed" : "completed"}.`];
}

type ImportantEventKind = "delegate" | "verification" | "edit" | "failure" | "other";

interface ImportantEvent {
  kind: ImportantEventKind;
  index: number;
  lines: string[];
  verificationFailed?: boolean;
}

interface SummaryEvents {
  goal: string[];
  important: ImportantEvent[];
  tail: string[];
}

function recentEvents(events: readonly ImportantEvent[], limit: number): ImportantEvent[] {
  return events.slice(-limit).reverse();
}

function pushUnique(events: ImportantEvent[], event: ImportantEvent | undefined): void {
  if (event && !events.includes(event)) events.push(event);
}

function takeRecent(
  selected: ImportantEvent[],
  events: readonly ImportantEvent[],
  category: ImportantEventKind,
  limit: number,
): void {
  for (const event of recentEvents(events, limit)) {
    if (selected.filter((candidate) => candidate.kind === category).length >= limit) break;
    pushUnique(selected, event);
  }
}

/** Keep continuation state deterministic and recent-first with fixed category caps. */
function prioritizedImportantEvents(events: readonly ImportantEvent[]): ImportantEvent[] {
  const delegates = events.filter((event) => event.kind === "delegate");
  const verifications = events.filter((event) => event.kind === "verification");
  const failedVerifications = verifications.filter((event) => event.verificationFailed);
  const passedVerifications = verifications.filter((event) => !event.verificationFailed);
  const edits = events.filter((event) => event.kind === "edit");
  const failures = events.filter((event) => event.kind === "failure");
  const other = events.filter((event) => event.kind === "other");
  const selected: ImportantEvent[] = [];

  // Anchor the newest continuation/file/failure signals before older state.
  pushUnique(selected, delegates.at(-1));
  pushUnique(selected, failedVerifications.at(-1) ?? verifications.at(-1));
  pushUnique(selected, edits.at(-1));
  takeRecent(selected, delegates, "delegate", IMPORTANT_EVENT_CAPS.delegate);
  const failedVerificationLimit = Math.min(IMPORTANT_EVENT_CAPS.verification, failedVerifications.length);
  for (const event of recentEvents(failedVerifications, failedVerificationLimit)) {
    if (selected.filter((candidate) => candidate.kind === "verification").length >= IMPORTANT_EVENT_CAPS.verification) break;
    pushUnique(selected, event);
  }
  const passedVerificationLimit = IMPORTANT_EVENT_CAPS.verification - failedVerificationLimit;
  takeRecent(selected, passedVerifications, "verification", passedVerificationLimit);
  takeRecent(selected, edits, "edit", IMPORTANT_EVENT_CAPS.edit);
  takeRecent(selected, failures, "failure", IMPORTANT_EVENT_CAPS.failure);
  takeRecent(selected, other, "other", IMPORTANT_EVENT_CAPS.other);

  const selectedSet = new Set(selected);
  const older = events
    .filter((event) => !selectedSet.has(event))
    .slice()
    .sort((left, right) => right.index - left.index)
    .slice(0, MAX_OLDER_IMPORTANT_EVENTS);
  return [...selected, ...older];
}

function summaryEvents(messages: readonly Message[]): SummaryEvents {
  const goal: string[] = [];
  const important: ImportantEvent[] = [];
  const ordinary: string[] = [];
  const firstUser = messages.find((message) => message.role === "user");
  const goalText = firstUser ? compactSnippet(textOf(firstUser), 500) : "";
  if (goalText) goal.push(`- ${goalText}`);

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "toolResult") {
      const lines = toolSummary(messages, index);
      let kind: ImportantEventKind | undefined;
      let failed: boolean | undefined;
      if (message.toolName === "delegate") kind = "delegate";
      else if (message.toolName === "verification") {
        kind = "verification";
        const details = detailsOf(message);
        failed = message.isError === true || details?.ok !== true;
      } else if (message.toolName === "edit" && !message.isError) kind = "edit";
      else if (message.isError) kind = "failure";

      if (kind) {
        important.push({
          kind,
          index,
          lines,
          ...(failed === undefined ? {} : { verificationFailed: failed }),
        });
      } else {
        ordinary.push(...lines);
      }
      continue;
    }
    if (message.role === "user" && message !== firstUser) {
      const text = compactSnippet(textOf(message), 280);
      if (text) ordinary.push(`- User: ${text}`);
    } else if (message.role === "assistant" && toolCalls(message).length === 0) {
      const text = compactSnippet(textOf(message), 220);
      if (text) ordinary.push(`- Assistant: ${text}`);
    }
  }
  return { goal, important, tail: ordinary.slice(-HISTORICAL_TAIL) };
}

function summaryFor(messages: readonly Message[], maxChars = SUMMARY_CHARS, interruptions = 0, orphans = 0): Message | undefined {
  const header = [
    "[Earlier session context compacted]",
    "Historical file observations may be stale. Re-read relevant workspace files before editing.",
  ];
  const events = summaryEvents(messages);
  const sections: string[][] = [];
  if (events.goal.length) sections.push(["", "Goal:", ...events.goal]);
  const importantLines = prioritizedImportantEvents(events.important).flatMap((event) => event.lines);
  const important = [
    ...importantLines,
    ...(interruptions ? ["- Previous tool execution was interrupted before all tool calls completed."] : []),
    ...(orphans ? ["- An unmatched historical tool result was omitted."] : []),
  ];
  if (important.length) sections.push(["", "Important state:", ...important]);
  if (events.tail.length) sections.push(["", "Recent historical state:", ...events.tail]);

  let content = header.join("\n");
  for (const section of sections) {
    for (const line of section) {
      if (`${content}\n${line}`.length > maxChars) break;
      content += `\n${line}`;
    }
  }
  if (content.length < header[0]!.length || maxChars < 80) return undefined;
  return { role: "user", content: content.slice(0, maxChars), timestamp: 0 };
}

function compactRecord(value: unknown): Record<string, unknown> | undefined {
  const record = objectOf(value);
  return record && !Array.isArray(value) ? record : undefined;
}

function boundedNumber(value: unknown): number | null | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : value === null
      ? null
      : undefined;
}

function boundedBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function putIfDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

function compactBashDetails(value: unknown): Record<string, unknown> | undefined {
  const source = compactRecord(value);
  if (!source) return undefined;
  const result: Record<string, unknown> = {};
  putIfDefined(result, "exitCode", boundedNumber(source.exitCode));
  for (const key of ["stdoutTruncated", "stderrTruncated", "timedOut", "aborted"] as const) {
    putIfDefined(result, key, boundedBoolean(source[key]));
  }
  putIfDefined(result, "cwd", safeString(source.cwd, 160));
  return Object.keys(result).length ? result : undefined;
}

function compactReadDetails(value: unknown): Record<string, unknown> | undefined {
  const source = compactRecord(value);
  if (!source) return undefined;
  const result: Record<string, unknown> = {};
  putIfDefined(result, "path", safeString(source.path, 240));
  putIfDefined(result, "bytes", boundedNumber(source.bytes));
  putIfDefined(result, "truncated", boundedBoolean(source.truncated));
  return Object.keys(result).length ? result : undefined;
}

function compactEditDetails(value: unknown): Record<string, unknown> | undefined {
  const source = compactRecord(value);
  if (!source) return undefined;
  const result: Record<string, unknown> = {};
  putIfDefined(result, "path", safeString(source.path, 240));
  putIfDefined(result, "created", boundedBoolean(source.created));
  return Object.keys(result).length ? result : undefined;
}

function compactDelegateEntry(value: unknown): Record<string, unknown> | undefined {
  const source = compactRecord(value);
  if (!source) return undefined;
  const result: Record<string, unknown> = {};
  putIfDefined(result, "status", safeString(source.status, 48));
  putIfDefined(result, "summary", safeString(source.summary, PROVIDER_DETAIL_STRING_LIMIT));
  putIfDefined(result, "filesChanged", stringList(source.filesChanged, MAX_FILES));
  putIfDefined(result, "sessionId", safeString(source.sessionId, 128));
  putIfDefined(result, "detail", safeString(source.detail, PROVIDER_DETAIL_STRING_LIMIT));
  putIfDefined(result, "error", safeString(source.error, PROVIDER_DETAIL_STRING_LIMIT));
  if (Array.isArray(source.verification)) {
    const verification = source.verification.slice(0, MAX_VERIFICATIONS).flatMap((raw) => {
      const entry = compactRecord(raw);
      if (!entry) return [];
      const compact: Record<string, unknown> = {};
      putIfDefined(compact, "command", safeString(entry.command, 160));
      putIfDefined(compact, "status", safeString(entry.status, 48));
      putIfDefined(compact, "summary", safeString(entry.summary, PROVIDER_DETAIL_STRING_LIMIT));
      return Object.keys(compact).length ? [compact] : [];
    });
    if (verification.length) result.verification = verification;
  }
  return Object.keys(result).length ? result : undefined;
}

function compactDelegateDetails(value: unknown): unknown {
  if (Array.isArray(value)) {
    const results = value.slice(0, 3).flatMap((entry) => {
      const compact = compactDelegateEntry(entry);
      return compact ? [compact] : [];
    });
    return results.length ? results : undefined;
  }
  const source = compactRecord(value);
  if (!source) return undefined;
  if (Array.isArray(source.results)) {
    const results = source.results.slice(0, 3).flatMap((entry) => {
      const compact = compactDelegateEntry(entry);
      return compact ? [compact] : [];
    });
    return results.length ? results : undefined;
  }
  return compactDelegateEntry(source);
}

function compactVerificationDetails(value: unknown): Record<string, unknown> | undefined {
  const source = compactRecord(value);
  if (!source) return undefined;
  const result: Record<string, unknown> = {};
  putIfDefined(result, "action", safeString(source.action, 80));
  putIfDefined(result, "cwd", safeString(source.cwd, 160));
  putIfDefined(result, "ok", boundedBoolean(source.ok));
  putIfDefined(result, "error", safeString(source.error, PROVIDER_DETAIL_STRING_LIMIT));
  if (Array.isArray(source.results)) {
    const results = source.results.slice(0, MAX_VERIFICATIONS).flatMap((raw) => {
      const entry = compactRecord(raw);
      if (!entry) return [];
      const compact: Record<string, unknown> = {};
      putIfDefined(compact, "command", safeString(entry.command, 180));
      putIfDefined(compact, "status", safeString(entry.status, 48));
      putIfDefined(compact, "exitCode", boundedNumber(entry.exitCode));
      putIfDefined(compact, "ok", boundedBoolean(entry.ok));
      putIfDefined(compact, "timedOut", boundedBoolean(entry.timedOut));
      putIfDefined(compact, "stdoutTruncated", boundedBoolean(entry.stdoutTruncated));
      putIfDefined(compact, "stderrTruncated", boundedBoolean(entry.stderrTruncated));
      if (entry.ok !== true) {
        putIfDefined(
          compact,
          "summary",
          safeString(entry.summary, PROVIDER_DETAIL_STRING_LIMIT)
            ?? safeString(entry.stderr, PROVIDER_DETAIL_STRING_LIMIT)
            ?? safeString(entry.stdout, PROVIDER_DETAIL_STRING_LIMIT),
        );
      }
      return Object.keys(compact).length ? [compact] : [];
    });
    if (results.length) result.results = results;
  }
  return Object.keys(result).length ? result : undefined;
}

function compactSearchDetails(name: string, value: unknown): Record<string, unknown> | undefined {
  const source = compactRecord(value);
  if (!source) return undefined;
  const result: Record<string, unknown> = {};
  putIfDefined(result, name === "memory_search" ? "scope" : "role", safeString(source[name === "memory_search" ? "scope" : "role"], 48));
  putIfDefined(result, "count", boundedNumber(source.count));
  if (Array.isArray(source.matches)) {
    const matches = source.matches.slice(0, MAX_SEARCH_MATCHES).flatMap((raw) => {
      const entry = compactRecord(raw);
      if (!entry) return [];
      const compact: Record<string, unknown> = {};
      for (const key of ["id", "scope", "role", "sessionId"] as const) {
        putIfDefined(compact, key, safeString(entry[key], PROVIDER_DETAIL_MATCH_LIMIT));
      }
      putIfDefined(compact, "timestamp", boundedNumber(entry.timestamp));
      putIfDefined(compact, "score", boundedNumber(entry.score));
      putIfDefined(compact, "snippet", safeString(entry.snippet, PROVIDER_DETAIL_MATCH_LIMIT));
      if (Array.isArray(entry.snippets)) {
        const snippets = entry.snippets.slice(0, MAX_SEARCH_MATCHES).flatMap((snippet) => {
          const compactSnippetValue = safeString(snippet, PROVIDER_DETAIL_MATCH_LIMIT);
          return compactSnippetValue ? [compactSnippetValue] : [];
        });
        if (snippets.length) compact.snippets = snippets;
      }
      return Object.keys(compact).length ? [compact] : [];
    });
    if (matches.length) result.matches = matches;
  }
  return Object.keys(result).length ? result : undefined;
}

/** Whitelist compact runtime metadata for provider context; unknown details are omitted. */
function compactToolResultDetails(name: string, value: unknown): unknown {
  if (name === "bash") return compactBashDetails(value);
  if (name === "read") return compactReadDetails(value);
  if (name === "edit") return compactEditDetails(value);
  if (name === "delegate") return compactDelegateDetails(value);
  if (name === "verification") return compactVerificationDetails(value);
  if (name === "memory_search" || name === "session_search") return compactSearchDetails(name, value);
  return undefined;
}

function truncateRecentToolResult(message: Message, chars: number): Message {
  if (message.role !== "toolResult") return message;
  const text = textOf(message);
  const half = Math.max(1, Math.floor((chars - 100) / 2));
  const content = text.length <= chars
    ? message.content
    : [{ type: "text" as const, text: `${text.slice(0, half)}\n… [tool result truncated, ${text.length} chars total] …\n${text.slice(-half)}` }];
  const details = compactToolResultDetails(message.toolName, message.details);
  const { details: _details, ...withoutDetails } = message;
  return {
    ...withoutDetails,
    content,
    ...(details === undefined ? {} : { details }),
  };
}

function reduceToolResults(messages: readonly Message[], availableTokens: number): Message[] {
  let context = messages.map((message) => truncateRecentToolResult(message, RECENT_RESULT_CHARS));
  let chars = RECENT_RESULT_CHARS;
  while (estimateMessagesTokens(context) > availableTokens && chars > MIN_RESULT_CHARS) {
    chars = Math.max(MIN_RESULT_CHARS, Math.floor(chars / 2));
    context = context.map((message) => truncateRecentToolResult(message, chars));
  }
  return context;
}

function result(messages: Message[], compacted: boolean, before: number, usableTokens: number, systemTokens: number, originalMessages: number): CompactedContext {
  const after = estimateMessagesTokens(messages) + systemTokens;
  if (after > usableTokens) throw new ContextBudgetExceededError(after, usableTokens);
  if (!validateContextToolIntegrity(messages)) throw new Error("Compacted provider context has invalid tool-call/result structure");
  return {
    messages,
    compacted,
    estimatedTokens: after,
    usableTokens,
    diagnostics: {
      originalMessages,
      contextMessages: messages.length,
      estimatedTokensBefore: before,
      estimatedTokensAfter: after,
      compacted,
    },
  };
}

/** Build a bounded, provider-only view without altering the append-only session. */
export function buildContext(messages: readonly Message[], budget: ContextBudget): CompactedContext {
  const usableTokens = usableContextTokens(budget);
  const systemTokens = budget.systemPrompt ? Math.ceil(budget.systemPrompt.length / 4) + MESSAGE_OVERHEAD : 0;
  const availableTokens = usableTokens - systemTokens;
  const messageTokensBefore = estimateMessagesTokens(messages);
  const before = messageTokensBefore + systemTokens;
  const allGroups = groups(messages);
  const structurallyValid = allGroups.every((group) => group.complete && !group.orphan);

  if (availableTokens < 0) throw new ContextBudgetExceededError(systemTokens, usableTokens);
  if (messageTokensBefore <= availableTokens && structurallyValid) {
    return result([...messages], false, before, usableTokens, systemTokens, messages.length);
  }
  if (allGroups.length === 0) return result([], before > usableTokens, before, usableTokens, systemTokens, messages.length);

  const newest = allGroups.at(-1)!;
  let newestMessages = reduceToolResults(newest.messages, availableTokens);
  const newestTokens = estimateMessagesTokens(newestMessages);
  if (newestTokens > availableTokens) throw new ContextBudgetExceededError(newestTokens + systemTokens, usableTokens);

  const recent: MessageGroup[] = [{ ...newest, messages: newestMessages }];
  let recentTokens = newestTokens;
  const recentLimit = allGroups.length > 1
    ? Math.max(newestTokens, availableTokens - 512)
    : availableTokens;
  for (let index = allGroups.length - 2; index >= 0; index -= 1) {
    const group = allGroups[index]!;
    const reduced = reduceToolResults(group.messages, availableTokens - recentTokens);
    const tokens = estimateMessagesTokens(reduced);
    if (recentTokens + tokens > recentLimit) break;
    recent.unshift({ ...group, messages: reduced });
    recentTokens += tokens;
  }

  const firstRecent = recent[0]!.start;
  const oldGroups = allGroups.filter((group) => group.end <= firstRecent);
  const oldMessages = messages.slice(0, firstRecent);
  const retained = recent.flatMap((group) => group.messages);
  const summaryBudgetTokens = availableTokens - estimateMessagesTokens(retained);
  let context = retained;
  if (oldMessages.length > 0 && summaryBudgetTokens > MESSAGE_OVERHEAD + 20) {
    const summary = summaryFor(
      oldMessages,
      Math.min(SUMMARY_CHARS, Math.max(80, (summaryBudgetTokens - MESSAGE_OVERHEAD) * 4)),
      oldGroups.filter((group) => group.interrupted).length,
      oldGroups.filter((group) => group.orphan).length,
    );
    if (summary) context = [summary, ...retained];
    while (estimateMessagesTokens(context) > availableTokens && context[0] === summary) {
      const current = textOf(context[0]!);
      if (current.length <= 100) {
        context = retained;
        break;
      }
      context[0] = { role: "user", content: current.slice(0, current.length - 64), timestamp: 0 };
    }
  }

  return result(context, true, before, usableTokens, systemTokens, messages.length);
}
