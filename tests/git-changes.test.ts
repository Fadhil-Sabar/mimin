import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  diffGitChanges,
  parsePorcelain,
  readGitChanges,
  type GitChanges,
} from "../src/task/git-changes.js";

const temporaryDirectories: string[] = [];

async function gitRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mimin-git-"));
  temporaryDirectories.push(root);
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
  await Bun.spawn(["git", "config", "user.email", "test@example.com"], { cwd: root }).exited;
  await Bun.spawn(["git", "config", "user.name", "Test"], { cwd: root }).exited;
  return root;
}

async function write(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf8");
}

async function commitAll(repo: string, message: string): Promise<void> {
  await Bun.spawn(["git", "add", "-A"], { cwd: repo }).exited;
  await Bun.spawn(["git", "commit", "-q", "-m", message], { cwd: repo }).exited;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("parsePorcelain", () => {
  test("parses modified, added, deleted, untracked", () => {
    const entries = parsePorcelain(
      " M src/a.ts\nA  src/b.ts\n D src/c.ts\n?? new-file.ts\n",
    );
    expect(entries).toEqual([
      { status: " M", path: "src/a.ts" },
      { status: "A ", path: "src/b.ts" },
      { status: " D", path: "src/c.ts" },
      { status: "??", path: "new-file.ts" },
    ]);
  });

  test("parses renames keeping the new path", () => {
    const entries = parsePorcelain("R  old.ts -> new.ts\n");
    expect(entries).toEqual([{ status: "R ", path: "new.ts" }]);
  });
});

describe("diffGitChanges", () => {
  test("attributes only paths that changed between baseline and completion", () => {
    const before: GitChanges = { modified: ["src/user.ts"], added: [], deleted: [] };
    const after: GitChanges = {
      modified: ["src/user.ts", "src/auth.ts"],
      added: ["src/new.ts"],
      deleted: [],
    };
    const delta = diffGitChanges(before, after);
    expect(delta.modified).toEqual(["src/auth.ts"]);
    expect(delta.added).toEqual(["src/new.ts"]);
    expect(delta.deleted).toEqual([]);
  });

  test("pre-existing dirty workspace is not attributed to the sidekick", () => {
    const before: GitChanges = { modified: ["README.md"], added: [], deleted: [] };
    const after: GitChanges = { modified: ["README.md"], added: [], deleted: [] };
    const delta = diffGitChanges(before, after);
    expect(delta.modified).toEqual([]);
    expect(delta.added).toEqual([]);
    expect(delta.deleted).toEqual([]);
  });

  test("a path dirty before but modified again is still not double-counted", () => {
    const before: GitChanges = { modified: ["src/a.ts"], added: [], deleted: [] };
    const after: GitChanges = { modified: ["src/a.ts"], added: [], deleted: [] };
    const delta = diffGitChanges(before, after);
    expect(delta.modified).toEqual([]);
  });

  test("deletions appear only when they were not deleted before", () => {
    const before: GitChanges = { modified: [], added: [], deleted: ["old.ts"] };
    const after: GitChanges = { modified: [], added: [], deleted: ["old.ts", "gone.ts"] };
    const delta = diffGitChanges(before, after);
    expect(delta.deleted).toEqual(["gone.ts"]);
  });

  test("falls back to after state when git is unavailable", () => {
    const after: GitChanges = {
      modified: ["a.ts"],
      added: [],
      deleted: [],
      unavailable: true,
    };
    const delta = diffGitChanges({ modified: [], added: [], deleted: [] }, after);
    expect(delta.unavailable).toBe(true);
    expect(delta.modified).toEqual(["a.ts"]);
  });

  test("preserves insertion/deletion counts", () => {
    const delta = diffGitChanges(
      { modified: ["a.ts"], added: [], deleted: [] },
      { modified: ["b.ts"], added: [], deleted: [], insertions: 12, deletions: 4 },
    );
    expect(delta.insertions).toBe(12);
    expect(delta.deletions).toBe(4);
  });
});

describe("readGitChanges", () => {
  test("reports unavailable outside a git repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "mimin-nogit-"));
    temporaryDirectories.push(root);
    const changes = await readGitChanges(root);
    expect(changes.unavailable).toBe(true);
  });

  test("captures modified, added, deleted after edits", async () => {
    const repo = await gitRepo();
    await write(join(repo, "a.ts"), "one\n");
    await commitAll(repo, "initial");
    await write(join(repo, "a.ts"), "one\ntwo\n");
    await write(join(repo, "b.ts"), "new\n");
    await write(join(repo, "c.ts"), "gone\n");
    await commitAll(repo, "setup");
    // Now make changes: modify a.ts, add d.ts, delete c.ts
    await write(join(repo, "a.ts"), "one\ntwo\nthree\n");
    await write(join(repo, "d.ts"), "added\n");
    await Bun.spawn(["git", "rm", "-q", "c.ts"], { cwd: repo }).exited;

    const changes = await readGitChanges(repo);
    expect(changes.modified).toContain("a.ts");
    expect(changes.added).toContain("d.ts");
    expect(changes.deleted).toContain("c.ts");
  });

  test("baseline + completion delta excludes pre-existing dirty files", async () => {
    const repo = await gitRepo();
    await write(join(repo, "a.ts"), "one\n");
    await write(join(repo, "b.ts"), "tracked\n");
    await commitAll(repo, "initial");
    // Pre-existing user change: modify tracked b.ts before the sidekick starts.
    await write(join(repo, "b.ts"), "user change\n");

    const before = await readGitChanges(repo);
    expect(before.modified).toContain("b.ts");

    // Sidekick modifies a.ts only.
    await write(join(repo, "a.ts"), "one\nsidekick\n");
    const after = await readGitChanges(repo);

    const delta = diffGitChanges(before, after);
    expect(delta.modified).toContain("a.ts");
    expect(delta.modified).not.toContain("b.ts");
  });
});
