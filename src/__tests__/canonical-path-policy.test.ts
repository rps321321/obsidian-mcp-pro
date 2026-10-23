import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendToNote,
  listNotes,
  readNote,
  readNoteLineRange,
  resolveVaultPathSafe,
  writeNote,
} from "../lib/vault.js";
import { openResolvedVaultFileForRead } from "../lib/vault-fs.js";
import { setPermissions } from "../lib/permissions.js";
import { getDailyNoteConfig } from "../config.js";
import { createTestEnv, type TestEnv } from "./handlers/harness.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv({ skipFixtures: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  setPermissions({ readPaths: null, writePaths: null });
  await env.cleanup();
});

async function aliasDirectory(target: string, alias: string): Promise<void> {
  await fs.symlink(
    target,
    alias,
    process.platform === "win32" ? "junction" : "dir"
  );
}

async function aliasFile(target: string, alias: string): Promise<boolean> {
  try {
    await fs.symlink(target, alias, "file");
    return true;
  } catch (err) {
    if (
      ["EPERM", "EACCES", "ENOSYS"].includes(
        (err as NodeJS.ErrnoException).code ?? ""
      )
    ) {
      return false;
    }
    throw err;
  }
}

describe.each([".obsidian", ".git", ".trash", "nested/.ObSiDiAn"])(
  "canonical exclusion for %s",
  (excluded) => {
    it("denies directory aliases for reads, listings, and writes", async () => {
      const target = path.join(env.vaultDir, excluded);
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(
        path.join(target, "hidden.md"),
        "synthetic hidden content"
      );
      await aliasDirectory(target, path.join(env.vaultDir, "alias"));

      await expect(readNote(env.vaultDir, "alias/hidden.md")).rejects.toThrow(
        /excluded directory/
      );
      await expect(
        readNoteLineRange(env.vaultDir, "alias/hidden.md", 1, 1)
      ).rejects.toThrow(/excluded directory/);
      await expect(listNotes(env.vaultDir, "alias")).rejects.toThrow(
        /excluded directory/
      );
      await expect(
        appendToNote(env.vaultDir, "alias/hidden.md", "changed")
      ).rejects.toThrow(/excluded directory/);
      await expect(
        writeNote(env.vaultDir, "alias/new/note.md", "created")
      ).rejects.toThrow(/excluded directory/);
      expect(await fs.readFile(path.join(target, "hidden.md"), "utf8")).toBe(
        "synthetic hidden content"
      );
      await expect(fs.access(path.join(target, "new"))).rejects.toThrow();
    });
  }
);

it("rejects excluded aliases through the MCP tool and note resource", async () => {
  await fs.writeFile(
    path.join(env.vaultDir, ".obsidian", "hidden.md"),
    "synthetic hidden content"
  );
  await aliasDirectory(
    path.join(env.vaultDir, ".obsidian"),
    path.join(env.vaultDir, "alias")
  );

  const result = await env.client.callTool({
    name: "get_note",
    arguments: { path: "alias/hidden.md" },
  });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).not.toContain("synthetic hidden content");
  await expect(
    env.client.readResource({ uri: "obsidian://note/alias/hidden.md" })
  ).rejects.toThrow(/excluded directory/);
});

it("rechecks exclusions when an alias changes before the file opens", async () => {
  const allowed = path.join(env.vaultDir, "allowed");
  const excluded = path.join(env.vaultDir, ".obsidian");
  const alias = path.join(env.vaultDir, "alias");
  await fs.mkdir(allowed);
  await fs.writeFile(path.join(allowed, "note.md"), "allowed");
  await fs.writeFile(path.join(excluded, "note.md"), "hidden");
  await aliasDirectory(allowed, alias);
  const originalOpen = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
    await fs.unlink(alias);
    await aliasDirectory(excluded, alias);
    return originalOpen(...args);
  });

  await expect(readNote(env.vaultDir, "alias/note.md")).rejects.toThrow(
    /excluded directory/
  );
});

it("keeps permitted directory aliases and canonical folder permissions", async () => {
  const allowed = path.join(env.vaultDir, "allowed");
  await fs.mkdir(allowed);
  await fs.writeFile(path.join(allowed, "note.md"), "allowed");
  await aliasDirectory(allowed, path.join(env.vaultDir, "alias"));

  await expect(readNote(env.vaultDir, "alias/note.md")).resolves.toBe(
    "allowed"
  );
  await expect(
    resolveVaultPathSafe(env.vaultDir, "alias/note.md", "write")
  ).resolves.toBe(path.join(env.vaultDir, "alias", "note.md"));
  setPermissions({ readPaths: ["alias"], writePaths: ["alias"] });
  await expect(readNote(env.vaultDir, "alias/note.md")).rejects.toThrow(
    /OBSIDIAN_READ_PATHS/
  );
  await expect(
    writeNote(env.vaultDir, "alias/new.md", "denied")
  ).rejects.toThrow(/OBSIDIAN_WRITE_PATHS/);
});

it("preserves internal configuration reads inside excluded directories", async () => {
  await fs.writeFile(
    path.join(env.vaultDir, ".obsidian", "daily-notes.json"),
    JSON.stringify({ folder: "journal", format: "YYYY" })
  );
  setPermissions({ readPaths: ["public"], writePaths: ["public"] });

  await expect(getDailyNoteConfig(env.vaultDir)).resolves.toEqual({
    folder: "journal",
    format: "YYYY",
    template: undefined,
  });
});

it("keeps permitted directory aliases whose names end in .md", async () => {
  const target = path.join(env.vaultDir, "permitted");
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, "note.md"), "allowed");
  await aliasDirectory(target, path.join(env.vaultDir, "folder.md"));

  await expect(listNotes(env.vaultDir, "folder.md")).resolves.toEqual([
    "folder.md/note.md",
  ]);
  await expect(
    resolveVaultPathSafe(env.vaultDir, "folder.md", "write")
  ).resolves.toBe(path.join(env.vaultDir, "folder.md"));
});

it("keeps the vault boundary for directory aliases", async () => {
  const outside = await fs.mkdtemp(
    path.join(os.tmpdir(), "canonical-outside-")
  );
  try {
    await fs.writeFile(path.join(outside, "note.md"), "outside");
    await aliasDirectory(outside, path.join(env.vaultDir, "alias"));
    await expect(readNote(env.vaultDir, "alias/note.md")).rejects.toThrow(
      /symlink/
    );
    await expect(
      writeNote(env.vaultDir, "alias/new.md", "denied")
    ).rejects.toThrow(/symlink/);
    expect(await fs.readFile(path.join(outside, "note.md"), "utf8")).toBe(
      "outside"
    );
    await expect(fs.access(path.join(outside, "new.md"))).rejects.toThrow();
  } finally {
    await fs.rm(outside, { recursive: true, force: true });
  }
});

it("denies file aliases into excluded subtrees when file symlinks are available", async ({
  skip,
}) => {
  const target = path.join(env.vaultDir, ".obsidian", "hidden.md");
  await fs.writeFile(target, "hidden");
  if (!(await aliasFile(target, path.join(env.vaultDir, "alias.md"))))
    return skip();

  await expect(readNote(env.vaultDir, "alias.md")).rejects.toThrow(
    /excluded directory/
  );
});

it("requires canonical markdown targets for note aliases when file symlinks are available", async ({
  skip,
}) => {
  const target = path.join(env.vaultDir, "data.bin");
  const alias = path.join(env.vaultDir, "alias.md");
  await fs.writeFile(target, "not a note");
  if (!(await aliasFile(target, alias))) return skip();

  await expect(readNote(env.vaultDir, "alias.md")).rejects.toThrow(
    /Not a markdown note/
  );
  await expect(
    appendToNote(env.vaultDir, "alias.md", "denied")
  ).rejects.toThrow(/Not a markdown note/);
  await expect(
    openResolvedVaultFileForRead(env.vaultDir, "alias.md", alias, "read")
  ).rejects.toThrow(/Not a markdown note/);
  expect(await fs.readFile(target, "utf8")).toBe("not a note");
});

it("keeps file aliases to permitted markdown targets when file symlinks are available", async ({
  skip,
}) => {
  const target = path.join(env.vaultDir, "target.md");
  await fs.writeFile(target, "allowed note");
  if (!(await aliasFile(target, path.join(env.vaultDir, "alias.md"))))
    return skip();

  await expect(readNote(env.vaultDir, "alias.md")).resolves.toBe(
    "allowed note"
  );
});
