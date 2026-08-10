import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * Provider credential store (v0.2.0).
 *
 * Keys are stored in `<dataDir>/auth.json` as plaintext with `chmod 600`
 * (owner read/write only). This is a deliberate tradeoff: it matches the
 * `auth.json` convention of many CLI tools, keeps the dependency surface
 * zero, and the file permission prevents other local users from reading it.
 *
 * Security invariants:
 * - Values are NEVER logged, rendered, or returned to the TUI.
 * - Environment variables always win over stored keys (env is the existing
 *   documented source; auth.json is a fallback for the interactive flow).
 * - The store is loaded lazily; a missing or corrupt file yields no keys.
 * - Only provider ids are used as keys; unknown entries are ignored.
 */

/** Shape of the persisted auth file. */
interface AuthFile {
  version: 1;
  /** provider id → API key. */
  keys: Record<string, string>;
}

export interface AuthStoreOptions {
  /** Root that contains `auth.json`. */
  root?: string;
  /** Convenience alternative to root; auth.json lives at `<dataDir>/auth.json`. */
  dataDir?: string;
  /** Injectable env (defaults to process.env) for the env-wins check. */
  env?: Record<string, string | undefined>;
}

const AUTH_FILE = "auth.json";

export class AuthStore {
  readonly root: string;
  private readonly env: Record<string, string | undefined>;
  private cache: AuthFile | undefined;

  constructor(options: AuthStoreOptions | string = {}) {
    const normalized = typeof options === "string" ? { root: options } : options;
    if (normalized.root && normalized.dataDir) {
      throw new Error("Specify either root or dataDir, not both");
    }
    this.root = resolve(normalized.root ?? join(normalized.dataDir ?? "", AUTH_FILE));
    this.env = normalized.env ?? process.env;
  }

  private get pathname(): string {
    // root may point directly at auth.json or at a directory containing it.
    return this.root.endsWith(AUTH_FILE) ? this.root : join(this.root, AUTH_FILE);
  }

  private async load(): Promise<AuthFile> {
    if (this.cache) return this.cache;
    let text: string;
    try {
      text = await readFile(this.pathname, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        this.cache = { version: 1, keys: {} };
        return this.cache;
      }
      throw error;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as { version?: unknown }).version === 1 &&
        typeof (parsed as { keys?: unknown }).keys === "object" &&
        (parsed as { keys: unknown }).keys !== null
      ) {
        const keys = (parsed as { keys: Record<string, unknown> }).keys;
        const clean: Record<string, string> = {};
        for (const [provider, value] of Object.entries(keys)) {
          if (typeof value === "string" && value.length > 0) {
            clean[provider] = value;
          }
        }
        this.cache = { version: 1, keys: clean };
        return this.cache;
      }
    } catch {
      // Corrupt auth.json: treat as empty rather than crashing the TUI.
    }
    this.cache = { version: 1, keys: {} };
    return this.cache;
  }

  private async save(): Promise<void> {
    const file = this.cache ?? { version: 1, keys: {} };
    const pathname = this.pathname;
    await mkdir(dirname(pathname), { recursive: true });
    // Write then chmod: never leave the file world-readable between write and
    // permission fix (writeFile creates with the process umask, typically 644).
    await writeFile(pathname, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    await chmod(pathname, 0o600);
  }

  /** Store a provider's API key. */
  async setKey(provider: string, key: string): Promise<void> {
    if (provider.trim().length === 0) throw new Error("Provider id must not be empty");
    const trimmed = key.trim();
    if (trimmed.length === 0) throw new Error("API key must not be empty");
    const file = await this.load();
    file.keys[provider] = trimmed;
    this.cache = file;
    await this.save();
  }

  /** Return the stored key for a provider, or undefined when absent. */
  async getKey(provider: string): Promise<string | undefined> {
    const file = await this.load();
    return file.keys[provider];
  }

  /** Whether a key is stored for the provider. */
  async hasKey(provider: string): Promise<boolean> {
    const file = await this.load();
    return typeof file.keys[provider] === "string" && file.keys[provider].length > 0;
  }

  /** Remove a provider's stored key. */
  async removeKey(provider: string): Promise<void> {
    const file = await this.load();
    if (provider in file.keys) {
      delete file.keys[provider];
      this.cache = file;
      await this.save();
    }
  }

  /**
   * Effective key for a provider: environment first (the documented,
   * higher-trust source), then the stored auth.json value.
   */
  async effectiveKey(provider: string, envVar: string): Promise<string | undefined> {
    const envValue = this.env[envVar];
    if (typeof envValue === "string" && envValue.trim().length > 0) return envValue.trim();
    return this.getKey(provider);
  }
}
