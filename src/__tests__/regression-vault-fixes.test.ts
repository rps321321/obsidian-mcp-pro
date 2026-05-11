import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  listNotes,
  writeNote,
  deleteNote,
  resolveVaultPathSafe,
} from "../lib/vault.js";

let vaultDir: string;

beforeEach(async () => {
  vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-regress-"));
});

afterEach(async () => {
  await fs.rm(vaultDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// H12: listNotes folder normalization
// ---------------------------------------------------------------------------
describe("H12: listNotes folder normalization", () => {
  it("normalizes a trailing slash so output paths have no double slashes", async () => {
    await fs.mkdir(path.join(vaultDir, "projects"), { recursive: true });
    await fs.writeFile(path.join(vaultDir, "projects", "active.md"), "x");

    const notes = await listNotes(vaultDir, "projects/");
    expect(notes).toEqual(["projects/active.md"]);
    for (const n of notes) {
      expect(n).not.toContain("//");
    }
  });

  it("normalizes leading and multiple trailing slashes", async () => {
    await fs.mkdir(path.join(vaultDir, "projects"), { recursive: true });
    await fs.writeFile(path.join(vaultDir, "projects", "a.md"), "x");

    const notes = await listNotes(vaultDir, "/projects///");
    expect(notes).toEqual(["projects/a.md"]);
  });

  it("normalizes backslashes to forward slashes (Windows-style input)", async () => {
    await fs.mkdir(path.join(vaultDir, "projects", "nested"), { recursive: true });
    await fs.writeFile(
      path.join(vaultDir, "projects", "nested", "deep.md"),
      "x",
    );

    // Input uses Windows-style separators; output must be normalized to /
    const notes = await listNotes(vaultDir, "projects\\nested");
    expect(notes).toEqual(["projects/nested/deep.md"]);
    for (const n of notes) {
      expect(n).not.toContain("\\");
    }
  });

  it("normalizes mixed separators (forward + back)", async () => {
    await fs.mkdir(path.join(vaultDir, "a", "b", "c"), { recursive: true });
    await fs.writeFile(path.join(vaultDir, "a", "b", "c", "note.md"), "x");

    const notes = await listNotes(vaultDir, "a/b\\c");
    expect(notes).toEqual(["a/b/c/note.md"]);
  });

  it("still excludes nested .git/.obsidian/.trash inside the folder", async () => {
    await fs.mkdir(path.join(vaultDir, "projects", ".git"), { recursive: true });
    await fs.writeFile(
      path.join(vaultDir, "projects", ".git", "secret.md"),
      "x",
    );
    await fs.writeFile(path.join(vaultDir, "projects", "ok.md"), "y");

    const notes = await listNotes(vaultDir, "projects/");
    expect(notes).toEqual(["projects/ok.md"]);
  });

  it("returns empty list when normalized folder doesn't exist", async () => {
    const notes = await listNotes(vaultDir, "missing/");
    expect(notes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// H13: assertRealPathWithinVault EACCES handling
// ---------------------------------------------------------------------------
describe("H13: EACCES does not leak ancestor paths", () => {
  // POSIX-only: chmod 0 on Windows doesn't produce EACCES the same way.
  const isPosix = process.platform !== "win32";
  const itPosix = isPosix && process.getuid && process.getuid() !== 0 ? it : it.skip;

  itPosix(
    "does not leak the restricted parent path in the error message",
    async () => {
      // Create a vault under a parent we'll lock down.
      const wrapper = await fs.mkdtemp(path.join(os.tmpdir(), "vault-eacces-wrap-"));
      const innerVault = path.join(wrapper, "vault");
      await fs.mkdir(innerVault, { recursive: true });

      try {
        // Lock down the wrapper directory: no permissions for anyone.
        await fs.chmod(wrapper, 0o000);

        // Now try to resolve a path. The realpath walk should not include
        // `wrapper` in any error message it surfaces.
        let caught: Error | undefined;
        try {
          await resolveVaultPathSafe(innerVault, "note.md");
        } catch (err) {
          caught = err as Error;
        }

        // The call may succeed (climbed past the restriction to a readable
        // root) or fail with the generic message — either way the wrapper
        // path must not appear verbatim in any thrown error.
        if (caught) {
          expect(caught.message).not.toContain(wrapper);
        }
      } finally {
        // Always restore permissions so cleanup works.
        try {
          await fs.chmod(wrapper, 0o755);
        } catch {
          /* ignore */
        }
        await fs.rm(wrapper, { recursive: true, force: true });
      }
    },
  );

  it("documents that non-POSIX platforms skip this regression check", () => {
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// H14: deleteNote trash path routes through canonical resolution
// ---------------------------------------------------------------------------
describe("H14: deleteNote trash path uses canonical resolution", () => {
  it("moves a top-level note to .trash/", async () => {
    await writeNote(vaultDir, "note.md", "body");
    const result = await deleteNote(vaultDir, "note.md");

    expect(result.updatedReferrers).toEqual([]);
    expect(result.failedReferrers).toEqual([]);

    // Original gone.
    await expect(fs.access(path.join(vaultDir, "note.md"))).rejects.toThrow();
    // Now in .trash/.
    const trashed = await fs.readFile(
      path.join(vaultDir, ".trash", "note.md"),
      "utf-8",
    );
    expect(trashed).toBe("body");
  });

  it("preserves nested folder structure under .trash/", async () => {
    await writeNote(vaultDir, "projects/active/plan.md", "details");
    await deleteNote(vaultDir, "projects/active/plan.md");

    // Original gone.
    await expect(
      fs.access(path.join(vaultDir, "projects", "active", "plan.md")),
    ).rejects.toThrow();
    // Trash mirrors the directory layout.
    const trashed = await fs.readFile(
      path.join(vaultDir, ".trash", "projects", "active", "plan.md"),
      "utf-8",
    );
    expect(trashed).toBe("details");
  });

  it("rejects notes whose relativePath contains .. (caught upstream)", async () => {
    await writeNote(vaultDir, "real.md", "x");
    // resolveVaultPathSafe at the top of deleteNote rejects path traversal
    // before the trash logic runs.
    await expect(deleteNote(vaultDir, "../real.md")).rejects.toThrow(
      /traversal/i,
    );
  });

  it("non-permanent delete with nested path keeps directory tree in .trash", async () => {
    await writeNote(vaultDir, "a/b/c/deep.md", "deep");
    await deleteNote(vaultDir, "a/b/c/deep.md", { permanent: false });

    const stat = await fs.stat(
      path.join(vaultDir, ".trash", "a", "b", "c", "deep.md"),
    );
    expect(stat.isFile()).toBe(true);
  });
});
