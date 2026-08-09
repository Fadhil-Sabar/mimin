import { stat } from "node:fs/promises";
import { relative } from "node:path";
import { Type } from "@mariozechner/pi-ai";
import type {
  AnyAgentTool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "../agent/types.js";
import { resolveWorkspacePath } from "./path.js";

const DEFAULT_READ_LIMIT = 256 * 1024;
const MAX_READ_LIMIT = 4 * 1024 * 1024;

interface ReadArguments {
  path: string;
  maxBytes?: number;
}

/** Create a workspace-contained file reading tool. */
export function createReadTool(workspace: string): AnyAgentTool {
  return {
    name: "read",
    description:
      "Read a UTF-8 text file from the configured workspace. Paths outside the workspace are rejected.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1, description: "Workspace file path" }),
      maxBytes: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_READ_LIMIT,
          description: "Optional maximum number of bytes to return",
        }),
      ),
    }),
    execute: async (
      rawArguments: Record<string, unknown>,
      _context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> => {
      const args = rawArguments as unknown as ReadArguments;
      const filePath = await resolveWorkspacePath(workspace, args.path);
      const fileInfo = await stat(filePath);
      if (!fileInfo.isFile()) {
        throw new Error(`Path ${JSON.stringify(args.path)} is not a regular file`);
      }

      const limit = Math.min(args.maxBytes ?? DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
      const file = Bun.file(filePath);
      const truncated = fileInfo.size > limit;
      const text = await file.slice(0, limit).text();
      const workspaceRoot = await resolveWorkspacePath(workspace, ".");

      return {
        text,
        details: {
          path: relative(workspaceRoot, filePath) || ".",
          bytes: fileInfo.size,
          truncated,
        },
      };
    },
  };
}

export const readTool = createReadTool;
