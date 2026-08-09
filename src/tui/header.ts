import { TruncatedText, type Component } from "@mariozechner/pi-tui";

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
}

/** Single-line, narrow-safe application header backed by pi-tui TruncatedText. */
export class Header implements Component {
  private line = new TruncatedText("");
  private product: string;
  private model: string;
  private workspace: string;

  constructor(options: HeaderOptions) {
    this.product = sanitizeText(options.product ?? "mimin", false) || "mimin";
    this.model = sanitizeText(options.managerModel, false) || "unknown";
    this.workspace = compactWorkspace(options.workspace);
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

  private refresh(): void {
    this.line = new TruncatedText(
      `${this.product} | manager ${this.model} | ${this.workspace}`,
    );
  }

  invalidate(): void {
    this.line.invalidate();
  }

  render(width: number): string[] {
    if (width <= 0) return [""];
    return this.line.render(width);
  }
}
