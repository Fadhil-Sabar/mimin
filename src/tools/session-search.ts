import { Type } from "@mariozechner/pi-ai";
import type { AnyAgentTool, ToolExecutionResult } from "../agent/types.js";
import { SessionSearch } from "../memory/session-search.js";
import type {
  SessionSearchOptions,
  SessionSearchResult,
} from "../memory/session-search.js";

export type ManagerSessionRole = "manager" | "sidekick" | "both";

export interface SessionSearchSource {
  search(
    query: string,
    options?: Omit<SessionSearchOptions, "dataDir" | "root">,
  ): Promise<SessionSearchResult[]>;
}

export interface CreateSessionSearchToolOptions {
  dataDir?: string;
  sessionsRoot?: string;
  searcher?: SessionSearchSource;
}

interface SessionSearchArguments {
  query: string;
  role?: ManagerSessionRole;
  limit?: number;
}

const MAX_RESULTS = 20;

function compact(value: string, limit: number): string {
  const safe = value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return safe.length <= limit ? safe : `${safe.slice(0, limit - 1)}…`;
}

/** Search bounded JSONL history without exposing messages or transcripts. */
export function createSessionSearchTool(
  options: CreateSessionSearchToolOptions,
): AnyAgentTool {
  const searcher = options.searcher ?? new SessionSearch({
    ...(options.sessionsRoot
      ? { root: options.sessionsRoot }
      : options.dataDir
        ? { dataDir: options.dataDir }
        : {}),
  });
  return {
    name: "session_search",
    description:
      "Search compact snippets from historical manager and/or sidekick sessions. Never returns full transcripts.",
    parameters: Type.Object(
      {
        query: Type.String({ minLength: 1, maxLength: 1_000 }),
        role: Type.Optional(Type.Union([
          Type.Literal("manager"),
          Type.Literal("sidekick"),
          Type.Literal("both"),
        ])),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RESULTS })),
      },
      { additionalProperties: false },
    ),
    execute: async (rawArguments: Record<string, unknown>): Promise<ToolExecutionResult> => {
      const args = rawArguments as unknown as SessionSearchArguments;
      const query = args.query.trim();
      if (!query) throw new Error("session_search query must be non-empty");
      const role = args.role ?? "both";
      if (role !== "manager" && role !== "sidekick" && role !== "both") {
        throw new Error(`Unknown session role: ${JSON.stringify(role)}`);
      }
      const limit = Math.min(MAX_RESULTS, Math.max(1, Math.floor(args.limit ?? 10)));
      const found = await searcher.search(query, {
        ...(role === "both" ? {} : { role }),
        limit,
        maxFiles: 1_000,
        maxFileBytes: 1_000_000,
        maxSnippets: 3,
        snippetLength: 200,
      });
      const matches = found.slice(0, limit).map((match) => ({
        role: match.role,
        sessionId: compact(match.sessionId, 100),
        timestamp: match.timestamp,
        score: match.score,
        snippets: match.snippets.slice(0, 3).map((snippet) => compact(snippet, 200)),
      }));
      const details = { role, count: matches.length, matches };
      return { text: JSON.stringify(details), details };
    },
  };
}
