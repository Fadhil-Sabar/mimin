import { mkdir, stat } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { Type } from "@mariozechner/pi-ai";
import type {
  AnyAgentTool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "../agent/types.js";
import { resolveWorkspacePath } from "./path.js";

interface EditArguments {
  path: string;
  oldText: string;
  newText: string;
}

/**
 * Create an exact, workspace-contained edit tool.
 *
 * Existing files must contain `oldText` exactly once. A missing file can be
 * created by passing an empty `oldText`; parent directories are created only
 * after their containment has been checked.
 */
export function createEditTool(workspace: string): AnyAgentTool {
  return {
    name: "edit",
    description:
      "Replace exactly one occurrence of oldText in a workspace file, or create a new file when oldText is empty.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1, description: "Workspace file path" }),
      oldText: Type.String({ description: "Exact text to replace; empty only for file creation" }),
      newText: Type.String({ description: "Replacement or new file contents" }),
    }),
    execute: async (
      rawArguments: Record<string, unknown>,
      _context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> => {
      const args = rawArguments as unknown as EditArguments;
      const filePath = await resolveWorkspacePath(workspace, args.path);
      const workspaceRoot = await resolveWorkspacePath(workspace, ".");
      const fileExists = await Bun.file(filePath).exists();

      if (!fileExists) {
        if (args.oldText !== "") {
          throw new Error("Cannot edit a missing file unless oldText is empty");
        }
        await mkdir(dirname(filePath), { recursive: true });
        // Re-resolve after mkdir so a newly materialized symlink cannot change
        // the destination outside the workspace.
        const checkedPath = await resolveWorkspacePath(workspace, args.path);
        await Bun.write(checkedPath, args.newText);
        return {
          text: `Created ${relative(workspaceRoot, checkedPath) || "."}`,
          details: {
            path: relative(workspaceRoot, checkedPath) || ".",
            created: true,
          },
        };
      }

      const fileInfo = await stat(filePath);
      if (!fileInfo.isFile()) {
        throw new Error(`Path ${JSON.stringify(args.path)} is not a regular file`);
      }
      if (args.oldText.length === 0) {
        throw new Error("oldText must be non-empty when editing an existing file");
      }

      const original = await Bun.file(filePath).text();
      const first = original.indexOf(args.oldText);
      const last = original.lastIndexOf(args.oldText);
      if (first < 0) {
        throw new Error("oldText was not found exactly in the target file");
      }
      if (first !== last) {
        throw new Error("oldText must match exactly one occurrence in the target file");
      }

      const updated =
        original.slice(0, first) + args.newText + original.slice(first + args.oldText.length);
      await Bun.write(filePath, updated);
      return {
        text: `Updated ${relative(workspaceRoot, filePath) || "."}`,
        details: {
          path: relative(workspaceRoot, filePath) || ".",
          created: false,
        },
      };
    },
  };
}

export const editTool = createEditTool;
