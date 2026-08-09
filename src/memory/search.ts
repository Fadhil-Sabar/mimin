import type { MemoryRecord, MemoryScope } from "./store.js";

export interface MemorySearchOptions {
  scope?: MemoryScope;
  workspace?: string;
  projectId?: string;
  /** Number of ranked records returned (default 10, hard maximum 100). */
  limit?: number;
  /** Maximum records inspected, newest first (default 2,000, maximum 10,000). */
  maxScanRecords?: number;
  /** Maximum snippet size (default 220, range 40-500). */
  snippetLength?: number;
}

export interface MemorySearchResult {
  id: string;
  scope: MemoryScope;
  projectId?: string;
  timestamp: number;
  snippet: string;
  score: number;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function termsFor(query: string): string[] {
  return [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])]
    .filter((term) => term.length > 1)
    .slice(0, 24);
}

function occurrences(text: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (count < 20) {
    const found = text.indexOf(needle, offset);
    if (found < 0) break;
    count += 1;
    offset = found + Math.max(needle.length, 1);
  }
  return count;
}

function scoreText(content: string, query: string, terms: readonly string[]): number {
  const text = content.toLocaleLowerCase();
  const phrase = query.toLocaleLowerCase();
  let score = occurrences(text, phrase) * 20;
  let matchedTerms = 0;
  for (const term of terms) {
    const count = occurrences(text, term);
    if (count > 0) matchedTerms += 1;
    score += Math.min(count, 8) * 3;
    if (new RegExp(`(^|[^\\p{L}\\p{N}_-])${escapeRegExp(term)}(?=$|[^\\p{L}\\p{N}_-])`, "iu").test(content)) {
      score += 2;
    }
  }
  if (terms.length > 1 && matchedTerms === terms.length) score += 8;
  return score;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Produce one whitespace-normalized window rather than returning full memory text. */
export function compactSnippet(content: string, query: string, maxLength = 220): string {
  const length = boundedInteger(maxLength, 220, 40, 500);
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= length) return normalized;
  const lower = normalized.toLocaleLowerCase();
  const phrase = query.trim().toLocaleLowerCase();
  const terms = termsFor(query);
  let match = phrase ? lower.indexOf(phrase) : -1;
  if (match < 0) {
    match = terms.reduce((best, term) => {
      const index = lower.indexOf(term);
      return index >= 0 && (best < 0 || index < best) ? index : best;
    }, -1);
  }
  const markerSpace = 2;
  const available = length - markerSpace;
  let start = match < 0 ? 0 : Math.max(0, match - Math.floor(available / 3));
  let end = Math.min(normalized.length, start + available);
  if (end === normalized.length) start = Math.max(0, end - available);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < normalized.length ? "…" : "";
  return `${prefix}${normalized.slice(start, end).trim()}${suffix}`.slice(0, length);
}

/** Rank already-loaded records using bounded, dependency-free text matching. */
export function searchMemoryRecords(
  records: readonly MemoryRecord[],
  query: string,
  options: MemorySearchOptions = {},
): MemorySearchResult[] {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) return [];
  const limit = boundedInteger(options.limit, 10, 1, 100);
  const scanLimit = boundedInteger(options.maxScanRecords, 2_000, 1, 10_000);
  const snippetLength = boundedInteger(options.snippetLength, 220, 40, 500);
  const terms = termsFor(normalizedQuery);

  return records
    .slice(-scanLimit)
    .map((record) => ({ record, score: scoreText(record.content, normalizedQuery, terms) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || right.record.createdAt - left.record.createdAt)
    .slice(0, limit)
    .map(({ record, score }) => ({
      id: record.id,
      scope: record.scope,
      ...(record.projectId ? { projectId: record.projectId } : {}),
      timestamp: record.createdAt,
      snippet: compactSnippet(record.content, normalizedQuery, snippetLength),
      score,
    }));
}

/** Search any MemoryStore-compatible source without coupling to its class. */
export async function searchMemory(
  source: { search(query: string, options?: MemorySearchOptions): Promise<MemorySearchResult[]> },
  query: string,
  options: MemorySearchOptions = {},
): Promise<MemorySearchResult[]> {
  return source.search(query, options);
}
