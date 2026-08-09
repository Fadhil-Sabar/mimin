export {
  canonicalWorkspacePath,
  deriveProjectId,
  MemoryStore,
  projectIdForWorkspace,
} from "./store.js";
export type {
  AddMemoryInput,
  AddMemoryOptions,
  LoadMemoryOptions,
  MemoryRecord,
  MemoryScope,
  MemoryStoreOptions,
  MemoryWriteResult,
} from "./store.js";

export {
  compactSnippet,
  searchMemory,
  searchMemoryRecords,
} from "./search.js";
export type {
  MemorySearchOptions,
  MemorySearchResult,
} from "./search.js";

export {
  filterSecrets,
  redactSecrets,
} from "./secrets.js";
export type { SecretFilterResult } from "./secrets.js";

export {
  searchSessions,
  SessionSearch,
  SessionSearcher,
} from "./session-search.js";
export type {
  SessionSearchOptions,
  SessionSearchResult,
} from "./session-search.js";
