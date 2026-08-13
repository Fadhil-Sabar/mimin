import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { ConfigValidationError, loadConfig } from "../src/config.js";
import type { RoleConfig } from "../src/config.js";

const temporaryDirectories: string[] = [];

const roles: { manager: RoleConfig; sidekick: RoleConfig } = {
  manager: {
    provider: "manager-provider",
    model: "manager-model",
    thinking: "low",
  },
  sidekick: {
    provider: "sidekick-provider",
    model: "sidekick-model",
    thinking: "medium",
  },
};

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) await Bun.$`rm -rf ${directory}`;
  }
});

async function fixture(): Promise<{ root: string; home: string; project: string }> {
  const root = await Bun.$`mktemp -d ${join(tmpdir(), "mimin-config-XXXXXXXX")}`.text();
  const cleanRoot = root.trim();
  temporaryDirectories.push(cleanRoot);
  const home = join(cleanRoot, "home");
  const project = join(cleanRoot, "project");
  await mkdir(join(home, ".mimin"), { recursive: true });
  await mkdir(join(project, ".mimin"), { recursive: true });
  return { root: cleanRoot, home, project };
}

async function writeJson(pathname: string, value: unknown): Promise<void> {
  await Bun.write(pathname, JSON.stringify(value, null, 2));
}

describe("layered config", () => {
  test("loads global config from <home>/.mimin/config.json by default", async () => {
    const { home, project } = await fixture();
    await writeJson(join(home, ".mimin", "config.json"), roles);

    const config = await loadConfig({ cwd: project, homeDir: home, env: {} });

    expect(config.manager).toEqual(roles.manager);
    expect(config.sidekick).toEqual(roles.sidekick);
    expect(config.dataDir).toBe(join(home, ".mimin", "data"));
  });

  test("project .mimin/config.json overrides the global layer", async () => {
    const { root, home, project } = await fixture();
    await writeJson(join(home, ".mimin", "config.json"), {
      dataDir: join(root, "global-data"),
      ...roles,
    });
    await writeJson(join(project, ".mimin", "config.json"), {
      dataDir: "project-data",
      manager: { model: "project-manager-model" },
      sidekick: { thinking: "high" },
    });

    const config = await loadConfig({ cwd: project, homeDir: home, env: {} });

    expect(config.manager).toEqual({
      provider: "manager-provider",
      model: "project-manager-model",
      thinking: "low",
    });
    expect(config.sidekick).toEqual({
      provider: "sidekick-provider",
      model: "sidekick-model",
      thinking: "high",
    });
    expect(config.dataDir).toBe(join(project, "project-data"));
  });

  test("uses MIMIN_HOME for the global config root and default data", async () => {
    const { root, home, project } = await fixture();
    const miminHome = join(root, "isolated-mimin-home");
    await mkdir(miminHome, { recursive: true });
    await writeJson(join(miminHome, "config.json"), roles);

    const config = await loadConfig({
      cwd: project,
      homeDir: home,
      env: { MIMIN_HOME: miminHome },
    });

    expect(config.dataDir).toBe(join(miminHome, "data"));
    expect(config.manager.provider).toBe("manager-provider");
    expect(config.sidekick.model).toBe("sidekick-model");
  });

  test("MIMIN_DATA_DIR wins over configured persistent data", async () => {
    const { root, home, project } = await fixture();
    await writeJson(join(home, ".mimin", "config.json"), {
      dataDir: join(root, "configured-data"),
      ...roles,
    });

    const config = await loadConfig({
      cwd: project,
      homeDir: home,
      env: { MIMIN_DATA_DIR: join(root, "mimin-data") },
    });

    expect(config.dataDir).toBe(join(root, "mimin-data"));
    expect(config.manager).toEqual(roles.manager);
  });

  test("legacy namespace environment values do not affect new defaults", async () => {
    const { root, home, project } = await fixture();
    await writeJson(join(home, ".mimin", "config.json"), roles);
    const legacyHome = ["AGENT", "HOME"].join("_");
    const legacyData = ["AGENT", "DATA", "DIR"].join("_");
    const legacyMinimalData = ["MINIMAL", "AGENT", "DATA", "DIR"].join("_");

    const config = await loadConfig({
      cwd: project,
      homeDir: home,
      env: {
        [legacyHome]: join(root, "legacy-home"),
        [legacyData]: join(root, "legacy-data"),
        [legacyMinimalData]: join(root, "legacy-minimal-data"),
      },
    });

    expect(config.dataDir).toBe(join(home, ".mimin", "data"));
    expect(config.manager).toEqual(roles.manager);
  });

  test("validates role provider/model IDs and thinking settings", async () => {
    const { home, project } = await fixture();
    await writeJson(join(project, ".mimin", "config.json"), {
      manager: { provider: "", model: "model", thinking: "medium" },
      sidekick: { provider: "provider", model: "model", thinking: "unsupported" },
    });

    await expect(
      loadConfig({ cwd: project, homeDir: home, env: {} }),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  test("legacy maxTurns in config files is accepted and ignored", async () => {
    const { home, project } = await fixture();
    // A config written before maxTurns removal must still load cleanly.
    await writeJson(join(project, ".mimin", "config.json"), {
      manager: { provider: "provider", model: "manager", thinking: "medium", maxTurns: 24 },
      sidekick: { provider: "provider", model: "sidekick", thinking: "low", maxTurns: 8 },
    });
    const config = await loadConfig({ cwd: project, homeDir: home, env: {} });
    // The role configs carry no maxTurns field at all.
    expect(config.manager).toEqual({
      provider: "provider",
      model: "manager",
      thinking: "medium",
    });
    expect(config.sidekick).toEqual({
      provider: "provider",
      model: "sidekick",
      thinking: "low",
    });
  });

  test("memory.auto defaults to true and merges across layers", async () => {
    const { root, home, project } = await fixture();
    await writeJson(join(home, ".mimin", "config.json"), {
      ...roles,
      memory: { auto: false },
    });

    const config = await loadConfig({ cwd: project, homeDir: home, env: {} });
    expect(config.memory).toEqual({ auto: false });

    // Project layer can re-enable it.
    await writeJson(join(project, ".mimin", "config.json"), {
      memory: { auto: true },
    });
    const reenabled = await loadConfig({ cwd: project, homeDir: home, env: {} });
    expect(reenabled.memory).toEqual({ auto: true });
    expect(reenabled.manager.provider).toBe("manager-provider");
  });

  test("memory.auto rejects non-boolean values", async () => {
    const { home, project } = await fixture();
    await writeJson(join(project, ".mimin", "config.json"), {
      ...roles,
      memory: { auto: "yes" },
    });

    await expect(
      loadConfig({ cwd: project, homeDir: home, env: {} }),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  test("review.maxReviewIterations defaults to 2", async () => {
    const { home, project } = await fixture();
    await writeJson(join(project, ".mimin", "config.json"), { ...roles });
    const config = await loadConfig({ cwd: project, homeDir: home, env: {} });
    expect(config.review).toEqual({ maxReviewIterations: 2 });
  });

  test("review.maxReviewIterations is configurable and merged across layers", async () => {
    const { home, project } = await fixture();
    await writeJson(join(home, ".mimin", "config.json"), {
      ...roles,
      review: { maxReviewIterations: 4 },
    });
    const config = await loadConfig({ cwd: project, homeDir: home, env: {} });
    expect(config.review.maxReviewIterations).toBe(4);

    // Project layer overrides.
    await writeJson(join(project, ".mimin", "config.json"), {
      review: { maxReviewIterations: 1 },
    });
    const overridden = await loadConfig({ cwd: project, homeDir: home, env: {} });
    expect(overridden.review.maxReviewIterations).toBe(1);
  });

  test("review.maxReviewIterations rejects non-integer values", async () => {
    const { home, project } = await fixture();
    await writeJson(join(project, ".mimin", "config.json"), {
      ...roles,
      review: { maxReviewIterations: "many" },
    });
    await expect(
      loadConfig({ cwd: project, homeDir: home, env: {} }),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  test("a role with an empty provider inherits the other role's provider (global)", async () => {
    const { home, project } = await fixture();
    await writeJson(join(project, ".mimin", "config.json"), {
      manager: { provider: "anthropic", model: "claude-sonnet-4-6", thinking: "medium" },
      // No sidekick.provider: it should inherit "anthropic".
      sidekick: { model: "claude-sonnet-4-6", thinking: "low" },
    });

    const config = await loadConfig({ cwd: project, homeDir: home, env: {} });
    expect(config.manager.provider).toBe("anthropic");
    expect(config.sidekick.provider).toBe("anthropic");
    expect(config.sidekick.model).toBe("claude-sonnet-4-6");
  });

  test("provider can be configured only on the sidekick and the manager inherits it", async () => {
    const { home, project } = await fixture();
    await writeJson(join(project, ".mimin", "config.json"), {
      manager: { model: "gpt-5.5", thinking: "medium" },
      sidekick: { provider: "openrouter", model: "gpt-5.5", thinking: "low" },
    });

    const config = await loadConfig({ cwd: project, homeDir: home, env: {} });
    expect(config.manager.provider).toBe("openrouter");
    expect(config.sidekick.provider).toBe("openrouter");
    expect(config.manager.model).toBe("gpt-5.5");
  });

  test("neither role with a provider is rejected with a clear error", async () => {
    const { home, project } = await fixture();
    await writeJson(join(project, ".mimin", "config.json"), {
      manager: { model: "gpt-5.5", thinking: "medium" },
      sidekick: { model: "gpt-5.5", thinking: "low" },
    });

    await expect(loadConfig({ cwd: project, homeDir: home, env: {} }))
      .rejects.toMatchObject({
        issues: ["at least one of manager.provider or sidekick.provider must be set"],
      });
  });

  test("an empty model inherits the other role's model when providers match", async () => {
    const { home, project } = await fixture();
    await writeJson(join(project, ".mimin", "config.json"), {
      manager: { provider: "openrouter", model: "gpt-5.5", thinking: "medium" },
      sidekick: { provider: "openrouter", thinking: "low" },
    });

    const config = await loadConfig({ cwd: project, homeDir: home, env: {} });
    expect(config.sidekick.model).toBe("gpt-5.5");
  });

  test("context token budgets merge and validate", async () => {
    const { home, project } = await fixture();
    await writeJson(join(home, ".mimin", "config.json"), {
      ...roles, context: { maxTokens: 40_000, reserveTokens: 8_000 },
    });
    await writeJson(join(project, ".mimin", "config.json"), {
      context: { reserveTokens: 6_000 },
    });
    const config = await loadConfig({ cwd: project, homeDir: home, env: {} });
    expect(config.context).toEqual({ maxTokens: 40_000, reserveTokens: 6_000 });

    await writeJson(join(project, ".mimin", "config.json"), {
      ...roles, context: { maxTokens: 100, reserveTokens: 100 },
    });
    await expect(loadConfig({ cwd: project, homeDir: home, env: {} }))
      .rejects.toBeInstanceOf(ConfigValidationError);
  });
});
