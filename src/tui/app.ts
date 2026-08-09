import {
  Key,
  matchesKey,
  ProcessTerminal,
  TUI,
  type Component,
  type Terminal,
} from "@mariozechner/pi-tui";
import { Footer, type ContextSummary } from "./footer.js";
import { Header } from "./header.js";
import {
  SidekickActivity,
  type LocalDelegateEvent,
  type LocalSidekickActivity,
  type LocalSidekickResult,
} from "./sidekick.js";
import { Transcript, type TranscriptRole } from "./transcript.js";

export interface TuiHost {
  addChild(component: Component): void;
  setFocus(component: Component | null): void;
  addInputListener(
    listener: (data: string) => { consume?: boolean; data?: string } | undefined,
  ): () => void;
  start(): void;
  stop(): void;
  requestRender(force?: boolean): void;
}

/** Broad structural stream event accepted without importing agent or pi-ai types. */
export interface LocalManagerEvent {
  type: string;
  event?: unknown;
  delta?: unknown;
  content?: unknown;
  error?: unknown;
}

export interface AgentTuiOptions {
  product?: string;
  managerModel: string;
  workspace: string;
  thinking?: string;
  context?: ContextSummary;
  onSubmit?: (line: string) => void | Promise<void>;
  onCancel?: () => void | Promise<void>;
  onExit?: () => void | Promise<void>;
  terminal?: Terminal;
  /** Test seam. When supplied, no ProcessTerminal is constructed. */
  tui?: TuiHost;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function managerError(value: unknown): string {
  if (typeof value === "string") return value;
  const object = record(value);
  if (!object) return "Manager stream failed.";
  if (typeof object.errorMessage === "string") return object.errorMessage;
  if (typeof object.message === "string") return object.message;
  return "Manager stream failed.";
}

/** Four-area pi-tui application shell for manager/sidekick orchestration. */
export class AgentTui {
  readonly tui: TuiHost;
  readonly header: Header;
  readonly transcript: Transcript;
  readonly sidekicks: SidekickActivity;
  readonly footer: Footer;

  private activeManagerStream?: string;
  private started = false;
  private readonly onExit?: () => void | Promise<void>;

  constructor(options: AgentTuiOptions) {
    this.tui = options.tui ?? new TUI(options.terminal ?? new ProcessTerminal());
    this.onExit = options.onExit;
    this.header = new Header({
      product: options.product,
      managerModel: options.managerModel,
      workspace: options.workspace,
    });
    this.transcript = new Transcript();
    this.sidekicks = new SidekickActivity(options.workspace);
    this.footer = new Footer({
      managerModel: options.managerModel,
      thinking: options.thinking,
      context: options.context,
      onSubmit: async (line) => {
        this.addUser(line);
        await options.onSubmit?.(line);
      },
      onCancel: options.onCancel,
      onSubmitError: (error) => this.addError(
        error instanceof Error ? error.message : String(error),
      ),
      requestRender: () => this.requestRender(),
    });

    // Deliberately exactly four top-level areas.
    this.tui.addChild(this.header);
    this.tui.addChild(this.transcript);
    this.tui.addChild(this.sidekicks);
    this.tui.addChild(this.footer);
    this.tui.setFocus(this.footer);
    this.tui.addInputListener((data) => {
      if (!matchesKey(data, Key.ctrl("c"))) return undefined;
      void this.onExit?.();
      this.stop();
      return { consume: true };
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.tui.start();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.tui.stop();
  }

  requestRender(force = false): void {
    this.tui.requestRender(force);
  }

  /** Deterministic component render for tests; it does not start a terminal. */
  render(width: number): string[] {
    return [
      ...this.header.render(width),
      ...this.transcript.render(width),
      ...this.sidekicks.render(width),
      ...this.footer.render(width),
    ];
  }

  addTranscript(role: TranscriptRole, text: string): string {
    const id = this.transcript.append(role, text);
    this.requestRender();
    return id;
  }

  addUser(text: string): string {
    return this.addTranscript("user", text);
  }

  addManager(text: string): string {
    return this.addTranscript("manager", text);
  }

  addInfo(text: string): string {
    return this.addTranscript("info", text);
  }

  addError(text: string): string {
    return this.addTranscript("error", text);
  }

  startManagerStream(initial = ""): string {
    if (this.activeManagerStream) this.transcript.finishStream(this.activeManagerStream);
    this.activeManagerStream = this.transcript.beginManagerStream(initial);
    this.requestRender();
    return this.activeManagerStream;
  }

  /** Append a provider text delta to the current manager entry. */
  appendManagerDelta(delta: string, streamId = this.activeManagerStream): boolean {
    const id = streamId ?? this.startManagerStream();
    const updated = this.transcript.appendStreamDelta(id, delta);
    if (updated) this.requestRender();
    return updated;
  }

  /** Replace the current manager entry with cumulative provider text. */
  updateManagerStream(text: string, streamId = this.activeManagerStream): boolean {
    const id = streamId ?? this.startManagerStream();
    const updated = this.transcript.updateStream(id, text);
    if (updated) this.requestRender();
    return updated;
  }

  finishManagerStream(finalText?: string, streamId = this.activeManagerStream): boolean {
    if (!streamId) return false;
    const finished = this.transcript.finishStream(streamId, finalText);
    if (streamId === this.activeManagerStream) this.activeManagerStream = undefined;
    if (finished) this.requestRender();
    return finished;
  }

  /** Map text-only stream events; thinking/tool payloads are intentionally ignored. */
  handleManagerEvent(source: LocalManagerEvent): void {
    const nested = source.type === "model_event" ? record(source.event) : undefined;
    const event = nested ?? source as unknown as Record<string, unknown>;
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "text_start") {
      if (!this.activeManagerStream) this.startManagerStream();
    } else if (type === "text_delta" && typeof event.delta === "string") {
      this.appendManagerDelta(event.delta);
    } else if (type === "text_end") {
      this.finishManagerStream(
        typeof event.content === "string" ? event.content : undefined,
      );
    } else if (type === "done") {
      this.finishManagerStream();
    } else if (type === "error") {
      this.finishManagerStream();
      this.addError(managerError(event.error));
    }
  }

  handleDelegateEvent(event: LocalDelegateEvent): void {
    this.sidekicks.apply(event);
    this.requestRender();
  }

  delegateStarted(index: number, taskCount = 1): void {
    this.sidekicks.start(index, taskCount);
    this.requestRender();
  }

  delegateActivity(
    index: number,
    activity: LocalSidekickActivity,
    taskCount = 1,
  ): void {
    this.sidekicks.activity(index, taskCount, activity);
    this.requestRender();
  }

  delegateFinished(
    index: number,
    result: LocalSidekickResult,
    taskCount = 1,
  ): void {
    this.sidekicks.finish(index, taskCount, result);
    this.requestRender();
  }

  toggleSidekick(identifier: number | string): boolean {
    const expanded = this.sidekicks.toggle(identifier);
    this.requestRender();
    return expanded;
  }

  setStatus(update: {
    managerModel?: string;
    thinking?: string;
    context?: ContextSummary;
  }): void {
    if (update.managerModel !== undefined) {
      this.header.setManagerModel(update.managerModel);
    }
    this.footer.setStatus(update);
    this.requestRender();
  }
}

export function createApp(options: AgentTuiOptions): AgentTui {
  return new AgentTui(options);
}
