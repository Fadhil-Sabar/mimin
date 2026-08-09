import {
  truncateToWidth,
  type Component,
} from "@mariozechner/pi-tui";
import { sanitizeText } from "./header.js";
import { cyan, dim, green, yellow } from "./theme.js";

export type SidekickCardStatus =
  | "running"
  | "complete"
  | "partial"
  | "blocked"
  | "needs_decision";

export type LocalSidekickActivity =
  | { type: "sidekick_started"; sessionId: string; timestamp?: number }
  | {
      type: "tool_started";
      sessionId: string;
      tool: string;
      timestamp?: number;
      /** Whitelisted safe detail parsed from toolCall arguments (path/command). */
      detail?: string;
    }
  | {
      type: "tool_finished";
      sessionId: string;
      tool: string;
      ok: boolean;
      path?: string;
      timestamp?: number;
      /** Whitelisted safe detail parsed from toolCall arguments (path/command). */
      detail?: string;
    }
  | {
      type: "sidekick_finished";
      sessionId: string;
      status: Exclude<SidekickCardStatus, "running">;
      timestamp?: number;
    };

export interface LocalSidekickResult {
  status: Exclude<SidekickCardStatus, "running">;
  summary: string;
  sessionId: string;
  /** Presentation metadata: changed files surfaced from the real SidekickResult. */
  filesChanged?: string[];
  /** Presentation metadata: verification entries surfaced from the real SidekickResult. */
  verification?: { command: string; status: string }[];
}

/** Structural mirror of delegate events; no import from the agent layer is needed. */
export type LocalDelegateEvent =
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
      activity: LocalSidekickActivity;
    }
  | {
      type: "delegation_finished";
      index: number;
      taskCount: number;
      result: LocalSidekickResult;
      /** Presentation metadata: the task title sent to this sidekick. */
      task?: string;
      /** Presentation metadata: the sidekick model id. */
      model?: string;
    };

interface SafeToolActivity {
  tool: string;
  path?: string;
  detail?: string;
  status: "running" | "ok" | "failed";
}

interface SidekickCard {
  index: number;
  taskCount: number;
  sessionId?: string;
  /** Presentation metadata: the sidekick model id (from delegate event). */
  model?: string;
  /** Presentation metadata: the task title sent to this sidekick. */
  task?: string;
  startedAt?: number;
  finishedAt?: number;
  status: SidekickCardStatus;
  summary?: string;
  filesChanged?: string[];
  verification?: { command: string; status: string }[];
  expanded: boolean;
  activities: SafeToolActivity[];
  order: number;
}

/** Number of cards shown when every running card is collapsed. */
export const MAX_VISIBLE_RUNNING_CARDS = 5;

function compact(value: unknown, limit: number): string {
  const text = sanitizeText(value, false).trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function status(value: unknown): Exclude<SidekickCardStatus, "running"> {
  return value === "complete" ||
      value === "partial" ||
      value === "blocked" ||
      value === "needs_decision"
    ? value
    : "blocked";
}

function normalizePath(value: unknown, workspace: string): string | undefined {
  let candidate = compact(value, 240).replace(/\\/g, "/");
  if (!candidate) return undefined;
  const root = sanitizeText(workspace, false).replace(/\\/g, "/").replace(/\/+$/, "");
  const absolute = candidate.startsWith("/") || /^[A-Za-z]:\//.test(candidate);
  if (absolute) {
    if (!root || (candidate !== root && !candidate.startsWith(`${root}/`))) {
      return undefined;
    }
    candidate = candidate.slice(root.length).replace(/^\/+/, "");
  }
  const parts = candidate.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) return undefined;
  return parts.join("/") || ".";
}

/** Privacy-preserving sidekick cards. Only whitelisted lifecycle fields are retained. */
export class SidekickActivity implements Component {
  private readonly cards: SidekickCard[] = [];
  private readonly latestByIndex = new Map<number, SidekickCard>();
  private readonly sessions = new Map<string, SidekickCard>();
  private order = 0;

  constructor(
    private readonly workspace = "",
    private readonly now: () => number = () => Date.now(),
  ) {}

  invalidate(): void {
    // Rendering is derived directly from the small whitelisted card state.
  }

  apply(event: LocalDelegateEvent): void {
    if (!Number.isSafeInteger(event.index) || event.index < 0) return;
    if (event.type === "delegation_started") {
      this.start(event.index, event.taskCount, event.task, event.model);
      return;
    }
    if (event.type === "sidekick_activity") {
      this.activity(event.index, event.taskCount, event.activity);
      return;
    }
    this.finish(event.index, event.taskCount, event.result, event.task, event.model);
  }

  start(index: number, taskCount = 1, task?: string, model?: string): void {
    // Delegation indices restart for later manager tool calls. Keep completed
    // session cards and make the newest card the index target.
    const current = this.latestByIndex.get(index);
    if (current?.status === "running" && !current.sessionId && current.activities.length === 0) {
      current.taskCount = Math.max(1, taskCount);
      if (task !== undefined) current.task = task;
      if (model !== undefined) current.model = model;
      return;
    }
    this.create(index, taskCount, task, model);
  }

  activity(index: number, taskCount: number, event: LocalSidekickActivity): void {
    const card = this.latestByIndex.get(index) ?? this.create(index, taskCount);
    const sessionId = compact(event.sessionId, 80);
    if (sessionId) {
      if (card.sessionId) this.sessions.delete(card.sessionId);
      card.sessionId = sessionId;
      this.sessions.set(sessionId, card);
    }
    if (event.type === "sidekick_started") {
      card.status = "running";
      if (card.startedAt === undefined && typeof event.timestamp === "number") {
        card.startedAt = event.timestamp;
      }
    } else if (event.type === "tool_started") {
      card.activities.push({
        tool: compact(event.tool, 48) || "tool",
        detail: event.detail !== undefined ? compact(event.detail, 48) : undefined,
        status: "running",
      });
    } else if (event.type === "tool_finished") {
      const tool = compact(event.tool, 48) || "tool";
      const pending = [...card.activities]
        .reverse()
        .find((item) => item.tool === tool && item.status === "running");
      const update: SafeToolActivity = pending ?? { tool, status: "running" };
      update.status = event.ok ? "ok" : "failed";
      if (event.detail !== undefined) update.detail = compact(event.detail, 48);
      const path = normalizePath(event.path, this.workspace);
      if (path) update.path = path;
      if (!pending) card.activities.push(update);
    } else {
      card.status = status(event.status);
    }
  }

  finish(
    index: number,
    taskCount: number,
    result: LocalSidekickResult,
    task?: string,
    model?: string,
  ): void {
    const card = this.latestByIndex.get(index) ?? this.create(index, taskCount);
    card.status = status(result.status);
    card.summary = compact(result.summary, 180);
    if (task !== undefined) card.task = task;
    if (model !== undefined) card.model = model;
    card.finishedAt = this.now();
    if (result.filesChanged !== undefined) {
      card.filesChanged = result.filesChanged.slice(0, 100).map((path) => compact(path, 240));
    }
    if (result.verification !== undefined) {
      card.verification = result.verification.slice(0, 100).map((entry) => ({
        command: compact(entry.command, 120),
        status: compact(entry.status, 24),
      }));
    }
    const sessionId = compact(result.sessionId, 80);
    if (sessionId) {
      if (card.sessionId) this.sessions.delete(card.sessionId);
      card.sessionId = sessionId;
      this.sessions.set(sessionId, card);
    }
  }

  toggle(identifier: number | string): boolean {
    const card = typeof identifier === "number"
      ? this.latestByIndex.get(identifier)
      : this.sessions.get(compact(identifier, 80));
    if (!card) return false;
    card.expanded = !card.expanded;
    return card.expanded;
  }

  /** Number of cards currently in the running state (for the footer). */
  workingCount(): number {
    return this.cards.reduce(
      (count, card) => count + (card.status === "running" ? 1 : 0),
      0,
    );
  }

  render(width: number): string[] {
    if (width <= 0) return this.cards.length > 0 ? [""] : [];
    const now = this.now();
    const ordered = [...this.cards].sort((a, b) => a.order - b.order);
    const lines: string[] = [];
    let rendered = 0;
    for (const card of ordered) {
      if (card.status === "running" && rendered >= MAX_VISIBLE_RUNNING_CARDS) break;
      lines.push(...renderCard(card, width, now));
      rendered += 1;
    }
    const queued = ordered.length - rendered;
    const badge = queuedBadge(queued);
    if (badge) lines.push(badge);
    return lines;
  }

  private create(index: number, taskCount: number, task?: string, model?: string): SidekickCard {
    const card: SidekickCard = {
      index,
      taskCount: Math.max(1, taskCount),
      status: "running",
      expanded: false,
      activities: [],
      order: ++this.order,
    };
    if (task !== undefined) card.task = task;
    if (model !== undefined) card.model = model;
    this.cards.push(card);
    this.latestByIndex.set(index, card);
    return card;
  }
}

function elapsedSeconds(card: SidekickCard, now: number): number | undefined {
  const end = card.finishedAt ?? (card.status === "running" ? now : undefined);
  const start = card.startedAt;
  if (start === undefined || end === undefined || end < start) return undefined;
  return Math.max(0, Math.round((end - start) / 1000));
}

function durationText(seconds: number | undefined): string {
  if (seconds === undefined) return "";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

/** Elapsed label while running (no start timestamp yet: "…"). */
function liveElapsed(card: SidekickCard, now: number): string {
  if (card.startedAt === undefined) return "…";
  return durationText(elapsedSeconds(card, now));
}

/** Compact "waiting" badge for sidekicks queued behind the running ones. */
function queuedBadge(count: number): string {
  return count > 0 ? dim(`┌ ${count} waiting`) : "";
}

/** Live activity label while a sidekick is running. */
function liveActivity(card: SidekickCard): string | undefined {
  if (card.status !== "running") return undefined;
  const current = card.activities.find((item) => item.status === "running");
  if (!current) return undefined;
  const detail = current.detail ? ` ${current.detail}` : "";
  if (current.tool === "edit") return `Editing${detail}`;
  if (current.tool === "read") return `Reading${detail}`;
  if (current.tool === "bash" || current.tool === "verification") return `Running${detail}`;
  return (current.tool[0]?.toUpperCase() + current.tool.slice(1)) + detail;
}

/** Concise metrics row for a completed card, derived from whitelisted fields. */
function metricsText(card: SidekickCard): string | undefined {
  const parts: string[] = [];
  const files = card.filesChanged?.length ?? 0;
  if (files > 0) parts.push(`${files} file${files === 1 ? "" : "s"} changed`);
  const checks = card.verification?.length ?? 0;
  const passed = card.verification?.filter((entry) => entry.status === "passed").length ?? 0;
  if (checks > 0) parts.push(`${passed} check${passed === 1 ? "" : "s"} passed`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** Summary row for a completed card even when collapsed (a "docked" status). */
function summaryText(card: SidekickCard, now: number): string {
  const elapsed = elapsedSeconds(card, now);
  const duration = elapsed !== undefined ? ` · ${durationText(elapsed)}` : "";
  const metrics = metricsText(card);
  if (metrics) return `${summaryStatus(card)}${duration} · ${metrics}`;
  return `${summaryStatus(card)}${duration}`;
}

/** Colored docked status label ("Complete" green, "Failed" yellow, others dim). */
function summaryStatus(card: SidekickCard): string {
  if (card.status === "complete") return green("Complete");
  if (card.status === "partial") return dim("Partial");
  if (card.status === "needs_decision") return yellow("Needs decision");
  return yellow("Failed");
}

function statusVerb(card: SidekickCard): string {
  if (card.status === "running") return cyan("Working");
  if (card.status === "complete") return green("Complete");
  if (card.status === "partial") return dim("Partial");
  if (card.status === "needs_decision") return yellow("Needs decision");
  return yellow("Failed");
}

function renderCard(card: SidekickCard, width: number, now: number): string[] {
  const inner = Math.max(1, width - 2);
  const label = card.taskCount > 1 ? `Sidekick #${card.index + 1}` : "Sidekick";
  const header = card.model
    ? `${label} · ${dim(compact(card.model, 40))}`
    : label;
  const lines: string[] = [];
  lines.push(`${dim("┌")} ${header}`);
  if (card.task) lines.push(`${dim("│")} ${compact(card.task, inner - 2)}`);
  if (card.status === "running") {
    const activity = liveActivity(card);
    const elapsed = dim(liveElapsed(card, now));
    lines.push(`${dim("│")} ${green("●")} ${activity ?? cyan("Running")} · ${elapsed}`);
  } else {
    const mark = card.status === "complete" ? green("✓") : yellow("✗");
    lines.push(`${dim("│")} ${mark} ${summaryText(card, now)}`);
    if (card.summary) lines.push(`${dim("│")} ${compact(card.summary, inner - 2)}`);
    if (card.expanded) {
      for (const file of card.filesChanged ?? []) {
        lines.push(`${dim("│")}   ${file}`);
      }
      for (const entry of card.verification ?? []) {
        const status = entry.status === "passed" ? green(entry.status) : yellow(entry.status);
        lines.push(`${dim("│")}   ${entry.command} [${status}]`);
      }
      for (const activity of card.activities) {
        const path = activity.path ? ` · ${activity.path}` : "";
        lines.push(`${dim("│")}   ${activity.tool}${path}`);
      }
    }
  }
  const footer = card.taskCount > 1 ? `${card.index + 1}/${card.taskCount}` : "";
  lines.push(`${dim("└")} ${footer}`.trimEnd());
  // Truncate each line to the available width and keep box borders.
  return lines.map((line) => truncateToWidth(line, width));
}
