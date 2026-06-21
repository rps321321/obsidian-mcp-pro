import fs from "fs/promises";
import path from "path";
import {
  assertNoteFileSize,
  getVaultRootRealPath,
  openVaultFileForRead,
  resolveVaultInternalPathSafe,
} from "./vault.js";
import { mapConcurrent } from "./concurrency.js";
import { log } from "./logger.js";

/**
 * mtime-keyed content cache (in-memory only).
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
 * Disk snapshots used to live at
 * `<vault>/.obsidian/cache/mcp-pro-index-cache.json`. They carried full note
 * bodies, and because that path is vault-local, a snapshot could not prove its
 * text still matched the live note without reading the note again. The cache
 * now stays in memory and best-effort deletes legacy snapshots on first use.
 *
 * No watcher: stat is cheap (one syscall per file, no read), and a watcher
 * adds a moving part that complicates the SDK consumer / Obsidian-plugin
 * embedding paths. Upgrade later if profiling shows stat dominates.
 */

const READ_CONCURRENCY = 16;
const CACHE_REL_PATH = ".obsidian/cache/mcp-pro-index-cache.json";

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

export interface CachedFileStats {
  size: number;
  ctime: number;
  mtime: number;
}

interface VaultCacheState {
  entries: Map<string, CacheEntry>;
  /** True once we've attempted legacy snapshot cleanup for this vault. */
  loaded: boolean;
  /** True when entries have changed since the last legacy cleanup. */
  dirty: boolean;
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
    s = { entries: new Map(), loaded: false, dirty: false };
    caches.set(key, s);
  }
  return s;
}

async function cacheFilePath(vaultPath: string): Promise<string> {
  return resolveVaultInternalPathSafe(vaultPath, CACHE_REL_PATH);
}

async function loadFromDisk(vaultPath: string, state: VaultCacheState): Promise<void> {
  if (state.loaded) return;
  state.loaded = true;
  await removeLegacySnapshot(vaultPath);
}

async function removeLegacySnapshot(vaultPath: string): Promise<void> {
  let file: string;
  try {
    file = await cacheFilePath(vaultPath);
  } catch (err) {
    log.warn("index-cache: snapshot path failed vault-boundary check", { err: err as Error });
    return;
  }
  try {
    await fs.unlink(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      log.warn("index-cache: failed to remove legacy snapshot", { file, err: err as Error });
    }
    return;
  }
  log.debug("index-cache: removed legacy persistent snapshot", { file });
}

async function flushVaultCache(vaultPath: string, state: VaultCacheState): Promise<void> {
  state.dirty = false;
  await removeLegacySnapshot(vaultPath);
}

export interface ReadAllResult {
  /** vault-relative path → latest content. Files that failed to read are
   *  omitted; callers that need to know about failures should pass an
   *  `onError` callback. */
  contents: Map<string, string>;
  /** vault-relative path -> stat mtime in whole milliseconds. */
  mtimes: Map<string, number>;
  /** vault-relative path -> stat fields collected before each read/cache hit. */
  stats: Map<string, CachedFileStats>;
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
  const mtimes = new Map<string, number>();
  const statsByPath = new Map<string, CachedFileStats>();
  let cacheHits = 0;
  let cacheMisses = 0;
  const realVaultRoot = await getVaultRootRealPath(vaultPath);

  await mapConcurrent(relPaths, READ_CONCURRENCY, async (relPath) => {
    seen.add(relPath);
    let fullPath: string;
    let opened: Awaited<ReturnType<typeof openVaultFileForRead>> | undefined;
    try {
      opened = await openVaultFileForRead(vaultPath, relPath, "read", { realVaultRoot });
      fullPath = opened.fullPath;
    } catch (err) {
      onError?.(relPath, err as Error);
      return undefined;
    }
    if (!opened) return undefined;
    const openedFile = opened;
    let mtimeMs: number;
    try {
      const stat = openedFile.stats;
      assertNoteFileSize(relPath, stat.size);
      mtimeMs = stat.mtimeMs;
      mtimes.set(relPath, stat.mtime.getTime());
      statsByPath.set(relPath, {
        size: stat.size,
        ctime: stat.ctimeMs,
        mtime: stat.mtimeMs,
      });
    } catch (err) {
      await openedFile.handle.close();
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
      await openedFile.handle.close();
      return undefined;
    }
    let content: string;
    try {
      content = await openedFile.handle.readFile("utf-8");
    } catch (err) {
      onError?.(relPath, err as Error);
      if (cache.delete(relPath)) state.dirty = true;
      return undefined;
    } finally {
      await openedFile.handle.close();
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

  return { contents, mtimes, stats: statsByPath, cacheHits, cacheMisses };
}

/** Best-effort cleanup for legacy disk snapshots during shutdown. */
export async function flushAllCachesAsync(): Promise<void> {
  await Promise.all(
    Array.from(caches.entries()).map(async ([vaultRoot, state]) => {
      try {
        await flushVaultCache(vaultRoot, state);
      } catch {
        // best-effort; we're shutting down
      }
    }),
  );
}

/** Force immediate legacy snapshot cleanup for a single vault. */
export async function flushNow(vaultPath: string): Promise<void> {
  const state = caches.get(path.resolve(vaultPath));
  if (!state) {
    await removeLegacySnapshot(vaultPath);
    return;
  }
  await flushVaultCache(vaultPath, state);
}

/** For tests / hot reload: drop everything cached for a given vault.
 *  Pass `removeSnapshot: true` to also delete a legacy disk snapshot. */
export async function clearCache(
  vaultPath: string,
  options?: { removeSnapshot?: boolean },
): Promise<void> {
  const root = path.resolve(vaultPath);
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
