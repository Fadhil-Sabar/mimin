import { mkdir, realpath, stat } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

function isContained(workspaceRoot: string, candidate: string): boolean {
  const relativePath = relative(workspaceRoot, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

async function existingAncestor(pathname: string): Promise<string> {
  let current = pathname;
  while (true) {
    try {
      await stat(current);
      return current;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

/**
 * Resolve a user-supplied path under a workspace and check symlink targets.
 * Absolute paths are accepted only when they are already inside the workspace;
 * relative paths are resolved from the workspace root.
 */
export async function resolveWorkspacePath(
  workspace: string,
  requestedPath: string,
): Promise<string> {
  if (typeof requestedPath !== "string" || requestedPath.length === 0) {
    throw new WorkspacePathError("A non-empty workspace-relative path is required");
  }
  if (requestedPath.includes("\0")) {
    throw new WorkspacePathError("NUL bytes are not valid in workspace paths");
  }

  await mkdir(workspace, { recursive: true });
  const workspaceRoot = await realpath(workspace);
  const candidate = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(workspaceRoot, requestedPath);

  if (!isContained(workspaceRoot, candidate)) {
    throw new WorkspacePathError(
      `Path ${JSON.stringify(requestedPath)} is outside the workspace`,
    );
  }

  try {
    const resolved = await realpath(candidate);
    if (!isContained(workspaceRoot, resolved)) {
      throw new WorkspacePathError(
        `Path ${JSON.stringify(requestedPath)} resolves outside the workspace`,
      );
    }
    return resolved;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }

    // For a new file, verify the nearest existing parent after resolving its
    // symlinks. This prevents creating through a link that leaves the root.
    const parent = await existingAncestor(dirname(candidate));
    const resolvedParent = await realpath(parent);
    if (!isContained(workspaceRoot, resolvedParent)) {
      throw new WorkspacePathError(
        `Path ${JSON.stringify(requestedPath)} resolves outside the workspace`,
      );
    }
    return candidate;
  }
}

/**
 * Mask safe command constructs containing slashes (URLs, safe /dev stream endpoints,
 * sed/awk/filter regex patterns, and arithmetic division) before checking
 * for genuine absolute paths outside the workspace.
 */
function maskSafeCommandSyntax(command: string): string {
  let text = command;

  // 1. URLs (e.g. https://example.com/foo, http://localhost:3000/api, git://..., file://...)
  text = text.replace(
    /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"`<>)\]}]+/g,
    (match) => " ".repeat(match.length),
  );

  // 2. Safe /dev/ stream and pseudo-device endpoints (e.g. /dev/null, /dev/zero, /dev/urandom, /dev/stdin, /dev/stdout, /dev/stderr, /dev/fd/1)
  text = text.replace(
    /(?<=^|[\s'"`=(:,;|&<>\\{}[\]])\/dev\/(?:null|zero|urandom|random|stdin|stdout|stderr|fd\/\d+)(?=[\s'"`=:,;|&<>\\{}[\]]|$)/g,
    (match) => " ".repeat(match.length),
  );

  // 3. Sed / tr substitution & transliteration expressions (e.g. s/foo/bar/g, y/abc/xyz/)
  text = text.replace(
    /\b[sy]\/((?:\\\/|[^\/])*)\/((?:\\\/|[^\/])*)\/[a-zA-Z]*/g,
    (match) => " ".repeat(match.length),
  );

  // 4. Delimiter flags with a single slash (e.g. awk -F'/', awk -F"/", cut -d'/', tr '/')
  text = text.replace(
    /(?<=-[Fd]\s*|(?:\btr\s+(?:-[a-zA-Z0-9]+\s+)*))(['"])\/\1/g,
    (match) => " ".repeat(match.length),
  );

  // 5. Quoted or flag-delimited regex patterns (e.g. sed '/pattern/d', awk '/pattern/', --filter /pattern/)
  text = text.replace(
    /(?<=\bsed\s+(?:-[a-zA-Z0-9_-]+\s+)*['"])\/((?:\\\/|[^\/])+)\/[a-zA-Z0-9_!~=><\s{}]*/g,
    (match) => " ".repeat(match.length),
  );
  text = text.replace(
    /(?<=\bawk\s+(?:-[a-zA-Z0-9_-]+\s+)*['"][^'"]*)\/((?:\\\/|[^\/])+)\//g,
    (match) => " ".repeat(match.length),
  );
  text = text.replace(
    /(?<=--(?:filter|grep|test-name-pattern)[=\s]+)(['"]?)\/((?:\\\/|[^\/\s])+)\/[gimsuxydv]*\1?/g,
    (match) => " ".repeat(match.length),
  );
  text = text.replace(
    /(?<=-[eEP]\s+)(['"])\/((?:\\\/|[^\/])+)\/[gimsuxydv]*\1/g,
    (match) => " ".repeat(match.length),
  );

  // 6. Search patterns for grep/rg where a pattern starting with / is quoted and followed by a target file/directory
  text = text.replace(
    /(?<=\b(?:grep|rg|ag)\s+(?:-[a-zA-Z0-9_-]+\s+)*)(['"])\S+?\1(?=\s+[a-zA-Z0-9._-])/g,
    (match) => " ".repeat(match.length),
  );

  // 7. Arithmetic division expressions (e.g. 1/2 or (a + b) / 2)
  text = text.replace(
    /(?<=\d|\))\s*\/\s*(?=\d|\(|\w)/g,
    (match) => " ".repeat(match.length),
  );

  return text;
}

/**
 * Reject common shell spellings that explicitly escape the configured cwd.
 * Bun's cwd is the process boundary; this check blocks traversal, home-directory
 * expansion, and genuine absolute path operands before the shell is started.
 */
export function assertWorkspaceCommand(command: string): void {
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new WorkspacePathError("A non-empty bash command is required");
  }

  const traversal = /(?:^|[\s/\\'"`=(:;|&<>\\{}[\]])\.\.(?=$|[\s/\\'"`=():;|&<>\\{}[\]])/;
  if (traversal.test(command)) {
    throw new WorkspacePathError("Bash commands may not traverse outside the workspace");
  }

  if (/(?:^|[\s'"`])~(?:[/\s'"`]|$)/.test(command)) {
    throw new WorkspacePathError("Bash commands may not use home-directory expansion");
  }

  const masked = maskSafeCommandSyntax(command);
  const absolutePath = /(?:^|[\s'"`=(:,;|&<>\\{}[\]])\/(?:[^\s'"`=(:,;|&<>\\{}[\]]*)?/;
  if (absolutePath.test(masked)) {
    throw new WorkspacePathError("Bash commands may not use absolute paths");
  }
}
