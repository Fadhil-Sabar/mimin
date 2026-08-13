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
import { AnimationTicker } from "./animation.js";
import { TasksPanel } from "./tasks-panel.js";
import type { TaskBoard } from "../task/task.js";

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
  /** Presentation metadata: the sidekick model id shown in the header. */
  sidekickModel?: string;
  /** Current manager session id shown in the header. */
  sessionId?: string;
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

/** Three-area pi-tui application shell for manager/sidekick orchestration. */
export class AgentTui {
  readonly tui: TuiHost;
  readonly header: Header;
  readonly transcript: Transcript;
  readonly sidekicks: SidekickActivity;
  readonly tools: ToolActivity;
  readonly footer: Footer;
  /** Compact task-board panel; renders inline in the transcript. */
  readonly tasks: TasksPanel;
  /** Begin a masked API-key prompt for a provider (renders in the footer). */
  promptForKey: (provider: string) => void;
  /** Cancel the active masked key prompt. */
  cancelKeyPrompt: () => void;

  private activeManagerStream?: string;
  /** Transcript entry id for each turn's inline tool block. */
  private readonly toolBlockByTurn = new Map<number, string>();
  /** Transcript live block id for each inline sidekick card (by card id). */
  private readonly sidekickBlockByCard = new Map<string, string>();
  /** Transcript live block id for the task-board panel. */
  private taskBlockId?: string;
  private runState: HeaderRunState = "idle";
  private started = false;
  private mouseTrackingEnabled = false;
  private readonly writeTerminal?: (data: string) => void;
  readonly animation = new AnimationTicker({ onTick: () => this.onAnimationTick() });
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
      sidekickModel: options.sidekickModel,
      sessionId: options.sessionId,
      workspace: options.workspace,
      thinking: options.thinking,
    });
    this.transcript = new Transcript(1_000, this.animation.state);
    // Re-bind the transcript to the viewport before every render (the TUI
    // renders the transcript child directly, so this is the reliable hook).
    this.transcript.onBeforeRender = (width) => this.syncTranscriptHeight(width);
    this.sidekicks = new SidekickActivity(options.workspace, undefined, this.animation.state);
    this.tools = new ToolActivity(this.animation.state);
    this.tasks = new TasksPanel();
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
      onCancel: () => {
        // Surface the cancelling state before the owner's handler (abort).
        this.setCancelling();
        options.onCancel?.();
        this.requestRender();
      },
      onSubmitKey: options.onSubmitKey,
      onCancelKey: options.onCancelKey,
      onSubmitError: (error) => this.addError(
        error instanceof Error ? error.message : String(error),
      ),
      requestRender: () => this.requestRender(),
      animation: this.animation.state,
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

    // Three top-level areas: header, transcript, footer. Sidekick cards and
    // manager tool calls render inline inside the transcript as live blocks.
    this.tui.addChild(this.header);
    this.tui.addChild(this.transcript);
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
    this.syncAnimation();
    this.tui.start();
  }

  private onAnimationTick(): void {
    if (!this.wantsAnimation()) {
      this.animation.stop();
      return;
    }
    this.footer.invalidate();
    this.transcript.invalidate();
    this.requestRender();
  }

  private wantsAnimation(): boolean {
    return this.runState !== "idle" || this.activeManagerStream !== undefined
      || this.tools.hasRunning() || this.sidekicks.hasActive();
  }

  private syncAnimation(): void {
    if (this.started && this.wantsAnimation()) this.animation.start();
    else this.animation.stop();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.animation.stop();
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
      ...this.footer.render(width),
    ];
  }

  /**
   * Bound the transcript to the visible viewport so its rendered line count
   * never grows during streaming (pi-tui's differential renderer would
   * otherwise scroll the terminal to the tail, yanking the user's scroll
   * position). Sidekick cards live inline in the transcript, so only the
   * header and the footer's actual rendered height are reserved.
   */
  private syncTranscriptHeight(width: number): void {
    const rows = this.tui.terminal?.rows;
    if (!rows || rows <= 0) return;
    const reserved =
      this.header.render(width).length + this.footer.render(width).length;
    const available = Math.max(4, rows - reserved);
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
    this.activeManagerStream = undefined;
    this.toolBlockByTurn.clear();
    this.tools.clear();
    this.sidekicks.clear();
    this.sidekickBlockByCard.clear();
    this.updateSidekickStatus();
    this.syncAnimation();
    for (const entry of entries) {
      if (entry.role === "user") this.addUser(entry.text);
      else this.addManager(entry.text);
    }
    this.requestRender();
  }

  startManagerStream(initial = ""): string {
    if (this.activeManagerStream) this.transcript.finishStream(this.activeManagerStream);
    this.activeManagerStream = this.transcript.beginManagerStream(initial);
    this.syncAnimation();
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
    if (finished) {
      this.syncAnimation();
      this.requestRender();
    }
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
      const tracked = this.tools.apply(event as unknown as LocalToolEvent);
      // Tool rows live inline in the transcript, grouped per turn.
      const turn = record(event)?.turn;
      const turnNumber = typeof turn === "number" ? turn : 0;
      if (tracked && type === "tool_start" && !this.toolBlockByTurn.has(turnNumber)) {
        const id = this.transcript.appendLiveBlock(
          this.tools.rendererForTurn(turnNumber),
        );
        this.toolBlockByTurn.set(turnNumber, id);
      }
      // A tool start keeps the manager visibly working. A late tool_end must
      // not revive an already-finished run, while a normal tool_end preserves
      // the working footer as the manager begins its next model turn.
      if (this.tools.hasRunning()) this.setRunState("working");
      this.syncAnimation();
      this.requestRender();
    }
  }

  handleDelegateEvent(event: LocalDelegateEvent): void {
    const cardId = this.sidekicks.apply(event);
    this.attachCard(cardId);
    this.updateSidekickStatus();
    this.syncAnimation();
    this.requestRender();
  }

  /** Append the inline card block the first time a sidekick card is seen. */
  private attachCard(cardId: string | undefined): void {
    if (!cardId || this.sidekickBlockByCard.has(cardId)) return;
    const blockId = this.transcript.appendLiveBlock(
      this.sidekicks.rendererFor(cardId),
    );
    this.sidekickBlockByCard.set(cardId, blockId);
  }

  /** Mirror the sidekick working + total counts into the footer status. */
  private updateSidekickStatus(): void {
    this.footer.setStatus({
      sidekickWorking: this.sidekicks.workingCount(),
      sidekickTotal: this.sidekicks.totalCount(),
    });
  }

  /** Track the run state for the footer + exit-arm; the header shows no run state. */
  private setRunState(state: HeaderRunState): void {
    if (this.runState === state) return;
    this.runState = state;
    this.footer.setStatus({ managerWorking: state !== "idle", cancelling: false });
    this.syncAnimation();
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

  /** Show the footer's "cancelling" state (Escape during a run). */
  setCancelling(): void {
    if (this.runState === "idle") return;
    this.footer.setStatus({ cancelling: true });
    this.syncAnimation();
    this.requestRender();
  }

  /** Clear the footer editor's draft input. */
  clearInput(): void {
    this.footer.editor.setText("");
    this.requestRender();
  }

  delegateStarted(index: number, taskCount = 1): void {
    const cardId = this.sidekicks.start(index, taskCount);
    this.attachCard(cardId);
    this.updateSidekickStatus();
    this.syncAnimation();
    this.requestRender();
  }

  delegateActivity(
    index: number,
    activity: LocalSidekickActivity,
    taskCount = 1,
  ): void {
    const cardId = this.sidekicks.activity(index, taskCount, activity);
    this.attachCard(cardId);
    this.updateSidekickStatus();
    this.syncAnimation();
    this.requestRender();
  }

  delegateFinished(
    index: number,
    result: LocalSidekickResult,
    taskCount = 1,
  ): void {
    const cardId = this.sidekicks.finish(index, taskCount, result);
    this.attachCard(cardId);
    this.updateSidekickStatus();
    this.syncAnimation();
    this.requestRender();
  }

  setStatus(update: {
    managerModel?: string;
    sidekickModel?: string;
    sessionId?: string;
    thinking?: string;
    context?: ContextSummary;
    turn?: number;
  }): void {
    if (update.managerModel !== undefined) {
      this.header.setManagerModel(update.managerModel);
    }
    if (update.sidekickModel !== undefined) {
      this.header.setSidekickModel(update.sidekickModel);
    }
    if (update.sessionId !== undefined) {
      this.header.setSessionId(update.sessionId);
    }
    if (update.thinking !== undefined) {
      this.header.setThinking(update.thinking);
    }
    this.footer.setStatus({
      managerModel: update.managerModel,
      thinking: update.thinking,
      context: update.context,
    });
    this.requestRender();
  }

  /** Public turn signal retained for CLI compatibility (no header turn chip). */
  setTurn(_turn: number): void {
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
