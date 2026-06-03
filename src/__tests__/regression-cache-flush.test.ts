import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { readAllCached, clearCache, flushNow } from "../lib/index-cache.js";

// Regression coverage for two index-cache findings:
//   - C2: flushVaultCache lost dirty writes that arrived during an in-flight
//         flush. The second concurrent flush returned after awaiting the
//         pending promise without re-checking `state.dirty`, so the new
//         entries never reached disk and flushAllCachesAsync dropped them at
//         shutdown.
//   - M7: loadFromDisk set `state.loaded = true` before reading the snapshot,
//         so a transient permission error (EACCES, EIO) latched the cache
//         into "loaded but empty" for the rest of the session - even though
//         the file became readable again.

let vaultDir: string;
const itWin32 = process.platform === "win32" ? it : it.skip;

beforeEach(async () => {
  vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "cache-flush-test-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await clearCache(vaultDir, { removeSnapshot: true });
  await fs.rm(vaultDir, { recursive: true, force: true });
});

async function writeFile(rel: string, content: string): Promise<void> {
  const full = path.join(vaultDir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}

describe("flushVaultCache concurrent dirty-flag handling (C2)", () => {
  itWin32("retries transient Windows rename failures while persisting snapshots", async () => {
    await writeFile("a.md", "alpha");
    await readAllCached(vaultDir, ["a.md"]);

    const realRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename");
    renameSpy
      .mockRejectedValueOnce(Object.assign(new Error("simulated EBUSY"), { code: "EBUSY" }))
      .mockImplementation(realRename);

    await flushNow(vaultDir);

    expect(renameSpy).toHaveBeenCalledTimes(2);
    const snap = path.join(vaultDir, ".obsidian", "cache", "mcp-pro-index-cache.json");
    const parsed = JSON.parse(await fs.readFile(snap, "utf-8"));
    expect(parsed.entries["a.md"]?.content).toBe("alpha");
  });

  it("persists writes that arrive while an earlier flush is mid-write", async () => {
    // Stage: warm the cache with one entry so the first flush has data.
    await writeFile("a.md", "alpha");
    await readAllCached(vaultDir, ["a.md"]);

    // Intercept `fs.rename` and delay it. doFlush awaits rename last, so
    // delaying it widens the window where pendingFlush is set and the
    // snapshot for the in-flight write has already been captured (dirty=false
    // at this point). Anything we do to the cache during this window is the
    // exact scenario C2 describes.
    const realRename = fs.rename.bind(fs);
    let releaseFirstRename: (() => void) | null = null;
    const firstRenameStarted = new Promise<void>((resolve) => {
      const spy = vi.spyOn(fs, "rename");
      spy.mockImplementationOnce(async (...args: Parameters<typeof fs.rename>) => {
        resolve();
        await new Promise<void>((r) => {
          releaseFirstRename = r;
        });
        return realRename(...args);
      });
    });

    // Kick off the first flush. It will reach the rename call and block.
    const firstFlush = flushNow(vaultDir);
    await firstRenameStarted;

    // Mid-flush: add a second cache entry. This sets state.dirty = true
    // *after* the first flush's snapshot was captured. The pre-fix code
    // would lose this write.
    await writeFile("b.md", "beta");
    await readAllCached(vaultDir, ["a.md", "b.md"]);

    // Kick off a second flush while the first is still blocked on rename.
    // Pre-fix behaviour: this awaits the in-flight flush and returns without
    // writing b.md. Post-fix: it falls through, sees dirty=true, and starts
    // a follow-up flush that captures b.md.
    const secondFlush = flushNow(vaultDir);

    // Release the first flush's rename. Both flushes should now complete.
    if (releaseFirstRename) (releaseFirstRename as () => void)();
    await Promise.all([firstFlush, secondFlush]);

    // Snapshot on disk must include BOTH entries.
    const snap = path.join(vaultDir, ".obsidian", "cache", "mcp-pro-index-cache.json");
    const raw = await fs.readFile(snap, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.entries["a.md"]?.content).toBe("alpha");
    expect(parsed.entries["b.md"]?.content).toBe("beta");
  });

  it("multiple concurrent flushes converge and persist the latest state", async () => {
    // Same setup but with three concurrent flushers - exercises the
    // second-pendingFlush deferral path where caller N waits on caller M's
    // follow-up flush instead of starting a redundant third one.
    await writeFile("a.md", "v1");
    await readAllCached(vaultDir, ["a.md"]);

    const realRename = fs.rename.bind(fs);
    let release: (() => void) | null = null;
    const renameStarted = new Promise<void>((resolve) => {
      const spy = vi.spyOn(fs, "rename");
      spy.mockImplementationOnce(async (...args: Parameters<typeof fs.rename>) => {
        resolve();
        await new Promise<void>((r) => {
          release = r;
        });
        return realRename(...args);
      });
    });

    const first = flushNow(vaultDir);
    await renameStarted;

    // Two writes during the in-flight flush.
    await writeFile("a.md", "v2");
    await readAllCached(vaultDir, ["a.md"]);

    const second = flushNow(vaultDir);
    const third = flushNow(vaultDir);

    if (release) (release as () => void)();
    await Promise.all([first, second, third]);

    const snap = path.join(vaultDir, ".obsidian", "cache", "mcp-pro-index-cache.json");
    const parsed = JSON.parse(await fs.readFile(snap, "utf-8"));
    // Final on-disk content must reflect the latest read (v2), not the
    // pre-mid-flight v1 snapshot.
    expect(parsed.entries["a.md"]?.content).toBe("v2");
  });
});

describe("loadFromDisk retries after transient read failure (M7)", () => {
  // Simulating EACCES portably is hard on Windows: chmod is mostly a no-op
  // and creating an inaccessible file requires admin / ACL tweaks. Skip
  // there and run the same logic on POSIX via fs.chmod.
  const canSimulateEacces = process.platform !== "win32";

  it.skipIf(!canSimulateEacces)(
    "leaves state.loaded=false when the snapshot read fails with EACCES",
    async () => {
      // Seed an on-disk snapshot, then make it unreadable for the current
      // process. The first readAllCached should attempt to load and fail
      // (cold cache, no rehydration), but a subsequent call must retry the
      // load rather than returning the latched-empty state. The retry
      // succeeds once we restore permissions.
      await writeFile("a.md", "alpha");
      await readAllCached(vaultDir, ["a.md"]);
      await flushNow(vaultDir);
      await clearCache(vaultDir); // drop in-memory; snapshot remains on disk

      const snap = path.join(vaultDir, ".obsidian", "cache", "mcp-pro-index-cache.json");
      // 0o000: no read permission. fs.readFile will throw EACCES.
      await fs.chmod(snap, 0o000);

      try {
        // First call: load attempt fails. Cache must fall back to reading
        // the file fresh - we get a cacheMiss, not a rehydrated hit.
        const cold = await readAllCached(vaultDir, ["a.md"]);
        expect(cold.cacheMisses).toBe(1);
        expect(cold.cacheHits).toBe(0);

        // Restore permissions and call again. With the pre-fix code,
        // state.loaded was already true and the snapshot was never
        // re-attempted. With the fix, loaded stayed false on EACCES so this
        // call retries the load. We assert the retry path was taken by
        // spying on fs.readFile and checking it was called for the snapshot
        // file again.
        await fs.chmod(snap, 0o600);
        const readSpy = vi.spyOn(fs, "readFile");
        await readAllCached(vaultDir, ["a.md"]);
        const snapReads = readSpy.mock.calls.filter(
          (call) => typeof call[0] === "string" && call[0] === snap,
        );
        expect(snapReads.length).toBeGreaterThan(0);
      } finally {
        // Restore so afterEach can clean up.
        try {
          await fs.chmod(snap, 0o600);
        } catch {
          /* ignore */
        }
      }
    },
  );

  it.skipIf(canSimulateEacces)("placeholder on Windows where EACCES is hard to simulate", () => {
    // Documented skip: see comment above. On POSIX this test runs the real
    // EACCES path; on Windows we just record that the platform was excluded.
    expect(true).toBe(true);
  });
});
