import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const MIMIN_HOME_ENV_VAR = "MIMIN_HOME" as const;
export const MIMIN_DATA_DIR_ENV_VAR = "MIMIN_DATA_DIR" as const;

export type ThinkingSetting = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface RoleConfig {
  /**
   * Provider id. Empty means "inherit": the role uses the same provider as
   * the other role (the global provider), resolved at load time. Only
   * non-empty values are validated as real providers.
   */
  provider: string;
  /** Model id. Empty inherits the other role's model when providers match. */
  model: string;
  thinking: ThinkingSetting;
}

export interface MemoryConfig {
  /** Automatically learn durable user/project facts from conversations. */
  auto: boolean;
}

export interface SecurityConfig {
  /**
   * Prepend an injection-defense notice to the system prompt for both roles.
   * Defaults to true. The notice tells the model that file contents and
   * command output are untrusted data, not instructions.
   */
  injectionWarning: boolean;
}

/** Bounded provider input context, leaving room for responses and tool calls. */
export interface ContextConfig {
  maxTokens: number;
  reserveTokens: number;
}

export interface AgentConfig {
  dataDir: string;
  manager: RoleConfig;
  sidekick: RoleConfig;
  memory: MemoryConfig;
  security: SecurityConfig;
  /** Optional in the public type for compatibility with programmatic callers. */
  context?: ContextConfig;
}

export interface LoadConfigOptions {
  /** Project directory containing `.mimin/config.json`. */
  cwd?: string;
  /** Injectable home directory used for the global config in tests. */
  homeDir?: string;
  /** Injectable environment; process.env/Bun.env is used when omitted. */
  env?: Record<string, string | undefined>;
  globalConfigPath?: string;
  projectConfigPath?: string;
}

export class ConfigValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid mimin configuration: ${issues.join("; ")}`);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

interface RawObject {
  [key: string]: unknown;
}

function isObject(value: unknown): value is RawObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeObjects(base: RawObject, overlay: RawObject): RawObject {
  const result: RawObject = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const previous = result[key];
    if (isObject(previous) && isObject(value)) {
      result[key] = mergeObjects(previous, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function environment(options: LoadConfigOptions): Record<string, string | undefined> {
  if (options.env) return options.env;
  return {
    [MIMIN_HOME_ENV_VAR]: Bun.env[MIMIN_HOME_ENV_VAR],
    [MIMIN_DATA_DIR_ENV_VAR]: Bun.env[MIMIN_DATA_DIR_ENV_VAR],
  };
}

function configuredPath(value: string, cwd: string, home: string): string {
  const expanded = value.startsWith("~/")
    ? join(home, value.slice(2))
    : value;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/** Resolve the product-wide config root from MIMIN_HOME or the user home. */
export function defaultMiminHome(options: LoadConfigOptions = {}): string {
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = resolve(options.homeDir ?? homedir());
  const value = environment(options)[MIMIN_HOME_ENV_VAR];
  return value === undefined || value.trim().length === 0
    ? join(home, ".mimin")
    : configuredPath(value, cwd, home);
}

/** Resolve the product-wide persistent data root from MIMIN_DATA_DIR or MIMIN_HOME. */
export function defaultDataDir(options: LoadConfigOptions = {}): string {
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = resolve(options.homeDir ?? homedir());
  const value = environment(options)[MIMIN_DATA_DIR_ENV_VAR];
  return value === undefined || value.trim().length === 0
    ? join(defaultMiminHome({ ...options, cwd, homeDir: home }), "data")
    : configuredPath(value, cwd, home);
}

function configuredDataDir(
  value: unknown,
  cwd: string,
  home: string,
  fallback: string,
): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigValidationError(["dataDir must be a non-empty string"]);
  }
  return configuredPath(value, cwd, home);
}

function requiredString(
  object: RawObject,
  key: string,
  path: string,
  issues: string[],
): string {
  const value = object[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(`${path}.${key} must be a non-empty string`);
    return "";
  }
  return value.trim();
}

/** String-or-empty: empty values are valid (inherit / unset sentinels). */
function optionalString(
  object: RawObject,
  key: string,
  path: string,
  issues: string[],
): string {
  const value = object[key];
  if (value === undefined) return "";
  if (typeof value !== "string") {
    issues.push(`${path}.${key} must be a string when present`);
    return "";
  }
  return value.trim();
}

function thinkingValue(
  object: RawObject,
  path: string,
  issues: string[],
): ThinkingSetting {
  const value = object.thinking;
  const allowed: readonly ThinkingSetting[] = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ];
  if (typeof value !== "string" || !allowed.includes(value as ThinkingSetting)) {
    issues.push(`${path}.thinking must be one of ${allowed.join(", ")}`);
    return "medium";
  }
  return value as ThinkingSetting;
}

function validateConfig(raw: RawObject, dataDir: string): AgentConfig {
  const issues: string[] = [];
  const manager = isObject(raw.manager) ? raw.manager : undefined;
  const sidekick = isObject(raw.sidekick) ? raw.sidekick : undefined;
  if (!manager) issues.push("manager must be an object");
  if (!sidekick) issues.push("sidekick must be an object");

  const managerConfig: RoleConfig = {
    provider: manager ? optionalString(manager, "provider", "manager", issues) : "",
    model: manager ? optionalString(manager, "model", "manager", issues) : "",
    thinking: manager ? thinkingValue(manager, "manager", issues) : "medium",
  };
  const sidekickConfig: RoleConfig = {
    provider: sidekick ? optionalString(sidekick, "provider", "sidekick", issues) : "",
    model: sidekick ? optionalString(sidekick, "model", "sidekick", issues) : "",
    thinking: sidekick ? thinkingValue(sidekick, "sidekick", issues) : "medium",
  };

  const memoryRaw = isObject(raw.memory) ? raw.memory : {};
  const auto = memoryRaw.auto;
  if (auto !== undefined && typeof auto !== "boolean") {
    issues.push("memory.auto must be a boolean");
  }
  const memoryConfig: MemoryConfig = {
    auto: typeof auto === "boolean" ? auto : true,
  };

  const securityRaw = isObject(raw.security) ? raw.security : {};
  const injectionWarning = securityRaw.injectionWarning;
  if (injectionWarning !== undefined && typeof injectionWarning !== "boolean") {
    issues.push("security.injectionWarning must be a boolean");
  }
  const securityConfig: SecurityConfig = {
    injectionWarning: typeof injectionWarning === "boolean" ? injectionWarning : true,
  };

  const contextRaw = isObject(raw.context) ? raw.context : {};
  const maxTokens = contextRaw.maxTokens;
  const reserveTokens = contextRaw.reserveTokens;
  if (!Number.isInteger(maxTokens) || (maxTokens as number) <= 0) {
    issues.push("context.maxTokens must be a positive integer");
  }
  if (!Number.isInteger(reserveTokens) || (reserveTokens as number) < 0) {
    issues.push("context.reserveTokens must be a non-negative integer");
  }
  const contextConfig: ContextConfig = {
    maxTokens: typeof maxTokens === "number" ? maxTokens : 32_000,
    reserveTokens: typeof reserveTokens === "number" ? reserveTokens : 8_000,
  };
  if (contextConfig.reserveTokens >= contextConfig.maxTokens) {
    issues.push("context.reserveTokens must be less than context.maxTokens");
  }

  if (issues.length > 0) throw new ConfigValidationError(issues);

  // Global-provider inheritance: a role with an empty provider uses the other
  // role's provider (whichever side configured one); a role with an empty
  // model uses the other role's model when the resolved providers match.
  const configuredManager = managerConfig.provider.length > 0;
  const configuredSidekick = sidekickConfig.provider.length > 0;
  if (!configuredManager && !configuredSidekick) {
    throw new ConfigValidationError([
      "at least one of manager.provider or sidekick.provider must be set",
    ]);
  }
  const globalProvider = configuredManager
    ? managerConfig.provider
    : sidekickConfig.provider;
  if (!configuredManager) managerConfig.provider = globalProvider;
  if (!configuredSidekick) sidekickConfig.provider = globalProvider;
  if (managerConfig.model.length === 0 && managerConfig.provider === sidekickConfig.provider) {
    managerConfig.model = sidekickConfig.model;
  }
  if (sidekickConfig.model.length === 0 && sidekickConfig.provider === managerConfig.provider) {
    sidekickConfig.model = managerConfig.model;
  }

  return {
    dataDir,
    manager: managerConfig,
    sidekick: sidekickConfig,
    memory: memoryConfig,
    security: securityConfig,
    context: contextConfig,
  };
}

async function readConfigFile(pathname: string): Promise<RawObject> {
  const file = Bun.file(pathname);
  if (!(await file.exists())) return {};
  let value: unknown;
  try {
    value = JSON.parse(await file.text()) as unknown;
  } catch (error) {
    throw new Error(
      `Could not parse ${pathname}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isObject(value)) throw new Error(`Configuration at ${pathname} must be a JSON object`);
  return value;
}

/** Return the unvalidated default layer used by `loadConfig`. */
export function defaultConfig(options: LoadConfigOptions = {}): AgentConfig {
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = resolve(options.homeDir ?? homedir());
  const dataDir = defaultDataDir({ ...options, cwd, homeDir: home });
  return {
    dataDir,
    manager: { provider: "", model: "", thinking: "medium" },
    sidekick: { provider: "", model: "", thinking: "medium" },
    memory: { auto: true },
    security: { injectionWarning: true },
    context: { maxTokens: 32_000, reserveTokens: 8_000 },
  };
}

/**
 * Load defaults, then `~/.mimin/config.json`, then project config. Nested
 * role objects are merged, so a project can override only one field. The
 * MIMIN_DATA_DIR override is applied last for test isolation.
 */
export async function loadConfig(
  options: LoadConfigOptions = {},
): Promise<AgentConfig> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = resolve(options.homeDir ?? homedir());
  const globalPath =
    options.globalConfigPath ??
    join(defaultMiminHome({ ...options, cwd, homeDir: home }), "config.json");
  const projectPath = options.projectConfigPath ?? join(cwd, ".mimin", "config.json");
  const defaults = defaultConfig({ ...options, cwd, homeDir: home });

  const globalLayer = await readConfigFile(globalPath);
  const projectLayer = await readConfigFile(projectPath);
  const merged = mergeObjects(
    mergeObjects(
      {
        dataDir: defaults.dataDir,
        manager: defaults.manager,
        sidekick: defaults.sidekick,
        memory: defaults.memory,
        security: defaults.security,
        context: defaults.context,
      },
      globalLayer,
    ),
    projectLayer,
  );

  const override = environment(options)[MIMIN_DATA_DIR_ENV_VAR];
  const dataDir = configuredDataDir(
    override !== undefined && override.trim().length > 0 ? override : merged.dataDir,
    cwd,
    home,
    defaults.dataDir,
  );
  return validateConfig(merged, dataDir);
}
