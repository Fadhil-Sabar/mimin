import { truncateToWidth, visibleWidth, type Component } from "@mariozechner/pi-tui";
import { cyan, dim } from "./theme.js";

/** Remove terminal controls from text before it reaches a pi-tui component. */
export function sanitizeText(value: unknown, multiline = true): string {
  if (typeof value !== "string") return "";
  let text = value
    .replace(/\r\n?/g, "\n")
    // ANSI SGR and CSI sequences; raw tool/provider errors can carry color.
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\t/g, " ");
  if (!multiline) text = text.replace(/\n+/g, " ");
  return text;
}

export interface HeaderOptions {
  product?: string;
  managerModel: string;
  /** Retained for call-site compatibility; not rendered by the compact header. */
  workspace?: string;
  thinking?: string;
  /** Presentation metadata: the sidekick's model id (from delegate events). */
  sidekickModel?: string;
  /** Presentation metadata: the active manager session id. */
  sessionId?: string;
}

/** Kept for call-site compatibility; the compact header renders no run state. */
export type HeaderRunState = "idle" | "running" | "working";

/** One identity segment with its drop priority (lower disappears first). */
interface Segment {
  priority: number;
  text: string;
}

/** Strip the "manager-"/"sidekick-" role prefix and shorten for the header chip. */
function compactSession(id: string): string {
  const text = sanitizeText(id, false).trim();
  if (!text) return "";
  const stripped = text.replace(/^(manager|sidekick)-/, "");
  return stripped.length <= 8 ? stripped : stripped.slice(0, 8);
}

/**
 * Compact single-line role identity header:
 * `mimin · manager <model> · thinking <mode> · sidekick <model> · session <short id>`.
 * Only the role identity is shown — no workspace, provider, or run state.
 * Low-priority segments (thinking, then session, then sidekick) are dropped as
 * the width narrows so the manager model always fits without overflow.
 */
export class Header implements Component {
  private product: string;
  private manager: string;
  private thinking: string;
  private sidekick?: string;
  private session?: string;

  constructor(options: HeaderOptions) {
    this.product = sanitizeText(options.product ?? "mimin", false) || "mimin";
    this.manager = sanitizeText(options.managerModel, false) || "unknown";
    this.thinking = sanitizeText(options.thinking ?? "off", false) || "off";
    this.sidekick = options.sidekickModel !== undefined
      ? sanitizeText(options.sidekickModel, false) || undefined
      : undefined;
    this.session = options.sessionId !== undefined
      ? compactSession(options.sessionId) || undefined
      : undefined;
  }

  setManagerModel(model: string): void {
    this.manager = sanitizeText(model, false) || "unknown";
  }

  setThinking(thinking: string): void {
    this.thinking = sanitizeText(thinking, false) || "off";
  }

  /** Set the sidekick model chip (hidden when empty). */
  setSidekickModel(model?: string): void {
    this.sidekick = model !== undefined
      ? sanitizeText(model, false) || undefined
      : undefined;
  }

  /** Set the session chip (hidden when empty). */
  setSessionId(sessionId?: string): void {
    this.session = sessionId !== undefined
      ? compactSession(sessionId) || undefined
      : undefined;
  }

  // Back-compat no-ops: the compact header has no run state, turn, or workspace.

  /** @deprecated no-op: the header no longer renders run state. */
  setRunState(_state: HeaderRunState): void {}

  /** @deprecated no-op: the header no longer renders the turn chip. */
  setTurn(_turn: number): void {}

  /** @deprecated no-op: the header no longer renders the workspace. */
  setWorkspace(_workspace: string): void {}

  invalidate(): void {
    // Rendering derives directly from the small identity fields.
  }

  render(width: number): string[] {
    if (width <= 0) return [""];
    let segments = this.buildSegments();
    // Drop the lowest-priority identity segment until the line fits, keeping
    // at least the product + manager model (priority 4).
    while (
      segments.some((segment) => segment.priority < 4)
      && visibleWidth(segments.map((segment) => segment.text).join("")) > width
    ) {
      let drop = 0;
      for (let index = 1; index < segments.length; index += 1) {
        if (segments[index]!.priority < segments[drop]!.priority) drop = index;
      }
      segments = segments.filter((_, index) => index !== drop);
    }
    const line = segments.map((segment) => segment.text).join("");
    return [truncateToWidth(line, width)];
  }

  /** Identity segments in render order with drop priorities. */
  private buildSegments(): Segment[] {
    const segments: Segment[] = [
      { priority: 4, text: cyan(this.product) },
      { priority: 4, text: ` · ${dim("manager")} ${cyan(this.manager)}` },
    ];
    if (this.thinking !== "off" && this.thinking.length > 0) {
      segments.push({
        priority: 1,
        text: ` · ${dim("thinking")} ${dim(this.thinking)}`,
      });
    }
    if (this.sidekick) {
      segments.push({
        priority: 3,
        text: ` · ${dim("sidekick")} ${cyan(this.sidekick)}`,
      });
    }
    if (this.session) {
      segments.push({
        priority: 2,
        text: ` · ${dim("session")} ${dim(this.session)}`,
      });
    }
    return segments;
  }
}
