import type { SessionSummary } from "../session/session.js";
import type { SessionStore } from "../session/session.js";

/** A session choice offered by the /session command. */
export interface SessionSuggestion {
  /** The exact session id to continue. */
  id: string;
  /** Display label; defaults to the session id when absent. */
  label?: string;
  /** Optional hint (e.g. message count, age). */
  description?: string;
}

/** Session suggestions for a role; never throws for missing session stores. */
export type SessionSuggestionSource = (role: "manager" | "sidekick") => Promise<SessionSuggestion[]>;

/** Format a session summary into a dropdown item with a useful hint. */
export function sessionToSuggestion(summary: SessionSummary): SessionSuggestion {
  const messages = summary.messageCount > 0
    ? `${summary.messageCount} message${summary.messageCount === 1 ? "" : "s"}`
    : "empty";
  const age = ageText(summary.createdAt);
  return {
    id: summary.id,
    label: summary.id,
    description: `${messages} · ${age}`,
  };
}

function ageText(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  const seconds = Math.floor(elapsed / 1_000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Default session suggestions from a live SessionStore. */
export function sessionSuggestionsFromStore(store: SessionStore): SessionSuggestionSource {
  return async (role: "manager" | "sidekick"): Promise<SessionSuggestion[]> => {
    const summaries = await store.listSessions(role);
    return summaries.map(sessionToSuggestion);
  };
}
