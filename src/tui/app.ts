import {
  Key,
  matchesKey,
  ProcessTerminal,
  TUI,
  type Component,
  type Terminal,
} from "@mariozechner/pi-tui";
import type { RoleProviderResolver, SessionSuggestionSource } from "./commands.js";
import { Footer, type ContextSummary } from "./footer.js";
import { Header, type HeaderRunState } from "./header.js";
import {
  SidekickActivity,
  type LocalDelegateEvent,
  type LocalSidekickActivity,
  type LocalSidekickResult,
} from "./sidekick.js";
import { ToolActivity, type LocalToolEvent } from "./tool-activity.js";
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
  /** Live role→provider resolution for the /model dropdown. */
  roleProviders?: RoleProviderResolver;
  /** Session suggestions for the /session dropdown. */
  sessionSource?: SessionSuggestionSource;
  onSubmit?: (line: string) => void | Promise<void>;
  onCancel?: () => void | Promise<void>;
  onExit?: () => void | Promise<void>;
  onToggleSidekick?: (identifier: number | string) => void;
  terminal?: Terminal;
  /** Test seam. When supplied, no ProcessTerminal is constructed. */
  tui?: TuiHost;
}

/** Heartbeat interval for live elapsed tickers while a run is active. */
const TICK_INTERVAL_MS = 1_000;
/** One page of transcript rows scrolled per PageUp/PageDown press. */
const SCROLL_PAGE = 12;

const SECOND_CONFIRMATION =
  "Ctrl-C again to exit (Escape cancels the active run).";

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
  readonly tools: ToolActivity;
  readonly footer: Footer;

  private activeManagerStream?: string;
  private runState: HeaderRunState = "idle";
  private started = false;
  private tickTimer?: Timer;
  private exitArmed = false;
  private exitArmedAt = 0;
  private readonly onExit?: () => void | Promise<void>;
  private readonly onToggleSidekick?: (identifier: number | string) => void;

  constructor(options: AgentTuiOptions) {
    this.tui = options.tui ?? new TUI(options.terminal ?? new ProcessTerminal());
    this.onExit = options.onExit;
    this.onToggleSidekick = options.onToggleSidekick;
    this.header = new Header({
      product: options.product,
      managerModel: options.managerModel,
      workspace: options.workspace,
      thinking: options.thinking,
    });
    this.transcript = new Transcript();
    this.sidekicks = new SidekickActivity(options.workspace);
    this.tools = new ToolActivity();
    this.footer = new Footer({
      managerModel: options.managerModel,
      thinking: options.thinking,
      context: options.context,
      workspace: options.workspace,
      roleProviders: options.roleProviders,
      sessionSource: options.sessionSource,
      managerWorking: false,
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

    // Five top-level areas: header, transcript, tool rows, sidekick cards, footer.
    this.tui.addChild(this.header);
    this.tui.addChild(this.transcript);
    this.tui.addChild(this.tools);
    this.tui.addChild(this.sidekicks);
    this.tui.addChild(this.footer);
    this.tui.setFocus(this.footer);
    this.tui.addInputListener((data) => {
      if (matchesKey(data, Key.pageUp)) {
        this.transcript.scrollUp(SCROLL_PAGE);
        this.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, Key.pageDown)) {
        this.transcript.scrollDown(SCROLL_PAGE);
        this.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, Key.end)) {
        this.transcript.scrollToBottom();
        this.requestRender();
        return { consume: true };
      }
      if (!matchesKey(data, Key.ctrl("c"))) return undefined;
      if (this.runState === "idle" || (this.exitArmed && Date.now() - this.exitArmedAt < 1_500)) {
        void this.onExit?.();
        this.stop();
        return { consume: true };
      }
      this.exitArmed = true;
      this.exitArmedAt = Date.now();
      this.addInfo(SECOND_CONFIRMATION);
      return { consume: true };
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.tickTimer = setInterval(() => {
      if (this.runState === "idle") return;
      this.header.invalidate();
      this.sidekicks.invalidate();
      this.requestRender(true);
    }, TICK_INTERVAL_MS);
    this.tui.start();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
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
      ...this.tools.render(width),
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

  /** Clear the transcript and replay a restored session's history. */
  restoreSession(entries: { role: "user" | "manager"; text: string }[]): void {
    this.transcript.clearEntries();
    for (const entry of entries) {
      if (entry.role === "user") this.addUser(entry.text);
      else this.addManager(entry.text);
    }
    this.requestRender();
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

  /** Map text-only stream events; thinking payloads are intentionally ignored. */
  handleManagerEvent(source: LocalManagerEvent): void {
    const nested = source.type === "model_event" ? record(source.event) : undefined;
    const event = nested ?? source as unknown as Record<string, unknown>;
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "text_start") {
      this.setRunState("running");
      if (!this.activeManagerStream) this.startManagerStream();
    } else if (type === "text_delta" && typeof event.delta === "string") {
      if (!this.activeManagerStream) this.setRunState("running");
      this.appendManagerDelta(event.delta);
    } else if (type === "text_end") {
      this.setRunState("working");
      this.finishManagerStream(
        typeof event.content === "string" ? event.content : undefined,
      );
    } else if (type === "done") {
      this.setRunState("idle");
      this.finishManagerStream();
    } else if (type === "error") {
      this.setRunState("idle");
      this.finishManagerStream();
      this.addError(managerError(event.error));
    } else if (type === "tool_start" || type === "tool_end") {
      this.setRunState("working");
      this.tools.apply(event as unknown as LocalToolEvent);
      this.requestRender();
    }
  }

  handleDelegateEvent(event: LocalDelegateEvent): void {
    this.sidekicks.apply(event);
    this.updateSidekickStatus();
    this.requestRender();
  }

  /** Mirror the running-sidekick count into the footer without touching cards. */
  private updateSidekickStatus(): void {
    const working = this.sidekicks.workingCount();
    this.footer.setStatus({ sidekickWorking: working });
  }

  /** Set the header run state and mirror it to the footer spinner. */
  private setRunState(state: HeaderRunState): void {
    if (this.runState === state) return;
    this.runState = state;
    if (state === "idle") this.header.setTurn(0);
    this.header.setRunState(state);
    this.footer.setStatus({ managerWorking: state !== "idle" });
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

  setStatus(update: {
    managerModel?: string;
    thinking?: string;
    context?: ContextSummary;
    turn?: number;
  }): void {
    if (update.managerModel !== undefined) {
      this.header.setManagerModel(update.managerModel);
    }
    if (update.thinking !== undefined) {
      this.header.setThinking(update.thinking);
    }
    if (update.turn !== undefined) {
      this.header.setTurn(update.turn);
    }
    this.footer.setStatus(update);
    this.requestRender();
  }

  setTurn(turn: number): void {
    this.header.setTurn(turn);
    this.requestRender();
  }

  toggleSidekick(identifier: number | string): boolean {
    const expanded = this.sidekicks.toggle(identifier);
    this.onToggleSidekick?.(identifier);
    this.requestRender();
    return expanded;
  }
}

export function createApp(options: AgentTuiOptions): AgentTui {
  return new AgentTui(options);
}
