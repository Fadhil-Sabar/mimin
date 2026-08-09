import { TruncatedText, type Component } from "@mariozechner/pi-tui";
import { cyan, dim, green, yellow } from "./theme.js";

/** Remove terminal controls from text before it reaches a pi-tui component. */
export function sanitizeText(value: unknown, multiline = true): string {
  if (typeof value !== "string") return "";
  let text = value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\t/g, " ");
  if (!multiline) text = text.replace(/\n+/g, " ");
  return text;
}

function compactWorkspace(workspace: string): string {
  const normalized = sanitizeText(workspace, false).replace(/[\\/]+$/, "");
  if (!normalized) return ".";
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? normalized;
}

export interface HeaderOptions {
  product?: string;
  managerModel: string;
  workspace: string;
  thinking?: string;
}

/** The manager's run state shown in the header status slot. */
export type HeaderRunState = "idle" | "running" | "working";

/** Spinner frames shown while the manager is streaming text. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 100;

/** Single-line, narrow-safe application header backed by pi-tui TruncatedText. */
export class Header implements Component {
  private line = new TruncatedText("");
  private product: string;
  private model: string;
  private workspace: string;
  private thinking: string;
  private runState: HeaderRunState = "idle";
  private turn = 0;
  private frame = 0;
  private timer?: Timer;

  constructor(options: HeaderOptions) {
    this.product = sanitizeText(options.product ?? "mimin", false) || "mimin";
    this.model = sanitizeText(options.managerModel, false) || "unknown";
    this.workspace = compactWorkspace(options.workspace);
    this.thinking = sanitizeText(options.thinking ?? "off", false) || "off";
    this.refresh();
  }

  setManagerModel(model: string): void {
    this.model = sanitizeText(model, false) || "unknown";
    this.refresh();
  }

  setWorkspace(workspace: string): void {
    this.workspace = compactWorkspace(workspace);
    this.refresh();
  }

  setThinking(thinking: string): void {
    this.thinking = sanitizeText(thinking, false) || "off";
    this.refresh();
  }

  /** Set the manager run state; the spinner animates only while streaming. */
  setRunState(state: HeaderRunState): void {
    if (this.runState === state) return;
    this.runState = state;
    this.frame = 0;
    this.updateTimer();
    this.refresh();
  }

  /** Set the current manager turn; 0 hides the turn chip. */
  setTurn(turn: number): void {
    const next = Math.max(0, Math.floor(turn));
    if (this.turn === next) return;
    this.turn = next;
    this.refresh();
  }

  invalidate(): void {
    this.line.invalidate();
  }

  render(width: number): string[] {
    if (width <= 0) return [""];
    return this.line.render(width);
  }

  private updateTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.runState === "running") {
      this.timer = setInterval(() => {
        this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
        this.refresh();
      }, SPINNER_INTERVAL_MS);
    }
  }

  private refresh(): void {
    const status = this.runState === "running"
      ? cyan(`${SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length]} working`)
      : this.runState === "working"
        ? cyan("⚙ working")
        : dim("idle");
    const turn = this.turn > 0 ? ` · ${dim(`turn ${this.turn}`)}` : "";
    const model = cyan(this.model);
    const thinking = dim(`thinking ${this.thinking}`);
    const workspace = dim(this.workspace);
    const product = this.runState === "idle"
      ? yellow(this.product)
      : green(this.product);
    this.line = new TruncatedText(
      `${product} · ${model} · ${status}${turn} · ${thinking} · ${workspace}`,
    );
  }
}
