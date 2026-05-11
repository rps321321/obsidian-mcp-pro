import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { resolveVaultPath } from "../lib/vault.js";

// ---------------------------------------------------------------------------
// FN-H4: Windows drive-relative / absolute / UNC paths bypass prefix check
//
// `path.resolve(vaultDir, "C:foo")` on Windows resolves against the CWD of
// drive C. If that CWD happens to be inside the vault during dev or testing,
// the syntactic prefix check passes even though the input was clearly an
// attempted absolute reference. The library-level guard explicitly rejects
// any input that looks absolute / drive-relative / UNC up front. The
// rejection is platform-independent (string matching), so these tests run
// the same on Windows, macOS, and Linux.
// ---------------------------------------------------------------------------

let vaultDir: string;

beforeEach(async () => {
  vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-fn-h4-"));
});

afterEach(async () => {
  await fs.rm(vaultDir, { recursive: true, force: true });
});

describe("FN-H4: resolveVaultPath rejects non-vault-relative inputs", () => {
  it("rejects Windows drive-relative path 'C:foo'", () => {
    expect(() => resolveVaultPath(vaultDir, "C:foo")).toThrow(/Invalid path/);
  });

  it("rejects Windows absolute path with backslashes", () => {
    expect(() => resolveVaultPath(vaultDir, "C:\\absolute\\path")).toThrow(
      /Invalid path/,
    );
  });

  it("rejects lowercase drive letters too", () => {
    expect(() => resolveVaultPath(vaultDir, "d:notes.md")).toThrow(
      /Invalid path/,
    );
  });

  it("rejects POSIX-style absolute path '/abs/path'", () => {
    expect(() => resolveVaultPath(vaultDir, "/abs/path")).toThrow(
      /Invalid path/,
    );
  });

  it("rejects UNC path '\\\\server\\share\\foo'", () => {
    expect(() => resolveVaultPath(vaultDir, "\\\\server\\share\\foo")).toThrow(
      /Invalid path/,
    );
  });

  it("rejects single leading backslash (Windows root-relative)", () => {
    expect(() => resolveVaultPath(vaultDir, "\\foo\\bar")).toThrow(
      /Invalid path/,
    );
  });
});

describe("FN-H4: resolveVaultPath still accepts vault-relative inputs", () => {
  it("accepts nested folder/sub/note.md", () => {
    const resolved = resolveVaultPath(vaultDir, "folder/sub/note.md");
    expect(resolved).toBe(
      path.resolve(vaultDir, "folder", "sub", "note.md"),
    );
  });

  it("accepts a bare filename note.md", () => {
    const resolved = resolveVaultPath(vaultDir, "note.md");
    expect(resolved).toBe(path.resolve(vaultDir, "note.md"));
  });

  it("accepts an explicitly-relative ./folder/note.md", () => {
    const resolved = resolveVaultPath(vaultDir, "./folder/note.md");
    expect(resolved).toBe(path.resolve(vaultDir, "folder", "note.md"));
  });
});
