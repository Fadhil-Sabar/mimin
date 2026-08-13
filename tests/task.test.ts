import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { SessionStore } from "../src/session/session.js";
import {
  attachTaskBoardPersistence,
  isTaskBoardEvent,
  restoreTaskBoard,
} from "../src/task/persistence.js";
import {
  recoverTasks,
  TaskBoard,
  taskId,
  type Task,
} from "../src/task/task.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function sessionRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mimin-task-persistence-"));
  temporaryDirectories.push(root);
  return root;
}

describe("taskId", () => {
  test("generates human-readable sequential ids", () => {
    expect(taskId(0)).toBe("T01");
    expect(taskId(1)).toBe("T02");
    expect(taskId(9)).toBe("T10");
  });
});

describe("TaskBoard", () => {
  test("creates tasks with sequential ids and pending status", () => {
    const board = new TaskBoard();
    const first = board.create({ title: "A", description: "a" });
    const second = board.create({ title: "B", description: "b" });
    expect(first.id).toBe("T01");
    expect(second.id).toBe("T02");
    expect(first.status).toBe("pending");
    expect(board.tasks).toHaveLength(2);
  });

  test("transitions status and records completion time", () => {
    const board = new TaskBoard({ now: () => 1000 });
    const task = board.create({ title: "A", description: "a" });
    board.transition(task.id, "running");
    expect(board.get(task.id)!.status).toBe("running");
    board.transition(task.id, "completed");
    expect(board.get(task.id)!.status).toBe("completed");
    expect(board.get(task.id)!.completedAt).toBe(1000);
  });

  test("dependency handling: pending until dependency completes", () => {
    const board = new TaskBoard();
    const t1 = board.create({ title: "investigate", description: "i" });
    const t2 = board.create({
      title: "implement",
      description: "impl",
      dependsOn: [t1.id],
    });
    expect(board.dependenciesComplete(t2)).toBe(false);
    expect(board.dispatchable().map((task) => task.id)).toEqual(["T01"]);

    board.transition(t1.id, "completed");
    expect(board.dependenciesComplete(t2)).toBe(true);
    expect(board.dispatchable().map((task) => task.id)).toEqual(["T02"]);
  });

  test("completed dependency unlocks pending task", () => {
    const board = new TaskBoard();
    const t1 = board.create({ title: "A", description: "a" });
    const t2 = board.create({ title: "B", description: "b", dependsOn: [t1.id] });
    const t3 = board.create({ title: "C", description: "c" });
    board.transition(t1.id, "completed");
    // T03 has no deps, so both T02 and T03 are dispatchable.
    expect(board.dispatchable().map((task) => task.id).sort()).toEqual(["T02", "T03"]);
  });

  test("failed dependency keeps dependent pending", () => {
    const board = new TaskBoard();
    const t1 = board.create({ title: "A", description: "a" });
    const t2 = board.create({ title: "B", description: "b", dependsOn: [t1.id] });
    board.transition(t1.id, "failed");
    expect(board.dependenciesComplete(t2)).toBe(false);
    expect(board.dispatchable().map((task) => task.id)).toEqual([]);
  });

  test("concurrency capacity respects the 3-sidekick limit", () => {
    const board = new TaskBoard();
    const tasks = [0, 1, 2, 3].map((index) =>
      board.create({ title: `T${index}`, description: "" }),
    );
    expect(board.hasCapacity()).toBe(true);
    for (const task of tasks.slice(0, 3)) board.transition(task.id, "running");
    expect(board.hasCapacity()).toBe(false);
    board.transition(tasks[0]!.id, "completed");
    expect(board.hasCapacity()).toBe(true);
  });

  test("records review iterations", () => {
    const board = new TaskBoard();
    const task = board.create({ title: "A", description: "a" });
    expect(board.recordReviewIteration(task.id)).toBe(1);
    expect(board.recordReviewIteration(task.id)).toBe(2);
    expect(board.get(task.id)!.reviewIterations).toBe(2);
  });

  test("normalizes file claims on create", () => {
    const board = new TaskBoard();
    const task = board.create({
      title: "A",
      description: "a",
      files: ["./src/a.ts", "src/../src/b.ts", "  ", "docs/"],
    });
    expect(task.files).toEqual(["src/a.ts", "src/b.ts", "docs/"]);
  });

  test("file overlap: exact, prefix, and directory claims", () => {
    expect(TaskBoard.filesOverlap("src/a.ts", "src/a.ts")).toBe(true);
    expect(TaskBoard.filesOverlap("src/a.ts", "src/a.tsx")).toBe(false);
    expect(TaskBoard.filesOverlap("src/", "src/a.ts")).toBe(true);
    expect(TaskBoard.filesOverlap("src/a.ts", "src/")).toBe(true);
    expect(TaskBoard.filesOverlap("src/a.ts", "lib/b.ts")).toBe(false);
    expect(TaskBoard.filesOverlap("./src/a.ts", "src/a.ts")).toBe(true);
    expect(TaskBoard.filesOverlap("", "src/a.ts")).toBe(false);
  });

  test("task overlap requires both tasks to claim files", () => {
    const board = new TaskBoard();
    const a = board.create({ title: "A", description: "a", files: ["src/a.ts"] });
    const b = board.create({ title: "B", description: "b" });
    const c = board.create({ title: "C", description: "c", files: ["src/c.ts"] });
    expect(TaskBoard.tasksOverlap(a, b)).toBe(false);
    expect(TaskBoard.tasksOverlap(b, c)).toBe(false);
    expect(TaskBoard.tasksOverlap(a, c)).toBe(false);
  });

  test("scheduler skips tasks overlapping a running task (sequential)", () => {
    const board = new TaskBoard({ maxConcurrent: 3 });
    const a = board.create({ title: "A", description: "a", files: ["src/a.ts"] });
    const b = board.create({ title: "B", description: "b", files: ["src/a.ts"] });
    const c = board.create({ title: "C", description: "c", files: ["src/c.ts"] });
    board.transition(a.id, "running");
    const scheduled = board.schedule();
    // B overlaps running A so it is skipped; C has no overlap and is dispatched.
    expect(scheduled.map((task) => task.id)).toEqual(["T03"]);
  });

  test("scheduler never dispatches overlapping tasks in the same batch", () => {
    const board = new TaskBoard({ maxConcurrent: 3 });
    const a = board.create({ title: "A", description: "a", files: ["src/shared.ts"] });
    const b = board.create({ title: "B", description: "b", files: ["src/shared.ts"] });
    const c = board.create({ title: "C", description: "c", files: ["src/c.ts"] });
    const scheduled = board.schedule();
    expect(scheduled).toHaveLength(2);
    expect(scheduled.map((task) => task.id)).toEqual(["T01", "T03"]);
  });

  test("scheduler dispatches non-overlapping tasks up to the pool cap", () => {
    const board = new TaskBoard({ maxConcurrent: 3 });
    const tasks = [0, 1, 2, 3].map((index) =>
      board.create({ title: `T${index}`, description: "", files: [`src/file-${index}.ts`] }),
    );
    const scheduled = board.schedule();
    expect(scheduled.map((task) => task.id)).toEqual(["T01", "T02", "T03"]);
    board.transition(tasks[0]!.id, "completed");
    board.transition(tasks[1]!.id, "completed");
    board.transition(tasks[2]!.id, "completed");
    expect(board.schedule().map((task) => task.id)).toEqual(["T04"]);
  });

  test("scheduler keeps dependency gating ahead of overlap gating", () => {
    const board = new TaskBoard({ maxConcurrent: 2 });
    const a = board.create({ title: "A", description: "a", files: ["src/a.ts"] });
    const b = board.create({
      title: "B",
      description: "b",
      dependsOn: [a.id],
      files: ["src/b.ts"],
    });
    // B depends on A, so only A is dispatchable despite capacity.
    expect(board.schedule().map((task) => task.id)).toEqual(["T01"]);
    board.transition(a.id, "completed");
    expect(board.schedule().map((task) => task.id)).toEqual(["T02"]);
  });

  test("overlap gating is lifted once the running task completes", () => {
    const board = new TaskBoard({ maxConcurrent: 3 });
    const a = board.create({ title: "A", description: "a", files: ["src/a.ts"] });
    const b = board.create({ title: "B", description: "b", files: ["src/a.ts"] });
    board.transition(a.id, "running");
    expect(board.schedule().map((task) => task.id)).toEqual([]);
    board.transition(a.id, "completed");
    expect(board.schedule().map((task) => task.id)).toEqual(["T02"]);
  });

  test("schedule returns tasks with completed deps up to pool capacity", () => {
    const board = new TaskBoard({ maxConcurrent: 3 });
    const t1 = board.create({ title: "A", description: "a" });
    const t2 = board.create({ title: "B", description: "b" });
    const t3 = board.create({ title: "C", description: "c" });
    const t4 = board.create({
      title: "E",
      description: "e",
      dependsOn: [t1.id],
    });

    // No capacity used yet: all pending tasks without deps fit in the pool.
    expect(board.schedule().map((task) => task.id)).toEqual(["T01", "T02", "T03"]);

    // A blocked task is never scheduled, even with free slots.
    board.transition(t1.id, "completed");
    board.transition(t2.id, "running");
    expect(board.schedule().map((task) => task.id)).toEqual(["T03", "T04"]);
  });

  test("schedule respects the pool cap and yields nothing at full capacity", () => {
    const board = new TaskBoard({ maxConcurrent: 2 });
    const t1 = board.create({ title: "A", description: "a" });
    const t2 = board.create({ title: "B", description: "b" });
    const t3 = board.create({ title: "C", description: "c" });

    expect(board.schedule().map((task) => task.id)).toEqual(["T01", "T02"]);

    board.transition(t1.id, "running");
    board.transition(t2.id, "running");
    expect(board.schedule()).toEqual([]);

    board.transition(t1.id, "completed");
    expect(board.schedule().map((task) => task.id)).toEqual(["T03"]);
  });

  test("serializes and restores via fromJSON", () => {
    const board = new TaskBoard({ now: () => 500 });
    const t1 = board.create({ title: "A", description: "a" });
    const t2 = board.create({ title: "B", description: "b", dependsOn: [t1.id] });
    board.transition(t1.id, "running");
    board.bindSidekick(t1.id, "sidekick-1");
    board.transition(t1.id, "completed");

    const restored = TaskBoard.fromJSON(board.toJSON());
    expect(restored.tasks).toHaveLength(2);
    expect(restored.get("T01")!.status).toBe("completed");
    expect(restored.get("T01")!.sidekickId).toBe("sidekick-1");
    expect(restored.get("T02")!.dependsOn).toEqual(["T01"]);
    expect(restored.dependenciesComplete(restored.get("T02")!)).toBe(true);
  });

  test("fromJSON ignores invalid records", () => {
    const board = TaskBoard.fromJSON([
      { id: "T01", title: "x", description: "y", status: "nonsense", createdAt: 1 },
      "not-an-object",
      null,
      { id: "T02", title: "ok", description: "ok", status: "pending", createdAt: 1 },
    ]);
    expect(board.tasks).toHaveLength(1);
    expect(board.tasks[0]!.id).toBe("T02");
  });
});

describe("recoverTasks", () => {
  test("running task with missing sidekick becomes failed", () => {
    const board = new TaskBoard();
    const task = board.create({ title: "A", description: "a" });
    board.transition(task.id, "running");
    board.bindSidekick(task.id, "sidekick-gone");
    const recovered = recoverTasks(board, new Set(["sidekick-1", "sidekick-2"]));
    expect(recovered).toEqual(["T01"]);
    expect(board.get("T01")!.status).toBe("failed");
  });

  test("running task without sidekick becomes failed", () => {
    const board = new TaskBoard();
    const task = board.create({ title: "A", description: "a" });
    board.transition(task.id, "running");
    recoverTasks(board, new Set());
    expect(board.get("T01")!.status).toBe("failed");
  });

  test("revising task with missing sidekick resets to pending", () => {
    const board = new TaskBoard();
    const task = board.create({ title: "A", description: "a" });
    board.transition(task.id, "revising");
    board.bindSidekick(task.id, "sidekick-gone");
    const recovered = recoverTasks(board, new Set());
    expect(recovered).toEqual(["T01"]);
    expect(board.get("T01")!.status).toBe("pending");
  });

  test("running task with valid sidekick is left alone", () => {
    const board = new TaskBoard();
    const task = board.create({ title: "A", description: "a" });
    board.transition(task.id, "running");
    board.bindSidekick(task.id, "sidekick-1");
    const recovered = recoverTasks(board, new Set(["sidekick-1"]));
    expect(recovered).toEqual([]);
    expect(board.get("T01")!.status).toBe("running");
  });

  test("reviewing task without sidekick becomes failed", () => {
    const board = new TaskBoard();
    const task = board.create({ title: "A", description: "a" });
    board.transition(task.id, "reviewing");
    recoverTasks(board, new Set());
    expect(board.get("T01")!.status).toBe("failed");
  });

  test("does not touch completed or pending tasks", () => {
    const board = new TaskBoard();
    const done = board.create({ title: "A", description: "a" });
    const pending = board.create({ title: "B", description: "b" });
    board.transition(done.id, "completed");
    const recovered = recoverTasks(board, new Set());
    expect(recovered).toEqual([]);
    expect(board.get("T01")!.status).toBe("completed");
    expect(board.get("T02")!.status).toBe("pending");
  });
});

describe("task board event persistence", () => {
  test("serializes a board to a task_board event record and back", () => {
    const board = new TaskBoard({ now: () => 500 });
    const t1 = board.create({ title: "A", description: "a" });
    board.transition(t1.id, "running");
    board.bindSidekick(t1.id, "sidekick-1");
    board.attachResult(t1.id, {
      status: "completed",
      summary: "done",
      filesChanged: ["src/a.ts"],
      verification: [],
    });

    const event = board.toEvent();
    expect(isTaskBoardEvent(event)).toBe(true);
    expect(event.type).toBe("task_board");
    expect(event.version).toBe(1);
    expect(event.tasks).toHaveLength(1);
    expect(event.tasks[0]).toMatchObject({
      id: "T01",
      status: "running",
      sidekickId: "sidekick-1",
    });

    const restored = TaskBoard.fromEvents([event]);
    expect(restored.tasks).toHaveLength(1);
    expect(restored.get("T01")!.status).toBe("running");
    expect(restored.get("T01")!.sidekickId).toBe("sidekick-1");
    expect(restored.get("T01")!.lastResult?.summary).toBe("done");
  });

  test("fromEvents ignores non-task events and picks the newest snapshot", () => {
    const first = new TaskBoard({ now: () => 1 });
    first.create({ title: "A", description: "a" });

    const second = new TaskBoard({ now: () => 2 });
    const task = second.create({ title: "B", description: "b" });
    second.transition(task.id, "completed");

    const restored = TaskBoard.fromEvents([
      { type: "sidekick_started", sessionId: "sidekick-x" },
      first.toEvent(),
      { type: "tool_started", sessionId: "sidekick-x", tool: "edit" },
      second.toEvent(),
    ]);
    // Newest snapshot wins; unrelated events are ignored.
    expect(restored.tasks).toHaveLength(1);
    expect(restored.get("T01")!.title).toBe("B");
    expect(restored.get("T01")!.status).toBe("completed");
  });

  test("fromEvents yields an empty board when no valid snapshot exists", () => {
    const restored = TaskBoard.fromEvents([
      { type: "sidekick_started", sessionId: "sidekick-x" },
      { type: "task_board", version: 99, tasks: [] },
    ]);
    expect(restored.tasks).toHaveLength(0);
  });

  test("persists snapshots to a real manager session via appendEvent and restores them", async () => {
    const root = await sessionRoot();
    const store = new SessionStore({ root, idFactory: () => "manager-1" });
    const session = await store.createSession("manager");

    const board = new TaskBoard({ now: () => 1000 });
    const t1 = board.create({ title: "A", description: "a" });
    board.transition(t1.id, "running");
    board.bindSidekick(t1.id, "sidekick-1");
    const persistence = attachTaskBoardPersistence(session, board);
    await persistence.persist();

    // Interleave an unrelated event; it must not confuse the restore.
    await session.appendEvent({ type: "tool_started", sessionId: "sidekick-1", tool: "edit" });
    board.transition(t1.id, "reviewing");
    await persistence.persist();

    // Re-open the same session from disk, exactly like a resume.
    const reopened = await store.loadSession("manager", session.id);
    const { board: restored } = restoreTaskBoard(
      reopened,
      new Set(["sidekick-1"]),
    );
    expect(restored.tasks).toHaveLength(1);
    expect(restored.get("T01")!.status).toBe("reviewing");
    expect(restored.get("T01")!.sidekickId).toBe("sidekick-1");
    expect(reopened.events.filter(isTaskBoardEvent)).toHaveLength(2);
  });
});

describe("task board resume recovery", () => {
  test("recovery fails running and reviewing tasks bound to a missing sidekick", () => {
    const board = new TaskBoard();
    const running = board.create({ title: "A", description: "a" });
    const reviewing = board.create({ title: "B", description: "b" });
    const revising = board.create({ title: "C", description: "c" });
    board.transition(running.id, "running");
    board.bindSidekick(running.id, "sidekick-gone");
    board.transition(reviewing.id, "reviewing");
    board.bindSidekick(reviewing.id, "sidekick-also-gone");
    board.transition(revising.id, "revising");
    board.bindSidekick(revising.id, "sidekick-gone-too");

    const recovered = recoverTasks(board, new Set(["sidekick-1"]));
    expect(recovered.sort()).toEqual(["T01", "T02", "T03"]);
    expect(board.get("T01")!.status).toBe("failed");
    expect(board.get("T02")!.status).toBe("failed");
    // Revising resets to pending so the revision can be retried cleanly.
    expect(board.get("T03")!.status).toBe("pending");
  });

  test("recovery leaves active tasks alone when the sidekick still exists", () => {
    const board = new TaskBoard();
    const running = board.create({ title: "A", description: "a" });
    const reviewing = board.create({ title: "B", description: "b" });
    const revising = board.create({ title: "C", description: "c" });
    board.transition(running.id, "running");
    board.bindSidekick(running.id, "sidekick-1");
    board.transition(reviewing.id, "reviewing");
    board.bindSidekick(reviewing.id, "sidekick-2");
    board.transition(revising.id, "revising");
    board.bindSidekick(revising.id, "sidekick-3");

    const recovered = recoverTasks(
      board,
      new Set(["sidekick-1", "sidekick-2", "sidekick-3"]),
    );
    expect(recovered).toEqual([]);
    expect(board.get("T01")!.status).toBe("running");
    expect(board.get("T02")!.status).toBe("reviewing");
    expect(board.get("T03")!.status).toBe("revising");
  });

  test("resume recovery restores from a persisted session and fails stale bindings", async () => {
    const root = await sessionRoot();
    const store = new SessionStore({ root, idFactory: () => "manager-1" });
    const session = await store.createSession("manager");

    // First run: create tasks, bind sidekicks, persist. Simulate a crash by
    // never persisting again: the sidekick sessions below are never created.
    const board = new TaskBoard({ now: () => 1000 });
    const t1 = board.create({ title: "A", description: "a" });
    const t2 = board.create({ title: "B", description: "b" });
    board.transition(t1.id, "running");
    board.bindSidekick(t1.id, "sidekick-missing");
    board.transition(t2.id, "revising");
    board.bindSidekick(t2.id, "sidekick-also-missing");
    await session.appendEvent(board.toEvent());

    // Resume: only "sidekick-live" exists in the store; both bindings are stale.
    const liveSidekick = await store.createSession("sidekick");
    const reopened = await store.loadSession("manager", session.id);
    const { board: restored, recoveredTaskIds } = restoreTaskBoard(
      reopened,
      new Set([liveSidekick.id]),
    );
    expect(recoveredTaskIds.sort()).toEqual(["T01", "T02"]);
    expect(restored.get("T01")!.status).toBe("failed");
    expect(restored.get("T02")!.status).toBe("pending");
    expect(restored.get("T01")!.completedAt).toBeTypeOf("number");
  });

  test("resume keeps a task running when its sidekick session still exists", async () => {
    const root = await sessionRoot();
    const store = new SessionStore({ root, idFactory: () => "manager-1" });
    const session = await store.createSession("manager");

    const board = new TaskBoard({ now: () => 1000 });
    const t1 = board.create({ title: "A", description: "a" });
    board.transition(t1.id, "running");
    const sidekick = await store.createSession("sidekick");
    board.bindSidekick(t1.id, sidekick.id);
    await session.appendEvent(board.toEvent());

    const reopened = await store.loadSession("manager", session.id);
    const { board: restored, recoveredTaskIds } = restoreTaskBoard(
      reopened,
      new Set([sidekick.id]),
    );
    expect(recoveredTaskIds).toEqual([]);
    expect(restored.get("T01")!.status).toBe("running");
    expect(restored.get("T01")!.sidekickId).toBe(sidekick.id);
  });
});
