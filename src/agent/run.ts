import {
  stream as piStream,
  streamSimple,
  validateToolCall,
} from "@mariozechner/pi-ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Message,
  Model,
  ProviderStreamOptions,
  StopReason,
  Tool as PiTool,
  ToolCall,
} from "@mariozechner/pi-ai";
import type {
  AgentEvent,
  AgentEventCallback,
  AgentMessageSession,
  AgentRunConfig,
  AgentToolCollection,
  AnyAgentTool,
  ToolExecutionResult,
  ToolExecutionValue,
} from "./types.js";

export const DEFAULT_MAX_TURNS = 8;

/** A stream factory is injectable so loop tests never need a live provider. */
export type AgentStreamFactory = (
  model: Model<Api>,
  context: Context,
  options?: ProviderStreamOptions,
) => AssistantMessageEventStream;

export type AgentTerminalStatus = "completed" | "max_turns" | "aborted" | "error";

/** Structured terminal state returned after the model/tool loop stops. */
export interface RunAgentResult {
  status: AgentTerminalStatus;
  turns: number;
  toolCalls: number;
  messages: Message[];
  finalMessage?: AssistantMessage;
  stopReason?: StopReason;
  error?: string;
}

export interface RunAgentOptions<TApi extends Api = Api> {
  model: Model<TApi>;
  systemPrompt?: string;
  /** Existing mutable conversation messages. A session's messages are used when omitted. */
  messages?: Message[];
  /** Optional append-only session to receive initial, assistant, and tool messages. */
  session?: AgentMessageSession;
  /** Explicitly supplied permissions; the engine does not add tools of its own. */
  tools?: AgentToolCollection;
  config?: AgentRunConfig;
  /** Convenience override for `config.maxTurns`. */
  maxTurns?: number;
  signal?: AbortSignal;
  onEvent?: AgentEventCallback;
  /** Optional test seam; production uses pi-ai's stream/streamSimple functions. */
  stream?: AgentStreamFactory;
}

function normalizeTools(collection: AgentToolCollection | undefined): AnyAgentTool[] {
  if (!collection) return [];
  if (Array.isArray(collection)) return [...collection];
  if (collection instanceof Map) return [...collection.values()];
  return Object.values(collection);
}

function toolDefinitions(tools: readonly AnyAgentTool[]): PiTool[] {
  return tools.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
}

function isToolCall(block: AssistantMessage["content"][number]): block is ToolCall {
  return block.type === "toolCall";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameMessage(left: Message, right: Message): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function normalizeToolResult(value: ToolExecutionValue): ToolExecutionResult {
  if (typeof value === "string") return { text: value };
  return {
    text: value.text,
    isError: value.isError,
    details: value.details,
  };
}

function streamOptionsFromConfig(
  config: AgentRunConfig | undefined,
  signal: AbortSignal | undefined,
): ProviderStreamOptions {
  if (!config) return signal ? { signal } : {};

  const {
    thinking: _thinking,
    maxTurns: _maxTurns,
    ...providerOptions
  } = config;
  return {
    ...providerOptions,
    ...(signal ? { signal } : {}),
  };
}

async function emit(
  callback: AgentEventCallback | undefined,
  event: AgentEvent,
): Promise<void> {
  await callback?.(event);
}

/**
 * Run one generic, bounded, tool-calling conversation.
 *
 * Each model response is one turn. The complete assistant response is added
 * before any tool result, and all tool calls in that response are executed in
 * order. The next model turn receives the same mutable message array, so tool
 * output is part of its context. Role-specific permissions belong entirely in
 * the injected tool collection.
 */
export async function runAgent<TApi extends Api = Api>(
  options: RunAgentOptions<TApi>,
): Promise<RunAgentResult> {
  const config = options.config;
  const maxTurns = options.maxTurns ?? config?.maxTurns ?? DEFAULT_MAX_TURNS;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) {
    throw new RangeError("maxTurns must be a positive safe integer");
  }

  const session = options.session;
  const messages = options.messages ?? session?.messages ?? [];
  const tools = normalizeTools(options.tools);
  const definitions = toolDefinitions(tools);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const signal = options.signal ?? undefined;

  // If callers provide a separate message array and a session sink, persist
  // only the suffix after the session's existing history. Divergent histories
  // are rejected rather than silently merging independent conversations.
  if (session && options.messages && options.messages !== session.messages) {
    if (session.messages.length > options.messages.length) {
      throw new Error("Supplied messages do not include the session history");
    }
    for (let index = 0; index < session.messages.length; index += 1) {
      const supplied = options.messages[index];
      const persisted = session.messages[index];
      if (!supplied || !persisted || !sameMessage(supplied, persisted)) {
        throw new Error("Supplied messages diverge from the session history");
      }
    }
    for (const message of options.messages.slice(session.messages.length)) {
      await session.append(message);
    }
  }

  let turns = 0;
  let toolCalls = 0;
  let finalMessage: AssistantMessage | undefined;
  let lastStopReason: StopReason | undefined;

  const finish = (
    status: AgentTerminalStatus,
    extra: Partial<RunAgentResult> = {},
  ): RunAgentResult => ({
    status,
    turns,
    toolCalls,
    messages,
    finalMessage,
    stopReason: lastStopReason,
    ...extra,
  });

  while (turns < maxTurns) {
    if (signal?.aborted) {
      return finish("aborted", { error: "Agent run aborted" });
    }

    turns += 1;
    const context: Context = {
      ...(options.systemPrompt === undefined
        ? {}
        : { systemPrompt: options.systemPrompt }),
      messages,
      tools: definitions,
    };

    let responseStream: AssistantMessageEventStream | undefined;
    let assistant: AssistantMessage;

    try {
      const providerOptions = streamOptionsFromConfig(config, signal);
      if (options.stream) {
        responseStream = options.stream(
          options.model as Model<Api>,
          context,
          providerOptions,
        );
      } else if (config?.thinking && config.thinking !== "off") {
        responseStream = streamSimple(options.model, context, {
          ...providerOptions,
          reasoning: config.thinking,
        });
      } else {
        responseStream = piStream(options.model, context, providerOptions);
      }

      // Consume the stream, racing each next() against the abort signal so a
      // stuck provider (no events, never ends) still aborts promptly.
      const iterator = responseStream[Symbol.asyncIterator]();
      const abortPromise = new Promise<never>((_, reject) => {
        if (signal?.aborted) {
          reject(new Error("Agent run aborted"));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(new Error("Agent run aborted"));
        }, { once: true });
      });
      try {
        while (true) {
          const next = await Promise.race([
            iterator.next(),
            abortPromise,
          ]);
          if (next.done) break;
          await emit(options.onEvent, { type: "model_event", turn: turns, event: next.value });
        }
      } finally {
        // Do not await iterator.return()/result(): a stuck provider never
        // settles them, and the abort must return promptly.
        void iterator.return?.();
      }
      assistant = await responseStream.result();
    } catch (error) {
      // A provider may expose a final partial message through result() even
      // when iteration reports an exception. Persist it when available.
      // On abort, skip this entirely: a stuck provider never settles result().
      if (responseStream && !signal?.aborted) {
        try {
          const partial = await responseStream.result();
          if (partial) {
            assistant = partial;
            finalMessage = partial;
            lastStopReason = partial.stopReason;
            await appendMessage(
              session,
              messages,
              partial,
              options.onEvent,
              turns,
            );
          }
        } catch {
          // The original stream error is the useful terminal error.
        }
      }
      if (signal?.aborted) {
        return finish("aborted", { error: errorText(error) });
      }
      return finish("error", { error: errorText(error) });
    }

    finalMessage = assistant;
    lastStopReason = assistant.stopReason;
    await appendMessage(
      session,
      messages,
      assistant,
      options.onEvent,
      turns,
    );

    if (assistant.stopReason === "aborted" || signal?.aborted) {
      return finish("aborted", { error: assistant.errorMessage });
    }
    if (assistant.stopReason === "error") {
      return finish("error", { error: assistant.errorMessage });
    }

    const calls = assistant.content.filter(isToolCall);
    if (calls.length === 0) {
      return finish("completed");
    }

    for (const call of calls) {
      if (signal?.aborted) {
        return finish("aborted", { error: "Agent run aborted" });
      }
      toolCalls += 1;
      await emit(options.onEvent, {
        type: "tool_start",
        turn: turns,
        toolCall: call,
      });

      const result = await executeTool(
        call,
        byName,
        definitions,
        options,
        turns,
      );
      const toolMessage: Message = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: result.text }],
        ...(result.details === undefined ? {} : { details: result.details }),
        isError: result.isError ?? false,
        timestamp: Date.now(),
      };
      await appendMessage(session, messages, toolMessage, options.onEvent, turns);
      await emit(options.onEvent, {
        type: "tool_end",
        turn: turns,
        toolCall: call,
        result,
      });
    }

    if (turns >= maxTurns) {
      return finish("max_turns");
    }
  }

  return finish("max_turns");
}

async function appendMessage(
  session: AgentMessageSession | undefined,
  messages: Message[],
  message: Message,
  callback: AgentEventCallback | undefined,
  turn: number,
): Promise<void> {
  const sessionOwnsMessages = session?.messages === messages;
  if (session) await session.append(message);
  if (!sessionOwnsMessages) messages.push(message);
  await emit(callback, { type: "message_appended", turn, message });
}

async function executeTool(
  call: ToolCall,
  byName: ReadonlyMap<string, AnyAgentTool>,
  definitions: readonly PiTool[],
  options: RunAgentOptions,
  turn: number,
): Promise<ToolExecutionResult> {
  const tool = byName.get(call.name);
  if (!tool) {
    return {
      text: `Tool ${JSON.stringify(call.name)} is not available in this run.`,
      isError: true,
    };
  }

  try {
    const validatedArgs = validateToolCall([...definitions], call);
    const value = await tool.execute(validatedArgs, {
      model: options.model as Model<Api>,
      signal: options.signal,
      turn,
      toolCall: call,
    });
    return normalizeToolResult(value);
  } catch (error) {
    return {
      text: `Tool ${JSON.stringify(call.name)} failed: ${errorText(error)}`,
      isError: true,
    };
  }
}
