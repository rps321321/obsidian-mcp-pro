import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { readAllCached, clearCache, cacheSize, flushNow } from "../lib/index-cache.js";

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

describe("readAllCached", () => {
  it("returns content for every requested path on first call (all misses)", async () => {
    await write("a.md", "alpha");
    await write("b.md", "beta");
    const result = await readAllCached(vaultDir, ["a.md", "b.md"]);
    expect(result.contents.get("a.md")).toBe("alpha");
    expect(result.contents.get("b.md")).toBe("beta");
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

  it("prunes entries that aren't requested in a later batch", async () => {
    await write("a.md", "alpha");
    await write("b.md", "beta");
    await readAllCached(vaultDir, ["a.md", "b.md"]);
    expect(cacheSize()).toBeGreaterThanOrEqual(2);
    await readAllCached(vaultDir, ["a.md"]);
    // Only `a.md` should remain in the cache.
    const onlyA = await readAllCached(vaultDir, ["a.md", "b.md"]);
    expect(onlyA.cacheMisses).toBe(1); // b.md re-read after pruning
  });
});

describe("persistent cache", () => {
  it("writes a snapshot under <vault>/.obsidian/cache/ after a flush", async () => {
    await write("a.md", "alpha");
    await readAllCached(vaultDir, ["a.md"]);
    await flushNow(vaultDir);
    const snap = path.join(vaultDir, ".obsidian", "cache", "mcp-pro-index-cache.json");
    const raw = await fs.readFile(snap, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.entries["a.md"].content).toBe("alpha");
  });

  it("rehydrates from disk on a fresh process (simulated via clearCache)", async () => {
    await write("a.md", "alpha");
    await write("b.md", "beta");
    await readAllCached(vaultDir, ["a.md", "b.md"]);
    await flushNow(vaultDir);
    // Drop in-memory cache only — snapshot stays on disk.
    await clearCache(vaultDir);
    const result = await readAllCached(vaultDir, ["a.md", "b.md"]);
    // Both files should hit the rehydrated snapshot since mtime is unchanged.
    expect(result.cacheHits).toBe(2);
    expect(result.cacheMisses).toBe(0);
    expect(result.contents.get("a.md")).toBe("alpha");
  });

  it("invalidates rehydrated entries when mtime changed since the snapshot", async () => {
    await write("a.md", "v1");
    await readAllCached(vaultDir, ["a.md"]);
    await flushNow(vaultDir);
    await clearCache(vaultDir);
    // Mutate the file outside the cache's view.
    await new Promise((r) => setTimeout(r, 10));
    await write("a.md", "v2");
    const result = await readAllCached(vaultDir, ["a.md"]);
    expect(result.contents.get("a.md")).toBe("v2");
    expect(result.cacheMisses).toBe(1);
    expect(result.cacheHits).toBe(0);
  });

  it("ignores a snapshot whose vaultRoot doesn't match the current vault", async () => {
    await write("a.md", "alpha");
    await readAllCached(vaultDir, ["a.md"]);
    await flushNow(vaultDir);
    // Tamper with the snapshot to simulate a moved vault.
    const snap = path.join(vaultDir, ".obsidian", "cache", "mcp-pro-index-cache.json");
    const raw = await fs.readFile(snap, "utf-8");
    const parsed = JSON.parse(raw);
    parsed.vaultRoot = "/some/other/path";
    await fs.writeFile(snap, JSON.stringify(parsed), "utf-8");
    await clearCache(vaultDir);
    const result = await readAllCached(vaultDir, ["a.md"]);
    // Snapshot was discarded → file is re-read, not served from rehydration.
    expect(result.cacheMisses).toBe(1);
  });

  it("respects OBSIDIAN_CACHE_DISABLED=1 (no snapshot written)", async () => {
    process.env.OBSIDIAN_CACHE_DISABLED = "1";
    try {
      await write("a.md", "alpha");
      await readAllCached(vaultDir, ["a.md"]);
      await flushNow(vaultDir);
      const snap = path.join(vaultDir, ".obsidian", "cache", "mcp-pro-index-cache.json");
      await expect(fs.access(snap)).rejects.toThrow();
    } finally {
      delete process.env.OBSIDIAN_CACHE_DISABLED;
    }
  });

  it("removes snapshot when clearCache(removeSnapshot: true)", async () => {
    await write("a.md", "alpha");
    await readAllCached(vaultDir, ["a.md"]);
    await flushNow(vaultDir);
    const snap = path.join(vaultDir, ".obsidian", "cache", "mcp-pro-index-cache.json");
    await fs.access(snap); // exists
    await clearCache(vaultDir, { removeSnapshot: true });
    await expect(fs.access(snap)).rejects.toThrow();
  });
});
