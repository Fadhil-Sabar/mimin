import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractAtReference,
  scanWorkspaceFiles,
  scoreFileMatch,
  buildFileCompletionValue,
  suggestWorkspaceFiles,
  applyAtReferenceCompletion,
  clearWorkspaceFileCache,
} from "../src/tui/file-suggestions.js";

describe("@ workspace file suggestions", () => {
  let testDir: string;
  let outsideDir: string;

  beforeEach(async () => {
    clearWorkspaceFileCache();
    testDir = join(
      tmpdir(),
      `mimin-file-sugg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    outsideDir = join(
      tmpdir(),
      `mimin-outside-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });

    // Create outside secrets
    await writeFile(join(outsideDir, "secret_id_rsa"), "SECRET_KEY_DATA");
    await mkdir(join(outsideDir, "outside_folder"), { recursive: true });
    await writeFile(join(outsideDir, "outside_folder/confidential.txt"), "CONFIDENTIAL");

    // Create test directory structure inside workspace
    await mkdir(join(testDir, "src/tools"), { recursive: true });
    await mkdir(join(testDir, "src/agent"), { recursive: true });
    await mkdir(join(testDir, "docs/specs with spaces"), { recursive: true });
    await mkdir(join(testDir, "docs/unicode_日本語_café"), { recursive: true });
    await mkdir(join(testDir, ".git/objects"), { recursive: true });
    await mkdir(join(testDir, "node_modules/pkg"), { recursive: true });
    await mkdir(join(testDir, "dist"), { recursive: true });

    await writeFile(join(testDir, "README.md"), "# Test Project");
    await writeFile(join(testDir, "package.json"), "{}");
    await writeFile(join(testDir, ".env.example"), "KEY=VAL");
    await writeFile(join(testDir, "src/index.ts"), "export {}");
    await writeFile(join(testDir, "src/tools/path.ts"), "export {}");
    await writeFile(join(testDir, "src/tools/read.ts"), "export {}");
    await writeFile(join(testDir, "src/agent/manager.ts"), "export {}");
    await writeFile(
      join(testDir, "docs/specs with spaces/req 1.md"),
      "specification",
    );
    await writeFile(
      join(testDir, "docs/unicode_日本語_café/файл.md"),
      "unicode content",
    );
    await writeFile(join(testDir, ".git/config"), "secret git config");
    await writeFile(join(testDir, "node_modules/pkg/index.js"), "external");
    await writeFile(join(testDir, "dist/bundle.js"), "bundled");

    // Create single and double quoted files
    await writeFile(join(testDir, "src/don't_break.ts"), "export {}");
    await writeFile(join(testDir, 'src/quote"double.ts'), "export {}");

    // Create symlinks:
    // 1. External file symlink (MUST be rejected)
    await symlink(join(outsideDir, "secret_id_rsa"), join(testDir, "symlink_to_outside_secret.txt"));
    // 2. External directory symlink (MUST be rejected)
    await symlink(join(outsideDir, "outside_folder"), join(testDir, "symlink_to_outside_dir"));
    // 3. Internal file symlink (Allowed)
    await symlink(join(testDir, "README.md"), join(testDir, "src/README_link.md"));
    // 4. Internal directory symlink (Allowed for drilldown, but not recursively traversed)
    await symlink(join(testDir, "src/tools"), join(testDir, "src/tools_symlink"));
  });

  afterEach(async () => {
    clearWorkspaceFileCache();
    await rm(testDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  describe("extractAtReference", () => {
    test("detects @ at beginning of line", () => {
      const match = extractAtReference("@");
      expect(match).not.toBeNull();
      expect(match!.rawPrefix).toBe("@");
      expect(match!.query).toBe("");
      expect(match!.isQuoted).toBe(false);
      expect(match!.startCol).toBe(0);
    });

    test("detects @ with query at beginning of line", () => {
      const match = extractAtReference("@src/to");
      expect(match).not.toBeNull();
      expect(match!.rawPrefix).toBe("@src/to");
      expect(match!.query).toBe("src/to");
      expect(match!.isQuoted).toBe(false);
      expect(match!.startCol).toBe(0);
    });

    test("detects @ preceded by whitespace and delimiters", () => {
      expect(extractAtReference("check @")?.query).toBe("");
      expect(extractAtReference("check @src/path")?.query).toBe("src/path");
      expect(extractAtReference("diff(@file1")?.query).toBe("file1");
      expect(extractAtReference("look at [@src")?.query).toBe("src");
      expect(extractAtReference("file=@tools")?.query).toBe("tools");
      expect(extractAtReference("files: @tools")?.query).toBe("tools");
    });

    test("handles multiple @ references on a single line and picks the active one at cursor", () => {
      const text = "compare @src/index.ts with @src/tools/p";
      const match = extractAtReference(text);
      expect(match).not.toBeNull();
      expect(match!.rawPrefix).toBe("@src/tools/p");
      expect(match!.query).toBe("src/tools/p");
      expect(match!.startCol).toBe(27);
    });

    test("detects double-quoted @ references with spaces", () => {
      const match = extractAtReference('read @"docs/specs with spaces/req');
      expect(match).not.toBeNull();
      expect(match!.rawPrefix).toBe('@"docs/specs with spaces/req');
      expect(match!.query).toBe("docs/specs with spaces/req");
      expect(match!.isQuoted).toBe(true);
      expect(match!.quoteChar).toBe('"');
      expect(match!.startCol).toBe(5);
    });

    test("detects single-quoted @ references", () => {
      const match = extractAtReference("read @'docs/specs with spaces/req");
      expect(match).not.toBeNull();
      expect(match!.rawPrefix).toBe("@'docs/specs with spaces/req");
      expect(match!.query).toBe("docs/specs with spaces/req");
      expect(match!.isQuoted).toBe(true);
      expect(match!.quoteChar).toBe("'");
      expect(match!.startCol).toBe(5);
    });

    test("ignores email addresses and non-token-boundary @", () => {
      expect(extractAtReference("user@example.com")).toBeNull();
      expect(extractAtReference("foo@bar")).toBeNull();
      expect(extractAtReference("abc@123")).toBeNull();
    });

    test("ignores closed references followed by normal text", () => {
      expect(extractAtReference('read @"src/index.ts" and do something')).toBeNull();
      expect(extractAtReference("read @src/index.ts and do something")).toBeNull();
    });
  });

  describe("scanWorkspaceFiles and symlink / realpath containment", () => {
    test("scans workspace files while ignoring .git, node_modules, and dist", async () => {
      const files = await scanWorkspaceFiles(testDir);
      expect(files).toContain("README.md");
      expect(files).toContain("package.json");
      expect(files).toContain(".env.example");
      expect(files).toContain("src/index.ts");
      expect(files).toContain("src/tools/path.ts");
      expect(files).toContain("src/tools/");
      expect(files).toContain("docs/specs with spaces/req 1.md");
      expect(files).toContain("docs/unicode_日本語_café/файл.md");

      // Ignored dirs must not appear
      expect(files.some((f) => f.startsWith(".git"))).toBe(false);
      expect(files.some((f) => f.startsWith("node_modules"))).toBe(false);
      expect(files.some((f) => f.startsWith("dist"))).toBe(false);
    });

    test("strictly rejects symlinks targeting files outside workspace root", async () => {
      const files = await scanWorkspaceFiles(testDir);
      // Symlinks to outside targets must be rejected
      expect(files).not.toContain("symlink_to_outside_secret.txt");
      expect(files.some((f) => f.includes("secret_id_rsa"))).toBe(false);
    });

    test("strictly rejects symlinks targeting directories outside workspace root", async () => {
      const files = await scanWorkspaceFiles(testDir);
      // External directory symlink and its children must not appear
      expect(files).not.toContain("symlink_to_outside_dir/");
      expect(files.some((f) => f.includes("outside_folder"))).toBe(false);
      expect(files.some((f) => f.includes("confidential.txt"))).toBe(false);
    });

    test("allows safe internal file and directory symlinks", async () => {
      const files = await scanWorkspaceFiles(testDir);
      expect(files).toContain("src/README_link.md");
      expect(files).toContain("src/tools_symlink/");
    });

    test("handles workspace root itself being a symlink", async () => {
      const symlinkedWorkspace = join(tmpdir(), `mimin-ws-symlink-${Date.now()}`);
      await symlink(testDir, symlinkedWorkspace);
      try {
        const files = await scanWorkspaceFiles(symlinkedWorkspace);
        expect(files).toContain("README.md");
        expect(files).toContain("src/index.ts");
        expect(files).not.toContain("symlink_to_outside_secret.txt");
      } finally {
        await rm(symlinkedWorkspace, { force: true });
      }
    });

    test("handles cyclic directory symlinks safely without recursion explosion", async () => {
      const cycleDir = join(testDir, "src/tools/cycle");
      await symlink(testDir, cycleDir);
      const files = await scanWorkspaceFiles(testDir);
      expect(files.length).toBeGreaterThan(0);
      expect(files.filter((f) => f.includes("path.ts")).length).toBe(1);
    });
  });

  describe("quotes, control characters, and Unicode safety", () => {
    test("selects double quotes for paths containing single quotes", () => {
      const val = buildFileCompletionValue("src/don't_break.ts", false);
      expect(val).toBe('@"src/don\'t_break.ts"');
    });

    test("selects single quotes for paths containing double quotes", () => {
      const val = buildFileCompletionValue('src/quote"double.ts', false);
      expect(val).toBe("@'src/quote\"double.ts'");
    });

    test("escapes double quotes when path contains both single and double quotes", () => {
      const val = buildFileCompletionValue('src/both\'single"and"double.ts', false);
      expect(val).toBe('@"src/both\'single\\"and\\"double.ts"');
    });

    test("rejects and returns null for paths with control characters or newlines", () => {
      expect(buildFileCompletionValue("src/file\nwith\nnewlines.txt", false)).toBeNull();
      expect(buildFileCompletionValue("src/file\twith\ttabs.txt", false)).toBeNull();
      expect(buildFileCompletionValue("src/file\x00null.txt", false)).toBeNull();
      expect(buildFileCompletionValue("src/file\x1bescape.txt", false)).toBeNull();
    });

    test("supports Unicode paths with Asian characters, accents, and Cyrillic", async () => {
      const suggestions = await suggestWorkspaceFiles(testDir, "файл");
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0]!.value).toBe("@docs/unicode_日本語_café/файл.md");
      expect(suggestions[0]!.label).toBe("файл.md");
    });
  });

  describe("cache correctness across scan options", () => {
    test("does not collide cache across different ignoredDirs or limits", async () => {
      // 1. Scan with default ignore list (dist ignored)
      const defaultFiles = await scanWorkspaceFiles(testDir);
      expect(defaultFiles.some((f) => f.startsWith("dist"))).toBe(false);

      // 2. Scan with empty ignore list (dist included)
      const allFiles = await scanWorkspaceFiles(testDir, { ignoredDirs: new Set() });
      expect(allFiles.some((f) => f.startsWith("dist"))).toBe(true);

      // 3. Scan with maxFiles limit
      const limitedFiles = await scanWorkspaceFiles(testDir, { maxFiles: 2 });
      expect(limitedFiles.length).toBeLessThanOrEqual(2);
    });
  });

  describe("scoreFileMatch and suggestions", () => {
    test("ranks exact match higher than partial and contains matches", () => {
      expect(scoreFileMatch("src/tools/path.ts", "path.ts", false)).toBeGreaterThan(
        scoreFileMatch("src/tools/path.ts", "pa", false),
      );
      expect(scoreFileMatch("src/tools/path.ts", "path.ts", false)).toBe(100);
      expect(scoreFileMatch("src/tools/path.ts", "tools", false)).toBe(50);
    });

    test("suggestWorkspaceFiles returns sorted autocomplete items", async () => {
      const suggestions = await suggestWorkspaceFiles(testDir, "path");
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0]!.value).toBe("@src/tools/path.ts");
      expect(suggestions[0]!.label).toBe("path.ts");
      expect(suggestions[0]!.description).toBe("src/tools/path.ts");
    });

    test("buildFileCompletionValue automatically quotes paths containing spaces", () => {
      expect(
        buildFileCompletionValue("docs/specs with spaces/req 1.md", false),
      ).toBe('@"docs/specs with spaces/req 1.md"');
      expect(buildFileCompletionValue("src/index.ts", false)).toBe("@src/index.ts");
      expect(buildFileCompletionValue("src/index.ts", true, "'")).toBe("@'src/index.ts'");
    });

    test("suggestWorkspaceFiles handles query with spaces and quotes", async () => {
      const suggestions = await suggestWorkspaceFiles(testDir, "specs with spaces", {
        isQuoted: true,
      });
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions.some((s) => s.value.includes("req 1.md"))).toBe(true);
    });
  });

  describe("applyAtReferenceCompletion", () => {
    test("completes unquoted file reference and appends trailing space", () => {
      const lines = ["check @src/to"];
      const res = applyAtReferenceCompletion(
        lines,
        0,
        13, // cursor at end of "@src/to"
        { value: "@src/tools/path.ts", label: "path.ts" },
        "@src/to",
      );
      expect(res.lines[0]).toBe("check @src/tools/path.ts ");
      expect(res.cursorCol).toBe("check @src/tools/path.ts ".length);
    });

    test("completes directory reference without trailing space to allow drill-down", () => {
      const lines = ["look in @src"];
      const res = applyAtReferenceCompletion(
        lines,
        0,
        12,
        { value: "@src/tools/", label: "tools/" },
        "@src",
      );
      expect(res.lines[0]).toBe("look in @src/tools/");
      expect(res.cursorCol).toBe("look in @src/tools/".length);
    });

    test("completes quoted file reference with spaces", () => {
      const lines = ['read @"docs/spe'];
      const res = applyAtReferenceCompletion(
        lines,
        0,
        15,
        {
          value: '@"docs/specs with spaces/req 1.md"',
          label: "req 1.md",
        },
        '@"docs/spe',
      );
      expect(res.lines[0]).toBe('read @"docs/specs with spaces/req 1.md" ');
      expect(res.cursorCol).toBe('read @"docs/specs with spaces/req 1.md" '.length);
    });

    test("handles multiple @ references and preserves text before and after", () => {
      const lines = ["compare @src/index.ts with @src/to and report"];
      const cursorCol = "compare @src/index.ts with @src/to".length;
      const res = applyAtReferenceCompletion(
        lines,
        0,
        cursorCol,
        { value: "@src/tools/path.ts", label: "path.ts" },
        "@src/to",
      );
      expect(res.lines[0]).toBe("compare @src/index.ts with @src/tools/path.ts and report");
      expect(res.cursorCol).toBe("compare @src/index.ts with @src/tools/path.ts ".length);
    });
  });
});
