import {
  truncateToWidth,
  type Component,
} from "@mariozechner/pi-tui";
import { sanitizeText } from "./header.js";

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
    }
  | {
      type: "tool_finished";
      sessionId: string;
      tool: string;
      ok: boolean;
      path?: string;
      timestamp?: number;
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
}

/** Structural mirror of delegate events; no import from the agent layer is needed. */
export type LocalDelegateEvent =
  | { type: "delegation_started"; index: number; taskCount: number }
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
    };

interface SafeToolActivity {
  tool: string;
  path?: string;
  status: "running" | "ok" | "failed";
}

interface SidekickCard {
  index: number;
  taskCount: number;
  sessionId?: string;
  status: SidekickCardStatus;
  summary?: string;
  expanded: boolean;
  activities: SafeToolActivity[];
  order: number;
}

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

  constructor(private readonly workspace = "") {}

  invalidate(): void {
    // Rendering is derived directly from the small whitelisted card state.
  }

  apply(event: LocalDelegateEvent): void {
    if (!Number.isSafeInteger(event.index) || event.index < 0) return;
    if (event.type === "delegation_started") {
      this.start(event.index, event.taskCount);
      return;
    }
    if (event.type === "sidekick_activity") {
      this.activity(event.index, event.taskCount, event.activity);
      return;
    }
    this.finish(event.index, event.taskCount, event.result);
  }

  start(index: number, taskCount = 1): void {
    // Delegation indices restart for later manager tool calls. Keep completed
    // session cards and make the newest card the index target.
    const current = this.latestByIndex.get(index);
    if (current?.status === "running" && !current.sessionId && current.activities.length === 0) {
      current.taskCount = Math.max(1, taskCount);
      return;
    }
    this.create(index, taskCount);
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
    } else if (event.type === "tool_started") {
      card.activities.push({
        tool: compact(event.tool, 48) || "tool",
        status: "running",
      });
    } else if (event.type === "tool_finished") {
      const tool = compact(event.tool, 48) || "tool";
      const pending = [...card.activities]
        .reverse()
        .find((item) => item.tool === tool && item.status === "running");
      const update: SafeToolActivity = pending ?? { tool, status: "running" };
      update.status = event.ok ? "ok" : "failed";
      const path = normalizePath(event.path, this.workspace);
      if (path) update.path = path;
      if (!pending) card.activities.push(update);
    } else {
      card.status = status(event.status);
    }
  }

  finish(index: number, taskCount: number, result: LocalSidekickResult): void {
    const card = this.latestByIndex.get(index) ?? this.create(index, taskCount);
    card.status = status(result.status);
    card.summary = compact(result.summary, 180);
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

  render(width: number): string[] {
    if (width <= 0) return this.cards.length > 0 ? [""] : [];
    const lines: string[] = [];
    const ordered = [...this.cards].sort((a, b) => a.order - b.order);
    for (const card of ordered) {
      const marker = card.expanded ? "-" : "+";
      const number = card.taskCount > 1
        ? `${card.index + 1}/${card.taskCount}`
        : `${card.index + 1}`;
      const session = card.sessionId ? ` ${card.sessionId}` : "";
      const summary = card.summary ? ` - ${card.summary}` : card.status === "running" ? " - working" : "";
      lines.push(truncateToWidth(
        `${marker} Sidekick ${number} [${card.status}]${session}${summary}`,
        width,
      ));
      if (card.expanded) {
        for (const activity of card.activities) {
          const path = activity.path ? ` | ${activity.path}` : "";
          lines.push(truncateToWidth(
            `  ${activity.tool}${path} | ${activity.status}`,
            width,
          ));
        }
      }
    }
    return lines;
  }

  private create(index: number, taskCount: number): SidekickCard {
    const card: SidekickCard = {
      index,
      taskCount: Math.max(1, taskCount),
      status: "running",
      expanded: false,
      activities: [],
      order: ++this.order,
    };
    this.cards.push(card);
    this.latestByIndex.set(index, card);
    return card;
  }
}
