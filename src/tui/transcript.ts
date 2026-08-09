import { Container, Text, type Component } from "@mariozechner/pi-tui";
import { sanitizeText } from "./header.js";

export type TranscriptRole = "user" | "manager" | "info" | "error";

export interface TranscriptEntry {
  readonly id: string;
  readonly role: TranscriptRole;
  readonly text: string;
  readonly streaming: boolean;
}

interface MutableEntry {
  id: string;
  role: TranscriptRole;
  text: string;
  streaming: boolean;
  component: Text;
}

const LABELS: Record<TranscriptRole, string> = {
  user: "You",
  manager: "Manager",
  info: "Info",
  error: "Error",
};

/** Transcript whose streaming updates mutate one Text primitive instead of rebuilding history. */
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

  append(role: TranscriptRole, value: string): string {
    const id = `transcript-${++this.sequence}`;
    const text = sanitizeText(value);
    const component = new Text(this.display(role, text), 0, 0);
    const entry: MutableEntry = { id, role, text, streaming: false, component };
    this.records.push(entry);
    this.byId.set(id, entry);
    this.addChild(component);
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
    entry.component.setText(this.display(entry.role, entry.text));
    return true;
  }

  /** Append only a new provider delta to the existing stream component. */
  appendStreamDelta(id: string, delta: string): boolean {
    const entry = this.byId.get(id);
    if (!entry || entry.role !== "manager") return false;
    entry.text += sanitizeText(delta);
    entry.component.setText(this.display(entry.role, entry.text));
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
  }

  render(width: number): string[] {
    if (width <= 0) return this.records.length > 0 ? [""] : [];
    return super.render(width);
  }

  private display(role: TranscriptRole, text: string): string {
    return `${LABELS[role]}: ${text}`;
  }
}
