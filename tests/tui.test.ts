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
    const rendered = [...header.render(80), ...footer.render(80)].join("\n");
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
    expect(transcript.render(40).join("\n")).toContain("Manager: streamed");
    transcript.updateStream(stream, "final");
    transcript.finishStream(stream);
    expect(transcript.entries[1]).toMatchObject({ text: "final", streaming: false });
    expectWidth(transcript.render(6), 6);
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

    const collapsed = cards.render(100).join("\n");
    expect(collapsed).toContain("[complete]");
    expect(collapsed).toContain("implemented safely");
    expect(collapsed).not.toContain("edit");

    expect(cards.toggle("session-0")).toBe(true);
    const expanded = cards.render(100).join("\n");
    expect(expanded).toContain("edit | src/safe.ts | ok");
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
      expect(cards.render(80).join("\n")).toContain("[running]");
      cards.apply({
        type: "delegation_finished",
        index,
        taskCount: 4,
        result: { status, summary: status, sessionId: `s-${index}` },
      });
      expect(cards.render(80).join("\n")).toContain(`[${status}]`);
    }
  });

  test("app has four primitive areas, async nonempty submit, stream mapping, and exit", async () => {
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
    app.footer.input.setValue("   ");
    app.footer.handleInput("\r");
    app.footer.input.setValue("ship it");
    app.footer.handleInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(submitted).toEqual(["ship it"]);
    expect(app.transcript.render(80).join("\n")).toContain("You: ship it");

    app.handleManagerEvent({ type: "model_event", event: { type: "text_start" } });
    app.handleManagerEvent({ type: "model_event", event: { type: "text_delta", delta: "done" } });
    app.handleManagerEvent({ type: "model_event", event: { type: "text_end", content: "done" } });
    expect(app.transcript.render(80).join("\n")).toContain("Manager: done");

    app.start();
    host.listener?.("\u0003");
    expect(exited).toBe(true);
    expect(host.starts).toBe(1);
    expect(host.stops).toBe(1);
  });
});
