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

  requestRender(): void {
    this.renders += 1;
  }
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
    expect(rendered).toContain("project");
    expect(rendered).toContain("50/100 (50%)");
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
    // One ◆ Manager heading per entry; no repeated "Manager:" prefix.
    expect(lines).toContain("◆ Manager");
    expect(lines).not.toContain("Manager:");
    // Raw markdown markers never reach rendered output (the list renders as a
    // styled bullet, not the source "- item" line).
    expect(lines).not.toContain("# Title");
    expect(lines).not.toContain("**bold**");
    expect(lines).not.toContain("`code`");
    expect(lines).toContain("item");
  });

  test("user entries render as > text with no You: label", () => {
    const transcript = new Transcript();
    transcript.append("user", "hello world");
    const lines = textOf(transcript.render(60));
    expect(lines).toContain("> hello world");
    expect(lines).not.toContain("You:");
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
    expect(collapsed).toContain("✓ Complete");
    expect(collapsed).toContain("implemented safely");
    expect(collapsed).not.toContain("edit");
    // Box card shape and hidden UUIDs.
    expect(collapsed).toContain("┌ Sidekick");
    expect(collapsed).toContain("└");
    expect(collapsed).not.toContain("session-0");

    expect(cards.toggle("session-0")).toBe(true);
    const expanded = textOf(cards.render(100));
    expect(expanded).toContain("src/safe.ts");
    for (const secret of [
      "SIDEKICK TRANSCRIPT",
      "PRIVATE REASONING",
      "RAW COMMAND OUTPUT",
      "PRIVATE FILE CONTENT",
      "FULL LOG",
    ]) expect(expanded).not.toContain(secret);
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
      expect(textOf(cards.render(80))).toContain("● Running");
      cards.apply({
        type: "delegation_finished",
        index,
        taskCount: 4,
        result: { status, summary: status, sessionId: `s-${index}` },
      });
      const verb = status === "needs_decision"
        ? "Needs decision"
        : status === "blocked"
          ? "Failed"
          : status[0]?.toUpperCase() + status.slice(1);
      const mark = status === "complete" ? "✓" : "✗";
      expect(textOf(cards.render(80))).toContain(`${mark} ${verb}`);
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
      app.sidekicks,
      app.footer,
    ]);
    app.footer.input.setText("   ");
    app.footer.handleInput("\r");
    app.footer.input.setText("ship it");
    app.footer.handleInput("\r");
    // Flush the submit promise chain (no wall-clock timer).
    await Promise.resolve();
    await Promise.resolve();
    expect(submitted).toEqual(["ship it"]);
    expect(textOf(app.transcript.render(80))).toContain("> ship it");

    // setRunning flips the header/footer immediately, before any model event.
    app.setRunning(true);
    expect(textOf(app.header.render(80))).toContain("working");
    expect(textOf(app.footer.render(80))).toContain("working");
    app.setRunning(false);
    expect(textOf(app.header.render(80))).toContain("idle");
    expect(textOf(app.footer.render(80))).not.toContain("working");

    app.handleManagerEvent({ type: "model_event", event: { type: "text_start" } });
    app.handleManagerEvent({ type: "model_event", event: { type: "text_delta", delta: "done" } });
    app.handleManagerEvent({ type: "model_event", event: { type: "text_end", content: "done" } });
    // Manager markdown renders without a repeated "Manager:" prefix.
    const transcriptLines = textOf(app.transcript.render(80));
    expect(transcriptLines).toContain("done");
    expect(transcriptLines).not.toContain("Manager: done");
    // Streaming sets the header run state to running.
    expect(app.header.render(80).join("\n")).toContain("working");

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
    // Title-case aligned labels, path from tool_start args, no debug text.
    expect(rows).toContain("✓ Read    src/app.ts");
    expect(rows).toContain("✕ Edit");
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
    expect(rows).toContain("● Bash    bun test");
    expect(rows).toContain("● Edit    src/cli.ts");
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
    expect(textOf(app.transcript.render(80))).toContain("● Read    a.ts");
    app.handleManagerEvent({
      type: "model_event",
      event: { type: "tool_end", turn: 1, toolCall: { name: "read" }, result: { isError: false } },
    });
    expect(textOf(app.transcript.render(80))).toContain("✓ Read    a.ts");
    // Edit: fails.
    app.handleManagerEvent({
      type: "model_event",
      event: { type: "tool_start", turn: 1, toolCall: { name: "edit", arguments: { path: "b.ts" } } },
    });
    expect(textOf(app.transcript.render(80))).toContain("● Edit    b.ts");
    app.handleManagerEvent({
      type: "model_event",
      event: { type: "tool_end", turn: 1, toolCall: { name: "edit" }, result: { isError: true, text: "boom" } },
    });
    const rows = textOf(app.transcript.render(80));
    expect(rows).toContain("✕ Edit    b.ts");
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
    expect(rows).toContain("✕ Read    src");
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
    expect(rows).toContain("✕ Bash");
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
    expect(rows.match(/Read/g)).toHaveLength(1);
    expect(rows).toContain("✓ Read    a.ts");
    expect(rows).not.toContain("● Read");
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
    expect(rows).toContain("> fix the bug");
    expect(rows).toContain("✓ Read    a.ts");
    expect(rows).toContain("✓ Verify  bun test");
    expect(rows).toContain("done");
    expect(rows).toContain("✓ Read    b.ts");
    // Order preserved: turn 1 tools before turn 2 text and tools.
    expect(rows.indexOf("✓ Read    a.ts")).toBeLessThan(rows.indexOf("✓ Verify  bun test"));
    expect(rows.indexOf("✓ Verify  bun test")).toBeLessThan(rows.indexOf("done"));
    expect(rows.indexOf("done")).toBeLessThan(rows.indexOf("✓ Read    b.ts"));
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
    expect(rows).toContain("✓ Bash    bun test");
    expect(rows).not.toContain("13 pass");
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
    expect(textOf(app.transcript.render(80))).toContain("● Verify");
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
    expect(rows).toContain("✓ Verify  bun test");
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
    const running = textOf(cards.render(100));
    expect(running).toContain("● Running");
    expect(running).toContain("Sidekick · gpt-5.5");
    expect(running).toContain("implement feature");
    expect(running).not.toContain("session-");

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
    expect(done).toContain("✓ Complete");
    expect(done).toContain("done safely");
    expect(done).not.toContain("session-abc");
    expect(cards.toggle("session-abc")).toBe(true);
    const expanded = textOf(cards.render(100));
    expect(expanded).toContain("src/app.ts");
    expect(expanded).toContain("bun test [passed]");
  });

  test("header shows thinking and footer shows sidekick working count", () => {
    const header = new Header({
      product: "mimin",
      managerModel: "gpt-5.5",
      workspace: "/repo/project",
      thinking: "high",
    });
    const footer = new Footer({
      managerModel: "gpt-5.5",
      thinking: "high",
      sidekickWorking: 2,
    });
    const headerLines = textOf(header.render(80));
    expect(headerLines).toContain("gpt-5.5");
    expect(headerLines).toContain("thinking high");
    expect(headerLines).toContain("project");
    expect(headerLines).toContain("·");
    const footerLines = textOf(footer.render(80));
    expect(footerLines).toContain("model gpt-5.5");
    expect(footerLines).toContain("2 sidekicks working");
    // Horizontal rule separates the footer from content above.
    expect(textOf([footer.render(80)[0] ?? ""])).toMatch(/^─+$/);
    footer.setStatus({ sidekickWorking: 0 });
    expect(textOf(footer.render(80))).toContain("sidekick: idle");
  });

  test("header run state and turn chip; footer spinner while working", () => {
    const header = new Header({
      managerModel: "gpt-5.5",
      workspace: "/repo/project",
    });
    expect(textOf(header.render(80))).toContain("idle");
    expect(textOf(header.render(80))).not.toContain("turn");
    header.setRunState("running");
    header.setTurn(2);
    expect(textOf(header.render(80))).toContain("working");
    expect(textOf(header.render(80))).toContain("turn 2");
    header.setRunState("working");
    expect(textOf(header.render(80))).toContain("working");
    header.setRunState("idle");
    expect(textOf(header.render(80))).toContain("idle");

    const footer = new Footer({
      managerModel: "gpt-5.5",
      managerWorking: true,
    });
    // The status line carries the working spinner while a run is active.
    const statusLines = textOf(footer.render(80));
    expect(statusLines).toContain("working");
    footer.setStatus({ managerWorking: false });
    // Idle shows the plain prompt, not the spinner.
    expect(textOf(footer.render(80))).not.toContain("working");
  });

  test("header turn chip clears when the run returns to idle", () => {
    const host = new FakeTui();
    const app = createApp({
      managerModel: "test-model",
      workspace: "/repo/project",
      tui: host,
    });
    app.handleManagerEvent({ type: "model_event", event: { type: "text_start" } });
    app.setTurn(1);
    expect(textOf(app.header.render(80))).toContain("turn 1");
    expect(textOf(app.header.render(80))).toContain("working");
    // The run ends: turn chip disappears along with the running state.
    app.handleManagerEvent({ type: "model_event", event: { type: "done" } });
    expect(textOf(app.header.render(80))).toContain("idle");
    expect(textOf(app.header.render(80))).not.toContain("turn");
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
    // One page up from the tail shows a middle window, not the head or tail.
    expect(paged).toContain("three");
    expect(paged).toContain("six");
    expect(paged).not.toContain("one");
    expect(paged).not.toContain("eight");
    expect(transcript.scrollUp(10)).toBe(true);
    const top = transcript.render(40).join("\n");
    // Fully scrolled to the head; the tail entry is off-window.
    expect(top).toContain("one");
    expect(top).not.toContain("eight");
    expect(transcript.scrollToBottom());
    expect(transcript.render(40).join("\n")).toContain("eight");
  });

  test("running sidekick card shows live elapsed, done cards show summary", () => {
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
    now = 65_000;
    const running = textOf(cards.render(100));
    expect(running).toContain("● Reading src/a.ts · 1m5s");
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
    // Collapsed completion shows a single summary row with duration and metrics.
    expect(done).toContain("✓ Complete · 1m5s · 1 file changed · 1 check passed");
    expect(done).toContain("done");
  });

  test("sidekick cards cap visible running cards and show a queued badge", () => {
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
    for (const task of ["task 0", "task 1", "task 2", "task 3"]) {
      expect(rendered).toContain(task);
    }
    expect(rendered).not.toContain("task 5");
    expect(rendered).not.toContain("task 6");
    expect(rendered).toContain("2 waiting");
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
    expect(textOf(cards.render(100))).toContain("● Reading src/cli.ts");
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
    expect(textOf(cards.render(100))).toContain("● Running bun test");
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
    expect(textOf(cards.render(100))).toContain("● Editing src/app.ts");
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
        { id: "gpt-5.5", description: "200k ctx" },
        { id: "deepseek/deepseek-v4-flash" },
        { id: "google/gemini-3.5-flash" },
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
    // Arrow down selects the second model; Tab applies it, preserving the role.
    footer.editor.handleInput("\u001b[B");
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    footer.editor.handleInput("\t");
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(footer.editor.getText()).toBe("/model sidekick deepseek/deepseek-v4-flash");
  });

  test("/model manager dropdown uses the manager's provider and preserves the role", async () => {
    const footer = new Footer({
      managerModel: "gpt-5.5",
      workspace: "/repo/project",
      roleProviders: (role) => (role === "manager" ? "anthropic" : "commandcode"),
      suggestModels: async (provider) =>
        provider === "anthropic"
          ? [{ id: "claude-sonnet-4-6", description: "200k ctx" }]
          : [{ id: "gpt-5.5" }],
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
    // Tab applies the model, preserving the manager role prefix.
    footer.editor.handleInput("\t");
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(footer.editor.getText()).toBe("/model manager claude-sonnet-4-6");
  });

  test("/model dropdown filters by any-position substring (sol finds gpt-5.6-sol)", async () => {    const footer = new Footer({
      managerModel: "gpt-5.5",
      workspace: "/repo/project",
      roleProviders: () => "commandcode",
      suggestModels: async () => [
        { id: "gpt-5.5", description: "200k ctx" },
        { id: "gpt-5.6-sol", description: "1M ctx" },
        { id: "deepseek/deepseek-v4-flash" },
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
});
