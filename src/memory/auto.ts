import type { MemoryStore } from "./store.js";
import type { MemoryCandidate, MemoryLearner } from "./learner.js";
import type { MemorySearchResult } from "./search.js";
import { filterSecrets } from "./secrets.js";

/**
 * Post-turn automatic memory coordinator (v0.2.0).
 *
 * Pipeline for one candidate:
 *   1. The learner already produced structured candidates from bounded
 *      user-authored text (no tools, no workspace access).
 *   2. Secret filtering (belt-and-suspenders, even though the learner output
 *      is also filtered).
 *   3. Deduplication: search existing relevant memory; skip exact or near
 *      duplicates.
 *   4. Scope classification (already on the candidate; conservative).
 *   5. Correction handling: a `correction` candidate that matches an existing
 *      memory supersedes it (tombstone + new record).
 *   6. Persist through MemoryStore (append-only JSONL).
 */

/** Result of one post-turn learning pass. */
export interface AutoMemoryResult {
  /** Number of memories actually persisted this turn. */
  learned: number;
  /** Human-readable status for a lightweight TUI notification. */
  status: "none" | "learned";
}

/** Normalize text for near-duplicate comparison (lowercase, collapse space). */
function normalized(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Exact or near-duplicate check against existing memory search results. */
function isDuplicate(
  candidate: MemoryCandidate,
  results: readonly MemorySearchResult[],
): boolean {
  const needle = normalized(candidate.text);
  for (const result of results) {
    const haystack = normalized(result.snippet);
    // Exact match or one is a near-substring of the other.
    if (haystack === needle) return true;
    if (needle.length >= 12 && haystack.includes(needle)) return true;
    if (haystack.length >= 12 && needle.includes(haystack)) return true;
  }
  return false;
}

/** Search existing memory (both scopes) for a candidate. */
async function findRelated(
  store: MemoryStore,
  candidate: MemoryCandidate,
  workspace: string,
): Promise<MemorySearchResult[]> {
  const scope = candidate.scope;
  const results = await store.search(candidate.text, {
    scope,
    ...(scope === "project" ? { workspace } : {}),
    limit: 5,
    snippetLength: 220,
  });
  return results;
}

/**
 * Run one post-turn learning pass. `learner` extracts candidates from
 * bounded user-authored turns; this function applies the persistence policy.
 * Never throws: learning is best-effort and must not break the interactive
 * session. Returns how many memories were learned (for a subtle TUI event).
 */
export async function learnFromTurn(
  learner: MemoryLearner,
  store: MemoryStore,
  workspace: string,
  history: readonly string[],
  signal?: AbortSignal,
): Promise<AutoMemoryResult> {
  try {
    const result = await learner.learn(history, undefined, signal);
    let learned = 0;
    for (const candidate of result.candidates) {
      // Belt-and-suspenders secret filtering (learner output is also filtered).
      // A candidate whose text redacted to only "[REDACTED]" (or similar) is
      // not a real memory — skip it entirely.
      const clean = filterSecrets(candidate.text);
      if (clean.filtered) continue;
      if (clean.content.trim().length === 0) continue;
      if (clean.content.includes("[REDACTED]")) continue;

      const related = await findRelated(store, candidate, workspace);
      if (isDuplicate(candidate, related)) continue;

      if (candidate.reason === "correction") {
        // Find the most relevant existing memory to supersede (same scope).
        const target = related.find((result) => result.scope === candidate.scope);
        if (target) {
          await store.supersede(
            {
              content: clean.content,
              scope: candidate.scope,
              ...(candidate.scope === "project" ? { workspace } : {}),
            },
            target.id,
          );
          learned += 1;
          continue;
        }
      }
      await store.add({
        content: clean.content,
        scope: candidate.scope,
        ...(candidate.scope === "project" ? { workspace } : {}),
      });
      learned += 1;
    }
    return {
      learned,
      status: learned > 0 ? "learned" : "none",
    };
  } catch {
    // Best-effort: a learner failure must never break the interactive loop.
    return { learned: 0, status: "none" };
  }
}

/** Whether automatic memory is enabled and a learner can run. */
export function autoMemoryEnabled(config: { memory: { auto: boolean } }): boolean {
  return config.memory.auto === true;
}
