import {
  Container,
  Markdown,
  Text,
  type Component,
  type MarkdownTheme,
} from "@mariozechner/pi-tui";
import { sanitizeText } from "./header.js";
import { cyan, dim, green, yellow } from "./theme.js";

export type TranscriptRole = "user" | "manager" | "info" | "error";

export interface TranscriptEntry {
  readonly id: string;
  readonly role: TranscriptRole;
  readonly text: string;
  readonly streaming: boolean;
}

/** Maximum visible transcript rows; the viewport is tail-anchored and scrollable. */
export const TRANSCRIPT_MAX_LINES = 1_000;

/** Maximum retained entries; the scrollback head drops oldest first. */
const TRANSCRIPT_MAX_ENTRIES = 500;

/** Number of rows reserved for the scroll position status line. */
const STATUS_ROWS = 1;

interface MutableEntry {
  id: string;
  role: TranscriptRole;
  text: string;
  streaming: boolean;
  /** Container holding the heading (if any) + body component. */
  component: Container;
  /** Rendered rows for this entry (may include a trailing blank separator). */
  rows: string[];
  /** Whether the entry's last rendered row is the blank separator. */
  trailingBlank: boolean;
  /** Absolute index of the entry's first rendered row in the full transcript. */
  startRow: number;
}

const HEADINGS: Record<TranscriptRole, string> = {
  user: "You",
  manager: "Manager",
  info: "Info",
  error: "Error",
};

/** One-line emphasis for headings: cyan with a bold accent token. */
function heading(text: string): string {
  return cyan(`\u001b[1m${text}\u001b[0m`);
}

/**
 * Minimal markdown theme for pi-tui Markdown. Bold/headings/code/lists are
 * styled with plain ANSI; the only color is a cyan heading accent.
 */
const THEME: MarkdownTheme = {
  heading,
  link: (text) => text,
  linkUrl: (text) => text,
  code: (text) => `\u001b[7m${text}\u001b[0m`,
  codeBlock: (text) => `\u001b[7m${text}\u001b[0m`,
  codeBlockBorder: (text) => dim(text),
  quote: (text) => `\u001b[3m${text}\u001b[0m`,
  quoteBorder: (text) => dim(text),
  hr: (text) => dim(text),
  listBullet: (text) => dim(text),
  bold: (text) => `\u001b[1m${text}\u001b[0m`,
  italic: (text) => `\u001b[3m${text}\u001b[0m`,
  strikethrough: (text) => `\u001b[9m${text}\u001b[0m`,
  underline: (text) => `\u001b[4m${text}\u001b[0m`,
  codeBlockIndent: "  ",
};

/**
 * Transcript with one heading per entry and markdown bodies:
 * - manager: a single `◆ Manager` heading line, markdown rendered beneath;
 * - user: `> text` (no `You:` label);
 * - info/error: `◆ Info`/`◆ Error` heading lines.
 * Streaming mutates the same body component instead of rebuilding history.
 */
export class Transcript extends Container implements Component {
  private readonly records: MutableEntry[] = [];
  private readonly byId = new Map<string, MutableEntry>();
  private sequence = 0;

  get entries(): readonly TranscriptEntry[] {
    return this.records.map(({ id, role, text, streaming }) => ({
      id,
      role,
      text,
      streaming,
    }));
  }

  /** Absolute index of the first rendered row (head of the transcript). */
  private head = 0;
  /** Number of rendered rows (entries plus separators). */
  private total = 0;
  /** Whether the viewport is pinned to the tail (default true). */
  private tailAnchored = true;
  private maxLines = TRANSCRIPT_MAX_LINES;
  private maxEntries = TRANSCRIPT_MAX_ENTRIES;

  constructor(maxLines = TRANSCRIPT_MAX_LINES) {
    super();
    this.maxLines = Math.max(1, Math.floor(maxLines));
  }

  /** Configure the maximum retained (and visible) transcript rows. */
  setMaxLines(maxLines: number): void {
    this.maxLines = Math.max(1, Math.floor(maxLines));
  }

  /** Page the viewport backward by one page of visible rows. */
  scrollUp(pageSize: number): boolean {
    const visible = Math.max(1, pageSize - STATUS_ROWS);
    const start = this.tailAnchored ? this.total - visible : this.head;
    const next = Math.max(0, start - visible);
    if (next === start) return false;
    this.head = next;
    this.tailAnchored = false;
    return true;
  }

  /** Page the viewport forward by one page of visible rows. */
  scrollDown(pageSize: number): boolean {
    const visible = Math.max(1, pageSize - STATUS_ROWS);
    const next = Math.min(this.total - visible, this.head + visible);
    if (next === this.head && this.tailAnchored) return false;
    this.head = next;
    this.tailAnchored = next >= this.total - visible;
    return true;
  }

  /** Jump to the newest transcript content. */
  scrollToBottom(): void {
    this.head = Math.max(0, this.total - 1);
    this.tailAnchored = true;
  }

  /** Rows the viewport must reserve beyond the visible transcript window. */
  statusRows(): number {
    return STATUS_ROWS;
  }

  append(role: TranscriptRole, value: string): string {
    const id = `transcript-${++this.sequence}`;
    const text = sanitizeText(value);
    const group = new Container();
    if (role === "user") {
      group.addChild(new Text(`${green(">")} ${text}`, 0, 0));
    } else {
      const headingText = role === "manager"
        ? cyan("◆")
        : role === "error"
          ? yellow("◆")
          : dim("◆");
      group.addChild(new Text(`${headingText} ${HEADINGS[role]}`, 0, 0));
      group.addChild(role === "manager"
        ? new Markdown(text, 0, 0, THEME)
        : new Text(text, 0, 0));
    }
    const entry: MutableEntry = {
      id,
      role,
      text,
      streaming: false,
      component: group,
      rows: [],
      trailingBlank: true,
      startRow: 0,
    };
    this.records.push(entry);
    this.byId.set(id, entry);
    this.addChild(group);
    this.discardOldest();
    return id;
  }

  beginManagerStream(initial = ""): string {
    const id = this.append("manager", initial);
    const entry = this.byId.get(id);
    if (entry) entry.streaming = true;
    return id;
  }

  /** Replace a stream with the provider's current cumulative text. */
  updateStream(id: string, value: string): boolean {
    const entry = this.byId.get(id);
    if (!entry || entry.role !== "manager") return false;
    entry.text = sanitizeText(value);
    this.bodyOf(entry).setText(entry.text);
    return true;
  }

  /** Append only a new provider delta to the existing stream component. */
  appendStreamDelta(id: string, delta: string): boolean {
    const entry = this.byId.get(id);
    if (!entry || entry.role !== "manager") return false;
    entry.text += sanitizeText(delta);
    this.bodyOf(entry).setText(entry.text);
    return true;
  }

  finishStream(id: string, finalText?: string): boolean {
    const entry = this.byId.get(id);
    if (!entry || entry.role !== "manager") return false;
    if (finalText !== undefined) this.updateStream(id, finalText);
    entry.streaming = false;
    return true;
  }

  clearEntries(): void {
    this.records.length = 0;
    this.byId.clear();
    this.clear();
    this.head = 0;
    this.total = 0;
    this.tailAnchored = true;
  }

  render(width: number): string[] {
    if (width <= 0) return this.records.length > 0 ? [""] : [];
    this.syncRows(width);
    const available = Math.max(0, this.maxLines - STATUS_ROWS);
    const totalVisible = Math.min(this.total, available);
    if (this.tailAnchored) {
      this.head = Math.max(0, this.total - totalVisible);
    } else {
      this.head = Math.min(this.head, Math.max(0, this.total - totalVisible));
    }
    const from = this.head;
    const to = Math.min(this.total, this.head + totalVisible);
    const lines: string[] = [];
    for (let row = from; row < to; row += 1) {
      const entry = this.entryAtRow(row);
      const line = entry.rows[row - entry.startRow];
      if (line !== undefined) lines.push(line);
    }
    return lines;
  }

  /** Recompute rendered rows for every entry and update absolute row offsets. */
  private syncRows(width: number): void {
    this.total = 0;
    for (const entry of this.records) {
      entry.startRow = this.total;
      const rendered = this.renderEntry(entry, width);
      entry.rows = rendered;
      this.total += rendered.length;
    }
  }

  /** The entry owning a given absolute row index (never null while in range). */
  private entryAtRow(row: number): MutableEntry {
    let target = this.records[0]!;
    for (const entry of this.records) {
      if (row < entry.startRow + entry.rows.length) {
        target = entry;
        break;
      }
      target = entry;
    }
    return target;
  }

  /** Drop the oldest entries when the transcript exceeds its entry budget. */
  private discardOldest(): void {
    while (this.records.length > this.maxEntries) {
      const oldest = this.records.shift();
      if (!oldest) break;
      this.byId.delete(oldest.id);
      this.removeChild(oldest.component);
    }
  }

  /** The Markdown body is the second child of a manager entry group. */
  private bodyOf(entry: MutableEntry): Markdown {
    const body = entry.component.children[1];
    if (!(body instanceof Markdown)) {
      throw new Error("manager transcript body is not a Markdown component");
    }
    return body;
  }

  /** Join a single entry's component lines with a blank separator row. */
  private renderEntry(entry: MutableEntry, width: number): string[] {
    const body: string[] = [];
    for (const child of entry.component.children) {
      body.push(...child.render(width));
    }
    if (entry.trailingBlank && body.length > 0) body.push("");
    return body;
  }
}
