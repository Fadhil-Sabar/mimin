import { describe, expect, test } from "bun:test";
import {
  applyReview,
  canRevise,
  dispatchContract,
  isReviewDecision,
  revisionContract,
} from "../src/task/review.js";
import { TaskBoard } from "../src/task/task.js";

describe("isReviewDecision", () => {
  test("accepts valid decisions", () => {
    expect(isReviewDecision("accept")).toBe(true);
    expect(isReviewDecision("revise")).toBe(true);
    expect(isReviewDecision("reject")).toBe(true);
  });
  test("rejects invalid values", () => {
    expect(isReviewDecision("maybe")).toBe(false);
    expect(isReviewDecision(undefined)).toBe(false);
  });
});

describe("applyReview", () => {
  test("accept completes the task", () => {
    const board = new TaskBoard();
    const task = board.create({ title: "A", description: "a" });
    board.transition(task.id, "reviewing");
    const outcome = applyReview(board, { taskId: task.id, decision: "accept" }, 2);
    expect(outcome.ok).toBe(true);
    expect(board.get(task.id)!.status).toBe("completed");
  });

  test("reject fails the task", () => {
    const board = new TaskBoard();
    const task = board.create({ title: "A", description: "a" });
    board.transition(task.id, "reviewing");
    const outcome = applyReview(board, { taskId: task.id, decision: "reject" }, 2);
    expect(outcome.ok).toBe(true);
    expect(board.get(task.id)!.status).toBe("failed");
  });

  test("revise transitions to revising and records feedback", () => {
    const board = new TaskBoard();
    const task = board.create({ title: "A", description: "a" });
    board.transition(task.id, "reviewing");
    const outcome = applyReview(
      board,
      { taskId: task.id, decision: "revise", feedback: "handle expired tokens" },
      2,
    );
    expect(outcome.ok).toBe(true);
    expect(board.get(task.id)!.status).toBe("revising");
    expect(board.get(task.id)!.reviewIterations).toBe(1);
    expect(board.get(task.id)!.pendingFeedback).toBe("handle expired tokens");
  });

  test("revise without feedback is rejected", () => {
    const board = new TaskBoard();
    const task = board.create({ title: "A", description: "a" });
    board.transition(task.id, "reviewing");
    const outcome = applyReview(board, { taskId: task.id, decision: "revise" }, 2);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("feedback");
    expect(board.get(task.id)!.status).toBe("reviewing");
  });

  test("revise respects maxReviewIterations", () => {
    const board = new TaskBoard();
    const task = board.create({ title: "A", description: "a" });
    board.transition(task.id, "reviewing");
    // First revision allowed.
    expect(
      applyReview(board, { taskId: task.id, decision: "revise", feedback: "f1" }, 1).ok,
    ).toBe(true);
    // Back to reviewing, second revision blocked (limit 1).
    board.transition(task.id, "reviewing");
    const outcome = applyReview(
      board,
      { taskId: task.id, decision: "revise", feedback: "f2" },
      1,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("budget");
    expect(board.get(task.id)!.status).toBe("reviewing");
  });

  test("no infinite review loop: limit 2 blocks the third revision", () => {
    const board = new TaskBoard();
    const task = board.create({ title: "A", description: "a" });
    for (let i = 0; i < 2; i += 1) {
      board.transition(task.id, "reviewing");
      expect(
        applyReview(board, { taskId: task.id, decision: "revise", feedback: `f${i}` }, 2).ok,
      ).toBe(true);
    }
    board.transition(task.id, "reviewing");
    const outcome = applyReview(
      board,
      { taskId: task.id, decision: "revise", feedback: "f3" },
      2,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("budget");
  });

  test("unknown task id returns an error", () => {
    const board = new TaskBoard();
    const outcome = applyReview(board, { taskId: "T99", decision: "accept" }, 2);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("Unknown task");
  });

  test("cannot revise a completed task", () => {
    const board = new TaskBoard();
    const task = board.create({ title: "A", description: "a" });
    board.transition(task.id, "completed");
    const outcome = applyReview(
      board,
      { taskId: task.id, decision: "revise", feedback: "nope" },
      2,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("completed");
  });

  test("canRevise respects the iteration count", () => {
    const board = new TaskBoard();
    const task = board.create({ title: "A", description: "a" });
    expect(canRevise(board, task, 2)).toBe(true);
    board.recordReviewIteration(task.id);
    board.recordReviewIteration(task.id);
    expect(canRevise(board, task, 2)).toBe(false);
  });
});

describe("contracts", () => {
  test("dispatchContract embeds the task scope", () => {
    const board = new TaskBoard();
    const task = board.create({ title: "Fix auth", description: "Handle refresh tokens" });
    const contract = dispatchContract(task);
    expect(contract).toContain("T01: Fix auth");
    expect(contract).toContain("Handle refresh tokens");
  });

  test("revisionContract carries the pending feedback", () => {
    const board = new TaskBoard();
    const task = board.create({ title: "Fix auth", description: "x" });
    applyReview(
      board,
      { taskId: task.id, decision: "revise", feedback: "cover expired tokens" },
      2,
    );
    const contract = revisionContract(board.get(task.id)!);
    expect(contract).toContain("cover expired tokens");
    expect(contract).toContain("same structured result JSON");
  });
});
