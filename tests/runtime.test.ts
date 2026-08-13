import { describe, expect, test } from "bun:test";
import { AgentRuntime } from "../src/agent/runtime.js";
import type { AgentConfig } from "../src/config.js";

function config(dataDir = "/data/root"): AgentConfig {
  return {
    dataDir,
    manager: { provider: "fake", model: "manager", thinking: "off" },
    sidekick: { provider: "fake", model: "sidekick", thinking: "off" },
    memory: { auto: true },
    security: { injectionWarning: true },
    context: { maxTokens: 32_000, reserveTokens: 8_000 },
  };
}

describe("AgentRuntime", () => {
  test("preserves the original dataDir in toConfig()", () => {
    const runtime = new AgentRuntime(config("/persist/here"));
    expect(runtime.dataDir).toBe("/persist/here");
    expect(runtime.toConfig().dataDir).toBe("/persist/here");
  });

  test("manager model can be changed at runtime", () => {
    const runtime = new AgentRuntime(config());
    runtime.manager = { ...runtime.manager, model: "gpt-5.5" };
    expect(runtime.manager.model).toBe("gpt-5.5");
    expect(runtime.toConfig().manager.model).toBe("gpt-5.5");
  });

  test("sidekick model can be changed at runtime", () => {
    const runtime = new AgentRuntime(config());
    runtime.sidekick = { ...runtime.sidekick, model: "deepseek/deepseek-v4-flash" };
    expect(runtime.sidekick.model).toBe("deepseek/deepseek-v4-flash");
    expect(runtime.toConfig().sidekick.model).toBe("deepseek/deepseek-v4-flash");
  });

  test("toConfig() returns isolated role objects, not mutable references", () => {
    const runtime = new AgentRuntime(config());
    const snapshot = runtime.toConfig();

    // Mutating the snapshot must not affect the runtime.
    snapshot.manager.model = "mutated";
    snapshot.sidekick.model = "mutated";
    expect(runtime.manager.model).toBe("manager");
    expect(runtime.sidekick.model).toBe("sidekick");

    // Mutating the runtime must not affect an earlier snapshot.
    const earlier = runtime.toConfig();
    runtime.manager = { ...runtime.manager, model: "new-manager" };
    expect(earlier.manager.model).toBe("manager");
    expect(earlier.sidekick.model).toBe("sidekick");

    // Each snapshot is a fresh object.
    const second = runtime.toConfig();
    second.manager.model = "second-mutation";
    expect(runtime.manager.model).toBe("new-manager");
    expect(second.manager).not.toBe(runtime.manager);
  });

  test("toConfig() preserves the full original config shape", () => {
    const original = config("/original/data");
    const runtime = new AgentRuntime(original);
    const snapshot = runtime.toConfig();
    expect(snapshot).toEqual(original);
    // The snapshot is a deep copy: mutating it leaves the source config intact.
    snapshot.manager.model = "changed";
    expect(original.manager.model).toBe("manager");
  });
});
