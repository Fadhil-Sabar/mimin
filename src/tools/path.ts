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
 * Reject common shell spellings that explicitly escape the configured cwd.
 * Bun's cwd is the process boundary; this conservative check also blocks
 * traversal and absolute path operands before the shell is started.
 */
export function assertWorkspaceCommand(command: string): void {
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new WorkspacePathError("A non-empty bash command is required");
  }

  const traversal = /(?:^|[\s/\\'"`=(:;|&<>])\.\.(?=$|[\s/\\'"`=():;|&<>])/;
  if (traversal.test(command)) {
    throw new WorkspacePathError("Bash commands may not traverse outside the workspace");
  }

  // An absolute path at a shell word boundary is never needed for commands
  // intended to operate in the workspace. This intentionally errs on the
  // safe side for quoted/interpolated operands too.
  const absolutePath = /(?:^|[\s'"`=(:,;|&<>])\/(?:[^\s'"`=(:,;|&<>]*)?/;
  if (absolutePath.test(command)) {
    throw new WorkspacePathError("Bash commands may not use absolute paths");
  }

  if (/(?:^|[\s'"`])~(?:[/\s'"`]|$)/.test(command)) {
    throw new WorkspacePathError("Bash commands may not use home-directory expansion");
  }
}
