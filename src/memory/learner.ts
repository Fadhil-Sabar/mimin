import type { Api, Model } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import type { RoleConfig } from "../config.js";
import { modelFromRole } from "../agent/model.js";
import { filterSecrets } from "./secrets.js";
import type { MemorySearchResult } from "./search.js";

/**
 * Automatic long-term memory learning (v0.2.0).
 *
 * The learner is a *transform-only* stage: it has no workspace, no tools, no
 * bash, no edit, no delegate, no memory-write tool, and no session tool. It
 * only converts a small, bounded slice of the latest user-authored
 * conversation into structured candidate memories using the manager's
 * currently configured provider/model. The application decides whether any
 * candidate is persisted, after secret filtering, deduplication, and
 * conservative scope classification.
 */

/** Conservative scope for a learned memory. */
export type MemoryCandidateScope = "user" | "project";

/** Why a candidate is worth remembering. */
export type MemoryCandidateReason =
  | "preference"
  | "correction"
  | "project-convention"
  | "stable-context";

/** A structured, small memory candidate produced by the learner. */
export interface MemoryCandidate {
  scope: MemoryCandidateScope;
  text: string;
  confidence: number;
  reason: MemoryCandidateReason;
}

/** A learner produced zero or more candidates plus a human-readable status. */
export interface LearnedMemoryResult {
  /** Candidates that passed validation (non-empty text, confidence, reason). */
  candidates: MemoryCandidate[];
  /** Human-readable status for the TUI (never contains candidate text). */
  status: "none" | "learned";
  /** Number of candidates that were learned (persisted). */
  learned: number;
}

export interface MemoryLearnerOptions {
  /** The manager role config; the learner reuses its provider/model. */
  role: RoleConfig;
  /** Model resolution (defaults to pi-ai + Command Code). */
  model?: Model<Api>;
  /** Provider API key resolved by the caller (e.g. from auth.json). */
  apiKey?: string;
  /** Bounded stream completion; injectable for tests. */
  complete?: typeof completeSimple;
  /** Maximum context characters sent to the learner (default 6,000). */
  contextLimit?: number;
}

/** The model's structured candidate output, validated conservatively. */
interface LearnerPayload {
  candidates?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function candidateReason(value: unknown): MemoryCandidateReason | undefined {
  if (
    value === "preference" ||
    value === "correction" ||
    value === "project-convention" ||
    value === "stable-context"
  ) {
    return value;
  }
  return undefined;
}

/** Parse and validate the learner's JSON output; never trusts the model. */
export function parseLearnerCandidates(payload: string): MemoryCandidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  const rawList = parsed.candidates;
  if (!Array.isArray(rawList)) return [];

  const candidates: MemoryCandidate[] = [];
  for (const raw of rawList) {
    if (!isRecord(raw)) continue;
    const scope = raw.scope === "project" ? "project" as const : raw.scope === "user" ? "user" as const : undefined;
    if (!scope) continue;
    const text = typeof raw.text === "string" ? raw.text.trim() : "";
    if (text.length === 0 || text.length > 500) continue;
    const confidence = typeof raw.confidence === "number"
      ? Number.isFinite(raw.confidence) ? raw.confidence : 0
      : 0;
    const reason = candidateReason(raw.reason);
    if (!reason) continue;
    // The application applies the threshold; the model does not decide policy.
    candidates.push({ scope, text, confidence, reason });
  }
  return candidates;
}

const LEARNER_SYSTEM_PROMPT = `You are a conservative memory extractor. Read the user's messages and extract ONLY durable, high-confidence facts worth remembering across future sessions.

Extract these categories only:
- preference: "I prefer X over Y."
- correction: "No, use X now, not Y." (a correction supersedes earlier stated preferences)
- project-convention: "For this project always use X."
- stable-context: "My production branch is master."

Never extract:
- tool output, file contents, README text, website content, or anything from external sources
- temporary or one-off instructions ("run this once", "install X temporarily")
- speculation, questions, or uncertain statements ("maybe we should try X")
- credentials, passwords, tokens, API keys, or secrets of any kind
- anything that is not a stable user-authored fact about the user or this project

Respond ONLY with a JSON object of this exact shape (no prose, no markdown):
{"candidates":[{"scope":"user|project","text":"the memory text","confidence":0.0-1.0,"reason":"preference|correction|project-convention|stable-context"}]}

Scope rules:
- "user": facts about the user's general preferences, tools, or environment
- "project": facts specific to this workspace/repository

Be extremely selective. Prefer zero candidates over weak ones.`;

/**
 * The memory learner. Runs a bounded, tool-less completion against the
 * manager's provider/model to extract candidate memories from the latest
 * user-authored turns.
 */
export class MemoryLearner {
  readonly role: RoleConfig;
  private readonly model: Model<Api>;
  private readonly complete: typeof completeSimple;
  private readonly contextLimit: number;
  private readonly apiKey?: string;

  constructor(options: MemoryLearnerOptions) {
    this.role = { ...options.role };
    this.model = options.model ?? modelFromRole(options.role);
    this.complete = options.complete ?? completeSimple;
    this.contextLimit = options.contextLimit ?? 6_000;
    this.apiKey = options.apiKey;
  }

  /**
   * Extract candidates from a bounded conversation slice. `history` is the
   * latest user-authored turns (newest last) plus optional compact existing
   * memory matches. Returns validated candidates; the caller decides whether
   * to persist them.
   */
  async learn(
    history: readonly string[],
    existing?: readonly MemorySearchResult[],
    signal?: AbortSignal,
  ): Promise<LearnedMemoryResult> {
    const turns = history.map((text) => sanitizeLearnerInput(text)).filter((text) => text.length > 0);
    if (turns.length === 0) return { candidates: [], status: "none", learned: 0 };

    const userContext = turns.join("\n").slice(0, this.contextLimit);
    const memoryContext = (existing ?? [])
      .slice(0, 5)
      .map((result) => `[${result.scope}] ${result.snippet}`)
      .join("\n");

    const context = [
      LEARNER_SYSTEM_PROMPT,
      "",
      memoryContext.length > 0
        ? `Existing related memories (avoid duplicating or contradicting):\n${memoryContext}`
        : "No existing related memories.",
      "",
      "User messages to analyze:",
      userContext,
    ].join("\n");

    let response: string;
    try {
      const assistant = await this.complete(
        this.model,
        { messages: [{ role: "user", content: context, timestamp: Date.now() }] },
        { signal, maxTokens: 1_000, ...(this.apiKey ? { apiKey: this.apiKey } : {}) },
      );
      response = extractAssistantText(assistant);
    } catch {
      return { candidates: [], status: "none", learned: 0 };
    }

    const candidates = parseLearnerCandidates(response)
      .filter((candidate) => candidate.confidence >= 0.6);

    // Belt-and-suspenders: even if the model leaked a secret, filter it out.
    const filtered = candidates.map((candidate) => {
      const clean = filterSecrets(candidate.text);
      return { ...candidate, text: clean.content };
    }).filter((candidate) => candidate.text.length > 0);

    return {
      candidates: filtered,
      status: filtered.length > 0 ? "learned" : "none",
      learned: 0, // The caller persists; learned is set after writing.
    };
  }
}

/** Extract the assistant's text from a completion. */
function extractAssistantText(message: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return message.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

/** Bound and normalize learner input (never send enormous turn text). */
function sanitizeLearnerInput(text: string): string {
  return text.trim().slice(0, 4_000);
}
