import type { AgentConfig, RoleConfig } from "../config.js";

/**
 * Mutable role configuration for one interactive session.
 *
 * `loadConfig` is a startup snapshot; `/model` swaps models at runtime, so
 * the interactive loop reads from this live object instead of the frozen
 * config. `toConfig` snapshots the current roles for a manager run while
 * preserving the original `dataDir` (downstream manager and sidekick
 * execution may still need it).
 */
export class AgentRuntime {
  readonly dataDir: string;
  manager: RoleConfig;
  sidekick: RoleConfig;

  constructor(config: AgentConfig) {
    this.dataDir = config.dataDir;
    this.manager = { ...config.manager };
    this.sidekick = { ...config.sidekick };
  }

  /** Snapshot the current roles for one run; returns fresh role objects. */
  toConfig(): AgentConfig {
    return {
      dataDir: this.dataDir,
      manager: { ...this.manager },
      sidekick: { ...this.sidekick },
    };
  }
}
