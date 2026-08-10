import {
  Key,
  matchesKey,
  ProcessTerminal,
  TUI,
  type Component,
  type Terminal,
} from "@mariozechner/pi-tui";
import type { RoleProviderResolver, SessionSuggestionSource } from "./commands.js";
import type { ProviderSuggestionSource } from "./commands.js";
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
  /** Terminal dimensions; the transcript is bounded to the visible rows. */
  terminal?: { rows: number; write?: (data: string) => void };
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
  /** Provider suggestions for the /provider dropdown. */
  suggestProviders?: ProviderSuggestionSource;
  /** Session suggestions for the /session dropdown. */
  sessionSource?: SessionSuggestionSource;
  onSubmit?: (line: string) => void | Promise<void>;
  onCancel?: () => void | Promise<void>;
  onExit?: () => void | Promise<void>;
  onToggleSidekick?: (identifier: number | string) => void;
  /** Enter submits a masked API key; Escape cancels the key prompt. */
  onSubmitKey?: (provider: string, key: string) => void | Promise<void>;
  onCancelKey?: () => void;
  terminal?: Terminal;
  /** Test seam. When supplied, no ProcessTerminal is constructed. */
  tui?: TuiHost;
}

/** Heartbeat interval for live elapsed tickers while a run is active. */
const TICK_INTERVAL_MS = 1_000;
/** One page of transcript rows scrolled per PageUp/PageDown press. */
const SCROLL_PAGE = 12;
/** Number of transcript rows moved by one mouse-wheel tick. */
const SCROLL_WHEEL = 3;
const MOUSE_TRACKING_ENABLE = "\u001b[?1000h\u001b[?1006h";
const MOUSE_TRACKING_DISABLE = "\u001b[?1006l\u001b[?1000l";

function mouseWheelDirection(data: string): "up" | "down" | undefined {
  const match = /^\u001b\[<(\d+);\d+;\d+[Mm]$/.exec(data);
  if (!match) return undefined;
  if (match[1] === "64") return "up";
  if (match[1] === "65") return "down";
  return undefined;
}

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
  /** Begin a masked API-key prompt for a provider (renders in the footer). */
  promptForKey: (provider: string) => void;
  /** Cancel the active masked key prompt. */
  cancelKeyPrompt: () => void;

  private activeManagerStream?: string;
  /** Transcript entry id for each turn's inline tool block. */
  private readonly toolBlockByTurn = new Map<number, string>();
  private runState: HeaderRunState = "idle";
  private started = false;
  private mouseTrackingEnabled = false;
  private readonly writeTerminal?: (data: string) => void;
  private tickTimer?: Timer;
  private lastTranscriptMaxLines = 0;
  private exitArmed = false;
  private exitArmedAt = 0;
  private readonly onExit?: () => void | Promise<void>;
  private readonly onToggleSidekick?: (identifier: number | string) => void;
  constructor(options: AgentTuiOptions) {
    const terminal = options.terminal ?? new ProcessTerminal();
    this.tui = options.tui ?? new TUI(terminal);
    const hostTerminal = options.tui?.terminal;
    this.writeTerminal = hostTerminal?.write?.bind(hostTerminal)
      ?? (options.tui ? undefined : terminal.write.bind(terminal));
    this.onExit = options.onExit;
    this.onToggleSidekick = options.onToggleSidekick;
    this.header = new Header({
      product: options.product,
      managerModel: options.managerModel,
      workspace: options.workspace,
      thinking: options.thinking,
    });
    this.transcript = new Transcript();
    // Re-bind the transcript to the viewport before every render (the TUI
    // renders the transcript child directly, so this is the reliable hook).
    this.transcript.onBeforeRender = (width) => this.syncTranscriptHeight(width);
    this.sidekicks = new SidekickActivity(options.workspace);
    this.tools = new ToolActivity();
    this.footer = new Footer({
      managerModel: options.managerModel,
      thinking: options.thinking,
      context: options.context,
      workspace: options.workspace,
      roleProviders: options.roleProviders,
      suggestProviders: options.suggestProviders,
      sessionSource: options.sessionSource,
      managerWorking: false,
      onSubmit: async (line) => {
        this.addUser(line);
        await options.onSubmit?.(line);
      },
      onCancel: options.onCancel,
      onSubmitKey: options.onSubmitKey,
      onCancelKey: options.onCancelKey,
      onSubmitError: (error) => this.addError(
        error instanceof Error ? error.message : String(error),
      ),
      requestRender: () => this.requestRender(),
    });
    // Key prompts render through the footer; expose a programmatic trigger.
    this.promptForKey = (provider) => {
      this.footer.beginKeyPrompt(provider);
      this.requestRender();
    };
    this.cancelKeyPrompt = () => {
      this.footer.cancelKeyPrompt();
      this.requestRender();
    };

    // Four top-level areas: header, transcript, sidekick cards, footer.
    // Manager tool calls render inline inside the transcript as blocks.
    this.tui.addChild(this.header);
    this.tui.addChild(this.transcript);
    this.tui.addChild(this.sidekicks);
    this.tui.addChild(this.footer);
    this.tui.setFocus(this.footer);
    this.tui.addInputListener((data) => {
      const wheelDirection = mouseWheelDirection(data);
      if (wheelDirection === "up") {
        this.transcript.scrollUp(SCROLL_WHEEL);
        this.requestRender();
        return { consume: true };
      }
      if (wheelDirection === "down") {
        this.transcript.scrollDown(SCROLL_WHEEL);
        this.requestRender();
        return { consume: true };
      }
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
    this.enableMouseTracking();
    this.tickTimer = setInterval(() => {
      if (this.runState === "idle") return;
      this.header.invalidate();
      this.sidekicks.invalidate();
      // Non-forced: the TUI diffs the invalidated components. A forced render
      // would clear the screen and reset the viewport every second, yanking
      // the user's scroll position while a response streams.
      this.requestRender();
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
    this.disableMouseTracking();
    this.tui.stop();
  }

  private enableMouseTracking(): void {
    if (this.mouseTrackingEnabled || !this.writeTerminal) return;
    this.writeTerminal(MOUSE_TRACKING_ENABLE);
    this.mouseTrackingEnabled = true;
  }

  private disableMouseTracking(): void {
    if (!this.mouseTrackingEnabled || !this.writeTerminal) return;
    this.writeTerminal(MOUSE_TRACKING_DISABLE);
    this.mouseTrackingEnabled = false;
  }

  requestRender(force = false): void {
    // Bound the transcript before the TUI renders its children directly
    // (the TUI calls each child's render(width), not the app's compose).
    this.syncTranscriptHeight(80);
    this.tui.requestRender(force);
  }

  /** Deterministic component render for tests; it does not start a terminal. */
  render(width: number): string[] {
    this.syncTranscriptHeight(width);
    return [
      ...this.header.render(width),
      ...this.transcript.render(width),
      ...this.sidekicks.render(width),
      ...this.footer.render(width),
    ];
  }

  /**
   * Bound the transcript to the visible viewport so its rendered line count
   * never grows during streaming (pi-tui's differential renderer would
   * otherwise scroll the terminal to the tail, yanking the user's scroll
   * position). Header/footer reservations are fixed; sidekick cards occupy
   * their current rendered height.
   */
  private syncTranscriptHeight(width: number): void {
    const rows = this.tui.terminal?.rows;
    if (!rows || rows <= 0) return;
    const reserved = 1 /* header */ + 5 /* footer rule+status+editor */;
    const sidekickRows = this.sidekicks.render(width).length;
    const available = Math.max(4, rows - reserved - sidekickRows);
    if (available !== this.lastTranscriptMaxLines) {
      this.lastTranscriptMaxLines = available;
      this.transcript.setMaxLines(available);
    }
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
    this.toolBlockByTurn.clear();
    this.tools.clear();
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
      const tracked = this.tools.apply(event as unknown as LocalToolEvent);
      // Tool rows live inline in the transcript, grouped per turn.
      const turn = record(event)?.turn;
      const turnNumber = typeof turn === "number" ? turn : 0;
      if (tracked && type === "tool_start" && !this.toolBlockByTurn.has(turnNumber)) {
        const id = this.transcript.appendToolBlock(
          this.tools.rendererForTurn(turnNumber),
        );
        this.toolBlockByTurn.set(turnNumber, id);
      }
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

  /**
   * Signal a run is starting/finishing immediately, before any model event
   * arrives. The provider round-trip can take a moment; without this the
   * header/footer stay idle during the request.
   */
  setRunning(running: boolean): void {
    this.setRunState(running ? "working" : "idle");
    this.requestRender();
  }

  /** Clear the footer editor's draft input. */
  clearInput(): void {
    this.footer.editor.setText("");
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
