import type { AgentConfig, RoleConfig } from "../config.js";

/**
 * Mutable role configuration for one interactive session.
 *
 * `loadConfig` is a startup snapshot; `/model` swaps models at runtime, so
 * the interactive loop reads from this live object instead of the frozen
 * config. `toConfig` snapshots the current roles for a manager run.
 */
export class AgentRuntime {
  manager: RoleConfig;
  sidekick: RoleConfig;

  constructor(config: AgentConfig) {
    this.manager = { ...config.manager };
    this.sidekick = { ...config.sidekick };
  }

  /** Snapshot the current roles for one run. */
  toConfig(): AgentConfig {
    return {
      dataDir: "",
      manager: { ...this.manager },
      sidekick: { ...this.sidekick },
    };
  }
}
