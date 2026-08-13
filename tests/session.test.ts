import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { Message } from "@mariozechner/pi-ai";
import { SessionStore } from "../src/session/session.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mimin-sessions-"));
  temporaryDirectories.push(root);
  return root;
}

function user(content: string, timestamp: number): Message {
  return { role: "user", content, timestamp };
}

describe("JSONL sessions", () => {
  test("persists messages and events through create/open/load", async () => {
    const root = await fixture();
    const store = new SessionStore({
      root,
      now: () => 1234,
      idFactory: () => "fixed-id",
    });
    const session = await store.createSession("manager");

    await session.append(user("first", 1));
    await session.appendEvent({ type: "checkpoint", label: "after-first" });

    const opened = await store.openSession("manager", session.id);
    expect(opened.messages).toEqual([user("first", 1)]);
    expect(opened.events).toEqual([
      { type: "checkpoint", label: "after-first" },
    ]);
    expect(await store.loadMessages("manager", session.id)).toHaveLength(1);
    expect(await store.loadEvents("manager", session.id)).toHaveLength(1);

    const lines = (await Bun.file(session.path).text()).trim().split("\n");
    expect(lines).toHaveLength(3);
    const listed = await store.listSessions("manager");
    expect(listed).toMatchObject([
      {
        id: session.id,
        role: "manager",
        messageCount: 1,
        eventCount: 1,
      },
    ]);
  });

  test("keeps manager and sidekick histories and identifiers independent", async () => {
    const root = await fixture();
    const store = new SessionStore({ root, idFactory: () => "same-seed" });
    const manager = await store.createSession("manager");
    const sidekick = await store.createSession("sidekick");

    await manager.append(user("manager only", 1));
    await sidekick.append(user("sidekick only", 2));

    expect(manager.id).toContain("manager");
    expect(sidekick.id).toContain("sidekick");
    expect(manager.path).not.toBe(sidekick.path);
    expect((await store.loadSession("manager", manager.id)).messages).toEqual([
      user("manager only", 1),
    ]);
    expect((await store.loadSession("sidekick", sidekick.id)).messages).toEqual([
      user("sidekick only", 2),
    ]);
    await expect(store.loadSession("manager", sidekick.id)).rejects.toThrow();
  });

  test("loadSession loads a valid sidekick session", async () => {
    const root = await fixture();
    const store = new SessionStore({ root });
    const sidekick = await store.createSession("sidekick");

    const loaded = await store.loadSession("sidekick", sidekick.id);

    expect(loaded.id).toBe(sidekick.id);
    expect(loaded.role).toBe("sidekick");
  });

  test("loadSession rejects an unknown sidekick id", async () => {
    const root = await fixture();
    const store = new SessionStore({ root });

    await expect(store.loadSession("sidekick", "unknown-id")).rejects.toThrow();
  });

  test("loadSession reports a role mismatch for a manager id loaded as sidekick", async () => {
    const root = await fixture();
    const store = new SessionStore({ root });
    const manager = await store.createSession("manager");

    await expect(store.loadSession("sidekick", manager.id)).rejects.toThrow(
      /not a sidekick/i,
    );
  });
});
