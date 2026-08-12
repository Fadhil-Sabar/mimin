import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@mariozechner/pi-tui";
import {
  AnimationTicker,
  Footer,
  SidekickActivity,
  Transcript,
  ToolActivity,
  cursorVisible,
  pulsePhase,
  spinnerFrame,
} from "../src/tui/index.js";

const plain = (lines: string[]) => lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");

describe("TUI animation primitives", () => {
  test("ticker advances shared frame and is idempotent", () => {
    let now = 1000;
    const ticker = new AnimationTicker({ now: () => now });
    expect(ticker.running).toBe(false);
    ticker.tick();
    expect(ticker.state).toEqual({ frame: 1, now: 1000 });
    now = 1200;
    ticker.tick();
    expect(ticker.state).toEqual({ frame: 2, now: 1200 });
    ticker.start();
    ticker.start();
    expect(ticker.running).toBe(true);
    ticker.stop();
    ticker.stop();
    expect(ticker.running).toBe(false);
  });

  test("spinner, cursor, and queued pulse phases are deterministic", () => {
    expect(spinnerFrame(0)).toBe("⠋");
    expect(spinnerFrame(10)).toBe("⠋");
    expect(cursorVisible(0)).toBe(true);
    expect(cursorVisible(4)).toBe(true);
    expect(cursorVisible(5)).toBe(false);
    expect(cursorVisible(10)).toBe(true);
    expect(pulsePhase(0)).toBe(0);
    expect(pulsePhase(5)).toBe(0);
    expect(pulsePhase(6)).toBe(1);
    expect(pulsePhase(12)).toBe(0);
  });

  test("footer renders working spinner, elapsed time, and cancelling", () => {
    let now = 5000;
    const footer = new Footer({ managerModel: "model", now: () => now });
    footer.setStatus({ managerWorking: true });
    expect(plain(footer.render(100))).toContain("⠋ working");
    now = 8000;
    expect(plain(footer.render(100))).toContain("3s");
    footer.setStatus({ cancelling: true });
    expect(plain(footer.render(100))).toContain("cancelling");
    footer.setStatus({ managerWorking: false });
    expect(plain(footer.render(100))).toContain("/help");
  });

  test("running tools and sidekicks use shared spinner frames", () => {
    const state = { frame: 0, now: 0 };
    const tools = new ToolActivity(state);
    tools.apply({ type: "tool_start", turn: 1, toolCall: { name: "read", arguments: { path: "a.ts" } } });
    expect(plain(tools.render(80))).toContain("⠋ read");
    state.frame = 2;
    expect(plain(tools.render(80))).toContain("⠹ read");

    const cards = new SidekickActivity("/repo", () => 0, state);
    cards.apply({ type: "delegation_started", index: 0, taskCount: 1 });
    expect(plain(cards.render(80))).toContain("○ queued");
    cards.apply({
      type: "sidekick_activity", index: 0, taskCount: 1,
      activity: { type: "sidekick_started", sessionId: "s" },
    });
    expect(plain(cards.render(80))).toContain("⠹ running");
  });

  test("streaming cursor blinks without changing transcript height", () => {
    const state = { frame: 0, now: 0 };
    const transcript = new Transcript(20, state);
    const id = transcript.beginManagerStream("hello");
    expect(plain(transcript.render(40))).toContain("hello▌");
    state.frame = 5;
    expect(plain(transcript.render(40))).not.toContain("hello▌");
    for (const line of transcript.render(5)) expect(visibleWidth(line)).toBeLessThanOrEqual(5);
    transcript.finishStream(id);
    expect(plain(transcript.render(40))).not.toContain("▌");
  });
});
