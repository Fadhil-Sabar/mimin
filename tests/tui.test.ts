import { describe, expect, test } from "bun:test";
import {
  visibleWidth,
  type Component,
} from "@mariozechner/pi-tui";
import {
  createApp,
  Footer,
  Header,
  SidekickActivity,
  Transcript,
  type TuiHost,
} from "../src/tui/index.js";

class FakeTui implements TuiHost {
  readonly children: Component[] = [];
  focused: Component | null = null;
  listener?: (data: string) => { consume?: boolean; data?: string } | undefined;
  starts = 0;
  stops = 0;
  renders = 0;
  writes: string[] = [];

  addChild(component: Component): void {
    this.children.push(component);
  }

  setFocus(component: Component | null): void {
    this.focused = component;
    if (component && "focused" in component) {
      (component as Component & { focused: boolean }).focused = true;
    }
  }

  addInputListener(
    listener: (data: string) => { consume?: boolean; data?: string } | undefined,
  ): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  start(): void {
    this.starts += 1;
  }

  stop(): void {
    this.stops += 1;
  }

  requestRender(force?: boolean): void {
    this.renders += 1;
    if (force) this.forcedRenders += 1;
  }

  forcedRenders = 0;
  /** Test seam: a fake terminal exposing row height to the app. */
  terminal?: { rows: number; write?: (data: string) => void };
}

function expectWidth(lines: string[], width: number): void {
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
}

/** Join rendered lines and strip ANSI codes so assertions check visible text. */
function textOf(lines: string[]): string {
  return lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
}

describe("lightweight pi-tui areas", () => {
  test("header and footer sanitize and fit narrow widths", () => {
    const header = new Header({
      product: "mi\u001b[31mmin",
      managerModel: "manager\nmodel",
      sidekickModel: "sidekick\u0000model",
      sessionId: "manager-abc12345",
      workspace: "/long/workspace/project",
    });
    const footer = new Footer({
      managerModel: "manager\u0000model",
      thinking: "medium",
      context: { used: 50, limit: 100 },
    });

    for (const width of [1, 4, 12, 32]) {
      expectWidth(header.render(width), width);
      expectWidth(footer.render(width), width);
    }
    const rendered = textOf([...header.render(80), ...footer.render(80)]);
    expect(rendered).not.toContain("\u001b[31m");
    // The compact header shows role identity, not the workspace.
    expect(rendered).toContain("manager");
    expect(rendered).toContain("50/100 (50%)");
    // The workspace is retained for call-site compatibility but never rendered.
    expect(rendered).not.toContain("project");
  });

  test("transcript updates one manager component during streaming", () => {
    const transcript = new Transcript();
    transcript.append("user", "hello");
    const stream = transcript.beginManagerStream();
    transcript.appendStreamDelta(stream, "stream");
    transcript.appendStreamDelta(stream, "ed");

    expect(transcript.entries).toHaveLength(2);
    expect(transcript.entries[1]).toMatchObject({
      role: "manager",
      text: "streamed",
      streaming: true,
    });
    // Manager markdown renders without a repeated "Manager:" prefix.
    const rendered = textOf(transcript.render(40));
    expect(rendered).toContain("streamed");
    expect(rendered).not.toContain("Manager: streamed");
    transcript.updateStream(stream, "final");
    transcript.finishStream(stream);
    expect(transcript.entries[1]).toMatchObject({ text: "final", streaming: false });
    expectWidth(transcript.render(6), 6);
  });

  test("manager markdown renders headings/bold/code/lists via pi-tui", () => {
    const transcript = new Transcript();
    const id = transcript.beginManagerStream();
    transcript.updateStream(id, "# Title\n\n**bold** `code`\n\n- item\n");
    const lines = textOf(transcript.render(60));
    expect(lines).toContain("Title");
    expect(lines).toContain("bold");
    expect(lines).toContain("code");
    expect(lines).toContain("item");
    // A bare "Mimin" label line, then the markdown body (no "Manager:" prefix).
    expect(lines).toContain("Mimin");
    expect(lines).not.toContain("Manager:");
    expect(lines).not.toContain("◆ Manager");
    // Raw markdown markers never reach rendered output (the list renders as a
    // styled bullet, not the source "- item" line).
    expect(lines).not.toContain("# Title");
    expect(lines).not.toContain("**bold**");
    expect(lines).not.toContain("`code`");
    expect(lines).toContain("item");
  });

  test("user entries render a distinct You label with no You: prefix", () => {
    const transcript = new Transcript();
    transcript.append("user", "hello world");
    const lines = textOf(transcript.render(60));
    // A distinct "You" label line, then the plain text body.
    expect(lines).toContain("You");
    expect(lines).toContain("hello world");
    expect(lines).not.toContain("You:");
    expect(lines).not.toContain("> hello world");
  });

  test("sidekick cards collapse, expand safe activity, and never retain raw fields", () => {
    const cards = new SidekickActivity("/repo");
    cards.apply({ type: "delegation_started", index: 0, taskCount: 2 });
    cards.apply({
      type: "sidekick_activity",
      index: 0,
      taskCount: 2,
      activity: {
        type: "sidekick_started",
        sessionId: "session-0",
        transcript: "SIDEKICK TRANSCRIPT",
      },
    } as Parameters<SidekickActivity["apply"]>[0]);
    cards.apply({
      type: "sidekick_activity",
      index: 0,
      taskCount: 2,
      activity: {
        type: "tool_started",
        sessionId: "session-0",
        tool: "edit",
        reasoning: "PRIVATE REASONING",
      },
    } as Parameters<SidekickActivity["apply"]>[0]);
    cards.apply({
      type: "sidekick_activity",
      index: 0,
      taskCount: 2,
      activity: {
        type: "tool_finished",
        sessionId: "session-0",
        tool: "edit",
        ok: true,
        path: "/repo/src/safe.ts",
        rawCommandOutput: "RAW COMMAND OUTPUT",
        fileContents: "PRIVATE FILE CONTENT",
      },
    } as Parameters<SidekickActivity["apply"]>[0]);
    cards.apply({
      type: "delegation_finished",
      index: 0,
      taskCount: 2,
      result: {
        status: "complete",
        summary: "implemented safely",
        sessionId: "session-0",
        messages: ["SIDEKICK TRANSCRIPT"],
        logs: "FULL LOG",
      },
    } as Parameters<SidekickActivity["apply"]>[0]);

    const collapsed = textOf(cards.render(100));
    // Compact box card with lowercase safe activity rows and semantic status.
    expect(collapsed).toContain("✓ done");
    expect(collapsed).toContain("implemented safely");
    expect(collapsed).toContain("edit src/safe.ts");
    // Box card shape and hidden UUIDs.
    expect(collapsed).toContain("┌─ sidekick #1");
    expect(collapsed).toContain("└");
    expect(collapsed).not.toContain("session-0");
    // Only whitelisted activity labels reach the card; private fields never do.
    for (const secret of [
      "SIDEKICK TRANSCRIPT",
      "PRIVATE REASONING",
      "RAW COMMAND OUTPUT",
      "PRIVATE FILE CONTENT",
      "FULL LOG",
    ]) expect(collapsed).not.toContain(secret);
    expectWidth(cards.render(7), 7);
  });

  test("maps every sidekick lifecycle result status", () => {
    for (const [index, status] of [
      [0, "complete"],
      [1, "partial"],
      [2, "blocked"],
      [3, "needs_decision"],
    ] as const) {
      const cards = new SidekickActivity();
      cards.apply({ type: "delegation_started", index, taskCount: 4 });
      expect(textOf(cards.render(80))).toContain("○ queued");
      cards.apply({
        type: "delegation_finished",
        index,
        taskCount: 4,
        result: { status, summary: status, sessionId: `s-${index}` },
      });
      const verb = status === "needs_decision"
        ? "× decision"
        : status === "blocked"
          ? "× failed"
          : status === "complete"
            ? "✓ done"
            : "× partial";
      expect(textOf(cards.render(80))).toContain(verb);
    }
  });

  test("app areas, async nonempty submit, stream mapping, scroll keys, and two-stage Ctrl-C exit", async () => {
    const host = new FakeTui();
    const submitted: string[] = [];
    let exited = false;
    const app = createApp({
      managerModel: "test-model",
      workspace: "/repo/project",
      tui: host,
      onSubmit: async (line) => {
        await Promise.resolve();
        submitted.push(line);
      },
      onExit: () => {
        exited = true;
      },
    });

    expect(host.children).toEqual([
      app.header,
      app.transcript,
      app.footer,
    ]);
    // The sidekick view model is NOT a top-level TUI child (cards are inline).
    expect(host.children).not.toContain(app.sidekicks);
    app.footer.input.setText("   ");
    app.footer.handleInput("\r");
    app.footer.input.setText("ship it");
    app.footer.handleInput("\r");
    // Flush the submit promise chain (no wall-clock timer).
    await Promise.resolve();
    await Promise.resolve();
    expect(submitted).toEqual(["ship it"]);
    expect(textOf(app.transcript.render(80))).toContain("ship it");
    expect(textOf(app.transcript.render(80))).toContain("You");

    // setRunning flips the footer immediately, before any model event.
    // (The compact header renders no run state.)
    app.setRunning(true);
    expect(textOf(app.footer.render(80))).toContain("esc cancel");
    app.setRunning(false);
    expect(textOf(app.footer.render(80))).not.toContain("esc cancel");

    app.handleManagerEvent({ type: "model_event", event: { type: "text_start" } });
    app.handleManagerEvent({ type: "model_event", event: { type: "text_delta", delta: "done" } });
    app.handleManagerEvent({ type: "model_event", event: { type: "text_end", content: "done" } });
    // Manager markdown renders without a repeated "Manager:" prefix.
    const transcriptLines = textOf(app.transcript.render(80));
    expect(transcriptLines).toContain("done");
    expect(transcriptLines).not.toContain("Manager: done");
    // The header stays identity-only (no run state) while the run is active.
    expect(textOf(app.header.render(80))).not.toContain("working");
    expect(textOf(app.header.render(80))).toContain("manager");

    // PageUp during a run pages the transcript back without exiting.
    expect(host.listener?.("\u001b[5~")).toEqual({ consume: true });

    app.start();
    // Ctrl-C while running only arms the warning; it does not exit.
    host.listener?.("\u0003");
    expect(exited).toBe(false);
    expect(textOf(app.transcript.render(80))).toContain("Ctrl-C again");
    // The second Ctrl-C (idle path) exits.
    host.listener?.("\u0003");
    expect(exited).toBe(true);
    expect(host.starts).toBe(1);
    expect(host.stops).toBe(1);
  });

  test("decodes SGR wheel input and brackets real TUI lifecycle with mouse tracking", () => {
    const host = new FakeTui();
    host.terminal = {
      rows: 12,
      write: (data: string) => host.writes.push(data),
    };
    const app = createApp({
      managerModel: "test-model",
      workspace: "/repo/project",
      tui: host,
    });
    for (let i = 0; i < 30; i += 1) app.addInfo(`info ${i}`);

    const tail = textOf(app.render(80));
    expect(tail).toContain("info 29");
    // A wheel-down at the already-rendered tail must not disable autoscroll.
    expect(host.listener?.("\u001b[<65;10;5m")).toEqual({ consume: true });
    expect(app.transcript.isTailAnchored()).toBe(true);
    app.startManagerStream("bottom stream");
    app.appendManagerDelta("newest delta after bottom wheel");
    expect(textOf(app.render(80))).toContain("newest delta after bottom wheel");

    app.start();
    app.start();
    expect(host.writes).toEqual(["\u001b[?1000h\u001b[?1006h"]);

    for (let i = 0; i < 6; i += 1) {
      expect(host.listener?.("\u001b[<64;10;5M")).toEqual({ consume: true });
    }
    const pagedUp = textOf(app.render(80));
    expect(pagedUp).not.toContain("info 29");
    for (let i = 0; i < 6; i += 1) {
      expect(host.listener?.("\u001b[<65;10;5m")).toEqual({ consume: true });
    }
    expect(textOf(app.render(80))).toContain("info 29");

    app.stop();
    app.stop();
    expect(host.writes).toEqual([
      "\u001b[?1000h\u001b[?1006h",
      "\u001b[?1006l\u001b[?1000l",
    ]);
  });

  test("tool rows render compactly with success summarized and errors visible", () => {
    const host = new FakeTui();
    const app = createApp({
      managerModel: "test-model",
      workspace: "/repo/project",
      tui: host,
    });

    app.handleManagerEvent({
      type: "model_event",
      event: { type: "tool_start", turn: 1, toolCall: { name: "read", arguments: { path: "src/app.ts" } } },
    });
    app.handleManagerEvent({
      type: "model_event",
      event: {
        type: "tool_end",
        turn: 1,
        toolCall: { name: "read" },
        result: { isError: false, details: { path: "src/app.ts", bytes: 12 } },
      },
    });
    app.handleManagerEvent({
      type: "model_event",
      event: { type: "tool_start", turn: 1, toolCall: { name: "edit" } },
    });
    app.handleManagerEvent({
      type: "model_event",
      event: {
        type: "tool_end",
        turn: 1,
        toolCall: { name: "edit" },
        result: { isError: true, text: "oldText was not found" },
      },
    });

    const rows = textOf(app.transcript.render(80));
    // Lowercase aligned labels, path from tool_start args, no debug text.
    expect(rows).toContain("✓ read   src/app.ts");
    expect(rows).toContain("✕ edit");
    expect(rows).toContain("oldText was not found");
    expect(rows).not.toContain("(turn");
    expect(rows).not.toContain("[ok]");
    expect(rows).not.toContain("[error]");
    // Raw output never reaches the rows.
    expect(rows).not.toContain("stdout");
    expectWidth(app.transcript.render(12), 12);
  });

  test("tool rows parse path/command from tool_start arguments", () => {
    const app = createApp({
      managerModel: "test-model",
      workspace: "/repo/project",
      tui: new FakeTui(),
    });
    app.handleManagerEvent({
      type: "model_event",
      event: {
        type: "tool_start",
        turn: 2,
        toolCall: { name: "bash", arguments: { command: "bun test" } },
      },
    });
    app.handleManagerEvent({
      type: "model_event",
      event: {
        type: "tool_start",
        turn: 2,
        toolCall: { name: "edit", arguments: { path: "src/cli.ts" } },
      },
    });
    const rows = textOf(app.transcript.render(80));
    expect(rows).toContain("● bash   bun test");
    expect(rows).toContain("● edit   src/cli.ts");
    expect(rows).toContain("…");
  });

  test("delegate is represented by the sidekick card, not a tool row", () => {
    const app = createApp({
      managerModel: "test-model",
      workspace: "/repo/project",
      tui: new FakeTui(),
    });
    app.handleManagerEvent({
      type: "model_event",
      event: {
        type: "tool_start",
        turn: 1,
        toolCall: { name: "delegate", arguments: { task: "implement" } },
      },
    });
    app.handleManagerEvent({
      type: "model_event",
      event: {
        type: "tool_end",
        turn: 1,
        toolCall: { name: "delegate" },
        result: { isError: false, details: [{ status: "complete" }] },
      },
    });
    expect(app.transcript.render(80)).toEqual([]);
    // No tool block appears in the transcript either (delegate is a card).
    expect(textOf(app.transcript.render(80))).not.toContain("Delegate");
  });

  test("tool rows show pending/running/completed/failed states", () => {
    const app = createApp({
      managerModel: "test-model",
      workspace: "/repo/project",
      tui: new FakeTui(),
    });
    // Read: running, then completed.
    app.handleManagerEvent({
      type: "model_event",
      event: { type: "tool_start", turn: 1, toolCall: { name: "read", arguments: { path: "a.ts" } } },
    });
    expect(textOf(app.transcript.render(80))).toContain("● read   a.ts");
    app.handleManagerEvent({
      type: "model_event",
      event: { type: "tool_end", turn: 1, toolCall: { name: "read" }, result: { isError: false } },
    });
    expect(textOf(app.transcript.render(80))).toContain("✓ read   a.ts");
    // Edit: fails.
    app.handleManagerEvent({
      type: "model_event",
      event: { type: "tool_start", turn: 1, toolCall: { name: "edit", arguments: { path: "b.ts" } } },
    });
    expect(textOf(app.transcript.render(80))).toContain("● edit   b.ts");
    app.handleManagerEvent({
      type: "model_event",
      event: { type: "tool_end", turn: 1, toolCall: { name: "edit" }, result: { isError: true, text: "boom" } },
    });
    const rows = textOf(app.transcript.render(80));
    expect(rows).toContain("✕ edit   b.ts");
    expect(rows).toContain("boom");
  });

  test("tool errors drop the redundant tool-name prefix and stay compact", () => {
    const app = createApp({
      managerModel: "test-model",
      workspace: "/repo/project",
      tui: new FakeTui(),
    });
    app.handleManagerEvent({
      type: "model_event",
      event: { type: "tool_start", turn: 1, toolCall: { name: "read", arguments: { path: "src" } } },
    });
    app.handleManagerEvent({
      type: "model_event",
      event: {
        type: "tool_end",
        turn: 1,
        toolCall: { name: "read" },
        result: { isError: true, text: 'Tool "read" failed: Path "src" is not a regular file' },
      },
    });
    const rows = textOf(app.transcript.render(80));
    // The name is already in the label column; the prefix is stripped.
    expect(rows).toContain("✕ read   src");
    expect(rows).not.toContain('Tool "read" failed:');
    expect(rows).toContain('Path "src" is not a regular file');
  });

  test("tool error text is sanitized and truncated", () => {
    const app = createApp({
      managerModel: "test-model",
      workspace: "/repo/project",
      tui: new FakeTui(),
    });
    app.handleManagerEvent({
      type: "model_event",
      event: { type: "tool_start", turn: 1, toolCall: { name: "bash" } },
    });
    app.handleManagerEvent({
      type: "model_event",
      event: {
        type: "tool_end",
        turn: 1,
        toolCall: { name: "bash" },
        result: {
          isError: true,
          text: "\u001b[31mTool \"bash\" failed: ENOENT: no such file " + "x".repeat(200),
        },
      },
    });
    const rows = textOf(app.transcript.render(80));
    expect(rows).toContain("✕ bash");
    expect(rows).toContain("ENOENT: no such file");
    expect(rows).not.toContain("\u001b[31m");
    // The error sub-line is compact: "· " marker plus a 60-char error cap.
    const errorLine = rows.split("\n").find((line) => line.trimStart().startsWith("·")) ?? "";
    expect(errorLine.length).toBeLessThanOrEqual(64);
    const errorText = errorLine.slice(errorLine.indexOf("ENOENT"));
    expect(errorText.length).toBeLessThanOrEqual(60);
  });

  test("running tool row is updated in place, no duplicate on completion", () => {
    const app = createApp({
      managerModel: "test-model",
      workspace: "/repo/project",
      tui: new FakeTui(),
    });
    app.handleManagerEvent({
      type: "model_event",
      event: { type: "tool_start", turn: 1, toolCall: { name: "read", arguments: { path: "a.ts" } } },
    });
    app.handleManagerEvent({
      type: "model_event",
      event: { type: "tool_end", turn: 1, toolCall: { name: "read" }, result: { isError: false } },
    });
    const rows = textOf(app.transcript.render(80));
    // Exactly one row, now completed; no second "running" copy survives.
    expect(rows.match(/read/g)).toHaveLength(1);
    expect(rows).toContain("✓ read   a.ts");
    expect(rows).not.toContain("● read");
  });

  test("tool rows group per turn, inline in conversation order", () => {
    const app = createApp({
      managerModel: "test-model",
      workspace: "/repo/project",
      tui: new FakeTui(),
    });
    // Turn 1: user prompt, read, verify.
    app.addUser("fix the bug");
    app.handleManagerEvent({
      type: "model_event",
      event: { type: "tool_start", turn: 1, toolCall: { name: "read", arguments: { path: "a.ts" } } },
    });
    app.handleManagerEvent({
      type: "model_event",
      event: { type: "tool_end", turn: 1, toolCall: { name: "read" }, result: { isError: false } },
    });
    app.handleManagerEvent({
      type: "model_event",
      event: { type: "tool_start", turn: 1, toolCall: { name: "verification", arguments: { action: "test" } } },
    });
    app.handleManagerEvent({
      type: "model_event",
      event: { type: "tool_end", turn: 1, toolCall: { name: "verification" }, result: { isError: false, details: { action: "test", ok: true, results: [{ command: "bun test", exitCode: 0, ok: true }] } } },
    });
    // Turn 2: manager text, then another read.
    app.handleManagerEvent({ type: "model_event", event: { type: "text_start", turn: 2 } });
    app.handleManagerEvent({ type: "model_event", event: { type: "text_delta", turn: 2, delta: "done" } });
    app.handleManagerEvent({ type: "model_event", event: { type: "text_end", turn: 2, content: "done" } });
    app.handleManagerEvent({
      type: "model_event",
      event: { type: "tool_start", turn: 2, toolCall: { name: "read", arguments: { path: "b.ts" } } },
    });
    app.handleManagerEvent({
      type: "model_event",
      event: { type: "tool_end", turn: 2, toolCall: { name: "read" }, result: { isError: false } },
    });

    const rows = textOf(app.transcript.render(80));
    // Both tool blocks appear inline, after their user prompt / manager text.
    expect(rows).toContain("fix the bug");
    expect(rows).toContain("✓ read   a.ts");
    expect(rows).toContain("✓ verify bun test");
    expect(rows).toContain("done");
    expect(rows).toContain("✓ read   b.ts");
    // Order preserved: turn 1 tools before turn 2 text and tools.
    expect(rows.indexOf("✓ read   a.ts")).toBeLessThan(rows.indexOf("✓ verify bun test"));
    expect(rows.indexOf("✓ verify bun test")).toBeLessThan(rows.indexOf("done"));
    expect(rows.indexOf("done")).toBeLessThan(rows.indexOf("✓ read   b.ts"));
  });

  test("bash rows show only the whitelisted command, never raw output", () => {
    const app = createApp({
      managerModel: "test-model",
      workspace: "/repo/project",
      tui: new FakeTui(),
    });
    app.handleManagerEvent({
      type: "model_event",
      event: { type: "tool_start", turn: 1, toolCall: { name: "bash", arguments: { command: "bun test" } } },
    });
    app.handleManagerEvent({
      type: "model_event",
      event: {
        type: "tool_end",
        turn: 1,
        toolCall: { name: "bash" },
        result: {
          isError: false,
          text: "13 pass\n0 fail\n[stdout] 4.2s",
          details: { command: "bun test" },
        },
      },
    });
    const rows = textOf(app.transcript.render(80));
    expect(rows).toContain("✓ bash   bun test · 13 passed");
    // Only the parsed count summary is shown; raw output lines never leak.
    expect(rows).not.toContain("0 fail");
    expect(rows).not.toContain("[stdout] 4.2s");
    expect(rows).not.toContain("stdout");
  });

  test("verification rows gain a safe summary from whitelisted details", () => {
    const app = createApp({
      managerModel: "test-model",
      workspace: "/repo/project",
      tui: new FakeTui(),
    });
    app.handleManagerEvent({
      type: "model_event",
      event: { type: "tool_start", turn: 1, toolCall: { name: "verification", arguments: { action: "test" } } },
    });
    expect(textOf(app.transcript.render(80))).toContain("● verify");
    app.handleManagerEvent({
      type: "model_event",
      event: {
        type: "tool_end",
        turn: 1,
        toolCall: { name: "verification" },
        result: {
          isError: false,
          text: '{"action":"test","ok":true,"results":[{"command":"bun test","exitCode":0,"ok":true}]}',
          details: {
            action: "test",
            ok: true,
            results: [
              { command: "bun test", exitCode: 0, ok: true, stdout: "81 tests passed\n", stderr: "" },
            ],
          },
        },
      },
    });
    const rows = textOf(app.transcript.render(80));
    expect(rows).toContain("✓ verify bun test");
    expect(rows).toContain("passed");
    // No raw output from the details leaks into the row.
    expect(rows).not.toContain("81 tests passed");
    expect(rows).not.toContain("stdout");
  });

  test("tool rows truncate at narrow widths", () => {
    const app = createApp({
      managerModel: "test-model",
      workspace: "/repo/project",
      tui: new FakeTui(),
    });
    app.handleManagerEvent({
      type: "model_event",
      event: { type: "tool_start", turn: 1, toolCall: { name: "bash", arguments: { command: "bun test --coverage --verbose" } } },
    });
    const wide = app.transcript.render(80);
    expect(textOf(wide)).toContain("bun test --coverage");
    expectWidth(wide, 80);
    const narrow = app.transcript.render(10);
    expectWidth(narrow, 10);
  });

  test("sidekick cards show model, task, status, elapsed, and summary; hide UUIDs", () => {
    const cards = new SidekickActivity("/repo");
    cards.apply({
      type: "delegation_started",
      index: 0,
      taskCount: 1,
      task: "implement feature",
      model: "gpt-5.5",
    });
    const queued = textOf(cards.render(100));
    expect(queued).toContain("○ queued");
    expect(queued).toContain("sidekick #1 · implement feature");
    expect(queued).not.toContain("session-");

    cards.apply({
      type: "delegation_finished",
      index: 0,
      taskCount: 1,
      task: "implement feature",
      model: "gpt-5.5",
      result: {
        status: "complete",
        summary: "done safely",
        sessionId: "session-abc",
        filesChanged: ["src/app.ts"],
        verification: [{ command: "bun test", status: "passed" }],
      },
    });
    const done = textOf(cards.render(100));
    expect(done).toContain("✓ done");
    expect(done).toContain("done safely");
    expect(done).toContain("1 file changed · 1 check passed");
    expect(done).not.toContain("session-abc");
    // The card id is stable and the renderer targets exactly that card.
    const id = cards.apply({ type: "delegation_started", index: 1, taskCount: 1, task: "other", model: "gpt-5.5" });
    expect(id).toBeDefined();
    const renderer = cards.rendererFor(id!);
    expect(renderer(100).join("\n")).toContain("sidekick #2 · other");
    expect(renderer(100).join("\n")).not.toContain("sidekick #1");
  });

  test("header shows thinking, models, session; footer shows sidekick working count", () => {
    const header = new Header({
      product: "mimin",
      managerModel: "gpt-5.5",
      sidekickModel: "deepseek-v4",
      sessionId: "manager-abc12345",
      workspace: "/repo/project",
      thinking: "high",
    });
    const footer = new Footer({
      managerModel: "gpt-5.5",
      thinking: "high",
      sidekickWorking: 2,
      sidekickTotal: 3,
    });
    const headerLines = textOf(header.render(120));
    expect(headerLines).toContain("manager gpt-5.5");
    expect(headerLines).toContain("sidekick deepseek-v4");
    expect(headerLines).toContain("thinking high");
    expect(headerLines).toContain("session abc12345");
    expect(headerLines).toContain("·");
    // The workspace is never rendered by the compact header.
    expect(headerLines).not.toContain("project");
    const footerLines = textOf(footer.render(80));
    // Idle footer: slash hints + sidekick working/total status.
    expect(footerLines).toContain("/help");
    expect(footerLines).toContain("2/3 sidekicks running");
    // Horizontal rule separates the footer from content above.
    expect(textOf([footer.render(80)[0] ?? ""])).toMatch(/^─+$/);
    footer.setStatus({ sidekickWorking: 0, sidekickTotal: 0 });
    expect(textOf(footer.render(80))).toContain("sidekick: idle");
  });

  test("transcript is bounded to the viewport so streaming does not yank the scroll position", () => {
    const host = new FakeTui();
    // Expose a terminal height so the app caps the transcript to the viewport.
    host.terminal = { rows: 24, write: () => {} };
    const app = createApp({
      managerModel: "test-model",
      workspace: "/repo/project",
      tui: host,
    });
    // Fill beyond the viewport, then render so paging uses measured rows.
    for (let i = 0; i < 40; i += 1) app.addInfo(`info ${i}`);
    app.render(80);
    app.transcript.scrollUp(12);
    const before = app.render(80);
    // Stream a long manager response (grows the body).
    const sid = app.startManagerStream("Answer:");
    app.appendManagerDelta("Long answer that wraps across many lines. ".repeat(200));
    app.appendManagerDelta("Even more streaming content. ".repeat(200));
    const after = app.render(80);
    // The rendered height must be stable so pi-tui never sees growth and
    // scrolls the terminal to the tail.
    expect(after.length).toBe(before.length);
    // And the scrolled-up position holds: the same content stays at the top.
    expect(after[2]).toBe(before[2]);
    // The new streamed content is NOT visible (viewport is pinned up).
    expect(after.join("\n")).not.toContain("Answer:");
  });

  test("manager streaming follows the tail but preserves an intentional scroll-up", () => {
    const host = new FakeTui();
    host.terminal = { rows: 24 };
    const app = createApp({
      managerModel: "test-model",
      workspace: "/repo/project",
      tui: host,
    });
    for (let i = 0; i < 40; i += 1) app.addInfo(`info ${i}`);
    app.render(80);
    expect(app.transcript.isTailAnchored()).toBe(true);

    app.startManagerStream("stream start");

    app.appendManagerDelta(" first streamed delta");
    expect(textOf(app.render(80))).toContain("first streamed delta");
    expect(app.transcript.isTailAnchored()).toBe(true);
    app.appendManagerDelta(" newest streamed text");
    expect(textOf(app.render(80))).toContain("newest streamed text");

    app.transcript.scrollUp(12);
    const beforeScrolled = app.render(80);
    expect(app.transcript.isTailAnchored()).toBe(false);
    app.appendManagerDelta(" hidden while intentionally scrolled up");
    const afterScrolled = app.render(80);
    expect(afterScrolled.length).toBe(beforeScrolled.length);
    expect(afterScrolled[2]).toBe(beforeScrolled[2]);
    expect(textOf(afterScrolled)).not.toContain("hidden while intentionally scrolled up");
  });


  test("End restores autoscroll so new content is visible again", () => {
    const host = new FakeTui();
    host.terminal = { rows: 24 };
    const app = createApp({
      managerModel: "test-model",
      workspace: "/repo/project",
      tui: host,
    });
    for (let i = 0; i < 40; i += 1) app.addInfo(`info ${i}`);
    app.transcript.scrollUp(12);
    app.transcript.scrollToBottom();
    app.addInfo("fresh tail");
    const view = app.render(80);
    // Tail-anchored again: the newest content is visible.
    expect(view.join("\n")).toContain("fresh tail");
  });

  test("the live tick timer never forces a full redraw (viewport must hold during streaming)", async () => {
    const host = new FakeTui();
    const app = createApp({
      managerModel: "test-model",
      workspace: "/repo/project",
      tui: host,
    });
    app.start();
    // A run is active: the tick timer invalidates and re-renders each second.
    app.handleManagerEvent({ type: "model_event", event: { type: "text_start" } });
    const before = host.forcedRenders;
    // Tick: wait for the interval to fire.
    await Bun.sleep(1_100);
    const during = host.forcedRenders;
    app.stop();
    // The tick must not force full redraws (force resets pi-tui's viewport).
    expect(during).toBe(before);
  });

  test("header is identity-only (no run state/turn); footer spinner while working", () => {
    const header = new Header({
      managerModel: "gpt-5.5",
      workspace: "/repo/project",
    });
    expect(textOf(header.render(80))).toContain("manager gpt-5.5");
    expect(textOf(header.render(80))).not.toContain("turn");
    // Run state and turn are no-ops on the compact header (footer drives status).
    header.setRunState("running");
    header.setTurn(2);
    expect(textOf(header.render(80))).not.toContain("working");
    expect(textOf(header.render(80))).not.toContain("turn");
    header.setRunState("idle");
    expect(textOf(header.render(80))).not.toContain("idle");

    const footer = new Footer({
      managerModel: "gpt-5.5",
      managerWorking: true,
    });
    // Running footer: esc cancel / ctrl+c quit + elapsed; no slash hints.
    const statusLines = textOf(footer.render(80));
    expect(statusLines).toContain("esc cancel");
    expect(statusLines).toContain("ctrl+c quit");
    expect(statusLines).not.toContain("/help");
    footer.setStatus({ managerWorking: false });
    // Idle shows the slash hints, not the cancel prompt.
    expect(textOf(footer.render(80))).toContain("/help");
    expect(textOf(footer.render(80))).not.toContain("esc cancel");
  });

  test("header turn chip is gone; app setTurn is a compat no-op", () => {
    const host = new FakeTui();
    const app = createApp({
      managerModel: "test-model",
      workspace: "/repo/project",
      tui: host,
    });
    app.handleManagerEvent({ type: "model_event", event: { type: "text_start" } });
    app.setTurn(1);
    expect(textOf(app.header.render(80))).not.toContain("turn");
    expect(textOf(app.header.render(80))).not.toContain("working");
    // The run ends: the footer working state clears with it.
    app.handleManagerEvent({ type: "model_event", event: { type: "done" } });
    expect(textOf(app.footer.render(80))).not.toContain("working");
  });

  test("transcript scrollback: tail-anchored viewport pages and re-pins", () => {
    const transcript = new Transcript(12);
    const labels = ["one", "two", "three", "four", "five", "six", "seven", "eight"];
    for (const label of labels) transcript.append("manager", label);
    const initial = transcript.render(40).join("\n");
    // Tail-anchored: the newest entries are visible; the head scrolled off.
    expect(initial).toContain("eight");
    expect(initial).toContain("five");
    expect(initial).not.toContain("one");
    expect(initial).not.toContain("two");
    expect(transcript.scrollUp(10)).toBe(true);
    const paged = transcript.render(40).join("\n");
    // One page up from the tail advances by page size while the viewport
    // itself remains sized from maxLines minus the status row.
    expect(paged).toContain("two");
    expect(paged).toContain("five");
    expect(paged).not.toContain("one");
    expect(paged).not.toContain("eight");
    expect(transcript.scrollUp(10)).toBe(true);
    const top = transcript.render(40).join("\n");
    // Fully scrolled to the head; the tail entry is off-window.
    expect(top).toContain("one");
    expect(top).not.toContain("eight");
    // Paging down advances without following until the true viewport bottom.
    expect(transcript.scrollDown(10)).toBe(true);
    expect(transcript.isTailAnchored()).toBe(false);
    expect(transcript.scrollDown(10)).toBe(true);
    expect(transcript.isTailAnchored()).toBe(true);
    // A wheel/page-down at the pinned tail is a no-op.
    expect(transcript.scrollDown(10)).toBe(false);
    expect(transcript.scrollToBottom());
    expect(transcript.render(40).join("\n")).toContain("eight");
  });

  test("running sidekick card shows live activity rows; done cards show metrics", () => {
    let now = 0;
    const cards = new SidekickActivity("/repo", () => now);
    cards.apply({
      type: "delegation_started",
      index: 0,
      taskCount: 1,
      task: "implement",
      model: "gpt-5.5",
    });
    cards.apply({
      type: "sidekick_activity",
      index: 0,
      taskCount: 1,
      activity: { type: "sidekick_started", sessionId: "s-1", timestamp: 0 },
    });
    cards.apply({
      type: "sidekick_activity",
      index: 0,
      taskCount: 1,
      activity: { type: "tool_started", sessionId: "s-1", tool: "read", detail: "src/a.ts", timestamp: 0 },
    });
    const running = textOf(cards.render(100));
    expect(running).toContain("● running");
    expect(running).toContain("read src/a.ts");
    cards.apply({
      type: "delegation_finished",
      index: 0,
      taskCount: 1,
      result: {
        status: "complete",
        summary: "done",
        sessionId: "s-1",
        filesChanged: ["src/a.ts"],
        verification: [{ command: "bun test", status: "passed" }],
      },
    });
    const done = textOf(cards.render(100));
    // Collapsed completion shows a status row with metrics.
    expect(done).toContain("✓ done");
    expect(done).toContain("1 file changed · 1 check passed");
    expect(done).toContain("done");
  });

  test("sidekick queued cards all render inline with a waiting row (no cap on queued)", () => {
    const cards = new SidekickActivity("/repo");
    for (let index = 0; index < 7; index += 1) {
      cards.apply({
        type: "delegation_started",
        index,
        taskCount: 7,
        task: `task ${index}`,
      });
    }
    const rendered = textOf(cards.render(100));
    // Queued cards are never capped: every card renders with a waiting row.
    for (const task of ["task 0", "task 1", "task 2", "task 3", "task 5", "task 6"]) {
      expect(rendered).toContain(task);
    }
    expect(rendered).toContain("○ queued");
    expect(rendered).toContain("waiting for turn");
    // No aggregate badge: nothing is hidden behind a running-card cap.
    expect(rendered).not.toContain("waiting ┐");
  });

  test("sidekick live state shows safe path/command detail from activity", () => {
    const cards = new SidekickActivity("/repo");
    cards.apply({ type: "delegation_started", index: 0, taskCount: 1 });
    cards.apply({
      type: "sidekick_activity",
      index: 0,
      taskCount: 1,
      activity: {
        type: "tool_started",
        sessionId: "s-1",
        tool: "read",
        detail: "src/cli.ts",
        timestamp: 0,
      },
    });
    expect(textOf(cards.render(100))).toContain("read src/cli.ts");
    cards.apply({
      type: "sidekick_activity",
      index: 0,
      taskCount: 1,
      activity: {
        type: "tool_finished",
        sessionId: "s-1",
        tool: "read",
        ok: true,
        detail: "src/cli.ts",
        timestamp: 1,
      },
    });
    cards.apply({
      type: "sidekick_activity",
      index: 0,
      taskCount: 1,
      activity: {
        type: "tool_started",
        sessionId: "s-1",
        tool: "bash",
        detail: "bun test",
        timestamp: 2,
      },
    });
    expect(textOf(cards.render(100))).toContain("bash bun test");
    cards.apply({
      type: "sidekick_activity",
      index: 0,
      taskCount: 1,
      activity: {
        type: "tool_finished",
        sessionId: "s-1",
        tool: "bash",
        ok: true,
        detail: "bun test",
        timestamp: 3,
      },
    });
    cards.apply({
      type: "sidekick_activity",
      index: 0,
      taskCount: 1,
      activity: {
        type: "tool_started",
        sessionId: "s-1",
        tool: "edit",
        detail: "src/app.ts",
        timestamp: 4,
      },
    });
    expect(textOf(cards.render(100))).toContain("edit src/app.ts");
  });

  test("completed sidekick card shows a concise metrics row without expansion", () => {
    const cards = new SidekickActivity("/repo");
    cards.apply({ type: "delegation_started", index: 0, taskCount: 1 });
    cards.apply({
      type: "delegation_finished",
      index: 0,
      taskCount: 1,
      result: {
        status: "complete",
        summary: "done",
        sessionId: "s-1",
        filesChanged: ["src/a.ts", "src/b.ts"],
        verification: [
          { command: "bun test", status: "passed" },
          { command: "bun run typecheck", status: "passed" },
        ],
      },
    });
    const collapsed = textOf(cards.render(100));
    expect(collapsed).toContain("2 files changed · 2 checks passed");
    expect(collapsed).not.toContain("bun test");
    expect(collapsed).not.toContain("src/a.ts");
    // Expanding by session id surfaces the changed file and verification
    // rows, but never raw transcripts or private fields.
    expect(cards.toggle("s-1")).toBe(true);
    const expanded = textOf(cards.render(100));
    expect(expanded).toContain("src/a.ts");
    expect(expanded).toContain("bun test [passed]");
    expect(expanded).toContain("bun run typecheck [passed]");
  });

  test("footer editor offers slash-command autocomplete for the interactive family", async () => {
    const footer = new Footer({
      managerModel: "gpt-5.5",
      workspace: "/repo/project",
    });
    expect(footer.editor).toBeDefined();
    // Typing "/" triggers the editor's autocomplete for the command family.
    footer.editor.setText("/me");
    footer.editor.handleInput("\t");
    // The suggestion request resolves through the editor's async chain.
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(footer.editor.isShowingAutocomplete()).toBe(true);
    footer.editor.handleInput("\t");
    const line = footer.editor.getText();
    // Applying the /memory completion inserts the command plus a trailing space.
    expect(line.startsWith("/memory ")).toBe(true);
  });

  test("footer editor escape cancels the active run but not via Ctrl-C", () => {
    let cancelled = 0;
    const footer = new Footer({
      managerModel: "gpt-5.5",
      workspace: "/repo/project",
      onCancel: () => {
        cancelled += 1;
      },
    });
    // Legacy bare Escape reaches the wrapper and fires onCancel.
    footer.handleInput("\u001b");
    expect(cancelled).toBe(1);
    // Kitty-protocol CSI-u Escape (what modern terminals send after the
    // \x1b[?u query) must also cancel.
    footer.handleInput("\u001b[27u");
    expect(cancelled).toBe(2);
    // Ctrl-C is not Escape; it must reach the editor unchanged so the app's
    // global Ctrl-C handling (exit) still works.
    footer.handleInput("\u0003");
    expect(cancelled).toBe(2);
  });

  test("/model sidekick dropdown lists model IDs and arrow+Tab applies", async () => {
    const footer = new Footer({
      managerModel: "gpt-5.5",
      workspace: "/repo/project",
      roleProviders: () => "commandcode",
      suggestModels: async () => [
        { provider: "commandcode", id: "gpt-5.5", description: "200k ctx" },
        { provider: "commandcode", id: "deepseek/deepseek-v4-flash" },
        { provider: "commandcode", id: "google/gemini-3.5-flash" },
      ],
    });
    // Typing "/model sidekick" triggers the role-aware model dropdown.
    footer.editor.setText("");
    for (const ch of "/model sidekick") {
      footer.editor.handleInput(ch);
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    }
    expect(footer.editor.isShowingAutocomplete()).toBe(true);
    // The dropdown lists the provider's model IDs.
    const menu = textOf(footer.editor.render(80));
    expect(menu).toContain("gpt-5.5");
    expect(menu).toContain("deepseek/deepseek-v4-flash");
    // Arrow down selects the second model; Tab applies it, preserving the role
    // and carrying the provider so selection is unambiguous.
    footer.editor.handleInput("\u001b[B");
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    footer.editor.handleInput("\t");
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(footer.editor.getText()).toBe("/model sidekick commandcode deepseek/deepseek-v4-flash");
  });

  test("/model manager dropdown uses the manager's provider and preserves the role", async () => {
    const footer = new Footer({
      managerModel: "gpt-5.5",
      workspace: "/repo/project",
      roleProviders: (role) => (role === "manager" ? "anthropic" : "commandcode"),
      suggestModels: async (provider) =>
        provider === "anthropic"
          ? [{ provider: "anthropic", id: "claude-sonnet-4-6", description: "200k ctx" }]
          : [{ provider: "commandcode", id: "gpt-5.5" }],
    });
    footer.editor.setText("");
    for (const ch of "/model manager") {
      footer.editor.handleInput(ch);
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    }
    expect(footer.editor.isShowingAutocomplete()).toBe(true);
    // The manager dropdown comes from the manager's provider.
    const menu = textOf(footer.editor.render(80));
    expect(menu).toContain("claude-sonnet-4-6");
    expect(menu).not.toContain("gpt-5.5");
    // Tab applies the model, preserving the manager role prefix and provider.
    footer.editor.handleInput("\t");
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(footer.editor.getText()).toBe("/model manager anthropic claude-sonnet-4-6");
  });

  test("/model dropdown filters by any-position substring (sol finds gpt-5.6-sol)", async () => {    const footer = new Footer({
      managerModel: "gpt-5.5",
      workspace: "/repo/project",
      roleProviders: () => "commandcode",
      suggestModels: async () => [
        { provider: "commandcode", id: "gpt-5.5", description: "200k ctx" },
        { provider: "commandcode", id: "gpt-5.6-sol", description: "1M ctx" },
        { provider: "commandcode", id: "deepseek/deepseek-v4-flash" },
      ],
    });
    footer.editor.setText("");
    for (const ch of "/model sidekick sol") {
      footer.editor.handleInput(ch);
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    }
    expect(footer.editor.isShowingAutocomplete()).toBe(true);
    const menu = textOf(footer.editor.render(80));
    // "sol" matches mid-id, not just prefix.
    expect(menu).toContain("gpt-5.6-sol");
    expect(menu).not.toContain("gpt-5.5");
    expect(menu).not.toContain("deepseek");
  });

  test("/provider dropdown lists provider IDs with hints and arrow+Tab applies", async () => {
    const footer = new Footer({
      managerModel: "gpt-5.5",
      workspace: "/repo/project",
      roleProviders: () => "commandcode",
      suggestProviders: async () => [
        { id: "anthropic", configured: true, description: "requires ANTHROPIC_API_KEY" },
        { id: "openai", description: "requires OPENAI_API_KEY" },
        { id: "openrouter" },
        { id: "commandcode", configured: true },
      ],
    });
    footer.editor.setText("");
    // No role pick: /provider alone opens the provider dropdown.
    for (const ch of "/provider ") {
      footer.editor.handleInput(ch);
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    }
    expect(footer.editor.isShowingAutocomplete()).toBe(true);
    const menu = textOf(footer.editor.render(80));
    expect(menu).toContain("anthropic");
    expect(menu).toContain("commandcode");
    expect(menu).toContain("requires ANTHROPIC_API_KEY");
    expect(menu).toContain("configured");
    // Arrow down selects the second provider; Tab applies it.
    footer.editor.handleInput("\u001b[B");
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    footer.editor.handleInput("\t");
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(footer.editor.getText()).toBe("/provider openai");
  });

  test("/provider dropdown filters by any-position case-insensitive substring", async () => {
    const footer = new Footer({
      managerModel: "gpt-5.5",
      workspace: "/repo/project",
      roleProviders: () => "commandcode",
      suggestProviders: async () => [
        { id: "anthropic" },
        { id: "openai" },
        { id: "openrouter" },
        { id: "google-vertex" },
      ],
    });
    footer.editor.setText("");
    // "ROUT" should match "openrouter" case-insensitively (any position).
    for (const ch of "/provider ROUT") {
      footer.editor.handleInput(ch);
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    }
    expect(footer.editor.isShowingAutocomplete()).toBe(true);
    const menu = textOf(footer.editor.render(80));
    expect(menu).toContain("openrouter");
    expect(menu).not.toContain("openai");
    expect(menu).not.toContain("anthropic");
  });

  test("/provider command appears in the autocomplete command list", async () => {
    const footer = new Footer({
      managerModel: "gpt-5.5",
      workspace: "/repo/project",
      suggestProviders: async () => [{ id: "anthropic" }],
    });
    footer.editor.setText("");
    for (const ch of "/prov") {
      footer.editor.handleInput(ch);
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    }
    expect(footer.editor.isShowingAutocomplete()).toBe(true);
    const menu = textOf(footer.editor.render(80));
    expect(menu).toContain("/provider");
  });

  test("footer masked key prompt never leaks the key into the editor or render", async () => {
    let submitted: { provider: string; key: string } | undefined;
    let cancelled = 0;
    const footer = new Footer({
      managerModel: "gpt-5.5",
      workspace: "/repo/project",
      onSubmitKey: (provider, key) => { submitted = { provider, key }; },
      onCancelKey: () => { cancelled += 1; },
    });
    // Enter key-prompt mode.
    footer.beginKeyPrompt("openrouter");
    expect(footer.promptingForKey).toBe(true);
    // Render shows a masked prompt, no key text.
    let rendered = textOf(footer.render(80));
    expect(rendered).toContain("openrouter");
    expect(rendered).toContain("Enter API key");
    // Type a secret: it renders as bullets, never the plaintext.
    for (const ch of "sk-secret-12345") {
      footer.handleInput(ch);
    }
    rendered = textOf(footer.render(80));
    expect(rendered).not.toContain("sk-secret-12345");
    expect(rendered).toContain("•".repeat("sk-secret-12345".length));
    // The editor buffer stays empty — the key never enters it.
    expect(footer.editor.getText()).toBe("");
    // Enter submits the key.
    footer.handleInput("\r");
    expect(submitted).toEqual({ provider: "openrouter", key: "sk-secret-12345" });
    expect(footer.promptingForKey).toBe(false);
    expect(cancelled).toBe(0);

    // Escape cancels a fresh prompt.
    footer.beginKeyPrompt("openai");
    footer.handleInput("partial");
    footer.handleInput("\u001b");
    expect(footer.promptingForKey).toBe(false);
    expect(cancelled).toBe(1);
  });

  test("footer masked key prompt truncates a long pasted key to the terminal width", () => {
    const footer = new Footer({
      managerModel: "gpt-5.5",
      workspace: "/repo/project",
    });
    footer.beginKeyPrompt("commandcode");
    // A long pasted key must never overflow the terminal (crash: "Rendered
    // line exceeds terminal width").
    const longKey = "sk-" + "x".repeat(400);
    footer.handleInput(`\u001b[200~${longKey}\x1b[201~`);
    const rendered = footer.render(60);
    for (const line of rendered) {
      const plain = line.replace(/\u001b\[[0-9;]*m/g, "");
      expect([...plain].length).toBeLessThanOrEqual(60);
    }
    // The full key is still submitted despite the truncated display.
    let submitted: string | undefined;
    const footer2 = new Footer({
      managerModel: "gpt-5.5",
      workspace: "/repo/project",
      onSubmitKey: (_provider, key) => { submitted = key; },
    });
    footer2.beginKeyPrompt("commandcode");
    footer2.handleInput(`\u001b[200~${longKey}\x1b[201~`);
    footer2.handleInput("\r");
    expect(submitted).toBe(longKey);
  });

  test("footer masked key prompt accepts bracketed paste (Ctrl+V) masked", async () => {
    let submitted: { provider: string; key: string } | undefined;
    const footer = new Footer({
      managerModel: "gpt-5.5",
      workspace: "/repo/project",
      onSubmitKey: (provider, key) => { submitted = { provider, key }; },
    });
    footer.beginKeyPrompt("openrouter");
    // Terminal delivers a paste wrapped in bracketed-paste markers.
    footer.handleInput("\u001b[200~sk-pasted-key-abcdef\x1b[201~");
    const rendered = textOf(footer.render(80));
    // The pasted content is masked, never rendered in plaintext.
    expect(rendered).not.toContain("sk-pasted-key-abcdef");
    expect(rendered).toContain("•".repeat("sk-pasted-key-abcdef".length));
    // The editor buffer stays empty.
    expect(footer.editor.getText()).toBe("");
    // Enter submits the pasted key.
    footer.handleInput("\r");
    expect(submitted).toEqual({ provider: "openrouter", key: "sk-pasted-key-abcdef" });
  });

  test("footer masked key prompt accepts a split bracketed paste across events", async () => {
    let submitted: { provider: string; key: string } | undefined;
    const footer = new Footer({
      managerModel: "gpt-5.5",
      workspace: "/repo/project",
      onSubmitKey: (provider, key) => { submitted = { provider, key }; },
    });
    footer.beginKeyPrompt("openrouter");
    // Paste may arrive in chunks: opener+part1, then part2+terminator.
    footer.handleInput("\u001b[200~sk-split-1");
    footer.handleInput("split-2\x1b[201~");
    footer.handleInput("\r");
    expect(submitted).toEqual({ provider: "openrouter", key: "sk-split-1split-2" });
    expect(textOf(footer.render(80))).not.toContain("sk-split");
  });

  test("/session dropdown lists sessions and arrow+Tab applies the id", async () => {
    const footer = new Footer({
      managerModel: "gpt-5.5",
      workspace: "/repo/project",
      sessionSource: async () => [
        { id: "manager-aaa", description: "3 messages · 2h ago" },
        { id: "manager-bbb", description: "1 message · just now" },
      ],
    });
    footer.editor.setText("");
    for (const ch of "/session") {
      footer.editor.handleInput(ch);
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    }
    expect(footer.editor.isShowingAutocomplete()).toBe(true);
    const menu = textOf(footer.editor.render(80));
    expect(menu).toContain("manager-aaa");
    expect(menu).toContain("manager-bbb");
    // Arrow down selects the second session; Tab applies it.
    footer.editor.handleInput("\u001b[B");
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    footer.editor.handleInput("\t");
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(footer.editor.getText()).toBe("/session manager-bbb");
  });

  test("app clearInput empties the footer editor draft", () => {
    const app = createApp({
      managerModel: "test-model",
      workspace: "/repo/project",
      tui: new FakeTui(),
    });
    app.footer.editor.setText("draft text");
    app.clearInput();
    expect(app.footer.editor.getText()).toBe("");
  });

  test("restoreSession clears the transcript and replays the session history", () => {
    const app = createApp({
      managerModel: "test-model",
      workspace: "/repo/project",
      tui: new FakeTui(),
    });
    // Populate the transcript with the current conversation.
    app.addUser("old user message");
    app.addManager("old manager reply");
    const before = textOf(app.transcript.render(80));
    expect(before).toContain("old user message");
    expect(before).toContain("old manager reply");

    // Restore a session: old entries are replaced by the session's history.
    app.restoreSession([
      { role: "user", text: "restored user" },
      { role: "manager", text: "restored manager" },
    ]);
    const after = textOf(app.transcript.render(80));
    expect(after).toContain("restored user");
    expect(after).toContain("restored manager");
    // The previous conversation is gone, not appended.
    expect(after).not.toContain("old user message");
    expect(after).not.toContain("old manager reply");
  });

  test("one sidekick card appends inline once and updates in place", () => {
    const host = new FakeTui();
    host.terminal = { rows: 24 };
    const app = createApp({
      managerModel: "gpt-5.5",
      sidekickModel: "deepseek-v4",
      workspace: "/repo",
      tui: host,
    });
    // A single delegation becomes exactly one inline card.
    app.handleDelegateEvent({
      type: "delegation_started",
      index: 0,
      taskCount: 1,
      task: "implement",
      model: "deepseek-v4",
    });
    let view = textOf(app.render(100));
    expect(view.match(/sidekick #1/g)).toHaveLength(1);
    expect(view).toContain("○ queued");
    expect(textOf(app.footer.render(80))).toContain("0/1 sidekicks running");

    // Activity transitions the SAME card in place (still one card), and the
    // footer working count rises.
    app.handleDelegateEvent({
      type: "sidekick_activity",
      index: 0,
      taskCount: 1,
      activity: { type: "sidekick_started", sessionId: "s-1", timestamp: 0 },
    });
    app.handleDelegateEvent({
      type: "sidekick_activity",
      index: 0,
      taskCount: 1,
      activity: { type: "tool_started", sessionId: "s-1", tool: "read", detail: "src/a.ts", timestamp: 0 },
    });
    view = textOf(app.render(100));
    expect(view.match(/sidekick #1/g)).toHaveLength(1);
    expect(view).toContain("● running");
    expect(view).toContain("read src/a.ts");
    expect(textOf(app.footer.render(80))).toContain("1/1 sidekicks running");

    // Completion keeps the same inline card, footer returns to 0 working.
    app.handleDelegateEvent({
      type: "delegation_finished",
      index: 0,
      taskCount: 1,
      task: "implement",
      model: "deepseek-v4",
      result: { status: "complete", summary: "done", sessionId: "s-1" },
    });
    view = textOf(app.render(100));
    expect(view.match(/sidekick #1/g)).toHaveLength(1);
    expect(view).toContain("✓ done");
    // The batch completed: the footer drops back to idle (no active delegation).
    expect(textOf(app.footer.render(80))).toContain("sidekick: idle");

    // A second delegation appends a second inline card; both persist.
    app.handleDelegateEvent({
      type: "delegation_started",
      index: 1,
      taskCount: 2,
      task: "second task",
      model: "deepseek-v4",
    });
    view = textOf(app.render(100));
    expect(view.match(/sidekick #1/g)).toHaveLength(1);
    expect(view.match(/sidekick #2/g)).toHaveLength(1);
    expect(textOf(app.footer.render(80))).toContain("0/2 sidekicks running");
  });

  test("restoreSession clears inline sidekick cards and the footer counts", () => {
    const host = new FakeTui();
    host.terminal = { rows: 24 };
    const app = createApp({
      managerModel: "gpt-5.5",
      sidekickModel: "deepseek-v4",
      sessionId: "manager-old",
      workspace: "/repo",
      tui: host,
    });
    app.handleDelegateEvent({
      type: "delegation_started",
      index: 0,
      taskCount: 1,
      task: "stale card",
      model: "deepseek-v4",
    });
    expect(textOf(app.render(100))).toContain("stale card");
    expect(textOf(app.footer.render(80))).toContain("0/1 sidekicks running");

    app.restoreSession([{ role: "user", text: "fresh session" }]);
    const after = textOf(app.render(100));
    expect(after).not.toContain("stale card");
    expect(after).not.toContain("sidekick #1");
    expect(textOf(app.footer.render(80))).toContain("sidekick: idle");
  });

  test("inline sidekick cards and tool rows fit narrow widths", () => {
    const host = new FakeTui();
    host.terminal = { rows: 24 };
    const app = createApp({
      managerModel: "gpt-5.5",
      workspace: "/repo",
      tui: host,
    });
    app.handleDelegateEvent({
      type: "delegation_started",
      index: 0,
      taskCount: 1,
      task: "implement feature",
      model: "deepseek-v4",
    });
    expectWidth(app.render(30), 30);
    // A narrow card collapses to plain rows, still truncated to the width.
    const narrowCard = textOf(app.render(14));
    expect(narrowCard).toContain("sidekick #1");
    expectWidth(app.render(14), 14);
  });

  test("compact tool rows show safe diff summary and exit codes", () => {
    const app = createApp({
      managerModel: "gpt-5.5",
      workspace: "/repo",
      tui: new FakeTui(),
    });
    // Successful edit: +added -removed derived from start args.
    app.handleManagerEvent({
      type: "model_event",
      event: {
        type: "tool_start",
        turn: 1,
        toolCall: { name: "edit", arguments: { path: "src/app.ts", oldText: "a\nb", newText: "a\nb\nc\nd" } },
      },
    });
    app.handleManagerEvent({
      type: "model_event",
      event: { type: "tool_end", turn: 1, toolCall: { name: "edit" }, result: { isError: false, text: "Updated src/app.ts" } },
    });
    expect(textOf(app.transcript.render(80))).toContain("✓ edit   src/app.ts +4 -2");

    // Failed bash: exit code inline + compact error line; no raw output.
    app.handleManagerEvent({
      type: "model_event",
      event: { type: "tool_start", turn: 1, toolCall: { name: "bash", arguments: { command: "bun test" } } },
    });
    app.handleManagerEvent({
      type: "model_event",
      event: {
        type: "tool_end",
        turn: 1,
        toolCall: { name: "bash" },
        result: { isError: true, text: "exitCode: 2\nstderr: boom", details: { exitCode: 2 } },
      },
    });
    const rows = textOf(app.transcript.render(80));
    expect(rows).toContain("✕ bash   bun test · exit 2");
    expect(rows).toContain("boom");
    expect(rows).not.toContain("exitCode:");
    expect(rows).not.toContain("stderr:");

    // Successful bash with a test-count summary; never raw output.
    app.handleManagerEvent({
      type: "model_event",
      event: { type: "tool_start", turn: 1, toolCall: { name: "bash", arguments: { command: "bun test" } } },
    });
    app.handleManagerEvent({
      type: "model_event",
      event: {
        type: "tool_end",
        turn: 1,
        toolCall: { name: "bash" },
        result: { isError: false, text: "81 tests passed", details: { stdout: "81 tests passed\n" } },
      },
    });
    const ok = textOf(app.transcript.render(80));
    expect(ok).toContain("✓ bash   bun test · 81 passed");
    expect(ok).not.toContain("81 tests passed");
  });

  test("header segment order: manager, thinking, sidekick, session", () => {
    const header = new Header({
      product: "mimin",
      managerModel: "gpt-5.5",
      sidekickModel: "deepseek-v4",
      sessionId: "manager-abc123",
      thinking: "medium",
    });
    const line = textOf(header.render(120));
    const order = [
      line.indexOf("manager"),
      line.indexOf("thinking"),
      line.indexOf("sidekick"),
      line.indexOf("session"),
    ];
    expect(order[0]).toBeGreaterThanOrEqual(0);
    expect(order[1]).toBeGreaterThan(order[0]!);
    expect(order[2]).toBeGreaterThan(order[1]!);
    expect(order[3]).toBeGreaterThan(order[2]!);
    // Thinking renders only when not off.
    expect(line).toContain("thinking medium");
    const off = textOf(new Header({ managerModel: "gpt-5.5", thinking: "off" }).render(80));
    expect(off).not.toContain("thinking");
  });

  test("footer order: hints, then sidekick status", () => {
    const footer = new Footer({
      managerModel: "gpt-5.5",
      sidekickWorking: 1,
      sidekickTotal: 2,
    });
    const line = textOf(footer.render(80));
    const hint = line.indexOf("/help");
    const sidekicks = line.indexOf("1/2 sidekicks running");
    expect(hint).toBeGreaterThanOrEqual(0);
    expect(sidekicks).toBeGreaterThan(hint!);
    // Running replaces hints with cancel/quit + elapsed.
    const running = new Footer({ managerModel: "gpt-5.5", managerWorking: true });
    const runningLine = textOf(running.render(80));
    expect(runningLine).toContain("esc cancel");
    expect(runningLine).toContain("ctrl+c quit");
    expect(runningLine).not.toContain("/help");
  });
});
