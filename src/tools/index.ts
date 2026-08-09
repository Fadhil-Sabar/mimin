export { createBashTool, bashTool } from "./bash.js";
export { createEditTool, editTool } from "./edit.js";
export {
  createDelegateTool,
  MAX_DELEGATE_CONCURRENCY,
} from "./delegate.js";
export type {
  CreateDelegateToolOptions,
  DelegateEvent,
  DelegateEventCallback,
  SidekickRunner,
  SidekickRunnerContext,
} from "./delegate.js";
export { createMemorySearchTool } from "./memory-search.js";
export type {
  CreateMemorySearchToolOptions,
  ManagerMemoryScope,
  MemorySearchSource,
} from "./memory-search.js";
export { createReadTool, readTool } from "./read.js";
export { createSessionSearchTool } from "./session-search.js";
export type {
  CreateSessionSearchToolOptions,
  ManagerSessionRole,
  SessionSearchSource,
} from "./session-search.js";
export {
  createVerificationTool,
  VERIFICATION_ACTIONS,
} from "./verification.js";
export type {
  CreateVerificationToolOptions,
  VerificationAction,
  VerificationSpawn,
} from "./verification.js";
export {
  assertWorkspaceCommand,
  resolveWorkspacePath,
  WorkspacePathError,
} from "./path.js";

import type { AgentToolCollection, AnyAgentTool } from "../agent/types.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createReadTool } from "./read.js";

/** The standard low-level tools; callers still choose which collection to inject. */
export function createWorkspaceTools(workspace: string): AnyAgentTool[] {
  return [createReadTool(workspace), createEditTool(workspace), createBashTool(workspace)];
}

export type WorkspaceToolCollection = AgentToolCollection;
