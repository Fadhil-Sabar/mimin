import { readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { defaultDataDir } from "../config.js";
import type { SessionRole } from "../session/session.js";
import { compactSnippet } from "./search.js";
import { filterSecrets } from "./secrets.js";

export interface SessionSearchOptions {
  /** Data directory containing `sessions/`. */
  dataDir?: string;
  /** Direct sessions root; takes precedence over dataDir. */
  root?: string;
  role?: SessionRole;
  limit?: number;
  maxFiles?: number;
  maxFileBytes?: number;
  maxSnippets?: number;
  snippetLength?: number;
}

export interface SessionSearchResult {
  role: SessionRole;
  sessionId: string;
  /** Timestamp of the newest matching message, or session creation time. */
  timestamp: number;
  snippets: string[];
  score: number;
}

interface TextMatch {
  text: string;
  timestamp?: number;
  score: number;
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageText(message: Record<string, unknown>): string {
  const role = message.role;
  if (role !== "user" && role !== "assistant") return "";

  const content = message.content;
  if (role === "user" && typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const pieces: string[] = [];
  for (const part of content) {
    if (
      isObject(part) &&
      part.type === "text" &&
      typeof part.text === "string"
    ) {
      pieces.push(part.text);
    }
  }
  return pieces.join("\n");
}

function queryTerms(query: string): string[] {
  return [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])]
    .filter((term) => term.length > 1)
    .slice(0, 24);
}

function count(text: string, value: string): number {
  let total = 0;
  let from = 0;
  while (total < 20) {
    const index = text.indexOf(value, from);
    if (index < 0) return total;
    total += 1;
    from = index + Math.max(1, value.length);
  }
  return total;
}

function textScore(text: string, query: string, terms: readonly string[]): number {
  const lower = text.toLocaleLowerCase();
  let score = count(lower, query.toLocaleLowerCase()) * 20;
  let matched = 0;
  for (const term of terms) {
    const termCount = count(lower, term);
    if (termCount > 0) matched += 1;
    score += Math.min(termCount, 8) * 3;
  }
  if (terms.length > 1 && matched === terms.length) score += 8;
  return score;
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

async function searchFile(
  pathname: string,
  role: SessionRole,
  query: string,
  terms: readonly string[],
  maxFileBytes: number,
  maxSnippets: number,
  snippetLength: number,
): Promise<SessionSearchResult | undefined> {
  try {
    const file = Bun.file(pathname);
    const start = Math.max(0, file.size - maxFileBytes);
    const text = await file.slice(start).text();
    let sessionId = basename(pathname, ".jsonl");
    let createdAt = 0;
    const matches: TextMatch[] = [];

    for (const rawLine of text.split("\n")) {
      if (rawLine.trim().length === 0) continue;
      try {
        const line = JSON.parse(rawLine) as unknown;
        if (!isObject(line)) continue;
        if (line.type === "session") {
          if (validSessionId(line.id)) sessionId = line.id;
          if (typeof line.createdAt === "number" && Number.isFinite(line.createdAt)) {
            createdAt = line.createdAt;
          }
          continue;
        }
        if (line.type !== "message" || !isObject(line.message)) continue;
        const value = messageText(line.message).slice(0, 100_000);
        if (value.length === 0) continue;
        const score = textScore(value, query, terms);
        if (score === 0) continue;
        matches.push({
          text: value,
          score,
          ...(typeof line.message.timestamp === "number"
            ? { timestamp: line.message.timestamp }
            : {}),
        });
      } catch {
        // Ignore malformed lines and torn final JSONL appends independently.
      }
    }

    if (matches.length === 0) return undefined;
    matches.sort((left, right) => right.score - left.score || (right.timestamp ?? 0) - (left.timestamp ?? 0));
    const selected = matches.slice(0, maxSnippets);
    return {
      role,
      sessionId,
      timestamp: Math.max(createdAt, ...selected.map((match) => match.timestamp ?? 0)),
      snippets: selected.map((match) =>
        compactSnippet(filterSecrets(match.text).content, query, snippetLength),
      ),
      score: matches.reduce((sum, match) => sum + match.score, 0),
    };
  } catch {
    // Files can disappear, be unreadable, or be corrupt while searching.
    return undefined;
  }
}

/**
 * Search manager and sidekick JSONL sessions without loading session objects or
 * returning transcript records. Work and output are both explicitly bounded.
 */
export async function searchSessions(
  query: string,
  options: SessionSearchOptions = {},
): Promise<SessionSearchResult[]> {
  const normalized = query.trim();
  if (normalized.length === 0) return [];
  const root = resolve(options.root ?? join(options.dataDir ?? defaultDataDir(), "sessions"));
  const roles: SessionRole[] = options.role ? [options.role] : ["manager", "sidekick"];
  const limit = bounded(options.limit, 10, 1, 100);
  const maxFiles = bounded(options.maxFiles, 1_000, 1, 10_000);
  const maxFileBytes = bounded(options.maxFileBytes, 1_000_000, 4_096, 4_000_000);
  const maxSnippets = bounded(options.maxSnippets, 3, 1, 5);
  const snippetLength = bounded(options.snippetLength, 200, 40, 500);
  const terms = queryTerms(normalized);
  const files: Array<{ pathname: string; role: SessionRole }> = [];

  for (const role of roles) {
    try {
      const entries = await readdir(join(root, role), { withFileTypes: true });
      for (const entry of entries) {
        if (files.length >= maxFiles) break;
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          files.push({ pathname: join(root, role, entry.name), role });
        }
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        // Treat an unreadable role directory like corrupt session input.
      }
    }
    if (files.length >= maxFiles) break;
  }

  const results = await Promise.all(
    files.map(({ pathname, role }) =>
      searchFile(pathname, role, normalized, terms, maxFileBytes, maxSnippets, snippetLength),
    ),
  );
  return results
    .filter((result): result is SessionSearchResult => result !== undefined)
    .sort((left, right) => right.score - left.score || right.timestamp - left.timestamp)
    .slice(0, limit);
}

export class SessionSearch {
  readonly options: SessionSearchOptions;

  constructor(options: SessionSearchOptions | string = {}) {
    this.options = typeof options === "string" ? { dataDir: options } : options;
  }

  search(query: string, options: Omit<SessionSearchOptions, "dataDir" | "root"> = {}): Promise<SessionSearchResult[]> {
    return searchSessions(query, { ...this.options, ...options });
  }
}

export const SessionSearcher = SessionSearch;
