export const ANIMATION_INTERVAL_MS = 100;
export const CURSOR_BLINK_FRAMES = 5;
export const QUEUED_PULSE_FRAMES = 6;

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export interface AnimationState {
  frame: number;
  now: number;
}

export function spinnerFrame(frame: number): string {
  const index = ((Math.floor(frame) % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[index] ?? SPINNER_FRAMES[0];
}

/** Cursor is visible for 500ms, hidden for 500ms at the 100ms ticker rate. */
export function cursorVisible(frame: number): boolean {
  return Math.floor(frame / CURSOR_BLINK_FRAMES) % 2 === 0;
}

/** Slow queued-state pulse: alternate every 600ms. */
export function pulsePhase(frame: number): number {
  return Math.floor(frame / QUEUED_PULSE_FRAMES) % 2;
}

export class AnimationTicker {
  readonly state: AnimationState;
  private timer?: Timer;
  private readonly intervalMs: number;
  private readonly nowFn: () => number;
  private readonly onTick?: (state: AnimationState) => void;

  constructor(options: {
    intervalMs?: number;
    now?: () => number;
    onTick?: (state: AnimationState) => void;
  } = {}) {
    this.intervalMs = options.intervalMs ?? ANIMATION_INTERVAL_MS;
    this.nowFn = options.now ?? Date.now;
    this.state = { frame: 0, now: this.nowFn() };
    this.onTick = options.onTick;
  }

  get running(): boolean { return this.timer !== undefined; }

  tick(): void {
    this.state.frame += 1;
    this.state.now = this.nowFn();
    this.onTick?.(this.state);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
