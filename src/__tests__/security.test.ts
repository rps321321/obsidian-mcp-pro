import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  resolveVaultPathSafe,
  writeNote,
  moveNote,
  deleteNote,
} from "../lib/vault.js";
import { sanitizeError } from "../lib/errors.js";

const SYMLINKS_SUPPORTED = process.platform !== "win32" || process.env.CI_SYMLINKS === "1";
const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

let vaultDir: string;
let outsideDir: string;

beforeEach(async () => {
  vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-sec-"));
  outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "outside-sec-"));
});

afterEach(async () => {
  await fs.rm(vaultDir, { recursive: true, force: true });
  await fs.rm(outsideDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Symlink escape (regression guard for C1/H1 from the audit)
// ---------------------------------------------------------------------------
describe.skipIf(!SYMLINKS_SUPPORTED)("resolveVaultPathSafe — symlink boundary", () => {
  it("rejects a symlink inside the vault that points outside", async () => {
    const target = path.join(outsideDir, "secret.md");
    await fs.writeFile(target, "outside", "utf-8");
    const linkPath = path.join(vaultDir, "escape.md");
    await fs.symlink(target, linkPath);

    await expect(
      resolveVaultPathSafe(vaultDir, "escape.md"),
    ).rejects.toThrow(/symlink/i);
  });

  it("rejects a symlinked directory inside the vault that points outside", async () => {
    const outsideSub = path.join(outsideDir, "notes");
    await fs.mkdir(outsideSub, { recursive: true });
    await fs.writeFile(path.join(outsideSub, "a.md"), "x", "utf-8");
    await fs.symlink(outsideSub, path.join(vaultDir, "linked"));

    await expect(
      resolveVaultPathSafe(vaultDir, "linked/a.md"),
    ).rejects.toThrow(/symlink/i);
  });

  it("rejects deletion when the trash itself is a symlink to outside the vault", async () => {
    await fs.writeFile(path.join(vaultDir, "note.md"), "hi", "utf-8");
    const outsideTrash = path.join(outsideDir, "fake-trash");
    await fs.mkdir(outsideTrash, { recursive: true });
    await fs.symlink(outsideTrash, path.join(vaultDir, ".trash"));

    await expect(deleteNote(vaultDir, "note.md", true)).rejects.toThrow(
      /symlink/i,
    );
  });
});

// ---------------------------------------------------------------------------
// moveNote case-rename deadlock (regression guard for H2)
// ---------------------------------------------------------------------------
describe.skipIf(!CASE_INSENSITIVE_FS)("moveNote case-only rename", () => {
  it("completes without deadlock and actually renames", async () => {
    await writeNote(vaultDir, "Note.md", "hello");
    await Promise.race([
      moveNote(vaultDir, "Note.md", "note.md"),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("moveNote deadlocked (>2s)")), 2000),
      ),
    ]);
    const entries = await fs.readdir(vaultDir);
    expect(entries).toContain("note.md");
    // Old casing should no longer be present as a distinct entry
    expect(entries.filter((e) => e.toLowerCase() === "note.md")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// writeNote exclusive + case-collision (regression guard for M1)
// ---------------------------------------------------------------------------
describe.skipIf(!CASE_INSENSITIVE_FS)("writeNote exclusive — case collision", () => {
  it("refuses to overwrite a case-different existing file", async () => {
    await writeNote(vaultDir, "note.md", "original");
    await expect(
      writeNote(vaultDir, "Note.md", "replacement", { exclusive: true }),
    ).rejects.toThrow(/exists/i);
    expect(await fs.readFile(path.join(vaultDir, "note.md"), "utf-8")).toBe(
      "original",
    );
  });
});

// ---------------------------------------------------------------------------
// sanitizeError — regression guard for H1/H3 (path leak in error messages)
// ---------------------------------------------------------------------------
describe("sanitizeError", () => {
  it("strips POSIX absolute paths", () => {
    const err = Object.assign(new Error(
      "ENOENT: no such file or directory, open '/home/alice/vault/secret.md'",
    ), { code: "ENOENT" });
    const msg = sanitizeError(err);
    expect(msg).not.toContain("/home/alice");
    expect(msg).not.toContain("secret.md");
  });

  it("strips Windows absolute paths", () => {
    const raw = "ENOENT: no such file or directory, open 'C:\\Users\\bob\\vault\\s.md'";
    const err = Object.assign(new Error(raw), { code: "ENOENT" });
    const msg = sanitizeError(err);
    expect(msg).not.toContain("C:\\Users");
    expect(msg).not.toContain("bob");
  });

  it("collapses known errno codes to generic messages", () => {
    for (const code of ["ENOENT", "EACCES", "EEXIST", "EISDIR"]) {
      const err = Object.assign(new Error(`${code}: /a/b/c`), { code });
      expect(sanitizeError(err)).not.toMatch(/\/a\/b\/c/);
      expect(sanitizeError(err)).not.toBe("");
    }
  });

  it("handles non-Error throws safely", () => {
    expect(sanitizeError("plain string /tmp/secret")).not.toContain("/tmp/secret");
    expect(sanitizeError(null)).toBe("Unknown error");
    expect(sanitizeError(undefined)).toBe("Unknown error");
    expect(sanitizeError(42)).toBe("Unknown error");
  });
});
