import type {
  Api,
  AssistantMessageEvent,
  Message,
  Model,
  ModelThinkingLevel,
  Tool as PiTool,
  ToolCall,
  TSchema,
} from "@mariozechner/pi-ai";

/** A value returned by an injected tool after it has finished executing. */
export interface ToolExecutionResult {
  /** Text sent back to the model as the tool result. */
  text: string;
  /** Whether the model should treat the result as a failed tool call. */
  isError?: boolean;
  /** Optional structured data retained in the session message. */
  details?: unknown;
}

export type ToolExecutionValue = string | ToolExecutionResult;

/** Context supplied to a tool for one invocation. */
export interface ToolExecutionContext {
  readonly model: Model<Api>;
  readonly signal?: AbortSignal;
  readonly turn: number;
  readonly toolCall: ToolCall;
}

/**
 * A pi-ai tool definition plus its executable implementation.
 *
 * The engine never chooses tools itself: callers pass the exact collection
 * available to a run. `any` is used for the implementation argument at the
 * collection boundary because pi-ai performs TypeBox validation immediately
 * before execution.
 */
export interface AgentTool<
  TParameters extends TSchema = TSchema,
  TArguments = Record<string, unknown>,
> extends PiTool<TParameters> {
  execute(
    args: TArguments,
    context: ToolExecutionContext,
  ): ToolExecutionValue | Promise<ToolExecutionValue>;
}

export type AnyAgentTool = AgentTool<TSchema, any>;

/** Tools may be supplied as an array, map, or name-indexed record. */
export type AgentToolCollection =
  | readonly AnyAgentTool[]
  | ReadonlyMap<string, AnyAgentTool>
  | Readonly<Record<string, AnyAgentTool>>;

/** Minimal session sink required by the generic agent loop. */
export interface AgentMessageSession {
  readonly messages: Message[];
  append(message: Message): void | Promise<void>;
}

/** Events emitted by a run, including raw pi-ai stream events. */
export type AgentEvent =
  | {
      type: "model_event";
      turn: number;
      event: AssistantMessageEvent;
    }
  | {
      type: "tool_start";
      turn: number;
      toolCall: ToolCall;
    }
  | {
      type: "tool_end";
      turn: number;
      toolCall: ToolCall;
      result: ToolExecutionResult;
    }
  | {
      type: "message_appended";
      turn: number;
      message: Message;
    };

export type AgentEventCallback = (
  event: AgentEvent,
) => void | Promise<void>;

/** Common model-side configuration understood by the generic loop. */
export interface AgentRunConfig {
  /** Provider/model stream options are passed through without reinterpretation. */
  temperature?: number;
  maxTokens?: number;
  apiKey?: string;
  transport?: "sse" | "websocket" | "websocket-cached" | "auto";
  cacheRetention?: "none" | "short" | "long";
  sessionId?: string;
  onPayload?: (
    payload: unknown,
    model: Model<Api>,
  ) => unknown | undefined | Promise<unknown | undefined>;
  onResponse?: (
    response: { status: number; headers: Record<string, string> },
    model: Model<Api>,
  ) => void | Promise<void>;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  metadata?: Record<string, unknown>;
  /** Optional pi thinking level; `off` uses the regular pi-ai stream. */
  thinking?: ModelThinkingLevel;
}
