import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  MemoryStore,
  projectIdForWorkspace,
  searchSessions,
} from "../src/memory/index.js";
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
  const directory = await mkdtemp(join(tmpdir(), "mimin-memory-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("persistent memory", () => {
  test("isolates user and canonical project scopes with stable filesystem-safe IDs", async () => {
    const root = await fixture();
    const workspaceA = join(root, "workspace-a");
    const workspaceB = join(root, "workspace-b");
    const aliasA = join(root, "workspace-a-link");
    await mkdir(workspaceA);
    await mkdir(workspaceB);
    await symlink(workspaceA, aliasA);

    const id = await projectIdForWorkspace(workspaceA);
    expect(await projectIdForWorkspace(join(workspaceA, "."))).toBe(id);
    expect(await projectIdForWorkspace(aliasA)).toBe(id);
    expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]+$/);
    expect(await projectIdForWorkspace(workspaceB)).not.toBe(id);

    const storeA = new MemoryStore({ root: join(root, "memory"), workspace: workspaceA });
    const storeB = new MemoryStore({ root: join(root, "memory"), workspace: workspaceB });
    await storeA.remember("shared user preference");
    await storeA.remember("project A convention", { scope: "project" });
    await storeB.remember("project B convention", { scope: "project" });

    expect((await storeB.list("user")).map((record) => record.content)).toEqual([
      "shared user preference",
    ]);
    expect((await storeA.load("project")).map((record) => record.content)).toEqual([
      "project A convention",
    ]);
    expect((await storeB.load("project")).map((record) => record.content)).toEqual([
      "project B convention",
    ]);
  });

  test("survives restart and serializes concurrent append writes", async () => {
    const root = await fixture();
    let tick = 0;
    const first = new MemoryStore({
      root,
      now: () => ++tick,
      idFactory: () => `record-${tick}`,
    });
    await Promise.all(
      Array.from({ length: 40 }, (_, index) => first.add(`concurrent ${index}`)),
    );

    const restarted = new MemoryStore({ root });
    const loaded = await restarted.load("user");
    expect(loaded).toHaveLength(40);
    expect(loaded.map((record) => record.content)).toEqual(
      Array.from({ length: 40 }, (_, index) => `concurrent ${index}`),
    );
    const diskLines = (await Bun.file(join(root, "user.jsonl")).text()).trim().split("\n");
    expect(diskLines).toHaveLength(40);
    expect(diskLines.every((line) => {
      try {
        JSON.parse(line);
        return true;
      } catch {
        return false;
      }
    })).toBe(true);
  });

  test("ranks compact matches and enforces the result limit", async () => {
    const root = await fixture();
    const store = new MemoryStore({ root });
    await store.add(`A weaker note mentions deployment once. ${"padding ".repeat(60)}`);
    await store.add("deployment deployment deployment is the exact project deployment policy");
    await store.add("unrelated cooking preference");

    const results = await store.search("deployment", { limit: 1, snippetLength: 80 });
    expect(results).toHaveLength(1);
    expect(results[0]?.snippet).toContain("deployment deployment");
    expect(results[0]?.snippet.length).toBeLessThanOrEqual(80);
    expect(results[0]).not.toHaveProperty("content");
  });

  test("filters credentials before disk writes while retaining ordinary prose", async () => {
    const root = await fixture();
    const store = new MemoryStore({ root });
    const secret = [
      "api_key=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890",
      "access_token: github_pat_abcdefghijklmnopqrstuvwxyz123456",
      "password = hunter2",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "eyJabcdefghijk.abcdefghijk.abcdefghijk",
      "-----BEGIN PRIVATE KEY-----\nraw-private-material\n-----END PRIVATE KEY-----",
    ].join("\n");
    const filtered = await store.remember(secret);
    const ordinary = await store.remember(
      "Use a password manager and rotate credentials; this is ordinary guidance.",
    );

    expect(filtered.filtered).toBe(true);
    expect(filtered.redactionCount).toBeGreaterThan(0);
    expect(ordinary.filtered).toBe(false);
    expect(ordinary.content).toContain("password manager");

    const disk = await Bun.file(join(root, "user.jsonl")).text();
    for (const raw of [
      "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890",
      "github_pat_abcdefghijklmnopqrstuvwxyz123456",
      "hunter2",
      "abcdefghijklmnopqrstuvwxyz",
      "eyJabcdefghijk.abcdefghijk.abcdefghijk",
      "raw-private-material",
    ]) expect(disk).not.toContain(raw);
    expect(disk).toContain("password manager");
    expect(disk).toContain("[REDACTED]");
  });
});

function sessionMetadata(id: string, role: "manager" | "sidekick", createdAt: number): string {
  return JSON.stringify({ type: "session", version: 1, id, role, createdAt });
}

function message(content: string, timestamp: number): string {
  return JSON.stringify({ type: "message", message: { role: "user", content, timestamp } });
}

function sessionMessage(value: Record<string, unknown>): string {
  return JSON.stringify({ type: "message", message: value });
}

describe("session search", () => {
  test("all persistent stores use MIMIN_DATA_DIR as the winning data root", async () => {
    const dataDir = await fixture();
    const miminHome = await fixture();
    const legacyHome = ["AGENT", "HOME"].join("_");
    const legacyData = ["AGENT", "DATA", "DIR"].join("_");
    const legacyMinimalData = ["MINIMAL", "AGENT", "DATA", "DIR"].join("_");
    const keys = [
      "MIMIN_HOME",
      "MIMIN_DATA_DIR",
      legacyHome,
      legacyData,
      legacyMinimalData,
    ];
    const previous = new Map(keys.map((key) => [key, Bun.env[key]]));

    try {
      Bun.env.MIMIN_HOME = miminHome;
      Bun.env.MIMIN_DATA_DIR = dataDir;
      Bun.env[legacyHome] = join(dataDir, "legacy-home");
      Bun.env[legacyData] = join(dataDir, "legacy-data");
      Bun.env[legacyMinimalData] = join(dataDir, "legacy-minimal-data");

      const sessions = new SessionStore();
      const memory = new MemoryStore();
      expect(sessions.root).toBe(join(dataDir, "sessions"));
      expect(memory.root).toBe(join(dataDir, "memory"));

      const manager = join(dataDir, "sessions", "manager");
      await mkdir(manager, { recursive: true });
      await writeFile(
        join(manager, "mimin-root.jsonl"),
        `${sessionMetadata("mimin-root", "manager", 1)}\n${message("shared-root-marker", 2)}\n`,
      );
      expect(await searchSessions("shared-root-marker")).toMatchObject([
        { role: "manager", sessionId: "mimin-root" },
      ]);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete Bun.env[key];
        else Bun.env[key] = value;
      }
    }
  });

  test("searches both roles, ranks matches, and returns snippets rather than transcripts", async () => {
    const dataDir = await fixture();
    await mkdir(join(dataDir, "sessions", "manager"), { recursive: true });
    await mkdir(join(dataDir, "sessions", "sidekick"), { recursive: true });
    await writeFile(
      join(dataDir, "sessions", "manager", "manager-one.jsonl"),
      [
        sessionMetadata("manager-one", "manager", 10),
        message(`prefix ${"irrelevant ".repeat(50)}needle needle needle${" tail".repeat(50)}`, 11),
        message("this second message must never be returned because it does not match", 12),
      ].join("\n") + "\n",
    );
    await writeFile(
      join(dataDir, "sessions", "sidekick", "sidekick-one.jsonl"),
      [sessionMetadata("sidekick-one", "sidekick", 20), message("sidekick found one needle", 21)].join("\n") + "\n",
    );

    const results = await searchSessions("needle", {
      dataDir,
      limit: 2,
      snippetLength: 90,
      maxSnippets: 2,
    });
    expect(results.map((result) => result.role)).toEqual(["manager", "sidekick"]);
    expect(results[0]?.sessionId).toBe("manager-one");
    expect(results[0]?.timestamp).toBe(11);
    expect(results[0]?.snippets[0]?.length).toBeLessThanOrEqual(90);
    expect(results[0]?.snippets.join(" ")).not.toContain("second message");
    expect(results[0]).not.toHaveProperty("messages");
  });

  test("searches only safe conversation surfaces in isolated sessions", async () => {
    const dataDir = await fixture();
    const sidekick = join(dataDir, "sessions", "sidekick");
    await mkdir(sidekick, { recursive: true });
    await writeFile(
      join(sidekick, "isolated.jsonl"),
      [
        sessionMetadata("isolated", "sidekick", 40),
        message("User task aurora-user-marker", 41),
        sessionMessage({
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "reasoning-only-marker",
              text: "reasoning-only-marker",
              thinkingSignature: "private-signature",
            },
            { type: "text", text: "Final summary aurora-final-marker" },
          ],
          timestamp: 42,
        }),
        sessionMessage({
          role: "toolResult",
          toolCallId: "read-call",
          toolName: "read",
          content: [{ type: "text", text: "file-content-only-marker" }],
          isError: false,
          timestamp: 43,
        }),
        sessionMessage({
          role: "toolResult",
          toolCallId: "bash-call",
          toolName: "bash",
          content: [{ type: "text", text: "$ bun test\nraw-command-log-marker" }],
          isError: false,
          timestamp: 44,
        }),
      ].join("\n") + "\n",
    );

    const userResults = await searchSessions("aurora-user-marker", { dataDir });
    const finalResults = await searchSessions("aurora-final-marker", { dataDir });
    expect(userResults[0]?.snippets.join(" ")).toContain("aurora-user-marker");
    expect(finalResults[0]?.snippets.join(" ")).toContain("aurora-final-marker");

    for (const privateTerm of [
      "reasoning-only-marker",
      "file-content-only-marker",
      "raw-command-log-marker",
    ]) {
      expect(await searchSessions(privateTerm, { dataDir })).toEqual([]);
    }
  });

  test("redacts credential-like values from returned session snippets", async () => {
    const dataDir = await fixture();
    const manager = join(dataDir, "sessions", "manager");
    await mkdir(manager, { recursive: true });
    const credential = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890";
    await writeFile(
      join(manager, "secrets.jsonl"),
      [
        sessionMetadata("secrets", "manager", 50),
        message(`Deployment credential api_key=${credential}`, 51),
      ].join("\n") + "\n",
    );

    const results = await searchSessions("deployment credential", { dataDir });
    const snippets = results.flatMap((result) => result.snippets).join(" ");
    expect(snippets).toContain("[REDACTED]");
    expect(snippets).not.toContain(credential);
  });

  test("ignores corrupt files and malformed or partial lines", async () => {
    const dataDir = await fixture();
    const manager = join(dataDir, "sessions", "manager");
    const sidekick = join(dataDir, "sessions", "sidekick");
    await mkdir(manager, { recursive: true });
    await mkdir(sidekick, { recursive: true });
    await writeFile(join(manager, "broken.jsonl"), "not json\n{partial");
    await writeFile(
      join(sidekick, "partial-session.jsonl"),
      `${sessionMetadata("partial-session", "sidekick", 30)}\n${message("recoverable lighthouse match", 31)}\n{"type":"message"`,
    );

    const results = await searchSessions("lighthouse", { dataDir });
    expect(results).toMatchObject([
      { role: "sidekick", sessionId: "partial-session", timestamp: 31 },
    ]);
  });
});
