import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";
import { MemoryLearner, parseLearnerCandidates } from "../src/memory/learner.js";
import { learnFromTurn } from "../src/memory/auto.js";
import { MemoryStore } from "../src/memory/store.js";
import type { MemoryCandidate } from "../src/memory/learner.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mimin-learner-"));
  temporaryDirectories.push(directory);
  return directory;
}

const FAKE_MODEL: Model<Api> = {
  id: "fake-model",
  name: "Fake",
  api: "openai-completions",
  provider: "fake",
  baseUrl: "https://fake.example",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_384,
};

/** Build a valid AssistantMessage carrying JSON text for the fake completer. */
function assistantMessage(json: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: json }],
    api: "openai-completions",
    provider: "fake",
    model: "fake-model",
    timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
  };
}

/** A learner that returns a canned candidate list without any network. */
function learnerWithCandidates(candidates: MemoryCandidate[]): MemoryLearner {
  return new MemoryLearner({
    role: { provider: "fake", model: "fake-model", thinking: "off" },
    model: FAKE_MODEL,
    complete: async () => assistantMessage(JSON.stringify({ candidates })),
  });
}

describe("parseLearnerCandidates", () => {
  test("accepts well-formed candidates and rejects malformed ones", () => {
    const payload = JSON.stringify({
      candidates: [
        { scope: "user", text: "I prefer Bun", confidence: 0.9, reason: "preference" },
        { scope: "project", text: "This repo uses Bun", confidence: 0.8, reason: "project-convention" },
        { scope: "user", text: "short", confidence: 0.2, reason: "stable-context" },
        { scope: "user", text: "", confidence: 0.9, reason: "preference" },
        { scope: "nope", text: "bad scope", confidence: 0.9, reason: "preference" },
        { scope: "user", text: "bad reason", confidence: 0.9, reason: "unknown" },
        { scope: "user", text: "no confidence", reason: "preference" },
        "not an object",
      ],
    });
    const candidates = parseLearnerCandidates(payload);
    // parseLearnerCandidates validates SHAPE only; the confidence threshold is
    // applied later by the app. So valid-shape entries are kept (4 of them).
    expect(candidates).toHaveLength(4);
    expect(candidates[0]).toEqual({
      scope: "user",
      text: "I prefer Bun",
      confidence: 0.9,
      reason: "preference",
    });
    expect(candidates[1]).toEqual({
      scope: "project",
      text: "This repo uses Bun",
      confidence: 0.8,
      reason: "project-convention",
    });
    // Low-confidence and missing-confidence entries are shape-valid.
    expect(candidates.map((c) => c.text)).toContain("short");
    expect(candidates.map((c) => c.text)).toContain("no confidence");
    // Invalid scope, invalid reason, and non-objects are rejected.
    expect(candidates.some((c) => c.scope === ("nope" as never))).toBe(false);
    expect(candidates.some((c) => c.reason === ("unknown" as never))).toBe(false);
    expect(candidates.length).toBeLessThan(6);
  });

  test("returns empty for non-JSON or non-object payloads", () => {
    expect(parseLearnerCandidates("not json")).toEqual([]);
    expect(parseLearnerCandidates('{"nope":1}')).toEqual([]);
    expect(parseLearnerCandidates('[1,2]')).toEqual([]);
    expect(parseLearnerCandidates('')).toEqual([]);
  });
});

describe("MemoryLearner", () => {
  test("extracts candidates from user-authored turns with confidence threshold", async () => {
    const learner = new MemoryLearner({
      role: { provider: "fake", model: "fake-model", thinking: "off" },
      model: FAKE_MODEL,
      complete: async (_model, context, options) => {
        // The learner must receive ONLY bounded user text, never tools or files.
        const prompt = context.messages[0]?.content ?? "";
        expect(String(prompt)).toContain("User messages to analyze");
        expect(String(prompt)).toContain("I prefer Bun instead of npm");
        expect(options?.signal).toBeDefined();
        return assistantMessage(JSON.stringify({
          candidates: [
            { scope: "user", text: "I prefer Bun instead of npm", confidence: 0.95, reason: "preference" },
            { scope: "project", text: "Use pnpm here", confidence: 0.7, reason: "project-convention" },
          ],
        }));
      },
    });

    const result = await learner.learn(["I prefer Bun instead of npm"], [], new AbortController().signal);
    expect(result.status).toBe("learned");
    expect(result.candidates).toHaveLength(2);
  });

  test("drops low-confidence candidates below 0.6", async () => {
    const learner = learnerWithCandidates([
      { scope: "user", text: "Maybe try React", confidence: 0.4, reason: "preference" },
      { scope: "user", text: "I prefer Bun", confidence: 0.9, reason: "preference" },
    ]);
    const result = await learner.learn(["Maybe try React. I prefer Bun."]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.text).toBe("I prefer Bun");
  });

  test("filters secrets from candidate output even if the model leaks them", async () => {
    const learner = learnerWithCandidates([
      {
        scope: "user",
        text: "my api key is sk-proj-abcdefghijklmnopqrstuvwxyz1234567890",
        confidence: 0.99,
        reason: "stable-context",
      },
    ]);
    const result = await learner.learn(["my api key is sk-proj-abcdefghijklmnopqrstuvwxyz1234567890"]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.text).not.toContain("sk-proj-");
  });

  test("never throws on provider failure; returns empty candidates", async () => {
    const learner = new MemoryLearner({
      role: { provider: "fake", model: "fake-model", thinking: "off" },
      model: FAKE_MODEL,
      complete: async () => { throw new Error("provider down"); },
    });
    const result = await learner.learn(["hello"]);
    expect(result).toEqual({ candidates: [], status: "none", learned: 0 });
  });

  test("passes a resolved auth.json apiKey to the completion request", async () => {
    let receivedOptions: { apiKey?: string } | undefined;
    const learner = new MemoryLearner({
      role: { provider: "commandcode", model: "gpt-5.5", thinking: "off" },
      model: FAKE_MODEL,
      apiKey: "sk-stored-from-auth-json",
      complete: async (_model, _context, options) => {
        receivedOptions = options ?? {};
        return assistantMessage(JSON.stringify({ candidates: [] }));
      },
    });
    const result = await learner.learn(["I prefer Bun"]);
    expect(result.status).toBe("none");
    // The stored credential is forwarded so the learner's request works
    // without a COMMANDCODE_API_KEY env var.
    expect(receivedOptions?.apiKey).toBe("sk-stored-from-auth-json");
  });
});

describe("learnFromTurn integration", () => {
  test("persists candidates and reports the learned count", async () => {
    const root = await fixture();
    const store = new MemoryStore({ root: join(root, "memory"), workspace: root });
    const learner = learnerWithCandidates([
      { scope: "user", text: "I prefer Bun instead of npm", confidence: 0.95, reason: "preference" },
      { scope: "project", text: "For this project always use pnpm", confidence: 0.8, reason: "project-convention" },
    ]);

    const result = await learnFromTurn(learner, store, root, ["I prefer Bun instead of npm"]);
    expect(result.learned).toBe(2);
    expect(result.status).toBe("learned");

    const user = await store.load("user");
    const project = await store.load("project", { workspace: root });
    expect(user.map((r) => r.content)).toEqual(["I prefer Bun instead of npm"]);
    expect(project.map((r) => r.content)).toEqual(["For this project always use pnpm"]);
  });

  test("deduplicates: identical memory is not written twice", async () => {
    const root = await fixture();
    const store = new MemoryStore({ root: join(root, "memory"), workspace: root });
    const learner = learnerWithCandidates([
      { scope: "user", text: "I prefer Bun instead of npm", confidence: 0.95, reason: "preference" },
    ]);

    await learnFromTurn(learner, store, root, ["I prefer Bun instead of npm"]);
    await learnFromTurn(learner, store, root, ["I prefer Bun instead of npm"]);
    const user = await store.load("user");
    expect(user).toHaveLength(1);
  });

  test("correction supersedes an existing memory (no contradictory duplicates)", async () => {
    const root = await fixture();
    const store = new MemoryStore({ root: join(root, "memory"), workspace: root });
    // Existing memory: "I use Arch Linux."
    await store.remember("I use Arch Linux", { scope: "user" });
    const learner = learnerWithCandidates([
      { scope: "user", text: "No, I use Fedora now", confidence: 0.95, reason: "correction" },
    ]);

    const result = await learnFromTurn(learner, store, root, ["No, I use Fedora now"]);
    expect(result.learned).toBe(1);

    const user = await store.load("user");
    // Only the new memory surfaces; the old one is tombstoned.
    expect(user).toHaveLength(1);
    expect(user[0]?.content).toBe("No, I use Fedora now");
    expect(user[0]?.supersedes).toBeDefined();
    expect(user[0]?.supersedes).not.toBe(user[0]?.id);
  });

  test("secret-like candidates never reach storage", async () => {
    const root = await fixture();
    const store = new MemoryStore({ root: join(root, "memory"), workspace: root });
    const learner = learnerWithCandidates([
      {
        scope: "user",
        text: "password=super-secret-password-12345",
        confidence: 0.99,
        reason: "stable-context",
      },
    ]);

    const result = await learnFromTurn(learner, store, root, ["password=super-secret-password-12345"]);
    // The candidate is filtered: no persistable text remains.
    expect(result.learned).toBe(0);
    const user = await store.load("user");
    expect(user).toHaveLength(0);
  });

  test("low-confidence candidates are never persisted", async () => {
    const root = await fixture();
    const store = new MemoryStore({ root: join(root, "memory"), workspace: root });
    const learner = learnerWithCandidates([
      { scope: "user", text: "Maybe we should try React", confidence: 0.3, reason: "preference" },
    ]);

    const result = await learnFromTurn(learner, store, root, ["Maybe we should try React"]);
    expect(result.learned).toBe(0);
    expect(result.status).toBe("none");
    expect(await store.load("user")).toHaveLength(0);
  });

  test("classifies user vs project scope conservatively", async () => {
    const root = await fixture();
    const store = new MemoryStore({ root: join(root, "memory"), workspace: root });
    const learner = learnerWithCandidates([
      { scope: "user", text: "I prefer concise answers", confidence: 0.9, reason: "preference" },
      { scope: "project", text: "Always run typecheck before committing in this project", confidence: 0.85, reason: "project-convention" },
    ]);

    await learnFromTurn(learner, store, root, ["I prefer concise answers. Always run typecheck before committing."]);
    expect((await store.load("user")).map((r) => r.content)).toEqual(["I prefer concise answers"]);
    expect((await store.load("project", { workspace: root })).map((r) => r.content)).toEqual([
      "Always run typecheck before committing in this project",
    ]);
  });

  test("never throws on learner failure during a turn", async () => {
    const root = await fixture();
    const store = new MemoryStore({ root: join(root, "memory"), workspace: root });
    const learner = new MemoryLearner({
      role: { provider: "fake", model: "fake-model", thinking: "off" },
      model: FAKE_MODEL,
      complete: async () => { throw new Error("boom"); },
    });
    const result = await learnFromTurn(learner, store, root, ["hello"]);
    expect(result).toEqual({ learned: 0, status: "none" });
  });
});
