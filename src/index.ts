export { loadConfig, defaultConfig, ConfigValidationError } from "./config.js";
export type {
  AgentConfig,
  ContextConfig,
  LoadConfigOptions,
  ReviewConfig,
  RoleConfig,
  ThinkingSetting,
} from "./config.js";

export { buildContext, estimateMessageTokens, estimateMessagesTokens, usableContextTokens } from "./context/context.js";
export type { CompactedContext, ContextBudget, ContextDiagnostics } from "./context/context.js";

export { runAgent } from "./agent/run.js";
export type {
  AgentStreamFactory,
  RunAgentOptions,
  RunAgentResult,
  AgentTerminalStatus,
} from "./agent/run.js";
export type {
  AgentEvent,
  AgentEventCallback,
  AgentMessageSession,
  AgentRunConfig,
  AgentTool,
  AgentToolCollection,
  AnyAgentTool,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolExecutionValue,
} from "./agent/types.js";

export { modelFromRole, resolveConfiguredModel } from "./agent/model.js";
export { AgentRuntime } from "./agent/runtime.js";
export {
  COMMANDCODE_API_KEY_ENV_VAR,
  COMMANDCODE_METADATA,
  commandCodeCredentials,
} from "./agent/model.js";
export { COMMANDCODE_PROVIDER } from "./agent/commandcode.js";
export type { ModelResolver } from "./agent/model.js";
export { createManagerTools, runManager } from "./agent/manager.js";
export type {
  CreateManagerToolsOptions,
  ManagerResult,
  ManagerRunFunction,
  RunManagerOptions,
} from "./agent/manager.js";
export {
  createSidekickTools,
  extractAssistantText,
  parseSidekickResult,
  runSidekick,
} from "./agent/sidekick.js";
export type {
  ParseSidekickResultOptions,
  RunSidekickOptions,
  SidekickActivityCallback,
  SidekickActivityEvent,
  SidekickResult,
  SidekickRunFunction,
  SidekickStatus,
  VerificationEntry,
  VerificationStatus,
} from "./agent/sidekick.js";

export {
  createBashTool,
  createDelegateTool,
  createEditTool,
  createMemorySearchTool,
  createReadTool,
  createSessionSearchTool,
  createVerificationTool,
  createWorkspaceTools,
  MAX_DELEGATE_CONCURRENCY,
  VERIFICATION_ACTIONS,
  WorkspacePathError,
  resolveWorkspacePath,
} from "./tools/index.js";
export type {
  CreateDelegateToolOptions,
  CreateMemorySearchToolOptions,
  CreateSessionSearchToolOptions,
  CreateVerificationToolOptions,
  DelegateEvent,
  DelegateEventCallback,
  ManagerMemoryScope,
  ManagerSessionRole,
  MemorySearchSource,
  SessionSearchSource,
  SidekickRunner,
  SidekickRunnerContext,
  VerificationAction,
  VerificationSpawn,
} from "./tools/index.js";

export {
  createSession,
  JsonlSession,
  listSessions,
  loadEvents,
  loadMessages,
  loadSession,
  openSession,
  SessionStore,
} from "./session/index.js";
export type {
  SessionEvent,
  SessionRole,
  SessionStoreOptions,
  SessionSummary,
} from "./session/index.js";

export {
  TaskBoard,
  isTaskStatus,
  recoverTasks,
  taskId,
} from "./task/index.js";
export type {
  Task,
  TaskBoardEvent,
  TaskBoardOptions,
  TaskCreateInput,
  TaskDispatch,
  TaskResultSummary,
  TaskStatus,
} from "./task/index.js";
export {
  attachTaskBoardPersistence,
  isTaskBoardEvent,
  restoreTaskBoard,
} from "./task/persistence.js";
export type {
  TaskBoardPersistence,
} from "./task/persistence.js";

export * from "./memory/index.js";
export * from "./tui/index.js";
export {
  CLI_VERSION,
  CliUsageError,
  handleInteractiveCommand,
  main,
  parseCliArgs,
  runCli,
} from "./cli.js";
export type {
  CliDependencies,
  CliIo,
  CliTui,
  InteractiveCommandOptions,
  ParsedCliArguments,
} from "./cli.js";

import { runCli } from "./cli.js";

if (import.meta.main) {
  process.exitCode = await runCli();
}
