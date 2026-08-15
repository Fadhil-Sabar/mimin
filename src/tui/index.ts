export { AgentTui, createApp } from "./app.js";
export type {
  AgentTuiOptions,
  LocalManagerEvent,
  TuiHost,
} from "./app.js";

export { SLASH_COMMANDS, INTERACTIVE_COMMAND_NAMES, createSlashCommands } from "./commands.js";
export type { RoleProviderResolver, SessionSuggestionSource } from "./commands.js";

export { suggestModels, suggestCommandCodeModels } from "./model-suggestions.js";
export type { ModelSuggestion, ModelSuggestionSource } from "./model-suggestions.js";

export { sessionSuggestionsFromStore, sessionToSuggestion } from "./session-suggestions.js";
export type { SessionSuggestion } from "./session-suggestions.js";

export { dim, green, yellow, cyan } from "./theme.js";
export {
  AnimationTicker,
  ANIMATION_INTERVAL_MS,
  SPINNER_FRAMES,
  spinnerFrame,
  cursorVisible,
  pulsePhase,
} from "./animation.js";
export type { AnimationState } from "./animation.js";

export { Footer } from "./footer.js";
export type {
  ContextSummary,
  ContextUsage,
  FooterOptions,
} from "./footer.js";

export { Header, sanitizeText } from "./header.js";
export type { HeaderOptions } from "./header.js";

export { SidekickActivity } from "./sidekick.js";
export type {
  LocalDelegateEvent,
  LocalSidekickActivity,
  LocalSidekickResult,
  SidekickCardStatus,
} from "./sidekick.js";

export { Transcript } from "./transcript.js";
export type { TranscriptEntry, TranscriptRole } from "./transcript.js";

export { ToolActivity } from "./tool-activity.js";
export type { LocalToolEvent } from "./tool-activity.js";

export { TasksPanel } from "./tasks-panel.js";
export type { TasksPanelOptions } from "./tasks-panel.js";

export {
  formatTaskList,
  formatTaskDetail,
  formatTaskRecord,
  formatDuration,
  taskListRows,
  taskStatusSymbol,
  taskStatusCounts,
  formatTaskCounts,
} from "./task-board.js";
export type { TaskListRow, TaskStatusCounts } from "./task-board.js";

export {
  DEFAULT_IGNORED_DIRS,
  extractAtReference,
  scanWorkspaceFiles,
  scoreFileMatch,
  buildFileCompletionValue,
  suggestWorkspaceFiles,
  applyAtReferenceCompletion,
  clearWorkspaceFileCache,
} from "./file-suggestions.js";
export type { AtReferenceMatch } from "./file-suggestions.js";
