import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  readAllCached,
  clearCache,
  cacheSize,
  flushNow,
} from "../lib/index-cache.js";

let vaultDir: string;

beforeEach(async () => {
  vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "cache-test-"));
});

afterEach(async () => {
  await clearCache(vaultDir);
  await fs.rm(vaultDir, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<void> {
  const full = path.join(vaultDir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}

async function linkCacheDirOutside(outsideDir: string): Promise<boolean> {
  await fs.mkdir(path.join(vaultDir, ".obsidian"), { recursive: true });
  try {
    await fs.symlink(
      outsideDir,
      path.join(vaultDir, ".obsidian", "cache"),
      process.platform === "win32" ? "junction" : "dir",
    );
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "EINVAL") return false;
    throw err;
  }
}

describe("readAllCached", () => {
  it("returns content for every requested path on first call (all misses)", async () => {
    await write("a.md", "alpha");
    await write("b.md", "beta");
    const result = await readAllCached(vaultDir, ["a.md", "b.md"]);
    expect(result.contents.get("a.md")).toBe("alpha");
    expect(result.contents.get("b.md")).toBe("beta");
    expect(result.mtimes.get("a.md")).toEqual(expect.any(Number));
    expect(result.mtimes.get("b.md")).toEqual(expect.any(Number));
    expect(result.stats.get("a.md")).toEqual({
      size: 5,
      ctime: expect.any(Number),
      mtime: expect.any(Number),
    });
    expect(result.cacheMisses).toBe(2);
    expect(result.cacheHits).toBe(0);
  });

  it("hits the cache on the second call when files are unchanged", async () => {
    await write("a.md", "alpha");
    await readAllCached(vaultDir, ["a.md"]);
    const result = await readAllCached(vaultDir, ["a.md"]);
    expect(result.cacheHits).toBe(1);
    expect(result.cacheMisses).toBe(0);
  });

  it("re-reads when mtime changes", async () => {
    await write("a.md", "v1");
    await readAllCached(vaultDir, ["a.md"]);
    // Force a measurable mtime change.
    await new Promise((r) => setTimeout(r, 10));
    await write("a.md", "v2");
    const result = await readAllCached(vaultDir, ["a.md"]);
    expect(result.contents.get("a.md")).toBe("v2");
    expect(result.cacheMisses).toBe(1);
    expect(result.cacheHits).toBe(0);
  });

  it("calls onError for missing files and omits them from contents", async () => {
    await write("a.md", "alpha");
    const errors: string[] = [];
    const result = await readAllCached(vaultDir, ["a.md", "missing.md"], (rel) => {
      errors.push(rel);
    });
    expect(result.contents.has("missing.md")).toBe(false);
    expect(result.contents.get("a.md")).toBe("alpha");
    expect(errors).toContain("missing.md");
  });

  it("keeps entries for files that still exist on disk even if out of scope", async () => {
    await write("a.md", "alpha");
    await write("b.md", "beta");
    await readAllCached(vaultDir, ["a.md", "b.md"]);
    expect(cacheSize()).toBeGreaterThanOrEqual(2);
    await readAllCached(vaultDir, ["a.md"]);
    // b.md still exists on disk, so the cache retains it even though it
    // wasn't requested in the previous batch.
    const both = await readAllCached(vaultDir, ["a.md", "b.md"]);
    expect(both.cacheMisses).toBe(0); // b.md served from cache
  });
});

describe("legacy persistent cache", () => {
  function snapshotPath(): string {
    return path.join(vaultDir, ".obsidian", "cache", "mcp-pro-index-cache.json");
  }

  async function writeLegacySnapshot(relPath: string, content: string): Promise<void> {
    const fullPath = path.join(vaultDir, relPath);
    const stat = await fs.stat(fullPath);
    const snap = snapshotPath();
    await fs.mkdir(path.dirname(snap), { recursive: true });
    await fs.writeFile(
      snap,
      JSON.stringify({
        version: 1,
        vaultRoot: path.resolve(vaultDir),
        entries: {
          [relPath]: {
            fullPath,
            content,
            mtimeMs: stat.mtimeMs,
          },
        },
      }),
      "utf-8",
    );
  }

  it("does not write note bodies to a disk snapshot", async () => {
    await write("a.md", "alpha");
    await readAllCached(vaultDir, ["a.md"]);
    await flushNow(vaultDir);

    await expect(fs.access(snapshotPath())).rejects.toThrow();
  });

  it("ignores and removes forged legacy snapshots before reading notes", async () => {
    await write("a.md", "fresh");
    await writeLegacySnapshot("a.md", "forged body from cache");
    await clearCache(vaultDir);

    const result = await readAllCached(vaultDir, ["a.md"]);

    expect(result.cacheHits).toBe(0);
    expect(result.cacheMisses).toBe(1);
    expect(result.contents.get("a.md")).toBe("fresh");
    await expect(fs.access(snapshotPath())).rejects.toThrow();
  });

  it("removes legacy snapshots when clearCache(removeSnapshot: true)", async () => {
    await write("a.md", "alpha");
    await writeLegacySnapshot("a.md", "alpha");

    await clearCache(vaultDir, { removeSnapshot: true });

    await expect(fs.access(snapshotPath())).rejects.toThrow();
  });

  it("does not follow a .obsidian/cache symlink outside the vault while cleaning up", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "cache-outside-"));
    try {
      const linked = await linkCacheDirOutside(outsideDir);
      if (!linked) return;

      const outsideSnapshot = path.join(outsideDir, "mcp-pro-index-cache.json");
      await fs.writeFile(outsideSnapshot, "outside cache", "utf-8");
      await write("a.md", "alpha");
      await readAllCached(vaultDir, ["a.md"]);
      await flushNow(vaultDir);

      await expect(fs.readFile(outsideSnapshot, "utf-8")).resolves.toBe("outside cache");
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});
