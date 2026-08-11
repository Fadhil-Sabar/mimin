import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { AuthStore } from "../src/auth.js";
import { commandCodeCredentials } from "../src/agent/model.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mimin-auth-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("AuthStore", () => {
  test("persists a key to auth.json with owner-only permissions", async () => {
    const root = await fixture();
    const store = new AuthStore({ dataDir: root, env: {} });
    await store.setKey("commandcode", "sk-test-1234567890");
    expect(await store.hasKey("commandcode")).toBe(true);
    expect(await store.getKey("commandcode")).toBe("sk-test-1234567890");

    // The file is at <dataDir>/auth.json with mode 0600.
    const file = join(root, "auth.json");
    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);

    // A fresh store reads the same key back.
    const reloaded = new AuthStore({ dataDir: root, env: {} });
    expect(await reloaded.getKey("commandcode")).toBe("sk-test-1234567890");
  });

  test("environment variables win over stored keys", async () => {
    const root = await fixture();
    const store = new AuthStore({
      dataDir: root,
      env: { COMMANDCODE_API_KEY: "env-key-123" },
    });
    await store.setKey("commandcode", "stored-key-456");
    expect(await store.effectiveKey("commandcode", "COMMANDCODE_API_KEY")).toBe("env-key-123");
  });

  test("stored key is used when env is absent", async () => {
    const root = await fixture();
    const store = new AuthStore({ dataDir: root, env: {} });
    await store.setKey("commandcode", "stored-key-456");
    expect(await store.effectiveKey("commandcode", "COMMANDCODE_API_KEY")).toBe("stored-key-456");
  });

  test("removeKey deletes the entry", async () => {
    const root = await fixture();
    const store = new AuthStore({ dataDir: root, env: {} });
    await store.setKey("anthropic", "sk-ant-1234567890abcdef");
    expect(await store.hasKey("anthropic")).toBe(true);
    await store.removeKey("anthropic");
    expect(await store.hasKey("anthropic")).toBe(false);
    expect(await store.getKey("anthropic")).toBeUndefined();
  });

  test("missing or corrupt auth.json yields no keys without throwing", async () => {
    const root = await fixture();
    const missing = new AuthStore({ dataDir: root, env: {} });
    expect(await missing.getKey("openai")).toBeUndefined();
    expect(await missing.hasKey("openai")).toBe(false);

    await Bun.write(join(root, "auth.json"), "not json{{{");
    const corrupt = new AuthStore({ dataDir: root, env: {} });
    expect(await corrupt.getKey("openai")).toBeUndefined();
    expect(await corrupt.hasKey("openai")).toBe(false);
  });

  test("ignores non-string or empty entries on load", async () => {
    const root = await fixture();
    await Bun.write(join(root, "auth.json"), JSON.stringify({
      version: 1,
      keys: { good: "real-key", bad: 123, empty: "", nested: { x: 1 } },
    }));
    const store = new AuthStore({ dataDir: root, env: {} });
    expect(await store.getKey("good")).toBe("real-key");
    expect(await store.getKey("bad")).toBeUndefined();
    expect(await store.getKey("empty")).toBeUndefined();
    expect(await store.getKey("nested")).toBeUndefined();
  });

  test("root may be auth.json or the directory containing it", async () => {
    const dir = await fixture();
    const viaFile = new AuthStore({ root: join(dir, "auth.json"), env: {} });
    const viaDir = new AuthStore({ root: dir, env: {} });
    await viaFile.setKey("commandcode", "shared-key-123");
    expect(await viaDir.getKey("commandcode")).toBe("shared-key-123");
  });

  test("passing both root and dataDir throws", async () => {
    const root = await fixture();
    expect(() => new AuthStore({ root, dataDir: root, env: {} })).toThrow();
  });

  test("setKey rejects empty or whitespace-only provider ids and keys", async () => {
    const root = await fixture();
    const store = new AuthStore({ dataDir: root, env: {} });
    await expect(store.setKey("   ", "sk-test-123")).rejects.toThrow();
    await expect(store.setKey("commandcode", "   ")).rejects.toThrow();
  });

  test("effectiveKey falls back to the stored key when env is whitespace-only", async () => {
    const root = await fixture();
    const store = new AuthStore({
      dataDir: root,
      env: { COMMANDCODE_API_KEY: "   " },
    });
    await store.setKey("commandcode", "stored-key-789");
    expect(await store.effectiveKey("commandcode", "COMMANDCODE_API_KEY")).toBe("stored-key-789");
  });
});

describe("commandCodeCredentials with stored key", () => {
  test("uses the stored key when env is absent", () => {
    const creds = commandCodeCredentials("commandcode", {}, "stored-cc-key-123");
    expect(creds).toEqual({ apiKey: "stored-cc-key-123" });
  });

  test("env still wins over the stored key", () => {
    const creds = commandCodeCredentials(
      "commandcode",
      { COMMANDCODE_API_KEY: "env-key" },
      "stored-key",
    );
    expect(creds).toEqual({ apiKey: "env-key" });
  });

  test("built-in providers never receive a stored key", () => {
    expect(commandCodeCredentials("anthropic", {}, "should-not-leak")).toEqual({});
    expect(commandCodeCredentials("openai", {}, "should-not-leak")).toEqual({});
  });

  test("throws when neither env nor stored key is available", () => {
    expect(() => commandCodeCredentials("commandcode", {})).toThrow(/API key is required/);
  });
});
