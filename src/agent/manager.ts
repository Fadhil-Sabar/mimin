import { join } from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import managerPrompt from "../../prompts/manager.md" with { type: "text" };
import type { AgentConfig } from "../config.js";
import { SessionStore } from "../session/session.js";
import { createDelegateTool } from "../tools/delegate.js";
import type {
  CreateDelegateToolOptions,
  DelegateEventCallback,
  SidekickRunner,
} from "../tools/delegate.js";
import { createMemorySearchTool } from "../tools/memory-search.js";
import type { MemorySearchSource } from "../tools/memory-search.js";
import { createReadTool } from "../tools/read.js";
import { createSessionSearchTool } from "../tools/session-search.js";
import type { SessionSearchSource } from "../tools/session-search.js";
import { createVerificationTool } from "../tools/verification.js";
import type { VerificationSpawn } from "../tools/verification.js";
import { commandCodeCredentials, modelFromRole, type ModelResolver } from "./model.js";
import { runAgent } from "./run.js";
import type {
  AgentStreamFactory,
  RunAgentOptions,
  RunAgentResult,
} from "./run.js";
import {
  extractAssistantText,
  type SidekickRunFunction,
} from "./sidekick.js";
import type {
  AgentEventCallback,
  AgentRunConfig,
  AnyAgentTool,
} from "./types.js";

export type ManagerRunFunction = (
  options: RunAgentOptions,
) => Promise<RunAgentResult>;

export interface CreateManagerToolsOptions {
  workspace: string;
  config: AgentConfig;
  sessionStore?: SessionStore;
  sidekickModel?: Model<Api>;
  sidekickModelResolver?: ModelResolver;
  sidekickStream?: AgentStreamFactory;
  sidekickRun?: SidekickRunFunction;
  sidekickSystemPrompt?: string;
  sidekickRunConfig?: Omit<AgentRunConfig, "thinking">;
  /** Provider API key for the delegated sidekick, resolved separately from the
   *  manager's (never the manager's key). Env still wins inside runSidekick. */
  sidekickAuthKey?: string;
  sidekickRunner?: SidekickRunner;
  maxDelegationConcurrency?: number;
  onDelegateEvent?: DelegateEventCallback;
  memoryStore?: MemorySearchSource;
  sessionSearch?: SessionSearchSource;
  verificationSpawn?: VerificationSpawn;
  verificationTimeoutMs?: number;
}

/** Mechanical manager permission boundary: read, delegate, retrieval, and fixed verification. */
export function createManagerTools(
  options: CreateManagerToolsOptions,
): AnyAgentTool[] {
  const delegateOptions: CreateDelegateToolOptions = {
    sidekick: {
      workspace: options.workspace,
      config: options.config.sidekick,
      dataDir: options.config.dataDir,
      sessionStore: options.sessionStore,
      model: options.sidekickModel,
      modelResolver: options.sidekickModelResolver,
      stream: options.sidekickStream,
      run: options.sidekickRun,
      systemPrompt: options.sidekickSystemPrompt,
      runConfig: options.sidekickRunConfig,
      managerRole: options.config.manager,
      ...(options.sidekickAuthKey !== undefined
        ? { authKey: options.sidekickAuthKey }
        : {}),
    },
    run: options.sidekickRunner,
    maxConcurrency: options.maxDelegationConcurrency,
    onEvent: options.onDelegateEvent,
  };
  return [
    createReadTool(options.workspace),
    createDelegateTool(delegateOptions),
    createMemorySearchTool({
      workspace: options.workspace,
      dataDir: options.config.dataDir,
      store: options.memoryStore,
    }),
    createSessionSearchTool({
      sessionsRoot: options.sessionStore?.root,
      dataDir: options.config.dataDir,
      searcher: options.sessionSearch,
    }),
    createVerificationTool({
      workspace: options.workspace,
      spawn: options.verificationSpawn,
      timeoutMs: options.verificationTimeoutMs,
    }),
  ];
}

export interface RunManagerOptions extends CreateManagerToolsOptions {
  input: string;
  /** Omit to create a manager session; provide to resume that role-scoped session. */
  sessionId?: string;
  model?: Model<Api>;
  modelResolver?: ModelResolver;
  stream?: AgentStreamFactory;
  run?: ManagerRunFunction;
  systemPrompt?: string;
  runConfig?: Omit<AgentRunConfig, "thinking">;
  /** Provider API key resolved from auth.json by the CLI layer (env wins). */
  authKey?: string;
  signal?: AbortSignal;
  onEvent?: AgentEventCallback;
  now?: () => number;
}

export interface ManagerResult extends RunAgentResult {
  sessionId: string;
  finalText: string;
}

/** Create/resume a manager conversation and run it through the generic loop. */
export async function runManager(
  options: RunManagerOptions,
): Promise<ManagerResult> {
  if (!options.input.trim()) throw new Error("Manager input must be non-empty");
  const store =
    options.sessionStore ??
    new SessionStore({ root: join(options.config.dataDir, "sessions") });
  const session = options.sessionId
    ? await store.loadSession("manager", options.sessionId)
    : await store.createSession("manager");

  // Persist user intent before any model resolution or streaming can fail.
  await session.append({
    role: "user",
    content: options.input,
    timestamp: (options.now ?? Date.now)(),
  });

  const model = options.model ?? modelFromRole(options.config.manager, options.modelResolver);
  const run = options.run ?? ((runOptions) => runAgent(runOptions));
  const result = await run({
    model,
    systemPrompt: options.systemPrompt ?? managerPrompt,
    session,
    tools: createManagerTools({
      workspace: options.workspace,
      config: options.config,
      sessionStore: store,
      sidekickModel: options.sidekickModel,
      sidekickModelResolver: options.sidekickModelResolver,
      sidekickStream: options.sidekickStream,
      sidekickRun: options.sidekickRun,
      sidekickSystemPrompt: options.sidekickSystemPrompt,
      sidekickRunConfig: options.sidekickRunConfig,
      sidekickRunner: options.sidekickRunner,
      sidekickAuthKey: options.sidekickAuthKey,
      maxDelegationConcurrency: options.maxDelegationConcurrency,
      onDelegateEvent: options.onDelegateEvent,
      memoryStore: options.memoryStore,
      sessionSearch: options.sessionSearch,
      verificationSpawn: options.verificationSpawn,
      verificationTimeoutMs: options.verificationTimeoutMs,
    }),
    config: {
      ...options.runConfig,
      ...commandCodeCredentials(options.config.manager.provider, process.env, options.authKey),
      thinking: options.config.manager.thinking,
    },
    stream: options.stream,
    signal: options.signal,
    onEvent: options.onEvent,
  });

  return {
    ...result,
    sessionId: session.id,
    finalText: extractAssistantText(result.finalMessage),
  };
}
