import {
  truncateToWidth,
  type Component,
} from "@mariozechner/pi-tui";
import { sanitizeText } from "./header.js";
import { cyan, dim, green, yellow } from "./theme.js";
import { pulsePhase, spinnerFrame, type AnimationState } from "./animation.js";

export type SidekickCardStatus =
  | "queued"
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
  /** Stable unique card id; survives index reuse. */
  id: string;
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
  animationFrame?: number;
}

/** Number of cards shown when every running card is collapsed. */
export const MAX_VISIBLE_RUNNING_CARDS = 5;

/** Maximum number of activity rows retained per card. */
const MAX_ACTIVITIES_PER_CARD = 3;

const CARD_ID_SEQUENCE = { value: 0 };
/** Stable unique card id; never reused, independent of delegation index. */
function nextCardId(): string {
  CARD_ID_SEQUENCE.value += 1;
  return `card-${CARD_ID_SEQUENCE.value}`;
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
  private readonly byCardId = new Map<string, SidekickCard>();
  private readonly latestByIndex = new Map<number, SidekickCard>();
  private readonly sessions = new Map<string, SidekickCard>();
  private order = 0;

  constructor(
    private readonly workspace = "",
    private readonly now: () => number = () => Date.now(),
    private readonly animation?: AnimationState,
  ) {}

  invalidate(): void {
    // Rendering is derived directly from the small whitelisted card state.
  }

  apply(event: LocalDelegateEvent): string | undefined {
    if (!Number.isSafeInteger(event.index) || event.index < 0) return undefined;
    if (event.type === "delegation_started") {
      return this.start(event.index, event.taskCount, event.task, event.model);
    }
    if (event.type === "sidekick_activity") {
      return this.activity(event.index, event.taskCount, event.activity);
    }
    return this.finish(event.index, event.taskCount, event.result, event.task, event.model);
  }

  /** Render exactly one card by its stable id; undefined when unknown. */
  rendererFor(cardId: string): (width: number) => string[] {
    const card = this.byCardId.get(cardId);
    return (width: number) => {
      if (!card) return [];
      card.animationFrame = this.animation?.frame ?? 0;
      return renderCard(card, width);
    };
  }

  start(index: number, taskCount = 1, task?: string, model?: string): string {
    // Delegation indices restart for later manager tool calls. Keep completed
    // session cards and make the newest card the index target.
    const current = this.latestByIndex.get(index);
    if (
      current &&
      (current.status === "queued" || current.status === "running") &&
      !current.sessionId &&
      current.activities.length === 0
    ) {
      current.taskCount = Math.max(1, taskCount);
      if (task !== undefined) current.task = task;
      if (model !== undefined) current.model = model;
      return current.id;
    }
    return this.create(index, taskCount, task, model).id;
  }

  activity(index: number, taskCount: number, event: LocalSidekickActivity): string {
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
      card.status = "running";
      card.activities.push({
        tool: (compact(event.tool, 48) || "tool").toLowerCase(),
        detail: event.detail !== undefined ? compact(event.detail, 48) : undefined,
        status: "running",
      });
      if (card.activities.length > MAX_ACTIVITIES_PER_CARD) {
        card.activities.splice(0, card.activities.length - MAX_ACTIVITIES_PER_CARD);
      }
    } else if (event.type === "tool_finished") {
      const tool = (compact(event.tool, 48) || "tool").toLowerCase();
      const pending = [...card.activities]
        .reverse()
        .find((item) => item.tool === tool && item.status === "running");
      const update: SafeToolActivity = pending ?? { tool, status: "running" };
      update.status = event.ok ? "ok" : "failed";
      if (event.detail !== undefined) update.detail = compact(event.detail, 48);
      const path = normalizePath(event.path, this.workspace);
      if (path) update.path = path;
      if (!pending) {
        card.activities.push(update);
        if (card.activities.length > MAX_ACTIVITIES_PER_CARD) {
          card.activities.splice(0, card.activities.length - MAX_ACTIVITIES_PER_CARD);
        }
      }
    } else {
      card.status = status(event.status);
    }
    return card.id;
  }

  finish(
    index: number,
    taskCount: number,
    result: LocalSidekickResult,
    task?: string,
    model?: string,
  ): string {
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
    return card.id;
  }

  toggle(identifier: number | string): boolean {
    const card = typeof identifier === "number"
      ? this.latestByIndex.get(identifier)
      : this.sessions.get(compact(identifier, 80));
    if (!card) return false;
    card.expanded = !card.expanded;
    return card.expanded;
  }

  hasActive(): boolean {
    return this.cards.some((card) => card.status === "queued" || card.status === "running");
  }

  /** Number of cards currently in the running state (for the footer). */
  workingCount(): number {
    return this.cards.reduce(
      (count, card) => count + (card.status === "running" ? 1 : 0),
      0,
    );
  }

  /** Size of the active delegation: max taskCount among queued/running cards, 0 when idle. */
  totalCount(): number {
    return this.cards.reduce((max, card) => {
      if (card.status !== "queued" && card.status !== "running") return max;
      return Math.max(max, Math.max(1, card.taskCount));
    }, 0);
  }

  /** Drop every card (session restore). */
  clear(): void {
    this.cards.length = 0;
    this.byCardId.clear();
    this.latestByIndex.clear();
    this.sessions.clear();
    this.order = 0;
  }

  render(width: number): string[] {
    if (width <= 0) return this.cards.length > 0 ? [""] : [];
    const ordered = [...this.cards].sort((a, b) => a.order - b.order);
    for (const card of ordered) card.animationFrame = this.animation?.frame ?? 0;
    const lines: string[] = [];
    let rendered = 0;
    for (const card of ordered) {
      if (card.status === "running" && rendered >= MAX_VISIBLE_RUNNING_CARDS) break;
      lines.push(...renderCard(card, width));
      rendered += 1;
    }
    const queued = ordered.length - rendered;
    const badge = queuedBadge(queued);
    if (badge) lines.push(badge);
    return lines;
  }

  private create(index: number, taskCount: number, task?: string, model?: string): SidekickCard {
    const card: SidekickCard = {
      id: nextCardId(),
      index,
      taskCount: Math.max(1, taskCount),
      status: "queued",
      expanded: false,
      activities: [],
      order: ++this.order,
      animationFrame: this.animation?.frame ?? 0,
    };
    if (task !== undefined) card.task = task;
    if (model !== undefined) card.model = model;
    this.cards.push(card);
    this.byCardId.set(card.id, card);
    this.latestByIndex.set(index, card);
    return card;
  }
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

/** Colored status label; reused for both box header and docked summary. */
function animationFrame(card: SidekickCard): number {
  return card.animationFrame ?? 0;
}

function coloredStatus(card: SidekickCard, frame: number): string {
  // Queued cards pulse by alternating the glyph itself (◌ / ○); the resting
  // phase is dimmed so the alternation reads clearly, not as a color-only.
  if (card.status === "queued") return pulsePhase(frame) === 1 ? "◌ queued" : dim("○ queued");
  if (card.status === "running") return cyan(`${spinnerFrame(frame)} running`);
  if (card.status === "complete") return green("✓ done");
  if (card.status === "partial") return dim("× partial");
  if (card.status === "needs_decision") return yellow("× decision");
  return yellow("× failed");
}

/** Compact "waiting" badge for sidekicks queued behind the running ones. */
function queuedBadge(count: number): string {
  return count > 0 ? dim(`└ ${count} waiting`) : "";
}

/** One compact activity row: plain lowercase "tool path-or-detail". */
function activityRow(activity: SafeToolActivity): string {
  const suffix = activity.path
    ? ` ${activity.path}`
    : activity.detail
      ? ` ${activity.detail}`
      : "";
  return `${activity.tool}${suffix}`;
}

/** Pad a string to exactly `inner` visible columns (right side). */
function padTo(text: string, inner: number): string {
  return `${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))}`;
}

/** Bounded card box; collapses to plain rows when the width is too narrow. */
function renderCard(card: SidekickCard, width: number): string[] {
  const inner = Math.max(1, width - 4);
  const label = `sidekick #${card.index + 1}`;
  const status = coloredStatus(card, animationFrame(card));
  const lines: string[] = [];
  // Narrow mode: no box borders. Preserve the state before task/model detail.
  if (inner < 24) {
    const labelledStatus = `${label} · ${status}`;
    const statusRows = visibleWidth(labelledStatus) <= width
      ? [labelledStatus, compact(card.task, Math.max(1, inner))]
      : [status, label, compact(card.task, Math.max(1, inner))];
    const body = [
      ...statusRows,
      ...(card.status !== "queued" && card.status !== "running" && card.summary
        ? [compact(card.summary, Math.max(1, inner))]
        : []),
      ...card.activities.slice(-MAX_ACTIVITIES_PER_CARD).map(activityRow),
      ...(card.expanded ? expandedRows(card, Math.max(1, inner)) : []),
      "─",
    ];
    return body.map((line) => truncateToWidth(line, width));
  }
  // Normal width: bounded box with a right-aligned status in the header.
  // Template: `┌─ ` (3) + header + ` ─ ` (3) + status + ` ┐` (2) = width.
  // Fixed chrome = 8, so headerBudget = width - 8 - statusLen.
  const statusText = stripAnsi(status);
  const headerBudget = Math.max(1, width - 8 - statusText.length);
  const header = `${label} · ${compact(card.task, Math.max(1, headerBudget - label.length - 3))}`;
  lines.push(`┌─ ${padTo(header, headerBudget)} ─ ${status} ┐`);
  const statusRow = card.status === "queued"
    ? "waiting for turn"
    : card.status === "running"
      ? "running"
      : metricsText(card) ?? "";
  lines.push(`│ ${padTo(statusRow, inner)} │`);
  // Completed/failed cards also surface the safe result summary on one row.
  if (
    card.status !== "queued" &&
    card.status !== "running" &&
    card.summary
  ) {
    lines.push(`│ ${padTo(compact(card.summary, inner), inner)} │`);
  }
  for (const activity of card.activities.slice(-MAX_ACTIVITIES_PER_CARD)) {
    lines.push(`│ ${padTo(activityRow(activity), inner)} │`);
  }
  // Expanded cards surface changed files and verification results, bounded.
  if (card.expanded) {
    for (const row of expandedRows(card, inner)) {
      lines.push(`│ ${padTo(row, inner)} │`);
    }
  }
  lines.push(`└${"─".repeat(inner + 2)}┘`);
  return lines.map((line) => truncateToWidth(line, width));
}

/** Safe detail rows for an expanded card: changed files + verification. */
function expandedRows(card: SidekickCard, limit: number): string[] {
  const rows: string[] = [];
  for (const file of card.filesChanged ?? []) {
    rows.push(compact(file, limit));
  }
  for (const entry of card.verification ?? []) {
    const result = entry.status === "passed" ? green(entry.status) : yellow(entry.status);
    rows.push(`${compact(entry.command, Math.max(1, limit - 3))} [${result}]`);
  }
  return rows;
}

/** Strip ANSI SGR escapes to compute the visible width of a styled string. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/** Visible (ANSI-free) length of a styled string. */
function visibleWidth(text: string): number {
  return stripAnsi(text).length;
}
