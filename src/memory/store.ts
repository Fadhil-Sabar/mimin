import { appendFile, mkdir, realpath } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { defaultDataDir } from "../config.js";
import { filterSecrets } from "./secrets.js";
import { searchMemoryRecords } from "./search.js";
import type { MemorySearchOptions, MemorySearchResult } from "./search.js";

export type MemoryScope = "user" | "project";

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  content: string;
  createdAt: number;
  /** Present only for project-scoped records. */
  projectId?: string;
  /** Id of the memory record this one supersedes (correction handling). */
  supersedes?: string;
}

export interface MemoryWriteResult extends MemoryRecord {
  /** Whether credential-like text was replaced before persistence. */
  filtered: boolean;
  redactionCount: number;
}

export interface MemoryStoreOptions {
  /** Memory root. It contains `user.jsonl` and `projects/*.jsonl`. */
  root?: string;
  /** Convenience alternative to root; memory is stored below `<dataDir>/memory`. */
  dataDir?: string;
  /** Default workspace for project-scoped operations. */
  workspace?: string;
  now?: () => number;
  idFactory?: () => string;
}

export interface AddMemoryOptions {
  scope?: MemoryScope;
  workspace?: string;
  projectId?: string;
}

export interface AddMemoryInput extends AddMemoryOptions {
  content: string;
}

export interface LoadMemoryOptions {
  scope: MemoryScope;
  workspace?: string;
  projectId?: string;
}

interface StoredRecord {
  version: 1;
  type: "memory";
  id: string;
  scope: MemoryScope;
  content: string;
  createdAt: number;
  projectId?: string;
  /** Id of the memory record this one supersedes (correction handling). */
  supersedes?: string;
}

/** Append-only tombstone written when a memory is superseded. */
interface StoredTombstone {
  version: 1;
  type: "memory-tombstone";
  id: string;
  createdAt: number;
}

const writeQueues = new Map<string, Promise<void>>();

function safeProjectId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || id === "." || id === "..") {
    throw new Error("Invalid project id");
  }
  return id;
}

/** Resolve symlinks and path aliases before deriving project identity. */
export async function canonicalWorkspacePath(workspace: string): Promise<string> {
  if (workspace.trim().length === 0) throw new Error("Workspace must not be empty");
  const absolute = resolve(workspace);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      // A not-yet-created workspace still gets a deterministic absolute identity.
      return absolute;
    }
    throw error;
  }
}

/** Stable, filesystem-safe identity based on a workspace's canonical path. */
export async function projectIdForWorkspace(workspace: string): Promise<string> {
  const canonical = await canonicalWorkspacePath(workspace);
  const label = basename(canonical)
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 40) || "project";
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 24);
  return `${label}-${digest}`;
}

/** Alias emphasizing that identity is derived rather than allocated. */
export const deriveProjectId = projectIdForWorkspace;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecord(value: unknown): MemoryRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.version !== 1 ||
    value.type !== "memory" ||
    typeof value.id !== "string" ||
    (value.scope !== "user" && value.scope !== "project") ||
    typeof value.content !== "string" ||
    typeof value.createdAt !== "number"
  ) return undefined;
  if (value.scope === "project" && typeof value.projectId !== "string") return undefined;
  return {
    id: value.id,
    scope: value.scope,
    content: value.content,
    createdAt: value.createdAt,
    ...(typeof value.projectId === "string" ? { projectId: value.projectId } : {}),
    ...(typeof value.supersedes === "string" ? { supersedes: value.supersedes } : {}),
  };
}

async function appendSerialized(pathname: string, line: string): Promise<void> {
  const previous = writeQueues.get(pathname) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    await mkdir(resolve(pathname, ".."), { recursive: true });
    await appendFile(pathname, line, "utf8");
  });
  writeQueues.set(pathname, operation);
  try {
    await operation;
  } finally {
    if (writeQueues.get(pathname) === operation) writeQueues.delete(pathname);
  }
}

/** Append-friendly, filesystem-backed user and project memory. */
export class MemoryStore {
  readonly root: string;
  readonly workspace?: string;
  private readonly now: () => number;
  private readonly idFactory: () => string;

  constructor(options: MemoryStoreOptions | string = {}) {
    const normalized = typeof options === "string" ? { root: options } : options;
    if (normalized.root && normalized.dataDir) {
      throw new Error("Specify either root or dataDir, not both");
    }
    this.root = resolve(normalized.root ?? join(normalized.dataDir ?? defaultDataDir(), "memory"));
    this.workspace = normalized.workspace;
    this.now = normalized.now ?? Date.now;
    this.idFactory = normalized.idFactory ?? randomUUID;
  }

  private async resolveProjectId(options: {
    workspace?: string;
    projectId?: string;
  }): Promise<string> {
    if (options.projectId) return safeProjectId(options.projectId);
    const workspace = options.workspace ?? this.workspace;
    if (!workspace) throw new Error("Project memory requires a workspace or projectId");
    return projectIdForWorkspace(workspace);
  }

  private path(scope: MemoryScope, projectId?: string): string {
    if (scope === "user") return join(this.root, "user.jsonl");
    if (!projectId) throw new Error("Project memory requires a project id");
    return join(this.root, "projects", `${safeProjectId(projectId)}.jsonl`);
  }

  async add(input: AddMemoryInput): Promise<MemoryWriteResult>;
  async add(content: string, options?: AddMemoryOptions): Promise<MemoryWriteResult>;
  async add(
    inputOrContent: AddMemoryInput | string,
    options: AddMemoryOptions = {},
  ): Promise<MemoryWriteResult> {
    const input = typeof inputOrContent === "string"
      ? { ...options, content: inputOrContent }
      : inputOrContent;
    if (typeof input.content !== "string" || input.content.trim().length === 0) {
      throw new Error("Memory content must be a non-empty string");
    }
    const scope = input.scope ?? "user";
    const projectId = scope === "project" ? await this.resolveProjectId(input) : undefined;

    // Filtering is deliberately completed before directories are created or an
    // append is queued, so unfiltered input can never reach the filesystem.
    const filtered = filterSecrets(input.content);
    const record: StoredRecord = {
      version: 1,
      type: "memory",
      id: this.idFactory().replace(/[^A-Za-z0-9._-]/g, "-") || randomUUID(),
      scope,
      content: filtered.content,
      createdAt: this.now(),
      ...(projectId ? { projectId } : {}),
    };
    await appendSerialized(this.path(scope, projectId), `${JSON.stringify(record)}\n`);
    return {
      id: record.id,
      scope: record.scope,
      content: record.content,
      createdAt: record.createdAt,
      ...(projectId ? { projectId } : {}),
      filtered: filtered.filtered,
      redactionCount: filtered.redactionCount,
    };
  }

  remember(content: string, options: AddMemoryOptions = {}): Promise<MemoryWriteResult> {
    return this.add(content, options);
  }

  /**
   * Write a new memory that supersedes an existing one (correction handling).
   * The old record is tombstoned via an append-only marker so it no longer
   * surfaces in `load`/`search`, while the new record carries the
   * `supersedes` id for auditability. Append safety is preserved: nothing is
   * rewritten in place.
   */
  async supersede(
    input: AddMemoryInput,
    supersededId: string,
  ): Promise<MemoryWriteResult> {
    const scope = input.scope ?? "user";
    const projectId = scope === "project" ? await this.resolveProjectId(input) : undefined;
    if (typeof input.content !== "string" || input.content.trim().length === 0) {
      throw new Error("Memory content must be a non-empty string");
    }
    const filtered = filterSecrets(input.content);
    const record: StoredRecord = {
      version: 1,
      type: "memory",
      id: this.idFactory().replace(/[^A-Za-z0-9._-]/g, "-") || randomUUID(),
      scope,
      content: filtered.content,
      createdAt: this.now(),
      ...(projectId ? { projectId } : {}),
      supersedes: supersededId,
    };
    await appendSerialized(this.path(scope, projectId), `${JSON.stringify(record)}\n`);
    const tombstone: StoredTombstone = {
      version: 1,
      type: "memory-tombstone",
      id: supersededId,
      createdAt: this.now(),
    };
    await appendSerialized(this.path(scope, projectId), `${JSON.stringify(tombstone)}\n`);
    return {
      id: record.id,
      scope: record.scope,
      content: record.content,
      createdAt: record.createdAt,
      ...(projectId ? { projectId } : {}),
      supersedes: supersededId,
      filtered: filtered.filtered,
      redactionCount: filtered.redactionCount,
    };
  }

  async load(scope: MemoryScope, options?: Omit<LoadMemoryOptions, "scope">): Promise<MemoryRecord[]>;
  async load(options: LoadMemoryOptions): Promise<MemoryRecord[]>;
  async load(
    scopeOrOptions: MemoryScope | LoadMemoryOptions,
    options: Omit<LoadMemoryOptions, "scope"> = {},
  ): Promise<MemoryRecord[]> {
    const request = typeof scopeOrOptions === "string"
      ? { ...options, scope: scopeOrOptions }
      : scopeOrOptions;
    const projectId = request.scope === "project"
      ? await this.resolveProjectId(request)
      : undefined;
    const pathname = this.path(request.scope, projectId);
    let text: string;
    try {
      text = await Bun.file(pathname).text();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    const records: MemoryRecord[] = [];
    const tombstoned = new Set<string>();
    // First pass: collect tombstones (a superseded record's id is marked).
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (
          isRecord(parsed) &&
          parsed.version === 1 &&
          parsed.type === "memory-tombstone" &&
          typeof parsed.id === "string"
        ) {
          tombstoned.add(parsed.id);
        }
      } catch {
        // A torn final append must not hide earlier memory.
      }
    }
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const record = parseRecord(JSON.parse(line) as unknown);
        if (
          record &&
          record.scope === request.scope &&
          record.projectId === projectId &&
          !tombstoned.has(record.id)
        ) {
          records.push(record);
        }
      } catch {
        // A torn final append or unrelated line must not hide earlier memory.
      }
    }
    return records;
  }

  list(scope: MemoryScope, options?: Omit<LoadMemoryOptions, "scope">): Promise<MemoryRecord[]>;
  list(options: LoadMemoryOptions): Promise<MemoryRecord[]>;
  list(
    scopeOrOptions: MemoryScope | LoadMemoryOptions,
    options: Omit<LoadMemoryOptions, "scope"> = {},
  ): Promise<MemoryRecord[]> {
    if (typeof scopeOrOptions === "string") return this.load(scopeOrOptions, options);
    return this.load(scopeOrOptions);
  }

  async search(query: string, options: MemorySearchOptions = {}): Promise<MemorySearchResult[]> {
    const scope = options.scope ?? "user";
    const records = await this.load(scope, {
      workspace: options.workspace,
      projectId: options.projectId,
    });
    return searchMemoryRecords(records, query, options);
  }
}
