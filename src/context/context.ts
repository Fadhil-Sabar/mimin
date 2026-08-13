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

const MESSAGE_OVERHEAD = 8;
const LARGE_RESULT_CHARS = 4_000;
const RECENT_RESULT_CHARS = 3_000;
const SUMMARY_CHARS = 6_000;

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

interface MessageGroup { messages: Message[]; start: number; end: number }

/** Keep each assistant tool-call response with all of its corresponding results. */
function groups(messages: readonly Message[]): MessageGroup[] {
  const result: MessageGroup[] = [];
  for (let index = 0; index < messages.length;) {
    const message = messages[index]!;
    const calls = toolCalls(message);
    if (calls.length === 0) {
      result.push({ messages: [message], start: index, end: index + 1 });
      index += 1;
      continue;
    }
    const ids = new Set(calls.map((call) => call.id));
    let end = index + 1;
    while (end < messages.length) {
      const candidate = messages[end]!;
      if (candidate.role !== "toolResult" || !ids.has(candidate.toolCallId)) break;
      end += 1;
    }
    result.push({ messages: messages.slice(index, end), start: index, end });
    index = end;
  }
  return result;
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

function toolDescription(message: Message): string {
  if (message.role !== "assistant") return "";
  const calls = toolCalls(message);
  if (calls.length === 0) return "";
  return calls.map((call) => `${call.name}${call.arguments && Object.keys(call.arguments).length ? " (called)" : ""}`).join(", ");
}

function compactSnippet(value: string, limit = 400): string {
  const normalized = redactSecrets(value).content.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

/** Local summary that intentionally uses metadata instead of historical tool output. */
function summaryFor(messages: readonly Message[], maxChars = SUMMARY_CHARS): Message {
  const lines = [
    "[Earlier session context compacted]",
    "Historical file observations may be stale. Re-read relevant workspace files before editing.",
  ];
  for (const message of messages) {
    if (message.role === "user") {
      const text = compactSnippet(textOf(message));
      if (text) lines.push(`- User: ${text}`);
    } else if (message.role === "assistant") {
      const tools = toolDescription(message);
      const text = compactSnippet(textOf(message));
      if (tools) lines.push(`- Assistant used: ${tools}.`);
      if (text) lines.push(`- Assistant: ${text}`);
    } else if (message.role === "toolResult") {
      const output = textOf(message);
      if (output.length > LARGE_RESULT_CHARS) {
        lines.push(`- Large historical tool result omitted: ${message.toolName ?? "result"}, ${output.length} chars.`);
      } else if (message.isError) {
        const failure = compactSnippet(output, 240);
        lines.push(`- Tool ${message.toolName ?? "result"} failed${failure ? `: ${failure}` : "."}`);
      } else {
        lines.push(`- Tool ${message.toolName ?? "result"}: completed.`);
      }
    }
    if (lines.join("\n").length >= maxChars) break;
  }
  const content = lines.join("\n").slice(0, Math.max(80, maxChars));
  return { role: "user", content, timestamp: 0 };
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

/** Build a bounded, provider-only view without altering the append-only session. */
export function buildContext(messages: readonly Message[], budget: ContextBudget): CompactedContext {
  const usableTokens = usableContextTokens(budget);
  const systemTokens = budget.systemPrompt ? Math.ceil(budget.systemPrompt.length / 4) + MESSAGE_OVERHEAD : 0;
  const availableTokens = Math.max(1, usableTokens - systemTokens);
  const messageTokensBefore = estimateMessagesTokens(messages);
  const before = messageTokensBefore + systemTokens;
  if (messageTokensBefore <= availableTokens) {
    return { messages: [...messages], compacted: false, estimatedTokens: before, usableTokens, diagnostics: { originalMessages: messages.length, contextMessages: messages.length, estimatedTokensBefore: before, estimatedTokensAfter: before, compacted: false } };
  }

  const allGroups = groups(messages);
  const recent: MessageGroup[] = [];
  let recentTokens = 0;
  // Start at the end, retaining complete tool-call/result groups.
  for (let index = allGroups.length - 1; index >= 0; index -= 1) {
    const group = allGroups[index]!;
    const tokens = estimateMessagesTokens(group.messages);
    if (recent.length > 0 && recentTokens + tokens > Math.max(1, availableTokens - 512)) break;
    recent.unshift(group);
    recentTokens += tokens;
  }
  if (recent.length === 0 && allGroups.length > 0) recent.push(allGroups.at(-1)!);
  const firstRecent = recent[0]?.start ?? messages.length;
  const old = messages.slice(0, firstRecent);
  const retained = recent.flatMap((group) => group.messages);
  // Reserve only the remaining space for a compact synthetic summary.
  const summaryChars = Math.max(160, (availableTokens - estimateMessagesTokens(retained) - MESSAGE_OVERHEAD) * 4);
  let context = old.length > 0 ? [summaryFor(old, summaryChars), ...retained] : retained;

  // Large recent tool output is the only verbatim content we truncate. This
  // retains call/result structure and preserves the newest user message exactly.
  context = context.map((message) => truncateRecentToolResult(message, RECENT_RESULT_CHARS));
  while (estimateMessagesTokens(context) > availableTokens) {
    const index = context.findIndex((message) => message.role === "toolResult" && textOf(message).length > 256);
    if (index < 0) break;
    context[index] = truncateRecentToolResult(context[index]!, 256);
  }
  // If a summary is still too large, reduce it before ever sacrificing a
  // structural tool group or the newest user message.
  if (context[0]?.role === "user" && textOf(context[0]).startsWith("[Earlier session context compacted]")) {
    const remaining = Math.max(80, (availableTokens - estimateMessagesTokens(context.slice(1)) - MESSAGE_OVERHEAD) * 4);
    context[0] = summaryFor(old, remaining);
    // JSON/message overhead is deliberately accounted for by the estimator,
    // so make the final boundary exact rather than relying on char arithmetic.
    while (estimateMessagesTokens(context) > availableTokens && textOf(context[0]).length > 60) {
      const current = textOf(context[0]);
      context[0] = {
        role: "user",
        content: current.length <= 160
          ? "[Earlier session context compacted]\n[summary shortened]"
          : `${current.slice(0, current.length - 64)}\n[summary shortened]`,
        timestamp: 0,
      };
    }
  }
  const after = estimateMessagesTokens(context) + systemTokens;
  return { messages: context, compacted: true, estimatedTokens: after, usableTokens, diagnostics: { originalMessages: messages.length, contextMessages: context.length, estimatedTokensBefore: before, estimatedTokensAfter: after, compacted: true } };
}
