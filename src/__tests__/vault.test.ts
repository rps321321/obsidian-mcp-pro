import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  resolveVaultPath,
  listNotes,
  readNote,
  readNoteLineRange,
  writeNote,
  updateNote,
  appendToNote,
  prependToNote,
  deleteNote,
  moveNote,
  searchInContents,
  searchNotes,
  listCanvasFiles,
  readCanvasFile,
  MAX_CANVAS_FILE_BYTES,
  setMaxNoteFileBytesForTests,
  setMaxNoteLineRangeBytesForTests,
  getNoteStats,
  getVaultRootRealPath,
} from "../lib/vault.js";
import { setPermissions } from "../lib/permissions.js";

let vaultDir: string;
const itWin32 = process.platform === "win32" ? it : it.skip;
const SYMLINKS_SUPPORTED = process.platform !== "win32" || process.env.CI_SYMLINKS === "1";

beforeEach(async () => {
  vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-test-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  setMaxNoteFileBytesForTests(null);
  setMaxNoteLineRangeBytesForTests(null);
  setPermissions({ readPaths: null, writePaths: null });
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

  itWin32("should block alternate data stream syntax", () => {
    expect(() => resolveVaultPath(vaultDir, "note.md:hidden.png")).toThrow(
      /alternate data stream/i,
    );
    expect(() => resolveVaultPath(vaultDir, "folder/note.md:hidden.txt")).toThrow(
      /alternate data stream/i,
    );
  });

  itWin32("should block trailing dot and space aliases", () => {
    expect(() => resolveVaultPath(vaultDir, "notes/secret.md.")).toThrow(
      /space or period/i,
    );
    expect(() => resolveVaultPath(vaultDir, "notes/secret.md ")).toThrow(
      /space or period/i,
    );
    expect(() => resolveVaultPath(vaultDir, ".obsidian./config.json")).toThrow(
      /space or period/i,
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

  it.skipIf(!SYMLINKS_SUPPORTED)("should skip symlinked notes in broad listings", async () => {
    await fs.writeFile(path.join(vaultDir, "target.md"), "x");
    await fs.symlink(path.join(vaultDir, "target.md"), path.join(vaultDir, "linked.md"));

    const notes = await listNotes(vaultDir);
    expect(notes).toEqual(["target.md"]);
  });

  it("should return empty array for empty vault", async () => {
    const notes = await listNotes(vaultDir);
    expect(notes).toEqual([]);
  });

  it("should throw for non-existent folder", async () => {
    await expect(listNotes(vaultDir, "does-not-exist")).rejects.toThrow();
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
// getNoteStats
// ---------------------------------------------------------------------------
describe("getNoteStats", () => {
  it.skipIf(!SYMLINKS_SUPPORTED)("rejects symlink escapes with a reused vault root", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-stats-outside-"));
    try {
      await fs.writeFile(path.join(outsideDir, "secret.md"), "outside");
      await fs.symlink(path.join(outsideDir, "secret.md"), path.join(vaultDir, "linked.md"));

      const realVaultRoot = await getVaultRootRealPath(vaultDir);
      await expect(
        getNoteStats(vaultDir, "linked.md", { realVaultRoot }),
      ).rejects.toThrow("Path traversal via symlink detected");
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
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

  it("should reject non-markdown vault files", async () => {
    await fs.writeFile(path.join(vaultDir, "secret.txt"), "not note content", "utf-8");

    await expect(readNote(vaultDir, "secret.txt")).rejects.toThrow(
      "Not a markdown note: secret.txt",
    );
    await expect(readNoteLineRange(vaultDir, "secret.txt", 1, 1)).rejects.toThrow(
      "Not a markdown note: secret.txt",
    );
  });

  it("rejects oversized full-note reads before materializing content", async () => {
    setMaxNoteFileBytesForTests(10);
    await fs.writeFile(path.join(vaultDir, "oversized.md"), "x".repeat(11), "utf-8");

    await expect(readNote(vaultDir, "oversized.md")).rejects.toThrow(
      /Note file exceeds size cap \(11 > 10 bytes\): oversized\.md/,
    );
  });

  it("rejects markdown directories before reading note content", async () => {
    await fs.mkdir(path.join(vaultDir, "directory.md"));

    await expect(readNote(vaultDir, "directory.md")).rejects.toThrow(
      "Not a regular file: directory.md",
    );
    await expect(readNoteLineRange(vaultDir, "directory.md", 1, 1)).rejects.toThrow(
      "Not a regular file: directory.md",
    );
  });

  it("still streams line fragments from notes over the full-read cap", async () => {
    setMaxNoteFileBytesForTests(10);
    await fs.writeFile(
      path.join(vaultDir, "long.md"),
      ["first", "second", "third"].join("\n"),
      "utf-8",
    );

    await expect(readNoteLineRange(vaultDir, "long.md", 2, 2)).resolves.toEqual({
      text: "second",
    });
  });

  it("rejects a line fragment that exceeds the line-range byte cap", async () => {
    setMaxNoteLineRangeBytesForTests(10);
    await fs.writeFile(path.join(vaultDir, "oversized-line.md"), "x".repeat(11), "utf-8");

    await expect(readNoteLineRange(vaultDir, "oversized-line.md", 1, 1)).rejects.toThrow(
      /Note line fragment exceeds size cap \(11 > 10 bytes\): oversized-line\.md/,
    );
  });

  it("rejects line range scans that exceed the line-range byte cap", async () => {
    setMaxNoteLineRangeBytesForTests(12);
    await fs.writeFile(path.join(vaultDir, "many-lines.md"), "one\ntwo\nthree\nfour", "utf-8");

    await expect(readNoteLineRange(vaultDir, "many-lines.md", 99, 99)).rejects.toThrow(
      /Note line fragment exceeds size cap \(13 > 12 bytes\): many-lines\.md/,
    );
  });

  it.skipIf(!SYMLINKS_SUPPORTED)("rejects a symlink retargeted between validation and open", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-race-outside-"));
    try {
      const insideTarget = path.join(vaultDir, "inside.md");
      const outsideTarget = path.join(outsideDir, "secret.md");
      const linkPath = path.join(vaultDir, "race.md");
      await fs.writeFile(insideTarget, "inside\n", "utf-8");
      await fs.writeFile(outsideTarget, "outside\n", "utf-8");
      await fs.symlink(insideTarget, linkPath);

      const realOpen = fs.open.bind(fs);
      let swapped = false;
      vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const [file] = args;
        if (!swapped && path.resolve(String(file)) === linkPath) {
          swapped = true;
          await fs.unlink(linkPath);
          await fs.symlink(outsideTarget, linkPath);
        }
        return realOpen(...args);
      });

      await expect(readNoteLineRange(vaultDir, "race.md", 1, 1)).rejects.toThrow(/symlink|changed/i);
      await expect(fs.readFile(outsideTarget, "utf-8")).resolves.toBe("outside\n");
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
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

  it("rejects writes that would exceed the note file cap", async () => {
    setMaxNoteFileBytesForTests(10);

    await expect(writeNote(vaultDir, "too-big.md", "x".repeat(11))).rejects.toThrow(
      /Note file exceeds size cap/,
    );
    await expect(fs.access(path.join(vaultDir, "too-big.md"))).rejects.toThrow();
  });

  it("should reject non-markdown write targets", async () => {
    await fs.writeFile(path.join(vaultDir, "asset.txt"), "original", "utf-8");

    await expect(writeNote(vaultDir, "asset.txt", "new")).rejects.toThrow(
      "Not a markdown note: asset.txt",
    );
    await expect(updateNote(vaultDir, "asset.txt", () => "new")).rejects.toThrow(
      "Not a markdown note: asset.txt",
    );
    await expect(appendToNote(vaultDir, "asset.txt", "new")).rejects.toThrow(
      "Not a markdown note: asset.txt",
    );
    await expect(prependToNote(vaultDir, "asset.txt", "new")).rejects.toThrow(
      "Not a markdown note: asset.txt",
    );
    await expect(deleteNote(vaultDir, "asset.txt")).rejects.toThrow(
      "Not a markdown note: asset.txt",
    );
    await expect(moveNote(vaultDir, "asset.txt", "asset-renamed.txt")).rejects.toThrow(
      "Not a markdown note: asset.txt",
    );

    await expect(fs.readFile(path.join(vaultDir, "asset.txt"), "utf-8"))
      .resolves.toBe("original");
  });

  it("refuses to read-modify-write oversized existing notes", async () => {
    setMaxNoteFileBytesForTests(10);
    const oversized = "x".repeat(11);
    await fs.writeFile(path.join(vaultDir, "oversized.md"), oversized, "utf-8");

    await expect(updateNote(vaultDir, "oversized.md", () => "small")).rejects.toThrow(
      /Note file exceeds size cap/,
    );
    await expect(appendToNote(vaultDir, "oversized.md", "tail")).rejects.toThrow(
      /Note file exceeds size cap/,
    );
    await expect(prependToNote(vaultDir, "oversized.md", "head")).rejects.toThrow(
      /Note file exceeds size cap/,
    );
    await expect(fs.readFile(path.join(vaultDir, "oversized.md"), "utf-8"))
      .resolves.toBe(oversized);
  });

  it("refuses to read-modify-write markdown directories", async () => {
    await fs.mkdir(path.join(vaultDir, "directory.md"));

    await expect(updateNote(vaultDir, "directory.md", () => "small")).rejects.toThrow(
      "Not a regular file: directory.md",
    );
    await expect(appendToNote(vaultDir, "directory.md", "tail")).rejects.toThrow(
      "Not a regular file: directory.md",
    );
    await expect(prependToNote(vaultDir, "directory.md", "head")).rejects.toThrow(
      "Not a regular file: directory.md",
    );
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

  it("should permanently delete when permanent=true", async () => {
    await writeNote(vaultDir, "perm.md", "gone");
    await deleteNote(vaultDir, "perm.md", { permanent: true });

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

  it("should not overwrite an existing trashed note", async () => {
    await writeNote(vaultDir, "doomed.md", "first");
    await deleteNote(vaultDir, "doomed.md");
    await writeNote(vaultDir, "doomed.md", "second");
    await deleteNote(vaultDir, "doomed.md");

    const trashDir = path.join(vaultDir, ".trash");
    const entries = await fs.readdir(trashDir);
    expect(await fs.readFile(path.join(trashDir, "doomed.md"), "utf-8")).toBe("first");
    const collisionCopy = entries.find((entry) => /^doomed\.\d+-[0-9a-f]{8}\.md$/i.test(entry));
    expect(collisionCopy).toBeDefined();
    expect(await fs.readFile(path.join(trashDir, collisionCopy!), "utf-8")).toBe("second");
  });

  itWin32("retries transient Windows rename failures while moving to trash", async () => {
    await writeNote(vaultDir, "doomed.md", "bye");
    const realRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename");
    renameSpy
      .mockRejectedValueOnce(Object.assign(new Error("simulated EPERM"), { code: "EPERM" }))
      .mockImplementation(realRename);

    await deleteNote(vaultDir, "doomed.md");

    expect(renameSpy).toHaveBeenCalledTimes(2);
    await expect(fs.access(path.join(vaultDir, "doomed.md"))).rejects.toThrow();
    await expect(fs.access(path.join(vaultDir, ".trash", "doomed.md"))).resolves.toBeUndefined();
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

  it("does not overwrite a destination created after the move starts", async () => {
    await writeNote(vaultDir, "source.md", "source content");
    const racedDest = path.join(vaultDir, "raced.md");
    const realMkdir = fs.mkdir.bind(fs);
    const mkdirSpy = vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
      const result = await realMkdir(...args);
      if (String(args[0]) === vaultDir) {
        await fs.writeFile(racedDest, "racer content", "utf-8");
      }
      return result;
    });

    await expect(
      moveNote(vaultDir, "source.md", "raced.md", { updateLinks: false }),
    ).rejects.toThrow("Destination already exists: raced.md");

    mkdirSpy.mockRestore();
    await expect(fs.readFile(path.join(vaultDir, "source.md"), "utf-8")).resolves.toBe(
      "source content",
    );
    await expect(fs.readFile(racedDest, "utf-8")).resolves.toBe("racer content");
  });

  it("requires read access to the source note before moving it", async () => {
    await fs.mkdir(path.join(vaultDir, "private"), { recursive: true });
    await fs.mkdir(path.join(vaultDir, "public"), { recursive: true });
    await fs.writeFile(path.join(vaultDir, "private", "secret.md"), "secret", "utf-8");
    setPermissions({ readPaths: ["public"], writePaths: ["private", "public"] });

    await expect(
      moveNote(vaultDir, "private/secret.md", "public/secret.md", { updateLinks: false }),
    ).rejects.toThrow(/OBSIDIAN_READ_PATHS/);

    await expect(fs.access(path.join(vaultDir, "private", "secret.md"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(vaultDir, "public", "secret.md"))).rejects.toThrow();
  });

  itWin32("retries transient Windows rename failures for case-only renames", async () => {
    await writeNote(vaultDir, "Old.md", "moving");
    const realRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename");
    renameSpy
      .mockRejectedValueOnce(Object.assign(new Error("simulated EBUSY"), { code: "EBUSY" }))
      .mockImplementation(realRename);

    await moveNote(vaultDir, "Old.md", "old.md");

    expect(renameSpy).toHaveBeenCalledTimes(2);
    await expect(fs.access(path.join(vaultDir, "old.md"))).resolves.toBeUndefined();
  });

  itWin32("retries transient Windows unlink failures after no-replace moves", async () => {
    await writeNote(vaultDir, "old.md", "moving");
    const realUnlink = fs.unlink.bind(fs);
    const unlinkSpy = vi.spyOn(fs, "unlink");
    unlinkSpy
      .mockRejectedValueOnce(Object.assign(new Error("simulated EBUSY"), { code: "EBUSY" }))
      .mockImplementation(realUnlink);

    await moveNote(vaultDir, "old.md", "new.md", { updateLinks: false });

    expect(unlinkSpy).toHaveBeenCalledTimes(2);
    await expect(fs.access(path.join(vaultDir, "old.md"))).rejects.toThrow();
    await expect(fs.access(path.join(vaultDir, "new.md"))).resolves.toBeUndefined();
  });

  it.skipIf(!SYMLINKS_SUPPORTED)("rejects relative symlink moves that would retarget the link", async () => {
    await fs.mkdir(path.join(vaultDir, "links"), { recursive: true });
    await fs.writeFile(path.join(vaultDir, "links", "target.md"), "target", "utf-8");
    await fs.symlink("target.md", path.join(vaultDir, "links", "source.md"));

    await expect(
      moveNote(vaultDir, "links/source.md", "archive/source.md", { updateLinks: false }),
    ).rejects.toThrow("Refusing to move symlink");

    const sourceStat = await fs.lstat(path.join(vaultDir, "links", "source.md"));
    expect(sourceStat.isSymbolicLink()).toBe(true);
    await expect(fs.readlink(path.join(vaultDir, "links", "source.md"))).resolves.toBe(
      "target.md",
    );
    await expect(fs.lstat(path.join(vaultDir, "archive", "source.md"))).rejects.toThrow();
    await expect(readNote(vaultDir, "links/source.md")).resolves.toBe("target");
  });
});

// ---------------------------------------------------------------------------
// searchInContents
// ---------------------------------------------------------------------------
describe("searchInContents", () => {
  it("returns no results for an empty query", () => {
    const contents = new Map([["alpha.md", "alpha"]]);
    expect(searchInContents(["alpha.md"], contents, "")).toEqual([]);
  });

  it("keeps literal matches within a single source line", () => {
    const contents = new Map([
      ["alpha.md", "alpha\nbeta alpha\r\nAlpha beta"],
    ]);

    const crossLine = searchInContents(["alpha.md"], contents, "alpha\nbeta");
    expect(crossLine).toEqual([]);

    const results = searchInContents(["alpha.md"], contents, "alpha");
    expect(results[0].matches).toEqual([
      { line: 1, content: "alpha", column: 0 },
      { line: 2, content: "beta alpha", column: 5 },
      { line: 3, content: "Alpha beta", column: 0 },
    ]);
  });

  it("collapses repeated same-line matches into one visible snippet", () => {
    const contents = new Map([
      ["alpha.md", "alpha alpha alpha\nbeta alpha"],
    ]);

    const results = searchInContents(["alpha.md"], contents, "alpha");

    expect(results[0].matches).toEqual([
      { line: 1, content: "alpha alpha alpha", column: 0 },
      { line: 2, content: "beta alpha", column: 5 },
    ]);
  });

  it("centers long snippets around the first visible match", () => {
    const before = Array.from({ length: 80 }, (_, index) => `before-${index + 1}`).join(" ");
    const after = Array.from({ length: 80 }, (_, index) => `after-${index + 1}`).join(" ");
    const contents = new Map([
      ["alpha.md", `${before} alpha target ${after}`],
    ]);

    const results = searchInContents(["alpha.md"], contents, "alpha");
    const snippet = results[0].matches[0].content;

    expect(snippet.length).toBeLessThanOrEqual(240);
    expect(snippet).toContain("alpha");
    expect(snippet.startsWith("...")).toBe(true);
    expect(snippet.endsWith("...")).toBe(true);
  });

  it("ranks focused title matches ahead of repeated incidental mentions", () => {
    const contents = new Map([
      [
        "meeting-transcript.md",
        [
          "# Meeting Transcript",
          "Migration came up during staffing notes.",
          "Migration migration migration migration migration migration migration.",
        ].join("\n"),
      ],
      [
        "migration-plan.md",
        "# Migration Plan\nMigration scope and rollback owner decisions.",
      ],
      [
        "migration-checklist.md",
        "# Migration Checklist\nMigration prerequisites and verification.",
      ],
      [
        "release-notes.md",
        "# Release Notes\nThe migration is one part of the release.",
      ],
    ]);

    const results = searchInContents(
      [
        "meeting-transcript.md",
        "migration-plan.md",
        "migration-checklist.md",
        "release-notes.md",
      ],
      contents,
      "migration",
      { maxResults: 4 },
    );

    expect(results.map((result) => result.relativePath)).toEqual([
      "migration-checklist.md",
      "migration-plan.md",
      "release-notes.md",
      "meeting-transcript.md",
    ]);
    expect(results.at(-1)?.matches).toHaveLength(2);
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

  it("should collapse multiple matches on the same line", async () => {
    await writeNote(vaultDir, "repeat.md", "foo bar foo baz foo");
    const results = await searchNotes(vaultDir, "foo");
    const repeatResult = results.find((r) => r.relativePath === "repeat.md");
    expect(repeatResult).toBeDefined();
    expect(repeatResult!.matches).toEqual([
      { line: 1, content: "foo bar foo baz foo", column: 0 },
    ]);
  });

  it("should cap long snippets while preserving the source column", async () => {
    const before = Array.from({ length: 80 }, (_, index) => `before-${index + 1}`).join(" ");
    const after = Array.from({ length: 80 }, (_, index) => `after-${index + 1}`).join(" ");
    const line = `${before} needle ${after}`;
    await writeNote(vaultDir, "long.md", line);

    const results = await searchNotes(vaultDir, "needle");
    const longResult = results.find((r) => r.relativePath === "long.md");

    expect(longResult).toBeDefined();
    expect(longResult!.matches[0].content.length).toBeLessThanOrEqual(240);
    expect(longResult!.matches[0].content).toContain("needle");
    expect(longResult!.matches[0].column).toBe(line.indexOf("needle"));
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

  it("should reject oversized canvas files before JSON parsing", async () => {
    await fs.writeFile(
      path.join(vaultDir, "huge.canvas"),
      "x".repeat(MAX_CANVAS_FILE_BYTES + 1),
      "utf-8",
    );

    await expect(readCanvasFile(vaultDir, "huge.canvas")).rejects.toThrow(
      "Canvas file exceeds size cap",
    );
  });

  it("should throw on missing file", async () => {
    await expect(
      readCanvasFile(vaultDir, "nonexistent.canvas"),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Atomicity + concurrency
// ---------------------------------------------------------------------------
describe("writeNote exclusive mode", () => {
  it("rejects a create that collides with a file materialized out-of-process (OS-level wx)", async () => {
    // Simulate a separate process / Obsidian app creating the file after our
    // lock is acquired but before our write lands: we simply pre-create it
    // here with `fs.writeFile` (bypassing the vault lock entirely).
    await fs.writeFile(path.join(vaultDir, "shared.md"), "already-there", "utf-8");
    await expect(
      writeNote(vaultDir, "shared.md", "ours", { exclusive: true }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    // The out-of-process content must survive — no silent overwrite.
    const content = await fs.readFile(path.join(vaultDir, "shared.md"), "utf-8");
    expect(content).toBe("already-there");
  });

  it("allows exclusive create when the file does not exist", async () => {
    await writeNote(vaultDir, "fresh.md", "hello", { exclusive: true });
    const content = await fs.readFile(path.join(vaultDir, "fresh.md"), "utf-8");
    expect(content).toBe("hello");
  });

  it("removes the reserved file if the staged write fails", async () => {
    const realWriteFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
      const [file] = args;
      if (String(file).endsWith(".tmp")) {
        throw new Error("simulated staged write failure");
      }
      return realWriteFile(...args);
    });

    await expect(
      writeNote(vaultDir, "reserved.md", "body", { exclusive: true }),
    ).rejects.toThrow("simulated staged write failure");
    await expect(fs.access(path.join(vaultDir, "reserved.md"))).rejects.toThrow();
  });
});

describe("atomic writes", () => {
  it("leaves no tmp sibling files after a successful write", async () => {
    await writeNote(vaultDir, "atomic.md", "v1");
    await writeNote(vaultDir, "atomic.md", "v2");
    await appendToNote(vaultDir, "atomic.md", "more");
    const entries = await fs.readdir(vaultDir);
    // Only the target file should remain — no `.atomic.md.<pid>.<rand>.tmp`.
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
    expect(entries).toContain("atomic.md");
  });

  it("never leaves a truncated file: readers always see a complete prior or next version", async () => {
    // Seed with a large blob so a non-atomic truncate-then-write would be
    // observable mid-flight. Atomic writes should make every interleaved
    // read see either the seed or the full new payload.
    const seed = "A".repeat(64 * 1024);
    const next = "B".repeat(64 * 1024);
    await writeNote(vaultDir, "big.md", seed);

    const writers = Array.from({ length: 10 }, () =>
      writeNote(vaultDir, "big.md", next),
    );
    const readers = Array.from({ length: 50 }, async () => {
      // Interleave reads while the writers race.
      await new Promise((r) => setTimeout(r, Math.random() * 5));
      return readNote(vaultDir, "big.md");
    });

    const [, ...contents] = await Promise.all([
      Promise.all(writers),
      ...readers,
    ] as const);
    for (const content of contents) {
      expect(typeof content).toBe("string");
      expect([seed.length, next.length]).toContain((content).length);
    }
  });
});

describe("searchNotes tie-break ordering", () => {
  it("breaks score ties by relative path ascending for deterministic output", async () => {
    // Ten notes all containing exactly one match — they all tie at score 1.
    // With the old code the final order depended on mapConcurrent completion
    // scheduling; the new code sorts ties by path so repeated runs agree.
    const names = ["z.md", "a.md", "m.md", "b.md", "y.md"];
    for (const n of names) await writeNote(vaultDir, n, "needle");
    const results = await searchNotes(vaultDir, "needle");
    const paths = results.map((r) => r.relativePath);
    expect(paths).toEqual([...names].sort());
  });
});

describe("concurrent mutation races", () => {
  it("serializes concurrent appends so no update is lost", async () => {
    await writeNote(vaultDir, "counter.md", "");
    const N = 50;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        appendToNote(vaultDir, "counter.md", `line-${i}`),
      ),
    );
    const content = await readNote(vaultDir, "counter.md");
    // Each append adds `line-<i>\n` (the first append sees empty content and
    // inserts no leading separator). All N lines must be present.
    for (let i = 0; i < N; i++) {
      expect(content).toContain(`line-${i}`);
    }
    const lines = content.split("\n").filter((l) => l.startsWith("line-"));
    expect(lines).toHaveLength(N);
  });

  it("serializes append vs prepend — all fragments survive", async () => {
    await writeNote(vaultDir, "mixed.md", "---\ntitle: t\n---\nbody\n");
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      ops.push(appendToNote(vaultDir, "mixed.md", `A${i}`));
      ops.push(prependToNote(vaultDir, "mixed.md", `P${i}`));
    }
    await Promise.all(ops);
    const content = await readNote(vaultDir, "mixed.md");
    for (let i = 0; i < 10; i++) {
      expect(content).toContain(`A${i}`);
      expect(content).toContain(`P${i}`);
    }
    // Frontmatter block must still be intact and in leading position.
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain("title: t");
  });

  it("does not let a concurrent delete race a pending append into ghost content", async () => {
    await writeNote(vaultDir, "raced.md", "seed\n");
    const appends = Array.from({ length: 5 }, (_, i) =>
      appendToNote(vaultDir, "raced.md", `x${i}`).catch(() => undefined),
    );
    // Kick off a delete mid-appends. Either (a) all appends land then delete
    // removes the file, or (b) delete lands then later appends fail with
    // ENOENT — both are acceptable outcomes. The invariant is that the
    // filesystem never ends up with a partial/corrupt file.
    const del = deleteNote(vaultDir, "raced.md", { permanent: true }).catch(() => undefined);
    await Promise.all([...appends, del]);

    const exists = await fs
      .access(path.join(vaultDir, "raced.md"))
      .then(() => true)
      .catch(() => false);
    if (exists) {
      const content = await readNote(vaultDir, "raced.md");
      // If the file survived, it must still parse as UTF-8 text (no
      // zero-byte truncation) and begin with the seed.
      expect(content.startsWith("seed")).toBe(true);
    }
  });
});
