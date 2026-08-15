import { readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { AutocompleteItem } from "@mariozechner/pi-tui";

export const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  ".gemini",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "build",
  "out",
  ".idea",
  ".vscode",
  "target",
  ".venv",
  "venv",
  "__pycache__",
]);

interface CacheEntry {
  timestamp: number;
  files: string[];
}

const CACHE_TTL_MS = 2000;
const workspaceFileCache = new Map<string, CacheEntry>();

export function clearWorkspaceFileCache(): void {
  workspaceFileCache.clear();
}

/** Delimiters that can precede an '@' trigger. */
const TRIGGER_BOUNDARY_CHARS = new Set([
  " ",
  "\t",
  "\n",
  "(",
  "[",
  "{",
  "<",
  ",",
  ";",
  ":",
  "=",
  '"',
  "'",
  "`",
  "!",
  "?",
]);

/** Matches any control characters (0x00-0x1F, 0x7F) including newlines/tabs. */
const CONTROL_CHARS_REGEX = /[\x00-\x1f\x7f]/;

export interface AtReferenceMatch {
  /** Full prefix including the '@' (e.g. "@src/foo" or '@"my file'). */
  rawPrefix: string;
  /** Filter query without '@' or opening quotes. */
  query: string;
  isQuoted: boolean;
  quoteChar?: '"' | "'";
  startCol: number;
}

/**
 * Extracts an active @ reference before the cursor position.
 * Returns null if cursor is not in an active @ reference token.
 */
export function extractAtReference(textBeforeCursor: string): AtReferenceMatch | null {
  if (!textBeforeCursor || !textBeforeCursor.includes("@")) {
    return null;
  }

  // 1. Check for unclosed quoted reference: @"... or @'...
  let lastDoubleQuoteAt = -1;
  let lastSingleQuoteAt = -1;

  for (let i = 0; i < textBeforeCursor.length; i++) {
    if (textBeforeCursor[i] === "@" && i + 1 < textBeforeCursor.length) {
      const next = textBeforeCursor[i + 1];
      const isStart = i === 0 || TRIGGER_BOUNDARY_CHARS.has(textBeforeCursor[i - 1]!);
      if (isStart) {
        if (next === '"') lastDoubleQuoteAt = i;
        if (next === "'") lastSingleQuoteAt = i;
      }
    }
  }

  if (lastDoubleQuoteAt !== -1) {
    const afterOpenQuote = textBeforeCursor.slice(lastDoubleQuoteAt + 2);
    // If there is no closing quote after the opening quote, we are inside @"...
    if (!afterOpenQuote.includes('"')) {
      const rawPrefix = textBeforeCursor.slice(lastDoubleQuoteAt);
      return {
        rawPrefix,
        query: afterOpenQuote,
        isQuoted: true,
        quoteChar: '"',
        startCol: lastDoubleQuoteAt,
      };
    }
  }

  if (lastSingleQuoteAt !== -1) {
    const afterOpenQuote = textBeforeCursor.slice(lastSingleQuoteAt + 2);
    if (!afterOpenQuote.includes("'")) {
      const rawPrefix = textBeforeCursor.slice(lastSingleQuoteAt);
      return {
        rawPrefix,
        query: afterOpenQuote,
        isQuoted: true,
        quoteChar: "'",
        startCol: lastSingleQuoteAt,
      };
    }
  }

  // 2. Check for unquoted @reference
  const lastAtIndex = textBeforeCursor.lastIndexOf("@");
  if (lastAtIndex === -1) return null;

  // Check boundary before '@'
  if (lastAtIndex > 0 && !TRIGGER_BOUNDARY_CHARS.has(textBeforeCursor[lastAtIndex - 1]!)) {
    return null;
  }

  const tokenAfterAt = textBeforeCursor.slice(lastAtIndex + 1);

  // If token contains whitespace or delimiters that terminate an unquoted reference, return null
  if (/[\s"']/.test(tokenAfterAt)) {
    return null;
  }

  return {
    rawPrefix: textBeforeCursor.slice(lastAtIndex),
    query: tokenAfterAt,
    isQuoted: false,
    startCol: lastAtIndex,
  };
}

function getCacheKey(
  root: string,
  options?: {
    maxFiles?: number;
    maxDepth?: number;
    ignoredDirs?: Set<string>;
  },
): string {
  const ignored = options?.ignoredDirs
    ? [...options.ignoredDirs].sort().join(",")
    : "default";
  const maxFiles = options?.maxFiles ?? 3000;
  const maxDepth = options?.maxDepth ?? 10;
  return `${root}::${maxFiles}::${maxDepth}::${ignored}`;
}

/**
 * Recursively scans workspace directory for relative file paths, ignoring heavy dirs.
 * Enforces realpath-based containment and excludes outside symlinks and control-character filenames.
 */
export async function scanWorkspaceFiles(
  workspace: string,
  options?: {
    maxFiles?: number;
    maxDepth?: number;
    ignoredDirs?: Set<string>;
    now?: number;
  },
): Promise<string[]> {
  const resolvedWorkspace = resolve(workspace);
  let realRoot: string;
  try {
    realRoot = await realpath(resolvedWorkspace);
  } catch {
    realRoot = resolvedWorkspace;
  }

  const now = options?.now ?? Date.now();
  const maxFiles = options?.maxFiles ?? 3000;
  const maxDepth = options?.maxDepth ?? 10;
  const ignoredDirs = options?.ignoredDirs ?? DEFAULT_IGNORED_DIRS;

  const cacheKey = getCacheKey(realRoot, options);
  const cached = workspaceFileCache.get(cacheKey);
  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.files;
  }

  const results: string[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: realRoot, depth: 0 }];

  while (queue.length > 0 && results.length < maxFiles) {
    const current = queue.shift()!;
    if (current.depth > maxDepth) continue;

    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (results.length >= maxFiles) break;

      // Exclude filenames with control characters / newlines
      if (CONTROL_CHARS_REGEX.test(entry.name)) {
        continue;
      }

      const fullPath = join(current.dir, entry.name);

      // Lexical check against realRoot
      const rel = relative(realRoot, fullPath);
      if (rel.startsWith("..") || resolve(fullPath) !== fullPath) {
        continue;
      }

      const normalizedRel = rel.replace(/\\/g, "/");

      if (entry.isDirectory()) {
        if (ignoredDirs.has(entry.name) || ignoredDirs.has(normalizedRel)) {
          continue;
        }

        // Verify directory realpath containment
        let dirRealPath: string;
        try {
          dirRealPath = await realpath(fullPath);
        } catch {
          continue;
        }
        if (dirRealPath !== realRoot && !dirRealPath.startsWith(realRoot + "/")) {
          continue;
        }

        results.push(normalizedRel + "/");
        queue.push({ dir: fullPath, depth: current.depth + 1 });
      } else if (entry.isFile()) {
        results.push(normalizedRel);
      } else if (entry.isSymbolicLink()) {
        try {
          // Resolve symlink target canonical path
          const targetRealPath = await realpath(fullPath);
          const isTargetContained =
            targetRealPath === realRoot || targetRealPath.startsWith(realRoot + "/");
          if (!isTargetContained) {
            // Symlink points outside the real workspace root: skip
            continue;
          }

          const st = await stat(fullPath);
          if (st.isDirectory()) {
            if (!ignoredDirs.has(entry.name) && !ignoredDirs.has(normalizedRel)) {
              // Directory symlink within workspace: add to results for drilldown, but do NOT traverse recursively
              results.push(normalizedRel + "/");
            }
          } else if (st.isFile()) {
            results.push(normalizedRel);
          }
        } catch {
          // Broken or unreadable symlink
        }
      }
    }
  }

  workspaceFileCache.set(cacheKey, { timestamp: now, files: results });
  return results;
}

export function scoreFileMatch(relPath: string, query: string, isDirectory: boolean): number {
  if (!query) return isDirectory ? 5 : 10;

  const q = query.toLowerCase();
  const pathLower = relPath.toLowerCase();
  const name = basename(relPath.replace(/\/$/, ""));
  const nameLower = name.toLowerCase();

  // Exact matches
  if (nameLower === q) return 100;
  if (pathLower === q || pathLower === q + "/") return 95;

  // Name prefix
  if (nameLower.startsWith(q)) return 85;

  // Path prefix (e.g. query "src/to" matches "src/tools/path.ts")
  if (pathLower.startsWith(q)) return 80;

  // Name contains
  if (nameLower.includes(q)) return 65;

  // Path contains
  if (pathLower.includes(q)) return 50;

  // Subsequence matching
  let qi = 0;
  for (let pi = 0; pi < pathLower.length && qi < q.length; pi++) {
    if (pathLower[pi] === q[qi]) qi++;
  }
  if (qi === q.length) return 25;

  return 0;
}

/**
 * Builds a safe completion value for a file path, choosing appropriate quoting.
 * Returns null if the path contains unrepresentable control characters.
 */
export function buildFileCompletionValue(
  relPath: string,
  isQuoted: boolean,
  quoteChar: '"' | "'" = '"',
): string | null {
  if (CONTROL_CHARS_REGEX.test(relPath)) {
    return null;
  }

  const hasSpacesOrSpecial = /[\s'"()\[\]{}:;=,]/.test(relPath);
  const needsQuotes = isQuoted || hasSpacesOrSpecial;

  if (!needsQuotes) {
    return `@${relPath}`;
  }

  const hasDoubleQuote = relPath.includes('"');
  const hasSingleQuote = relPath.includes("'");

  if (hasDoubleQuote && !hasSingleQuote) {
    // Single quotes are safe
    return `@'${relPath}'`;
  }

  if (hasSingleQuote && !hasDoubleQuote) {
    // Double quotes are safe
    return `@"${relPath}"`;
  }

  if (hasDoubleQuote && hasSingleQuote) {
    // Both quotes present: escape double quotes in double-quoted reference
    const escaped = relPath.replace(/"/g, '\\"');
    return `@"${escaped}"`;
  }

  // Neither quote present: use requested quoteChar or default to double quotes
  const chosenQuote = quoteChar === "'" ? "'" : '"';
  return `@${chosenQuote}${relPath}${chosenQuote}`;
}

export async function suggestWorkspaceFiles(
  workspace: string,
  query: string,
  options?: {
    isQuoted?: boolean;
    quoteChar?: '"' | "'";
    signal?: AbortSignal;
    maxResults?: number;
    ignoredDirs?: Set<string>;
  },
): Promise<AutocompleteItem[]> {
  if (options?.signal?.aborted) return [];

  const files = await scanWorkspaceFiles(workspace, { ignoredDirs: options?.ignoredDirs });
  if (options?.signal?.aborted) return [];

  const scored: { path: string; score: number; isDirectory: boolean }[] = [];

  for (const file of files) {
    const isDir = file.endsWith("/");
    const score = scoreFileMatch(file, query, isDir);
    if (score > 0) {
      scored.push({ path: file, score, isDirectory: isDir });
    }
  }

  // Sort by score descending, then directory status (files first for specific queries), shorter path, alphabetical
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;
    return a.path.localeCompare(b.path);
  });

  const max = options?.maxResults ?? 30;
  const items: AutocompleteItem[] = [];

  for (const { path: filePath, isDirectory } of scored) {
    if (items.length >= max) break;

    const value = buildFileCompletionValue(filePath, options?.isQuoted ?? false, options?.quoteChar);
    if (!value) continue;

    const name = basename(filePath.replace(/\/$/, ""));
    const dir = dirname(filePath);
    const displayDir = dir === "." ? "" : dir + "/";

    items.push({
      value,
      label: name + (isDirectory ? "/" : ""),
      description: displayDir ? `${displayDir}${name}${isDirectory ? "/" : ""}` : undefined,
    });
  }

  return items;
}

/**
 * Replaces the @reference prefix before cursor with the completed file reference.
 */
export function applyAtReferenceCompletion(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
  item: AutocompleteItem,
  rawPrefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
  const currentLine = lines[cursorLine] ?? "";
  const beforePrefix = currentLine.slice(0, cursorCol - rawPrefix.length);
  const afterCursor = currentLine.slice(cursorCol);

  const isDirectory = item.value.endsWith("/") || item.value.endsWith('/"') || item.value.endsWith("/'");
  const hasExistingSpace = afterCursor.startsWith(" ");
  // Append a space after complete file references unless already followed by space
  const suffix = isDirectory || hasExistingSpace ? "" : " ";

  // If item value has quotes and afterCursor has a redundant trailing quote, consume it
  let adjustedAfterCursor = afterCursor;
  if (
    (item.value.endsWith('"') && adjustedAfterCursor.startsWith('"')) ||
    (item.value.endsWith("'") && adjustedAfterCursor.startsWith("'"))
  ) {
    adjustedAfterCursor = adjustedAfterCursor.slice(1);
  }

  const newLine = `${beforePrefix}${item.value}${suffix}${adjustedAfterCursor}`;
  const newLines = [...lines];
  newLines[cursorLine] = newLine;

  // Position cursor right inside directory slash for drilldown or after trailing space
  let cursorOffset = item.value.length;
  if (isDirectory && (item.value.endsWith('"') || item.value.endsWith("'"))) {
    cursorOffset = item.value.length - 1;
  }

  return {
    lines: newLines,
    cursorLine,
    cursorCol: beforePrefix.length + cursorOffset + suffix.length + (hasExistingSpace && !isDirectory ? 1 : 0),
  };
}
