import type { AssistantMessage, Message, ToolCall } from "@mariozechner/pi-ai";
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
  const direct = objectOf((message as Message & { details?: unknown }).details);
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

function summaryEvents(messages: readonly Message[]): { goal: string[]; important: string[]; tail: string[] } {
  const goal: string[] = [];
  const important: string[] = [];
  const ordinary: string[] = [];
  const firstUser = messages.find((message) => message.role === "user");
  const goalText = firstUser ? compactSnippet(textOf(firstUser), 500) : "";
  if (goalText) goal.push(`- ${goalText}`);

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "toolResult") {
      const lines = toolSummary(messages, index);
      if (
        message.toolName === "delegate"
        || message.toolName === "verification"
        || message.toolName === "edit"
        || message.isError
      ) important.push(...lines);
      else ordinary.push(...lines);
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
  const important = [...(interruptions ? ["- Previous tool execution was interrupted before all tool calls completed."] : []), ...(orphans ? ["- An unmatched historical tool result was omitted."] : []), ...events.important];
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

function truncateRecentToolResult(message: Message, chars: number): Message {
  if (message.role !== "toolResult") return message;
  const text = textOf(message);
  if (text.length <= chars) return message;
  const half = Math.max(1, Math.floor((chars - 100) / 2));
  return {
    ...message,
    content: [{ type: "text", text: `${text.slice(0, half)}\n… [tool result truncated, ${text.length} chars total] …\n${text.slice(-half)}` }],
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
