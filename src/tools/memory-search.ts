import { Type } from "@mariozechner/pi-ai";
import type { AnyAgentTool, ToolExecutionResult } from "../agent/types.js";
import { MemoryStore } from "../memory/store.js";
import type { MemorySearchOptions, MemorySearchResult } from "../memory/search.js";

export type ManagerMemoryScope = "user" | "project" | "both";

export interface MemorySearchSource {
  search(query: string, options?: MemorySearchOptions): Promise<MemorySearchResult[]>;
}

export interface CreateMemorySearchToolOptions {
  workspace: string;
  dataDir?: string;
  store?: MemorySearchSource;
}

interface MemorySearchArguments {
  query: string;
  scope?: ManagerMemoryScope;
  limit?: number;
}

const MAX_RESULTS = 20;
const MAX_SNIPPET = 240;

function compact(value: string, limit = MAX_SNIPPET): string {
  const safe = value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return safe.length <= limit ? safe : `${safe.slice(0, limit - 1)}…`;
}

/** Search only the requested persistent-memory scopes and return a compact whitelist. */
export function createMemorySearchTool(
  options: CreateMemorySearchToolOptions,
): AnyAgentTool {
  const store = options.store ?? new MemoryStore({
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    workspace: options.workspace,
  });
  return {
    name: "memory_search",
    description:
      "Search explicitly selected persistent user memory, this workspace's project memory, or both. Returns only compact ranked snippets.",
    parameters: Type.Object(
      {
        query: Type.String({ minLength: 1, maxLength: 1_000 }),
        scope: Type.Optional(Type.Union([
          Type.Literal("user"),
          Type.Literal("project"),
          Type.Literal("both"),
        ])),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RESULTS })),
      },
      { additionalProperties: false },
    ),
    execute: async (rawArguments: Record<string, unknown>): Promise<ToolExecutionResult> => {
      const args = rawArguments as unknown as MemorySearchArguments;
      const query = args.query.trim();
      if (!query) throw new Error("memory_search query must be non-empty");
      const scope = args.scope ?? "both";
      if (scope !== "user" && scope !== "project" && scope !== "both") {
        throw new Error(`Unknown memory scope: ${JSON.stringify(scope)}`);
      }
      const limit = Math.min(MAX_RESULTS, Math.max(1, Math.floor(args.limit ?? 10)));
      const scopes = scope === "both" ? ["user", "project"] as const : [scope];
      const matches = (await Promise.all(scopes.map((selected) =>
        store.search(query, {
          scope: selected,
          ...(selected === "project" ? { workspace: options.workspace } : {}),
          limit,
          snippetLength: MAX_SNIPPET,
          maxScanRecords: 2_000,
        })
      )))
        .flat()
        .sort((left, right) => right.score - left.score || right.timestamp - left.timestamp)
        .slice(0, limit)
        .map((match) => ({
          id: compact(match.id, 100),
          scope: match.scope,
          timestamp: match.timestamp,
          score: match.score,
          snippet: compact(match.snippet),
        }));
      const details = { scope, count: matches.length, matches };
      return { text: JSON.stringify(details), details };
    },
  };
}
