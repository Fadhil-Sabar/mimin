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
 * Shell-aware command analyzer for workspace containment.
 *
 * Implements lexical tokenization, quoting/expansion resolution, substitution
 * extraction, and syntax analysis to prevent absolute filesystem access,
 * directory traversal, home expansion, and nested shell execution escapes
 * while permitting legitimate relative commands, URLs, safe /dev streams,
 * regex expressions, and arithmetic.
 */

const SAFE_DEV_DEVICES = new Set([
  "/dev/null",
  "/dev/zero",
  "/dev/urandom",
  "/dev/random",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
]);

function isSafeDevPath(path: string): boolean {
  const normalized = path.replace(/\/+/g, "/");
  if (SAFE_DEV_DEVICES.has(normalized)) return true;
  return /^\/dev\/fd\/\d+$/.test(normalized);
}

function isUrl(text: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"`<>)\]}]+$/.test(text);
}

function isArithmeticDivision(text: string): boolean {
  return /^[\d\s()+\-*.\w]+(?:\/[\d\s()+\-*.\w]+)+$/.test(text) &&
    /[\d)]/.test(text.split("/")[0] ?? "") &&
    /[\d(\w]/.test(text.split("/")[1] ?? "");
}


/** Unescape ANSI-C quoting ($'...') */
function unescapeAnsiC(input: string): string {
  return input.replace(
    /\\(?:([0-7]{1,3})|x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|([abefnrtv\\'"?]))/g,
    (_, oct, hex, u4, u8, esc) => {
      if (oct) return String.fromCharCode(parseInt(oct, 8));
      if (hex) return String.fromCharCode(parseInt(hex, 16));
      if (u4) return String.fromCharCode(parseInt(u4, 16));
      if (u8) return String.fromCodePoint(parseInt(u8, 16));
      switch (esc) {
        case "a": return "\x07";
        case "b": return "\b";
        case "e":
        case "E": return "\x1b";
        case "f": return "\f";
        case "n": return "\n";
        case "r": return "\r";
        case "t": return "\t";
        case "v": return "\v";
        case "\\": return "\\";
        case "'": return "'";
        case '"': return '"';
        case "?": return "?";
        default: return esc ?? "";
      }
    },
  );
}

interface SimpleCommand {
  assignments: string[];
  words: string[];
  redirections: string[];
  isPipedIn?: boolean;
}

function parseSimpleCommands(command: string): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  let nextIsPipedIn = false;
  let current: SimpleCommand = { assignments: [], words: [], redirections: [], isPipedIn: false };

  const input = command;
  const len = input.length;
  let i = 0;
  let currentToken = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inAnsiQuote = false;

  function pushToken() {
    if (currentToken.length === 0) return;
    const tok = currentToken;
    currentToken = "";
    if (current.words.length === 0 && /^([a-zA-Z_][a-zA-Z0-9_]*)=/.test(tok)) {
      current.assignments.push(tok);
    } else {
      current.words.push(tok);
    }
  }

  function pushCommand(isPipeAfter: boolean) {
    pushToken();
    if (current.words.length > 0 || current.assignments.length > 0 || current.redirections.length > 0) {
      commands.push(current);
      current = { assignments: [], words: [], redirections: [], isPipedIn: nextIsPipedIn };
    }
    nextIsPipedIn = isPipeAfter;
    if (!isPipeAfter) {
      current.isPipedIn = false;
    }
  }

  while (i < len) {
    const ch = input[i]!;

    // 1. Single Quotes ('...')
    if (inSingleQuote) {
      if (ch === "'") {
        inSingleQuote = false;
      } else {
        currentToken += ch;
      }
      i++;
      continue;
    }

    // 2. ANSI C Quotes ($'...')
    if (inAnsiQuote) {
      if (ch === "'") {
        inAnsiQuote = false;
        currentToken = unescapeAnsiC(currentToken);
      } else {
        currentToken += ch;
      }
      i++;
      continue;
    }

    // 3. Double Quotes ("...")
    if (inDoubleQuote) {
      if (ch === '"') {
        inDoubleQuote = false;
      } else if (ch === "\\" && i + 1 < len) {
        const next = input[i + 1]!;
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          currentToken += next;
          i += 2;
          continue;
        }
        currentToken += "\\" + next;
        i += 2;
        continue;
      } else if (ch === "$" && i + 1 < len && input[i + 1] === "(") {
        let depth = 1;
        let subStart = i + 2;
        let j = subStart;
        while (j < len && depth > 0) {
          if (input[j] === "(") depth++;
          else if (input[j] === ")") depth--;
          j++;
        }
        const subCmd = input.slice(subStart, j - 1);
        assertWorkspaceCommand(subCmd);
        i = j;
        continue;
      } else if (ch === "`") {
        let j = i + 1;
        while (j < len && input[j] !== "`") {
          if (input[j] === "\\" && j + 1 < len) j++;
          j++;
        }
        const subCmd = input.slice(i + 1, j);
        assertWorkspaceCommand(subCmd);
        i = j + 1;
        continue;
      } else {
        currentToken += ch;
      }
      i++;
      continue;
    }

    // 4. Start of Quotes
    if (ch === "$" && i + 1 < len && input[i + 1] === "'") {
      inAnsiQuote = true;
      i += 2;
      continue;
    }
    if (ch === "'") {
      inSingleQuote = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inDoubleQuote = true;
      i++;
      continue;
    }

    // 5. Backslash escape
    if (ch === "\\" && i + 1 < len) {
      const next = input[i + 1]!;
      if (next === "/" || next === "\\" || next === " " || next === "'" || next === '"') {
        currentToken += next;
        i += 2;
        continue;
      }
      currentToken += "\\" + next;
      i += 2;
      continue;
    }

    // 6. Command Substitutions $(...) and <(...) and >(...)
    if (
      (ch === "$" && i + 1 < len && input[i + 1] === "(") ||
      (ch === "<" && i + 1 < len && input[i + 1] === "(") ||
      (ch === ">" && i + 1 < len && input[i + 1] === "(")
    ) {
      const isArithmetic = ch === "$" && i + 2 < len && input[i + 2] === "(";
      if (!isArithmetic) {
        let depth = 1;
        const subStart = i + 2;
        let j = subStart;
        while (j < len && depth > 0) {
          if (input[j] === "(") depth++;
          else if (input[j] === ")") depth--;
          j++;
        }
        const subCmd = input.slice(subStart, j - 1);
        assertWorkspaceCommand(subCmd);
        i = j;
        continue;
      }
    }

    // 7. Backtick substitutions `...`
    if (ch === "`") {
      let j = i + 1;
      while (j < len && input[j] !== "`") {
        if (input[j] === "\\" && j + 1 < len) j++;
        j++;
      }
      const subCmd = input.slice(i + 1, j);
      assertWorkspaceCommand(subCmd);
      i = j + 1;
      continue;
    }

    // 8. Redirection Operators (<, >, >>, 2>, &>, etc.)
    if (ch === "<" || ch === ">") {
      pushToken();
      while (i < len && (input[i] === "<" || input[i] === ">" || input[i] === "&")) {
        i++;
      }
      while (i < len && /\s/.test(input[i]!)) {
        i++;
      }
      let target = "";
      while (i < len && !/[\s;|&<>()]/.test(input[i]!)) {
        target += input[i]!;
        i++;
      }
      if (target.length > 0) {
        current.redirections.push(target);
      }
      continue;
    }

    // 9. Command Separators (;, &&, ||, |, &, \n, (, ))
    if (ch === "|" && i + 1 < len && input[i + 1] === "|") {
      pushCommand(false);
      i += 2;
      continue;
    }
    if (ch === "|") {
      pushCommand(true);
      i++;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "&" || ch === "(" || ch === ")") {
      pushCommand(false);
      i++;
      continue;
    }

    // 10. Whitespace
    if (/\s/.test(ch)) {
      pushToken();
      i++;
      continue;
    }

    // 11. Character
    currentToken += ch;
    i++;
  }

  pushCommand(false);
  return commands;
}

function checkTraversalAndHome(text: string): void {
  if (
    /(?:^|[/\\=:(,;{}[\]\s])\.\.(?:$|[/\\=:(,;{}[\]\s])/.test(text) ||
    text === ".." ||
    text.startsWith("../") ||
    text.endsWith("/..") ||
    text.includes("/../")
  ) {
    throw new WorkspacePathError("Bash commands may not traverse outside the workspace");
  }

  if (
    /(?:^|[\s=:])~(?:[/\\a-zA-Z0-9_.-]|$)/.test(text) ||
    text === "~" ||
    text.startsWith("~/")
  ) {
    throw new WorkspacePathError("Bash commands may not use home-directory expansion");
  }

  // Parameter expansions that escape workspace boundary or perform path indirection
  if (
    /\$(?:\{?(?:HOME|ROOT|TMPDIR|TMP|TEMP|USER|PATH)\b|\{[^}]*(?:HOME|ROOT|TMPDIR|TMP|TEMP|USER|PATH)[^}]*\})/i.test(text)
  ) {
    throw new WorkspacePathError("Bash commands may not use uncontained parameter expansions");
  }

  if (
    /(?:\$[a-zA-Z_][a-zA-Z0-9_]*|\$\{[^}]+\})\s*\/|\/\s*(?:\$[a-zA-Z_][a-zA-Z0-9_]*|\$\{[^}]+\})/.test(text)
  ) {
    throw new WorkspacePathError("Bash commands may not use variable path indirection");
  }
}

function isAbsolutePrefix(text: string): boolean {
  const clean = text.replace(/^\\+(?=\/)/, "");
  return (
    clean.startsWith("/") ||
    clean.startsWith("//") ||
    clean.startsWith("/*") ||
    clean.startsWith("/.") ||
    /^\[\/\]/.test(clean)
  );
}

function isKnownSystemRoot(text: string): boolean {
  const clean = text.replace(/^[\\'"]+/, "").replace(/\/+/g, "/");
  return /^\/(?:etc|tmp|var|usr|home|root|bin|sbin|opt|lib|lib64|sys|proc|dev|mnt|media|boot|srv)(?:\/|$)/.test(clean) ||
    clean === "/" ||
    text.startsWith("//");
}

function isSedOrAwkPattern(text: string): boolean {
  if (isKnownSystemRoot(text)) return false;
  // Sed/tr substitution: s/find/replace/flags, s#find#replace#flags, s|find|replace|flags, y/abc/xyz/
  if (/^[sy]([/#|!@;,])(?:(?!\1).|\\.)*\1(?:(?!\1).|\\.)*\1[a-zA-Z0-9]*$/.test(text)) {
    return true;
  }
  // Delimiter flags: -F/, -F'/', -d/, -d'/
  if (/^-[Fd]['"]?\/['"]?$/.test(text)) {
    return true;
  }
  // Regex pattern flags/addresses: /pattern/, /pattern/d, /start/,/end/p
  if (/^\/(?:\\\/|[^\/\r\n])+\/[gimsuxydv]*[dpI!]*$/.test(text)) {
    return true;
  }
  if (/^\/(?:\\\/|[^\/\r\n])+\/,\/(?:\\\/|[^\/\r\n])+\/[gimsuxydv]*[dpI!]*$/.test(text)) {
    return true;
  }
  return false;
}

function checkAbsoluteLiteral(text: string): void {
  if (isUrl(text)) return;
  if (isSafeDevPath(text)) return;
  if (isArithmeticDivision(text)) return;
  if (isSedOrAwkPattern(text)) return;

  if (isKnownSystemRoot(text) || isAbsolutePrefix(text)) {
    throw new WorkspacePathError("Bash commands may not use absolute paths");
  }

  // Check brace expansion {/a,/b}
  if (text.startsWith("{") && text.endsWith("}")) {
    const inner = text.slice(1, -1);
    const parts = inner.split(",");
    for (const part of parts) {
      const p = part.trim();
      if ((isKnownSystemRoot(p) || isAbsolutePrefix(p)) && !isSafeDevPath(p)) {
        throw new WorkspacePathError("Bash commands may not use absolute paths");
      }
    }
  }
}

/** Check inline interpreter script code for dynamic filesystem/OS access capabilities. */
function validateInlineInterpreterCode(code: string): void {
  // Check for dangerous runtime capabilities/modules
  const dangerousCapabilities =
    /\b(?:fs|promises|fs\/promises|os|sys|path|io|open|file|File|socket|net|http|https|urllib|requests|subprocess|child_process|require|import|__import__|eval|exec|compile|getattr|globals|locals|shutil|tempfile|posix|builtins|process\.env|process\.chdir|process\.mainModule)\b/;

  if (dangerousCapabilities.test(code)) {
    throw new WorkspacePathError(
      "Inline interpreter execution with filesystem or OS capabilities is blocked for workspace containment",
    );
  }

  // Check for system directory references or dynamic path construction
  const systemDirRef =
    /(?:['"`\s,[(]|^)(?:\/|\/\/)?[\\/]*(?:etc|tmp|var|usr|home|root|bin|sbin|opt|lib|sys|proc|dev|passwd|shadow|id_rsa)\b/i;
  if (systemDirRef.test(code)) {
    throw new WorkspacePathError("Bash commands may not use absolute paths");
  }

  if (isKnownSystemRoot(code) || /['"`]\s*\/(?:etc|tmp|var|usr|home|root|bin|sbin|opt|lib|sys|proc|dev)/.test(code)) {
    throw new WorkspacePathError("Bash commands may not use absolute paths");
  }
}

/**
 * Shell-aware command validator for workspace containment.
 */
export function assertWorkspaceCommand(command: string): void {
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new WorkspacePathError("A non-empty bash command is required");
  }

  // Global early checks on full string
  checkTraversalAndHome(command);

  const simpleCommands = parseSimpleCommands(command);

  for (const cmd of simpleCommands) {
    // 1. Validate assignments (e.g. TARGET=/etc/passwd, OUT=/tmp/out)
    for (const assignment of cmd.assignments) {
      checkTraversalAndHome(assignment);
      const eq = assignment.indexOf("=");
      if (eq > 0) {
        const val = assignment.slice(eq + 1).trim();
        checkAbsoluteLiteral(val);
      }
    }

    // 2. Validate redirections (e.g. >/tmp/out, <//etc/passwd, 2>/dev/null)
    for (const redir of cmd.redirections) {
      checkTraversalAndHome(redir);
      if (isSafeDevPath(redir)) continue;
      if (isKnownSystemRoot(redir) || isAbsolutePrefix(redir)) {
        throw new WorkspacePathError("Bash commands may not use absolute paths");
      }
    }

    // 3. Validate words
    if (cmd.words.length === 0) continue;
    const [cmdName, ...cmdArgs] = cmd.words;
    if (!cmdName) continue;

    // Check executable name
    checkTraversalAndHome(cmdName);
    if (isKnownSystemRoot(cmdName) || isAbsolutePrefix(cmdName)) {
      throw new WorkspacePathError("Bash commands may not use absolute paths");
    }

    // Check sourcing commands
    if (cmdName === "source" || cmdName === ".") {
      throw new WorkspacePathError("Sourcing shell scripts is blocked for workspace containment");
    }

    // Check nested shell / eval / exec commands
    if (cmdName === "eval" || cmdName === "exec") {
      const nestedCmd = cmdArgs.join(" ").trim();
      if (nestedCmd.length > 0) {
        assertWorkspaceCommand(nestedCmd);
      }
      continue;
    }

    if (cmdName === "bash" || cmdName === "sh" || cmdName === "dash" || cmdName === "zsh" || cmdName === "ksh") {
      if (cmd.isPipedIn) {
        throw new WorkspacePathError("Piping into shell interpreters is blocked for workspace containment");
      }
      if (cmd.redirections.length > 0) {
        throw new WorkspacePathError("Redirection into shell interpreters is blocked for workspace containment");
      }
      const cIndex = cmdArgs.findIndex((a) => a === "-c" || a === "--command");
      if (cIndex === -1 || cIndex + 1 >= cmdArgs.length) {
        throw new WorkspacePathError("Opaque shell script execution is blocked for workspace containment");
      }
      const script = cmdArgs[cIndex + 1]!;
      assertWorkspaceCommand(script);
      continue;
    }

    // Check inline interpreter commands (python, node, bun, ruby, perl, php)
    if (
      cmdName === "node" ||
      cmdName === "python" ||
      cmdName === "python3" ||
      cmdName === "ruby" ||
      cmdName === "perl" ||
      cmdName === "php" ||
      cmdName === "bun"
    ) {
      const inlineFlagIndex = cmdArgs.findIndex((a) => a === "-e" || a === "-c" || a === "--eval");
      if (inlineFlagIndex !== -1 && inlineFlagIndex + 1 < cmdArgs.length) {
        const inlineCode = cmdArgs[inlineFlagIndex + 1]!;
        validateInlineInterpreterCode(inlineCode);
      }
    }

    // Check arguments
    for (let argIdx = 0; argIdx < cmdArgs.length; argIdx++) {
      const arg = cmdArgs[argIdx]!;
      checkTraversalAndHome(arg);

      if (isUrl(arg)) continue;
      if (isSafeDevPath(arg)) continue;
      if (isArithmeticDivision(arg)) continue;

      // Check any assignment in args (e.g. export TARGET=/etc/hosts, --outdir=/tmp)
      if (arg.includes("=")) {
        const eq = arg.indexOf("=");
        const val = arg.slice(eq + 1).trim();
        checkAbsoluteLiteral(val);
        continue;
      }

      // Handle sed / awk / tr / cut commands
      if (cmdName === "sed" || cmdName === "awk" || cmdName === "tr" || cmdName === "cut") {
        if (isSedOrAwkPattern(arg)) continue;
        if (arg === "/" || arg === "-F/" || arg === "-d/") continue;
        if (cmdName === "awk" && !arg.startsWith("-")) {
          // Awk program script
          if (arg.includes("/etc/") || arg.includes("/tmp/") || arg.includes("/var/") || arg.includes("/root/") || arg.includes("/dev/")) {
            throw new WorkspacePathError("Bash commands may not use absolute paths");
          }
          continue;
        }
        if (arg.includes("/etc/") || arg.includes("/tmp/") || arg.includes("/var/") || arg.includes("/root/")) {
          throw new WorkspacePathError("Bash commands may not use absolute paths");
        }
        if (isKnownSystemRoot(arg) || isAbsolutePrefix(arg)) {
          throw new WorkspacePathError("Bash commands may not use absolute paths");
        }
        continue;
      }

      // Handle grep / rg / ag regex pattern argument followed by target path
      if (cmdName === "grep" || cmdName === "rg" || cmdName === "ag") {
        if (arg.startsWith("-")) {
          continue;
        }
        const isPatternPos = argIdx === cmdArgs.findIndex((a) => !a.startsWith("-"));
        const hasNextFileArg = argIdx < cmdArgs.length - 1;
        if (isPatternPos && hasNextFileArg) {
          continue;
        }
      }

      // Filter/grep options
      if (arg.startsWith("--filter") || arg.startsWith("--grep") || arg.startsWith("-e")) {
        continue;
      }

      // General argument
      checkAbsoluteLiteral(arg);
    }
  }
}
