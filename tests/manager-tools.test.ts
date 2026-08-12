import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { Api, Model, ToolCall } from "@mariozechner/pi-ai";
import type { AnyAgentTool, ToolExecutionContext } from "../src/agent/types.js";
import { createMemorySearchTool } from "../src/tools/memory-search.js";
import { createSessionSearchTool } from "../src/tools/session-search.js";
import {
  createVerificationTool,
  VERIFICATION_ACTIONS,
  type VerificationSpawn,
} from "../src/tools/verification.js";

const temporaryDirectories: string[] = [];

const model: Model<Api> = {
  id: "fake", name: "Fake", api: "fake", provider: "fake", baseUrl: "http://invalid",
  reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000, maxTokens: 100,
};

function context(name: string): ToolExecutionContext {
  const toolCall: ToolCall = { type: "toolCall", id: "call", name, arguments: {} };
  return { model, turn: 1, toolCall };
}

async function execute(tool: AnyAgentTool, args: Record<string, unknown>) {
  return tool.execute(args, context(tool.name));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "mimin-manager-tools-"));
  temporaryDirectories.push(path);
  return path;
}

describe("manager retrieval tools", () => {
  test("memory_search combines/selects scopes and returns only bounded compact records", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const store = {
      search: async (_query: string, options: Record<string, unknown> = {}) => {
        calls.push(options);
        const scope = options.scope as "user" | "project";
        return Array.from({ length: 30 }, (_, index) => ({
          id: `${scope}-${index}`,
          scope,
          timestamp: index,
          score: 100 - index,
          snippet: `${"long ".repeat(100)}${scope}`,
          content: "RAW MEMORY RECORD MUST NOT ESCAPE",
        }));
      },
    };
    const tool = createMemorySearchTool({
      workspace: "/current/project",
      store,
    });
    const both = await execute(tool, { query: "long", scope: "both", limit: 20 });
    if (typeof both === "string") throw new Error("expected structured result");
    const parsed = JSON.parse(both.text) as { matches: Array<{ snippet: string }> };

    expect(calls.map((call) => call.scope)).toEqual(["user", "project"]);
    expect(calls[1]?.workspace).toBe("/current/project");
    expect(parsed.matches).toHaveLength(20);
    expect(parsed.matches.every((match) => match.snippet.length <= 240)).toBe(true);
    expect(both.text).not.toContain("RAW MEMORY RECORD");
    expect(both.text.length).toBeLessThan(10_000);

    calls.length = 0;
    await execute(tool, { query: "only", scope: "project", limit: 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ scope: "project", workspace: "/current/project" });
  });

  test("session_search compacts matches and never returns transcript fields", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const searcher = {
      search: async (_query: string, options: Record<string, unknown> = {}) => {
        calls.push(options);
        return Array.from({ length: 30 }, (_, index) => ({
          role: "manager" as const,
          sessionId: `manager-${index}`,
          timestamp: index,
          score: 30 - index,
          snippets: ["x".repeat(500), "second"],
          messages: ["FULL TRANSCRIPT"],
        }));
      },
    };
    const tool = createSessionSearchTool({ searcher });
    const output = await execute(tool, { query: "x", role: "manager", limit: 20 });
    if (typeof output === "string") throw new Error("expected structured result");
    const parsed = JSON.parse(output.text) as {
      matches: Array<{ snippets: string[] }>;
    };

    expect(calls[0]).toMatchObject({ role: "manager", limit: 20, maxSnippets: 3 });
    expect(parsed.matches).toHaveLength(20);
    expect(parsed.matches[0]?.snippets[0]?.length).toBeLessThanOrEqual(200);
    expect(output.text).not.toContain("FULL TRANSCRIPT");
    expect(output.text).not.toContain("messages");
  });
});

describe("restricted verification tool", () => {
  test("exposes only fixed actions, fixed commands, and the workspace cwd", async () => {
    const root = await workspace();
    await Bun.write(join(root, "package.json"), JSON.stringify({
      scripts: { typecheck: "tsc --noEmit", build: "bun build src.ts" },
    }));
    const calls: Array<{ command: string[]; cwd: string }> = [];
    const spawn: VerificationSpawn = (command, options) => {
      calls.push({ command, cwd: options.cwd });
      return {
        stdout: new Response("ok\u001b[31m").body,
        stderr: new Response("").body,
        exited: Promise.resolve(0),
        exitCode: 0,
      };
    };
    const tool = createVerificationTool({ workspace: root, spawn });
    const output = await execute(tool, { action: "all" });
    if (typeof output === "string") throw new Error("expected structured result");

    expect(VERIFICATION_ACTIONS).toEqual([
      "git_status", "git_diff", "test", "typecheck", "build", "all",
    ]);
    expect(calls.map((call) => call.command)).toEqual([
      ["bun", "test"],
      ["bun", "run", "typecheck"],
      ["bun", "run", "build"],
    ]);
    expect(calls.every((call) => call.cwd === root)).toBe(true);
    expect(calls[0]?.cwd).toBe(await realpath(root));
    expect(output.text).not.toContain("\u001b");
    expect(output).toMatchObject({ isError: false });

    await expect(execute(tool, { action: "test", command: "rm -rf /", cwd: "/" }))
      .rejects.toThrow("only a fixed action");
    await expect(execute(tool, { action: "shell" })).rejects.toThrow("Unknown verification action");
  });

  test("reports command failures and missing configured scripts", async () => {
    const root = await workspace();
    await Bun.write(join(root, "package.json"), JSON.stringify({ scripts: {} }));
    const failing: VerificationSpawn = () => ({
      stdout: new Response("partial").body,
      stderr: new Response("failed").body,
      exited: Promise.resolve(7),
      exitCode: 7,
    });
    const tool = createVerificationTool({ workspace: root, spawn: failing });
    const failed = await execute(tool, { action: "test" });
    expect(failed).toMatchObject({ isError: true });
    expect(JSON.stringify(failed)).toContain('"exitCode":7');

    const missing = await execute(tool, { action: "typecheck" });
    expect(missing).toMatchObject({ isError: true });
    expect(JSON.stringify(missing)).toContain("no typecheck script");
  });

  test("adds compact context only after the same verification failure repeats", async () => {
    const root = await workspace();
    let exitCode = 7;
    const spawn: VerificationSpawn = () => ({
      stdout: new Response("same output").body,
      stderr: new Response("same failure").body,
      exited: Promise.resolve(exitCode),
      exitCode,
    });
    const tool = createVerificationTool({ workspace: root, spawn });

    const first = await execute(tool, { action: "test" });
    const repeated = await execute(tool, { action: "test" });
    if (typeof first === "string" || typeof repeated === "string") {
      throw new Error("expected structured results");
    }
    expect(first.text).not.toContain("consecutive times");
    expect(repeated.text).toContain(
      "Verification has failed with the same result 2 consecutive times.",
    );

    exitCode = 0;
    const passed = await execute(tool, { action: "test" });
    expect(JSON.stringify(passed)).not.toContain("consecutive times");
    exitCode = 7;
    const laterFailure = await execute(tool, { action: "test" });
    expect(JSON.stringify(laterFailure)).not.toContain("consecutive times");
  });
});
