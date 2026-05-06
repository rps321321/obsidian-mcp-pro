import fs from "fs/promises";
import path from "path";
import { resolveVaultPathSafe } from "./vault.js";
import { mapConcurrent } from "./concurrency.js";
import { log } from "./logger.js";

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

function isPersistenceEnabled(): boolean {
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

function cacheFilePath(vaultPath: string): string {
  return path.join(path.resolve(vaultPath), CACHE_REL_PATH);
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
  state.loaded = true;
  if (!isPersistenceEnabled()) return;

  const file = cacheFilePath(vaultPath);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("index-cache: failed to read snapshot", { file, err: err as Error });
    }
    return;
  }
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
  // Serialize concurrent flushes — without this, two debounce timers firing
  // close together could both write to the same file.
  if (state.pendingFlush) {
    await state.pendingFlush;
    return;
  }
  if (!state.dirty) return;
  state.pendingFlush = (async () => {
    state.dirty = false;
    const snapshot: PersistedSnapshot = {
      version: CACHE_FILE_VERSION,
      vaultRoot: path.resolve(vaultPath),
      entries: {},
    };
    let total = 0;
    // Build the JSON-serializable view. Skip pathologically large entries
    // so a single binary-ish note can't blow the cache file. Sort by content
    // length ascending so that small entries fill the budget first — Map
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
    const file = cacheFilePath(vaultPath);
    const dir = path.dirname(file);
    try {
      await fs.mkdir(dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(snapshot), "utf-8");
      await fs.rename(tmp, file);
    } catch (err) {
      // Mark dirty again so a later flush can retry.
      state.dirty = true;
      log.warn("index-cache: failed to persist snapshot", { file, err: err as Error });
    }
  })();
  try {
    await state.pendingFlush;
  } finally {
    state.pendingFlush = null;
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

  await mapConcurrent(relPaths, READ_CONCURRENCY, async (relPath) => {
    seen.add(relPath);
    let fullPath: string;
    try {
      fullPath = await resolveVaultPathSafe(vaultPath, relPath);
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

  // Prune entries that weren't asked for this round. This stops the cache
  // from holding stale paths after a vault reorg or folder filter change.
  for (const key of cache.keys()) {
    if (!seen.has(key)) {
      cache.delete(key);
      state.dirty = true;
    }
  }

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
    try { await fs.unlink(cacheFilePath(vaultPath)); } catch { /* ignore */ }
  }
}

/** For tests / debugging: total cached entries across all vaults. */
export function cacheSize(): number {
  let n = 0;
  for (const s of caches.values()) n += s.entries.size;
  return n;
}
