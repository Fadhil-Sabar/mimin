import { realpath } from "node:fs/promises";

/**
 * Git-aware change summary for sidekick work.
 *
 * The workspace may already contain user changes before a sidekick runs, so
 * the diff is captured relative to a baseline taken when the sidekick starts.
 * Only the delta between baseline and completion is attributed to the
 * sidekick. Nothing here ever commits, pushes, or creates branches.
 */

export interface GitChanges {
  modified: string[];
  added: string[];
  deleted: string[];
  insertions?: number;
  deletions?: number;
  /** True when the workspace is not a git repository (diff unavailable). */
  unavailable?: boolean;
}

/** Bounded diff text for manager review (never the full workspace diff). */
export const MAX_DIFF_CHARS = 12_000;

function spawnBounded(
  workspace: string,
  args: string[],
  maxBytes = 1024 * 1024,
): Promise<{ text: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: { text: string; exitCode: number | null }): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const process = Bun.spawn(["git", ...args], {
        cwd: workspace,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      const reader = process.stdout.getReader();
      const decoder = new TextDecoder();
      let text = "";
      let truncated = false;
      (async () => {
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (!truncated && text.length < maxBytes) {
              text += decoder.decode(chunk.value, { stream: true });
              if (text.length >= maxBytes) truncated = true;
            }
          }
          text += decoder.decode();
          const exitCode = await process.exited;
          finish({ text, exitCode });
        } catch {
          finish({ text, exitCode: null });
        }
      })();
    } catch {
      finish({ text: "", exitCode: null });
    }
  });
}

interface PorcelainEntry {
  status: string;
  path: string;
}

/** Parse `git status --porcelain` output into entries. */
export function parsePorcelain(output: string): PorcelainEntry[] {
  const entries: PorcelainEntry[] = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    const status = line.slice(0, 2);
    const path = line.slice(3);
    if (!path) continue;
    // Renames appear as "R  old -> new"; keep the new path as the change.
    const arrow = path.indexOf(" -> ");
    entries.push({
      status,
      path: arrow >= 0 ? path.slice(arrow + 4) : path,
    });
  }
  return entries;
}

function classify(entries: PorcelainEntry[]): {
  modified: string[];
  added: string[];
  deleted: string[];
} {
  const modified: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];
  for (const entry of entries) {
    const code = entry.status.trim();
    if (code === "D") deleted.push(entry.path);
    else if (code.startsWith("A") || code === "??") added.push(entry.path);
    else if (code !== "") modified.push(entry.path);
  }
  return { modified, added, deleted };
}

function parseDiffStat(stat: string): { insertions?: number; deletions?: number } {
  const insertionsMatch = /(\d+) insertions?/.exec(stat);
  const deletionsMatch = /(\d+) deletions?/.exec(stat);
  return {
    ...(insertionsMatch ? { insertions: Number(insertionsMatch[1]) } : {}),
    ...(deletionsMatch ? { deletions: Number(deletionsMatch[1]) } : {}),
  };
}

async function isGitRepository(workspace: string): Promise<boolean> {
  const { exitCode } = await spawnBounded(workspace, ["rev-parse", "--is-inside-work-tree"]);
  return exitCode === 0;
}

/** Read the current git change state (porcelain + diff stat). */
export async function readGitChanges(workspace: string): Promise<GitChanges> {
  const cwd = await realpath(workspace).catch(() => workspace);
  if (!(await isGitRepository(cwd))) {
    return { modified: [], added: [], deleted: [], unavailable: true };
  }
  const [statusResult, statResult] = await Promise.all([
    spawnBounded(cwd, ["status", "--porcelain", "--untracked-files=normal"]),
    spawnBounded(cwd, ["diff", "--stat", "--no-ext-diff"]),
  ]);
  if (statusResult.exitCode !== 0 || statResult.exitCode !== 0) {
    return { modified: [], added: [], deleted: [], unavailable: true };
  }
  const { modified, added, deleted } = classify(parsePorcelain(statusResult.text));
  return { modified, added, deleted, ...parseDiffStat(statResult.text) };
}

/**
 * Capture the delta attributable to a sidekick by diffing the git state
 * before it started against the state after it finished. Paths present before
 * the sidekick (pre-existing user changes) are excluded from the sidekick's
 * change list unless they changed further.
 */
export function diffGitChanges(before: GitChanges, after: GitChanges): GitChanges {
  if (before.unavailable || after.unavailable) return after;
  // Conservative attribution: only paths whose status set changed between
  // baseline and completion belong to the sidekick. A path that was already
  // dirty before the sidekick and kept the same status afterwards is not
  // claimed as sidekick work.
  const beforeModified = new Set(before.modified);
  const beforeAdded = new Set(before.added);
  const beforeDeleted = new Set(before.deleted);

  const modified = after.modified.filter((path) => !beforeModified.has(path));
  const added = after.added.filter(
    (path) => !beforeAdded.has(path) && !beforeModified.has(path),
  );
  const deleted = after.deleted.filter(
    (path) => !beforeDeleted.has(path) && !beforeModified.has(path),
  );
  return {
    modified,
    added,
    deleted,
    ...(after.insertions !== undefined ? { insertions: after.insertions } : {}),
    ...(after.deletions !== undefined ? { deletions: after.deletions } : {}),
  };
}

/** Bounded unified diff for the manager review. */
export async function readGitDiff(
  workspace: string,
  maxChars = MAX_DIFF_CHARS,
): Promise<string> {
  const cwd = await realpath(workspace).catch(() => workspace);
  const { text } = await spawnBounded(
    cwd,
    ["diff", "--no-ext-diff", "--unified=3", "--"],
    maxChars + 512,
  );
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.floor(maxChars / 2))}\n… [diff truncated, ${text.length} chars total] …\n${text.slice(-Math.floor(maxChars / 2))}`;
}
