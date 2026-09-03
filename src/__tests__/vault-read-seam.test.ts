import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { clearCache } from "../lib/index-cache.js";
import { readAllCached, readNote } from "../lib/vault-reads.js";
import { searchNotes } from "../lib/vault-search.js";

let vaultDir: string;

beforeEach(async () => {
  vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-read-seam-"));
});

afterEach(async () => {
  await clearCache(vaultDir);
  await fs.rm(vaultDir, { recursive: true, force: true });
});

async function write(relPath: string, content: string): Promise<void> {
  const fullPath = path.join(vaultDir, relPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf-8");
}

describe("vault read seam", () => {
  it("keeps readNote always-fresh and outside the mtime cache", async () => {
    await write("note.md", "v1");
    expect(await readNote(vaultDir, "note.md")).toBe("v1");

    // No delay or mtime manipulation: point reads must observe the live file
    // directly rather than relying on mtime cache semantics.
    await write("note.md", "v2");
    expect(await readNote(vaultDir, "note.md")).toBe("v2");

    // If either point read had populated the batch cache, this would be a hit.
    const batch = await readAllCached(vaultDir, ["note.md"]);
    expect(batch.cacheMisses).toBe(1);
    expect(batch.cacheHits).toBe(0);
    expect(batch.contents.get("note.md")).toBe("v2");
  });

  it("uses the cached batch path for library searchNotes", async () => {
    await write("a.md", "needle in alpha");
    await write("b.md", "needle in beta");

    const results = await searchNotes(vaultDir, "needle");
    expect(results.map((result) => result.relativePath).sort()).toEqual([
      "a.md",
      "b.md",
    ]);

    // searchNotes should have warmed the same batch cache exposed by the seam.
    const secondRead = await readAllCached(vaultDir, ["a.md", "b.md"]);
    expect(secondRead.cacheHits).toBe(2);
    expect(secondRead.cacheMisses).toBe(0);
  });
});
