import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { getVaultRootRealPath, resolveVaultInternalPathSafe, resolveVaultPathSafe } from "./vault.js";
import { mapConcurrent } from "./concurrency.js";
import { log } from "./logger.js";
import { renameWithRetry } from "./fs-ops.js";

/**
 * mtime-keyed content cache (in-memory + persistent).
 *
 * Vault-wide tools (get_tags, search_notes, find_orphans, …) repeatedly read
 * the same files. A cold scan of a 4k-note vault is dominated by realpath +
 * read syscalls; subsequent scans usually have a tiny working set of changed
 * files. This cache stat()'s each path, compares mtime against its last
 * cached read, and only re-reads files whose mtime has moved.
 *
 * The cache is keyed by absolute path so two vaults sharing the same process
 * don't poison each other's entries. Stale entries (paths the caller didn't
 * pass this round) are pruned at the end of every batch — easier than
 * tracking deletions, and the next call repopulates anything still live.
 *
 * Persistence: a JSON snapshot is written to
 * `<vault>/.obsidian/cache/mcp-pro-index-cache.json` so cold-start scans
 * after a server restart benefit from the prior session's reads. Every
 * persisted entry is re-validated against the current mtime before serving,
 * so external edits (Obsidian itself, sync clients, vim) invalidate the
 * relevant rows on the next call. Persistence can be disabled with
 * `OBSIDIAN_CACHE_DISABLED=1`.
 *
 * No watcher: stat is cheap (one syscall per file, no read), and a watcher
 * adds a moving part that complicates the SDK consumer / Obsidian-plugin
 * embedding paths. Upgrade later if profiling shows stat dominates.
 */

const READ_CONCURRENCY = 16;
const CACHE_FILE_VERSION = 1;
const CACHE_REL_PATH = ".obsidian/cache/mcp-pro-index-cache.json";
const FLUSH_DEBOUNCE_MS = 5_000;
const MAX_PERSISTED_BYTES = 64 * 1024 * 1024; // 64 MB safety cap

interface CacheEntry {
  /** Absolute path used as the cache key. */
  fullPath: string;
  /** Vault-relative path the caller asked for (preserved for callbacks). */
  relPath: string;
  /** Latest cached content. */
  content: string;
  /** mtime in milliseconds at the time content was last read. */
  mtimeMs: number;
}

interface VaultCacheState {
  entries: Map<string, CacheEntry>;
  /** True once we've attempted to load the on-disk snapshot for this vault. */
  loaded: boolean;
  /** True when entries have changed since the last successful flush. */
  dirty: boolean;
  /** Timer handle for the next debounced flush. Cleared when the flush runs
   *  or when the cache shuts down. */
  flushTimer: NodeJS.Timeout | null;
  /** Pending flush promise so concurrent triggers chain rather than race. */
  pendingFlush: Promise<void> | null;
}

const caches = new Map<string, VaultCacheState>(); // vaultRoot -> state

export function isPersistenceEnabled(): boolean {
  const v = process.env.OBSIDIAN_CACHE_DISABLED;
  return !(v === "1" || v === "true" || v === "yes");
}

function stateFor(vaultPath: string): VaultCacheState {
  const key = path.resolve(vaultPath);
  let s = caches.get(key);
  if (!s) {
    s = { entries: new Map(), loaded: false, dirty: false, flushTimer: null, pendingFlush: null };
    caches.set(key, s);
  }
  return s;
}

async function cacheFilePath(vaultPath: string): Promise<string> {
  return resolveVaultInternalPathSafe(vaultPath, CACHE_REL_PATH);
}

interface PersistedEntry {
  fullPath: string;
  content: string;
  mtimeMs: number;
}

interface PersistedSnapshot {
  version: number;
  vaultRoot: string;
  entries: Record<string, PersistedEntry>;
}

async function loadFromDisk(vaultPath: string, state: VaultCacheState): Promise<void> {
  if (state.loaded) return;
  if (!isPersistenceEnabled()) {
    state.loaded = true;
    return;
  }

  let file: string;
  try {
    file = await cacheFilePath(vaultPath);
  } catch (err) {
    log.warn("index-cache: snapshot path failed vault-boundary check", { err: err as Error });
    state.loaded = true;
    return;
  }
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // No snapshot yet — that's the normal first-run case. Mark loaded so we
      // don't keep stat'ing a missing file on every readAllCached call.
      state.loaded = true;
    } else {
      // Transient error (EACCES, EIO, EBUSY, …): leave loaded=false so the
      // next call can retry. Otherwise a single permission blip would force
      // the cache to run cold for the rest of the session.
      log.warn("index-cache: failed to read snapshot", { file, err: err as Error });
    }
    return;
  }
  // Past the read — whatever happens below (parse, shape check, vault-root
  // mismatch), the snapshot file is reachable and we've consumed it for this
  // session.
  state.loaded = true;
  let snapshot: PersistedSnapshot;
  try {
    snapshot = JSON.parse(raw) as PersistedSnapshot;
  } catch (err) {
    log.warn("index-cache: snapshot is not valid JSON; ignoring", { err: err as Error });
    return;
  }
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    snapshot.version !== CACHE_FILE_VERSION ||
    typeof snapshot.entries !== "object"
  ) {
    log.warn("index-cache: snapshot has unexpected shape; ignoring");
    return;
  }
  // Tolerate vault relocations: if the snapshot was written for a different
  // absolute root, drop it. mtime alone wouldn't catch a path move.
  const expectedRoot = path.resolve(vaultPath);
  if (snapshot.vaultRoot !== expectedRoot) {
    log.info("index-cache: snapshot vault root differs from current; discarding", {
      snapshotRoot: snapshot.vaultRoot,
      currentRoot: expectedRoot,
    });
    return;
  }
  let restored = 0;
  for (const [relPath, entry] of Object.entries(snapshot.entries)) {
    if (!entry || typeof entry.fullPath !== "string" || typeof entry.content !== "string") continue;
    if (typeof entry.mtimeMs !== "number") continue;
    state.entries.set(relPath, {
      fullPath: entry.fullPath,
      relPath,
      content: entry.content,
      mtimeMs: entry.mtimeMs,
    });
    restored++;
  }
  if (restored > 0) {
    log.debug("index-cache: snapshot restored", { vaultPath: expectedRoot, entries: restored });
  }
}

function scheduleFlush(vaultPath: string, state: VaultCacheState): void {
  if (!isPersistenceEnabled()) return;
  if (state.flushTimer) return;
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null;
    // Fire-and-forget; awaiting here would block the caller.
    void flushVaultCache(vaultPath, state).catch((err) => {
      log.warn("index-cache: flush failed", { err: err as Error });
    });
  }, FLUSH_DEBOUNCE_MS);
  // Don't keep the event loop alive solely for the flush — if the process
  // is otherwise idle, let it exit and rely on `flushAllCachesSync` from
  // the shutdown hook to persist any unsaved state.
  if (typeof state.flushTimer.unref === "function") state.flushTimer.unref();
}

async function flushVaultCache(vaultPath: string, state: VaultCacheState): Promise<void> {
  if (!isPersistenceEnabled()) return;
  // If another caller is already mid-flush, wait for that write to finish
  // and then re-check `dirty`. The previous version returned immediately
  // after awaiting, which lost any writes that arrived between the in-flight
  // flush's snapshot-capture and the second caller arriving — on shutdown
  // via flushAllCachesAsync those writes were silently dropped.
  if (state.pendingFlush) {
    await state.pendingFlush;
    // Fall through — do NOT return. We may need to start a fresh flush for
    // writes that the in-flight flush didn't capture.
  }
  // Another caller may have already claimed a follow-up flush while we were
  // awaiting above. Defer to it.
  if (state.pendingFlush) {
    await state.pendingFlush;
    return;
  }
  if (!state.dirty) return;
  state.pendingFlush = doFlush(vaultPath, state);
  try {
    await state.pendingFlush;
  } finally {
    state.pendingFlush = null;
  }
}

async function doFlush(vaultPath: string, state: VaultCacheState): Promise<void> {
  // Capture the snapshot synchronously, before any await, so concurrent
  // writes after this point cleanly flip `dirty` back to true and a future
  // flush picks them up. Clearing `dirty` before the snapshot would race
  // with such writes; clearing it after the write completes would leave
  // dirty=false for in-snapshot data while the snapshot was being written
  // (also racy in the other direction). Clear it here, between snapshot
  // build and the async write.
  const snapshot: PersistedSnapshot = {
    version: CACHE_FILE_VERSION,
    vaultRoot: path.resolve(vaultPath),
    entries: {},
  };
  let total = 0;
  // Build the JSON-serializable view. Skip pathologically large entries
  // so a single binary-ish note can't blow the cache file. Sort by content
  // length ascending so that small entries fill the budget first - Map
  // iteration order is insertion order, which would otherwise let a single
  // multi-MB note inserted early starve dozens of small notes from the
  // snapshot every flush.
  const sorted = Array.from(state.entries.entries()).sort(
    (a, b) => a[1].content.length - b[1].content.length,
  );
  for (const [rel, entry] of sorted) {
    total += entry.content.length;
    if (total > MAX_PERSISTED_BYTES) break;
    snapshot.entries[rel] = {
      fullPath: entry.fullPath,
      content: entry.content,
      mtimeMs: entry.mtimeMs,
    };
  }
  let file: string;
  try {
    file = await cacheFilePath(vaultPath);
  } catch (err) {
    state.dirty = true;
    log.warn("index-cache: snapshot path failed vault-boundary check", { err: err as Error });
    return;
  }
  // Snapshot is captured. From this point any setEntry will flip dirty back
  // to true and the next flushVaultCache call will see it.
  state.dirty = false;
  const dir = path.dirname(file);
  try {
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(snapshot), "utf-8");
    await renameWithRetry(tmp, file);
  } catch (err) {
    // Write failed - re-mark dirty so the next flush retries this data.
    state.dirty = true;
    log.warn("index-cache: failed to persist snapshot", { file, err: err as Error });
  }
}

export interface ReadAllResult {
  /** vault-relative path → latest content. Files that failed to read are
   *  omitted; callers that need to know about failures should pass an
   *  `onError` callback. */
  contents: Map<string, string>;
  /** Number of files whose content was reused from cache. */
  cacheHits: number;
  /** Number of files newly read (or re-read after mtime change). */
  cacheMisses: number;
}

/**
 * Read the latest content of every path in `relPaths`, using cached content
 * when mtime hasn't moved. Errors per file are reported via `onError` and
 * the file is omitted from the result map.
 */
export async function readAllCached(
  vaultPath: string,
  relPaths: readonly string[],
  onError?: (relPath: string, err: Error) => void,
): Promise<ReadAllResult> {
  const state = stateFor(vaultPath);
  await loadFromDisk(vaultPath, state);
  const cache = state.entries;
  const seen = new Set<string>();
  const contents = new Map<string, string>();
  let cacheHits = 0;
  let cacheMisses = 0;
  const realVaultRoot = await getVaultRootRealPath(vaultPath);

  await mapConcurrent(relPaths, READ_CONCURRENCY, async (relPath) => {
    seen.add(relPath);
    let fullPath: string;
    try {
      fullPath = await resolveVaultPathSafe(vaultPath, relPath, "read", { realVaultRoot });
    } catch (err) {
      onError?.(relPath, err as Error);
      return undefined;
    }
    let mtimeMs: number;
    try {
      const stat = await fs.stat(fullPath);
      mtimeMs = stat.mtimeMs;
    } catch (err) {
      // ENOENT during stat means the file disappeared between listing and
      // reading — drop the cache entry and skip.
      if (cache.delete(relPath)) state.dirty = true;
      onError?.(relPath, err as Error);
      return undefined;
    }
    const cached = cache.get(relPath);
    if (cached && cached.mtimeMs === mtimeMs && cached.fullPath === fullPath) {
      contents.set(relPath, cached.content);
      cacheHits++;
      return undefined;
    }
    let content: string;
    try {
      content = await fs.readFile(fullPath, "utf-8");
    } catch (err) {
      onError?.(relPath, err as Error);
      if (cache.delete(relPath)) state.dirty = true;
      return undefined;
    }
    cache.set(relPath, { fullPath, relPath, content, mtimeMs });
    state.dirty = true;
    contents.set(relPath, content);
    cacheMisses++;
    return undefined;
  });

  // Prune stale entries whose files no longer exist on disk. Previous
  // versions evicted every entry outside the current `seen` set, which
  // meant a folder-scoped call (e.g. reading only `folder-a/`) would
  // destroy cached entries for `folder-b/`, `folder-c/`, etc. Now we
  // only remove entries for files that have actually been deleted.
  const pruneKeys = Array.from(cache.keys()).filter((k) => !seen.has(k));
  await mapConcurrent(pruneKeys, READ_CONCURRENCY, async (key) => {
    const entry = cache.get(key);
    if (!entry) return;
    try {
      await fs.access(entry.fullPath);
    } catch {
      // File no longer exists on disk - evict the stale entry.
      cache.delete(key);
      state.dirty = true;
    }
  });

  if (state.dirty) scheduleFlush(vaultPath, state);

  return { contents, cacheHits, cacheMisses };
}

/** Synchronously flush all known caches to disk. Wired into the process
 *  shutdown hook so unsaved entries persist across normal exits. Best-effort:
 *  errors are swallowed because the process is already on its way out. */
export async function flushAllCachesAsync(): Promise<void> {
  if (!isPersistenceEnabled()) return;
  await Promise.all(
    Array.from(caches.entries()).map(async ([vaultRoot, state]) => {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      try {
        await flushVaultCache(vaultRoot, state);
      } catch {
        // best-effort; we're shutting down
      }
    }),
  );
}

/** Force an immediate flush for a single vault. Mainly useful for tests
 *  that want to assert on-disk state without waiting for the debounce. */
export async function flushNow(vaultPath: string): Promise<void> {
  const state = caches.get(path.resolve(vaultPath));
  if (!state) return;
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  await flushVaultCache(vaultPath, state);
}

/** For tests / hot reload: drop everything cached for a given vault.
 *  Does NOT delete the on-disk snapshot — pass `removeSnapshot: true` for
 *  that. */
export async function clearCache(
  vaultPath: string,
  options?: { removeSnapshot?: boolean },
): Promise<void> {
  const root = path.resolve(vaultPath);
  const state = caches.get(root);
  if (state?.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  caches.delete(root);
  if (options?.removeSnapshot) {
    try { await fs.unlink(await cacheFilePath(vaultPath)); } catch { /* ignore */ }
  }
}

/** For tests / debugging: total cached entries across all vaults. */
export function cacheSize(): number {
  let n = 0;
  for (const s of caches.values()) n += s.entries.size;
  return n;
}
