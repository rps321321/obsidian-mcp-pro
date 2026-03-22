import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  resolveVaultPath,
  listNotes,
  readNote,
  writeNote,
  appendToNote,
  prependToNote,
  deleteNote,
  moveNote,
  searchNotes,
  listCanvasFiles,
  readCanvasFile,
} from "../lib/vault.js";

let vaultDir: string;

beforeEach(async () => {
  vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-test-"));
});

afterEach(async () => {
  await fs.rm(vaultDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// resolveVaultPath
// ---------------------------------------------------------------------------
describe("resolveVaultPath", () => {
  it("should resolve a valid relative path inside the vault", () => {
    const result = resolveVaultPath(vaultDir, "notes/hello.md");
    expect(result).toBe(path.resolve(vaultDir, "notes/hello.md"));
  });

  it("should allow the vault root itself", () => {
    const result = resolveVaultPath(vaultDir, ".");
    expect(result).toBe(path.resolve(vaultDir));
  });

  it("should block ../ traversal", () => {
    expect(() => resolveVaultPath(vaultDir, "../etc/passwd")).toThrow(
      "Path traversal detected",
    );
  });

  it("should block deeply nested ../ traversal", () => {
    expect(() =>
      resolveVaultPath(vaultDir, "a/b/../../../../etc/passwd"),
    ).toThrow("Path traversal detected");
  });

  it("should block null bytes", () => {
    expect(() => resolveVaultPath(vaultDir, "notes/\0evil.md")).toThrow(
      "Invalid path: contains null byte",
    );
  });

  it("should block sibling directory prefix attack", () => {
    // If vault is /tmp/vault, a path resolving to /tmp/vault-evil should fail
    const siblingDir = vaultDir + "-evil";
    const relativePath = path.relative(vaultDir, siblingDir);
    expect(() => resolveVaultPath(vaultDir, relativePath)).toThrow(
      "Path traversal detected",
    );
  });
});

// ---------------------------------------------------------------------------
// listNotes
// ---------------------------------------------------------------------------
describe("listNotes", () => {
  it("should return .md files", async () => {
    await fs.writeFile(path.join(vaultDir, "note1.md"), "# Note 1");
    await fs.writeFile(path.join(vaultDir, "note2.md"), "# Note 2");
    await fs.writeFile(path.join(vaultDir, "image.png"), "binary");

    const notes = await listNotes(vaultDir);
    expect(notes).toEqual(["note1.md", "note2.md"]);
  });

  it("should return nested .md files with forward-slash paths", async () => {
    await fs.mkdir(path.join(vaultDir, "sub"), { recursive: true });
    await fs.writeFile(path.join(vaultDir, "sub", "deep.md"), "content");

    const notes = await listNotes(vaultDir);
    expect(notes).toEqual(["sub/deep.md"]);
  });

  it("should exclude .obsidian/, .trash/, .git/ directories", async () => {
    for (const dir of [".obsidian", ".trash", ".git"]) {
      await fs.mkdir(path.join(vaultDir, dir), { recursive: true });
      await fs.writeFile(path.join(vaultDir, dir, "hidden.md"), "x");
    }
    await fs.writeFile(path.join(vaultDir, "visible.md"), "x");

    const notes = await listNotes(vaultDir);
    expect(notes).toEqual(["visible.md"]);
  });

  it("should return empty array for empty vault", async () => {
    const notes = await listNotes(vaultDir);
    expect(notes).toEqual([]);
  });

  it("should return empty array for non-existent folder", async () => {
    const notes = await listNotes(vaultDir, "does-not-exist");
    expect(notes).toEqual([]);
  });

  it("should filter by subfolder when folder is provided", async () => {
    await fs.mkdir(path.join(vaultDir, "journal"), { recursive: true });
    await fs.mkdir(path.join(vaultDir, "projects"), { recursive: true });
    await fs.writeFile(path.join(vaultDir, "journal", "day1.md"), "x");
    await fs.writeFile(path.join(vaultDir, "projects", "proj.md"), "x");

    const notes = await listNotes(vaultDir, "journal");
    expect(notes).toEqual(["journal/day1.md"]);
  });
});

// ---------------------------------------------------------------------------
// readNote
// ---------------------------------------------------------------------------
describe("readNote", () => {
  it("should read content correctly as UTF-8", async () => {
    const content = "# Hello\n\nUnicode: \u00e4\u00f6\u00fc\u00df \ud83d\ude80";
    await fs.writeFile(path.join(vaultDir, "test.md"), content, "utf-8");

    const result = await readNote(vaultDir, "test.md");
    expect(result).toBe(content);
  });

  it("should throw on missing file", async () => {
    await expect(readNote(vaultDir, "nonexistent.md")).rejects.toThrow(
      "Note not found: nonexistent.md",
    );
  });
});

// ---------------------------------------------------------------------------
// writeNote
// ---------------------------------------------------------------------------
describe("writeNote", () => {
  it("should create file with content", async () => {
    await writeNote(vaultDir, "new.md", "# New Note");
    const content = await fs.readFile(path.join(vaultDir, "new.md"), "utf-8");
    expect(content).toBe("# New Note");
  });

  it("should create parent directories automatically", async () => {
    await writeNote(vaultDir, "a/b/c/deep.md", "deep content");
    const content = await fs.readFile(
      path.join(vaultDir, "a", "b", "c", "deep.md"),
      "utf-8",
    );
    expect(content).toBe("deep content");
  });

  it("should write UTF-8 content", async () => {
    const unicode = "\u6d4b\u8bd5 \u30c6\u30b9\u30c8 \ud83d\udd25";
    await writeNote(vaultDir, "unicode.md", unicode);
    const content = await fs.readFile(
      path.join(vaultDir, "unicode.md"),
      "utf-8",
    );
    expect(content).toBe(unicode);
  });

  it("should overwrite existing file", async () => {
    await writeNote(vaultDir, "overwrite.md", "old");
    await writeNote(vaultDir, "overwrite.md", "new");
    const content = await fs.readFile(
      path.join(vaultDir, "overwrite.md"),
      "utf-8",
    );
    expect(content).toBe("new");
  });
});

// ---------------------------------------------------------------------------
// appendToNote
// ---------------------------------------------------------------------------
describe("appendToNote", () => {
  it("should append content with newline separator when file lacks trailing newline", async () => {
    await writeNote(vaultDir, "append.md", "line1");
    await appendToNote(vaultDir, "append.md", "line2");

    const content = await readNote(vaultDir, "append.md");
    expect(content).toBe("line1\nline2");
  });

  it("should append content without extra newline when file ends with newline", async () => {
    await writeNote(vaultDir, "append2.md", "line1\n");
    await appendToNote(vaultDir, "append2.md", "line2");

    const content = await readNote(vaultDir, "append2.md");
    expect(content).toBe("line1\nline2");
  });

  it("should throw when file does not exist", async () => {
    await expect(
      appendToNote(vaultDir, "missing.md", "content"),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// prependToNote
// ---------------------------------------------------------------------------
describe("prependToNote", () => {
  it("should prepend at start when no frontmatter exists", async () => {
    await writeNote(vaultDir, "prepend.md", "existing content");
    await prependToNote(vaultDir, "prepend.md", "prepended");

    const content = await readNote(vaultDir, "prepend.md");
    expect(content).toBe("prepended\nexisting content");
  });

  it("should prepend after frontmatter block", async () => {
    const original = "---\ntitle: Test\n---\nbody text";
    await writeNote(vaultDir, "fm.md", original);
    await prependToNote(vaultDir, "fm.md", "inserted");

    const content = await readNote(vaultDir, "fm.md");
    expect(content).toBe("---\ntitle: Test\n---\ninserted\nbody text");
  });

  it("should prepend after frontmatter that ends with trailing newline", async () => {
    const original = "---\ntitle: Test\n---\n\nbody text";
    await writeNote(vaultDir, "fm2.md", original);
    await prependToNote(vaultDir, "fm2.md", "inserted");

    const content = await readNote(vaultDir, "fm2.md");
    expect(content).toBe("---\ntitle: Test\n---\ninserted\n\nbody text");
  });

  it("should throw when file does not exist", async () => {
    await expect(
      prependToNote(vaultDir, "missing.md", "content"),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// deleteNote
// ---------------------------------------------------------------------------
describe("deleteNote", () => {
  it("should move file to .trash by default", async () => {
    await writeNote(vaultDir, "doomed.md", "bye");
    await deleteNote(vaultDir, "doomed.md");

    // Original should be gone
    await expect(fs.access(path.join(vaultDir, "doomed.md"))).rejects.toThrow();
    // Should exist in .trash
    const trashContent = await fs.readFile(
      path.join(vaultDir, ".trash", "doomed.md"),
      "utf-8",
    );
    expect(trashContent).toBe("bye");
  });

  it("should permanently delete when useTrash=false", async () => {
    await writeNote(vaultDir, "perm.md", "gone");
    await deleteNote(vaultDir, "perm.md", false);

    await expect(fs.access(path.join(vaultDir, "perm.md"))).rejects.toThrow();
    // .trash should not have it either
    await expect(
      fs.access(path.join(vaultDir, ".trash", "perm.md")),
    ).rejects.toThrow();
  });

  it("should preserve directory structure in .trash", async () => {
    await writeNote(vaultDir, "sub/nested.md", "nested");
    await deleteNote(vaultDir, "sub/nested.md");

    const trashContent = await fs.readFile(
      path.join(vaultDir, ".trash", "sub", "nested.md"),
      "utf-8",
    );
    expect(trashContent).toBe("nested");
  });
});

// ---------------------------------------------------------------------------
// moveNote
// ---------------------------------------------------------------------------
describe("moveNote", () => {
  it("should move file to new location", async () => {
    await writeNote(vaultDir, "old.md", "moving");
    await moveNote(vaultDir, "old.md", "new.md");

    await expect(fs.access(path.join(vaultDir, "old.md"))).rejects.toThrow();
    const content = await readNote(vaultDir, "new.md");
    expect(content).toBe("moving");
  });

  it("should create target directories automatically", async () => {
    await writeNote(vaultDir, "src.md", "data");
    await moveNote(vaultDir, "src.md", "deep/nested/dest.md");

    const content = await readNote(vaultDir, "deep/nested/dest.md");
    expect(content).toBe("data");
  });

  it("should throw if destination already exists", async () => {
    await writeNote(vaultDir, "a.md", "content a");
    await writeNote(vaultDir, "b.md", "content b");

    await expect(moveNote(vaultDir, "a.md", "b.md")).rejects.toThrow(
      "Destination already exists: b.md",
    );
  });
});

// ---------------------------------------------------------------------------
// searchNotes
// ---------------------------------------------------------------------------
describe("searchNotes", () => {
  beforeEach(async () => {
    await writeNote(
      vaultDir,
      "alpha.md",
      "Hello world\nThis is a test\nhello again",
    );
    await writeNote(
      vaultDir,
      "beta.md",
      "Nothing here\nJust some text",
    );
    await writeNote(
      vaultDir,
      "gamma.md",
      "HELLO uppercase\nhello lowercase",
    );
  });

  it("should find matches across files (case-insensitive by default)", async () => {
    const results = await searchNotes(vaultDir, "hello");
    expect(results.length).toBe(2); // alpha.md and gamma.md

    const paths = results.map((r) => r.relativePath).sort();
    expect(paths).toContain("alpha.md");
    expect(paths).toContain("gamma.md");
  });

  it("should respect caseSensitive option", async () => {
    const results = await searchNotes(vaultDir, "HELLO", {
      caseSensitive: true,
    });
    expect(results.length).toBe(1);
    expect(results[0].relativePath).toBe("gamma.md");
    expect(results[0].matches.length).toBe(1);
  });

  it("should respect maxResults option", async () => {
    const results = await searchNotes(vaultDir, "hello", { maxResults: 1 });
    expect(results.length).toBe(1);
  });

  it("should return correct line numbers (1-indexed)", async () => {
    const results = await searchNotes(vaultDir, "test");
    expect(results.length).toBe(1);
    expect(results[0].relativePath).toBe("alpha.md");
    expect(results[0].matches[0].line).toBe(2);
  });

  it("should return correct column positions", async () => {
    const results = await searchNotes(vaultDir, "world");
    const match = results[0].matches[0];
    expect(match.column).toBe(6); // "Hello world" -> index 6
  });

  it("should find multiple matches on the same line", async () => {
    await writeNote(vaultDir, "repeat.md", "foo bar foo baz foo");
    const results = await searchNotes(vaultDir, "foo");
    const repeatResult = results.find((r) => r.relativePath === "repeat.md");
    expect(repeatResult).toBeDefined();
    expect(repeatResult!.matches.length).toBe(3);
  });

  it("should return empty array when nothing matches", async () => {
    const results = await searchNotes(vaultDir, "zzz_nonexistent_zzz");
    expect(results).toEqual([]);
  });

  it("should filter by folder when provided", async () => {
    await fs.mkdir(path.join(vaultDir, "sub"), { recursive: true });
    await writeNote(vaultDir, "sub/found.md", "hello from sub");

    const results = await searchNotes(vaultDir, "hello", { folder: "sub" });
    expect(results.length).toBe(1);
    expect(results[0].relativePath).toBe("sub/found.md");
  });
});

// ---------------------------------------------------------------------------
// listCanvasFiles
// ---------------------------------------------------------------------------
describe("listCanvasFiles", () => {
  it("should return .canvas files", async () => {
    await fs.writeFile(path.join(vaultDir, "board.canvas"), "{}");
    await fs.writeFile(path.join(vaultDir, "note.md"), "x");

    const files = await listCanvasFiles(vaultDir);
    expect(files).toEqual(["board.canvas"]);
  });

  it("should exclude .obsidian/ canvas files", async () => {
    await fs.mkdir(path.join(vaultDir, ".obsidian"), { recursive: true });
    await fs.writeFile(
      path.join(vaultDir, ".obsidian", "workspace.canvas"),
      "{}",
    );
    await fs.writeFile(path.join(vaultDir, "user.canvas"), "{}");

    const files = await listCanvasFiles(vaultDir);
    expect(files).toEqual(["user.canvas"]);
  });

  it("should return empty array for vault with no canvas files", async () => {
    const files = await listCanvasFiles(vaultDir);
    expect(files).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// readCanvasFile
// ---------------------------------------------------------------------------
describe("readCanvasFile", () => {
  it("should parse valid canvas JSON with nodes and edges", async () => {
    const canvasData = {
      nodes: [
        { id: "1", type: "text", x: 0, y: 0, width: 100, height: 100, text: "Hello" },
      ],
      edges: [
        { id: "e1", fromNode: "1", toNode: "2" },
      ],
    };
    await fs.writeFile(
      path.join(vaultDir, "test.canvas"),
      JSON.stringify(canvasData),
    );

    const result = await readCanvasFile(vaultDir, "test.canvas");
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].id).toBe("1");
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].fromNode).toBe("1");
  });

  it("should return empty nodes/edges for JSON without nodes array", async () => {
    await fs.writeFile(
      path.join(vaultDir, "empty.canvas"),
      JSON.stringify({ something: "else" }),
    );

    const result = await readCanvasFile(vaultDir, "empty.canvas");
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it("should handle missing edges array gracefully", async () => {
    const data = {
      nodes: [
        { id: "1", type: "text", x: 0, y: 0, width: 50, height: 50 },
      ],
    };
    await fs.writeFile(
      path.join(vaultDir, "no-edges.canvas"),
      JSON.stringify(data),
    );

    const result = await readCanvasFile(vaultDir, "no-edges.canvas");
    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toEqual([]);
  });

  it("should throw on malformed JSON", async () => {
    await fs.writeFile(
      path.join(vaultDir, "bad.canvas"),
      "not valid json {{{",
    );

    await expect(readCanvasFile(vaultDir, "bad.canvas")).rejects.toThrow(
      "Invalid canvas file (malformed JSON): bad.canvas",
    );
  });

  it("should throw on missing file", async () => {
    await expect(
      readCanvasFile(vaultDir, "nonexistent.canvas"),
    ).rejects.toThrow();
  });
});
