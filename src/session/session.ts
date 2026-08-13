import { access, appendFile, mkdir, open, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentEvent, AgentMessageSession } from "../agent/types.js";
import { defaultDataDir } from "../config.js";

export type SessionRole = "manager" | "sidekick";

interface SessionMetadataLine {
  type: "session";
  version: 1;
  id: string;
  role: SessionRole;
  createdAt: number;
}

interface SessionMessageLine {
  type: "message";
  message: Message;
}

/** Runtime events may be persisted alongside messages without joining histories. */
export type SessionEvent = AgentEvent | { type: string; [key: string]: unknown };

interface SessionEventLine {
  type: "event";
  event: SessionEvent;
}

type SessionLine = SessionMetadataLine | SessionMessageLine | SessionEventLine;

export interface SessionSummary {
  id: string;
  role: SessionRole;
  createdAt: number;
  messageCount: number;
  eventCount: number;
  path: string;
}

export interface SessionStoreOptions {
  /** Root containing separate `manager/` and `sidekick/` directories. */
  root?: string;
  now?: () => number;
  idFactory?: () => string;
}

const ROLE_DIRECTORY = {
  manager: "manager",
  sidekick: "sidekick",
} as const;

function defaultRoot(): string {
  return join(defaultDataDir(), "sessions");
}

function roleDirectory(role: SessionRole): string {
  return ROLE_DIRECTORY[role];
}

function assertRole(value: string): asserts value is SessionRole {
  if (value !== "manager" && value !== "sidekick") {
    throw new Error(`Unknown session role: ${JSON.stringify(value)}`);
  }
}

function assertSessionId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id === "." || id === "..") {
    throw new Error("Invalid session id");
  }
}

function sessionPath(root: string, role: SessionRole, id: string): string {
  assertSessionId(id);
  return join(resolve(root), roleDirectory(role), `${id}.jsonl`);
}

function encodeLine(line: SessionLine): string {
  return `${JSON.stringify(line)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseLine(value: unknown): SessionLine {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Invalid session JSONL record");
  }
  if (value.type === "session") {
    const role = value.role;
    if (
      value.version !== 1 ||
      typeof value.id !== "string" ||
      typeof value.createdAt !== "number" ||
      typeof role !== "string"
    ) {
      throw new Error("Invalid session metadata record");
    }
    assertRole(role);
    return {
      type: "session",
      version: 1,
      id: value.id,
      role,
      createdAt: value.createdAt,
    };
  }
  if (value.type === "message" && "message" in value) {
    return { type: "message", message: value.message as Message };
  }
  if (
    value.type === "event" &&
    isRecord(value.event) &&
    typeof value.event.type === "string"
  ) {
    return { type: "event", event: value.event as SessionEvent };
  }
  throw new Error("Invalid session JSONL record");
}

async function readLines(pathname: string): Promise<SessionLine[]> {
  const text = await Bun.file(pathname).text();
  const lines = text.split("\n").filter((line) => line.length > 0);
  return lines.map((line) => parseLine(JSON.parse(line) as unknown));
}

async function fileExists(pathname: string): Promise<boolean> {
  try {
    await access(pathname);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/** An append-only JSONL conversation with independent role-scoped identity. */
export class JsonlSession implements AgentMessageSession {
  readonly messages: Message[];
  readonly events: SessionEvent[];
  readonly id: string;
  readonly role: SessionRole;
  /** Alias matching the manager/sidekick terminology used by orchestration. */
  readonly kind: SessionRole;
  readonly createdAt: number;
  readonly path: string;

  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    metadata: SessionMetadataLine,
    pathname: string,
    messages: Message[],
    events: SessionEvent[],
  ) {
    this.id = metadata.id;
    this.role = metadata.role;
    this.kind = metadata.role;
    this.createdAt = metadata.createdAt;
    this.path = pathname;
    this.messages = messages;
    this.events = events;
  }

  /** Append one complete pi-ai message and update the in-memory history. */
  append(message: Message): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      await appendFile(
        this.path,
        encodeLine({ type: "message", message }),
        "utf8",
      );
      this.messages.push(message);
    });
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  appendMessage(message: Message): Promise<void> {
    return this.append(message);
  }

  /** Append one serializable runtime event without adding it to model context. */
  appendEvent(event: SessionEvent): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      await appendFile(this.path, encodeLine({ type: "event", event }), "utf8");
      this.events.push(event);
    });
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }
}

/** Filesystem-backed session store. Pass `root` to isolate tests or projects. */
export class SessionStore {
  readonly root: string;
  private readonly now: () => number;
  private readonly idFactory: () => string;

  constructor(options: SessionStoreOptions | string = {}) {
    const normalized = typeof options === "string" ? { root: options } : options;
    this.root = resolve(normalized.root ?? defaultRoot());
    this.now = normalized.now ?? Date.now;
    this.idFactory = normalized.idFactory ?? randomUUID;
  }

  async createSession(role: SessionRole): Promise<JsonlSession> {
    assertRole(role);
    const directory = join(this.root, roleDirectory(role));
    await mkdir(directory, { recursive: true });

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const generated = this.idFactory().replace(/[^A-Za-z0-9._-]/g, "-");
      const baseId = generated.startsWith(`${role}-`)
        ? generated
        : `${role}-${generated}`;
      const id = attempt === 0 ? baseId : `${baseId}-${attempt}`;
      const pathname = sessionPath(this.root, role, id);
      const metadata: SessionMetadataLine = {
        type: "session",
        version: 1,
        id,
        role,
        createdAt: this.now(),
      };

      try {
        const handle = await open(pathname, "wx");
        try {
          await handle.writeFile(encodeLine(metadata), "utf8");
        } finally {
          await handle.close();
        }
        return new JsonlSession(metadata, pathname, [], []);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") {
          continue;
        }
        throw error;
      }
    }

    throw new Error(`Could not allocate a unique ${role} session id`);
  }

  async loadSession(role: SessionRole, id: string): Promise<JsonlSession> {
    assertRole(role);
    const pathname = sessionPath(this.root, role, id);
    // A wrong-role session id must read as a role mismatch, never as a missing
    // file. This keeps continuation errors compact and manager-facing.
    if (!(await fileExists(pathname))) {
      if (role === "sidekick" && (await fileExists(sessionPath(this.root, "manager", id)))) {
        throw new Error("Session is not a sidekick session");
      }
      if (role === "manager" && (await fileExists(sessionPath(this.root, "sidekick", id)))) {
        throw new Error("Session is not a manager session");
      }
    }
    const lines = await readLines(pathname);
    const metadata = lines.find(
      (line): line is SessionMetadataLine => line.type === "session",
    );
    if (!metadata || metadata.id !== id || metadata.role !== role) {
      throw new Error(`Session metadata does not match ${role}/${id}`);
    }
    const messages = lines
      .filter((line): line is SessionMessageLine => line.type === "message")
      .map((line) => line.message);
    const events = lines
      .filter((line): line is SessionEventLine => line.type === "event")
      .map((line) => line.event);
    return new JsonlSession(metadata, pathname, messages, events);
  }

  /** Open an existing role-scoped session. */
  openSession(role: SessionRole, id: string): Promise<JsonlSession> {
    return this.loadSession(role, id);
  }

  async loadMessages(role: SessionRole, id: string): Promise<Message[]> {
    return (await this.loadSession(role, id)).messages;
  }

  async loadEvents(role: SessionRole, id: string): Promise<SessionEvent[]> {
    return (await this.loadSession(role, id)).events;
  }

  /**
   * Read only the event records of a session without loading its full message
   * history. Used for read-only task-board snapshots in the TUI/CLI. Returns
   * an empty array when the session does not exist or cannot be parsed.
   */
  async peekSessionEvents(role: SessionRole, id: string): Promise<SessionEvent[]> {
    assertRole(role);
    const pathname = sessionPath(this.root, role, id);
    if (!(await fileExists(pathname))) return [];
    try {
      const lines = await readLines(pathname);
      return lines
        .filter((line): line is SessionEventLine => line.type === "event")
        .map((line) => line.event);
    } catch {
      return [];
    }
  }

  async listSessions(role?: SessionRole): Promise<SessionSummary[]> {
    const roles: SessionRole[] = role ? [role] : ["manager", "sidekick"];
    const summaries: SessionSummary[] = [];

    for (const currentRole of roles) {
      assertRole(currentRole);
      const directory = join(this.root, roleDirectory(currentRole));
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          continue;
        }
        throw error;
      }

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const id = entry.name.slice(0, -".jsonl".length);
        try {
          const session = await this.loadSession(currentRole, id);
          summaries.push({
            id: session.id,
            role: session.role,
            createdAt: session.createdAt,
            messageCount: session.messages.length,
            eventCount: session.events.length,
            path: session.path,
          });
        } catch {
          // Ignore unrelated/partial files rather than exposing them as sessions.
        }
      }
    }

    return summaries.sort((left, right) => right.createdAt - left.createdAt);
  }
}

export async function createSession(
  role: SessionRole,
  options: SessionStoreOptions | string = {},
): Promise<JsonlSession> {
  return new SessionStore(options).createSession(role);
}

export async function loadSession(
  role: SessionRole,
  id: string,
  options: SessionStoreOptions | string = {},
): Promise<JsonlSession> {
  return new SessionStore(options).loadSession(role, id);
}

export async function openSession(
  role: SessionRole,
  id: string,
  options: SessionStoreOptions | string = {},
): Promise<JsonlSession> {
  return new SessionStore(options).openSession(role, id);
}

export async function loadMessages(
  role: SessionRole,
  id: string,
  options: SessionStoreOptions | string = {},
): Promise<Message[]> {
  return new SessionStore(options).loadMessages(role, id);
}

export async function loadEvents(
  role: SessionRole,
  id: string,
  options: SessionStoreOptions | string = {},
): Promise<SessionEvent[]> {
  return new SessionStore(options).loadEvents(role, id);
}

export async function listSessions(
  options: SessionStoreOptions & { role?: SessionRole } = {},
): Promise<SessionSummary[]> {
  const { role, ...storeOptions } = options;
  return new SessionStore(storeOptions).listSessions(role);
}
