import fs from "fs/promises";
import path from "path";
import { createHash, randomBytes } from "crypto";
import { log } from "./logger.js";
import { isPersistenceEnabled } from "./index-cache.js";
import { resolveVaultInternalPathSafe } from "./vault.js";
import { renameWithRetry } from "./fs-ops.js";

/**
 * Persistent embedding store.
 *
 * Each entry is keyed by `<vault-relative-path>::<chunk-index>` and carries:
 *   - the embedding vector
 *   - a content hash (sha-256 of the chunk text) for incremental updates
 *   - the original chunk text (kept on disk so we can show snippets without
 *     re-reading the source note)
 *   - the headingPath the chunk came from
 *
 * Persistence: JSON snapshot at
 * `<vault>/.obsidian/cache/mcp-pro-embeddings.json`. Vector dimensionality
 * is captured on the snapshot envelope; switching providers or models
 * invalidates the entire store on the next load.
 *
 * Cosine similarity is brute-force across all chunks. For vaults under
 * ~10k notes this comfortably stays under 50ms with 768-dim vectors;
 * upgrade to HNSW if a real bottleneck appears.
 */

const STORE_REL_PATH = ".obsidian/cache/mcp-pro-embeddings.json";
const STORE_VERSION = 1;
const NOTE_BEST_CHUNK_WEIGHT = 0.8;
const NOTE_FOCUS_WEIGHT = 0.2;
const NOTE_FOCUS_CHUNKS = 3;
const SIMILAR_SOURCE_MIN_CHUNK_WEIGHT = 0.05;
const SIMILAR_SOURCE_ANCHOR_POWER = 2;
// Hard cap on the on-disk snapshot size. A 50k-note vault with 768-dim
// vectors can produce a multi-GB JSON blob, at which point persisting it
// each pass costs more than the cold-start re-embed it saves. When the
// serialized snapshot exceeds this, we keep the in-memory store live and
// skip the write; the next process start re-indexes from scratch. 256MB
// covers ~85k chunks at 768 dims (rough), which is well past the point
// where a user should switch to a real vector DB anyway.
const MAX_EMBEDDING_BYTES_DEFAULT = 256 * 1024 * 1024;
let maxEmbeddingBytes = MAX_EMBEDDING_BYTES_DEFAULT;
/** Test seam — temporarily lower the persistence cap so we can exercise the
 *  oversize branch without producing a real 256MB fixture. Pass `null` to
 *  reset to the production default. */
export function setMaxEmbeddingBytesForTests(bytes: number | null): void {
  maxEmbeddingBytes = bytes === null ? MAX_EMBEDDING_BYTES_DEFAULT : bytes;
}

export interface ChunkEmbedding {
  /** vault-relative note path. */
  notePath: string;
  /** 1-indexed chunk number within the note. */
  chunkIndex: number;
  /** Heading path the chunk came from. Empty for pre-heading content. */
  headingPath: string[];
  /** The embedded text (kept on disk so we can show snippets). */
  text: string;
  /** sha-256 of the chunk text — used for incremental updates. */
  hash: string;
  /** The vector itself. */
  vector: number[];
}

interface StoreSnapshot {
  version: number;
  vaultRoot: string;
  providerId: string;
  model: string;
  dimension: number;
  /** Per-note hash of all chunks concatenated, for fast skip-on-unchanged. */
  noteHashes: Record<string, string>;
  embeddings: ChunkEmbedding[];
}

interface StoreState {
  byKey: Map<string, ChunkEmbedding>;
  /** Per-note: chunk keys it owns. Lets us drop a note's old chunks
   *  efficiently when it changes. */
  byNote: Map<string, Set<string>>;
  /** Per-note hash, used to short-circuit re-chunk + re-embed when a note
   *  hasn't changed since the last index. */
  noteHashes: Map<string, string>;
  loaded: boolean;
  dirty: boolean;
  /** Cached promise so concurrent callers await the same load. */
  loadingPromise: Promise<StoreState> | null;
  /** True while a saveStore write is in progress. */
  saving: boolean;
  /** True if another save was requested while one was already in flight. */
  saveAgain: boolean;
  providerId: string | null;
  model: string | null;
  dimension: number | null;
}

const stores = new Map<string, StoreState>(); // resolved vault root -> state

function freshState(): StoreState {
  return {
    byKey: new Map(),
    byNote: new Map(),
    noteHashes: new Map(),
    loaded: false,
    dirty: false,
    loadingPromise: null,
    saving: false,
    saveAgain: false,
    providerId: null,
    model: null,
    dimension: null,
  };
}

function stateFor(vaultPath: string): StoreState {
  const root = path.resolve(vaultPath);
  let s = stores.get(root);
  if (!s) {
    s = freshState();
    stores.set(root, s);
  }
  return s;
}

function storePath(vaultPath: string): Promise<string> {
  return resolveVaultInternalPathSafe(vaultPath, STORE_REL_PATH);
}

function key(notePath: string, chunkIndex: number): string {
  return `${notePath}::${chunkIndex}`;
}

function validateVector(vector: unknown, expectedDimension: number | null): string | null {
  if (!Array.isArray(vector) || vector.length === 0) return "vector must be a non-empty number array";
  for (const value of vector) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return "vector contains a non-finite value";
    }
  }
  if (expectedDimension !== null && vector.length !== expectedDimension) {
    return `vector dimension mismatch (expected ${expectedDimension}, got ${vector.length})`;
  }
  return null;
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

export async function loadStore(vaultPath: string): Promise<StoreState> {
  const state = stateFor(vaultPath);
  if (state.loaded) return state;
  // If another caller is already loading, await the same promise instead of
  // starting a parallel read that would race against it.
  if (state.loadingPromise) return state.loadingPromise;

  const doLoad = async (): Promise<StoreState> => {
    if (!isPersistenceEnabled()) {
      state.loaded = true;
      state.loadingPromise = null;
      return state;
    }
    let raw: string;
    try {
      raw = await fs.readFile(await storePath(vaultPath), "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("embedding-store: failed to read snapshot", { err: err as Error });
      }
      state.loaded = true;
      state.loadingPromise = null;
      return state;
    }
    let snapshot: StoreSnapshot;
    try {
      snapshot = JSON.parse(raw) as StoreSnapshot;
    } catch (err) {
      log.warn("embedding-store: snapshot is invalid JSON; ignoring", { err: err as Error });
      state.loaded = true;
      state.loadingPromise = null;
      return state;
    }
    if (
      !snapshot ||
      snapshot.version !== STORE_VERSION ||
      !Array.isArray(snapshot.embeddings) ||
      typeof snapshot.providerId !== "string" ||
      typeof snapshot.model !== "string" ||
      typeof snapshot.dimension !== "number"
    ) {
      log.warn("embedding-store: snapshot has unexpected shape; ignoring");
      state.loaded = true;
      state.loadingPromise = null;
      return state;
    }
    const expectedRoot = path.resolve(vaultPath);
    if (snapshot.vaultRoot !== expectedRoot) {
      log.info("embedding-store: snapshot vault root differs; discarding", {
        snapshotRoot: snapshot.vaultRoot,
        currentRoot: expectedRoot,
      });
      state.loaded = true;
      state.loadingPromise = null;
      return state;
    }
    state.providerId = snapshot.providerId;
    state.model = snapshot.model;
    state.dimension = snapshot.dimension;
    for (const entry of snapshot.embeddings) {
      if (!entry || !Array.isArray(entry.vector)) continue;
      // Silently drop entries whose vector length doesn't match the snapshot's
      // declared dimension. Guards against hand-edited or partially-corrupted
      // snapshots where one row's length drifted from the rest.
      if (validateVector(entry.vector, snapshot.dimension) !== null) continue;
      state.byKey.set(key(entry.notePath, entry.chunkIndex), entry);
      let owned = state.byNote.get(entry.notePath);
      if (!owned) {
        owned = new Set();
        state.byNote.set(entry.notePath, owned);
      }
      owned.add(key(entry.notePath, entry.chunkIndex));
    }
    for (const [note, hash] of Object.entries(snapshot.noteHashes ?? {})) {
      if (typeof hash === "string" && state.byNote.has(note)) state.noteHashes.set(note, hash);
    }
    // Mark loaded only AFTER all async I/O and parsing is complete.
    state.loaded = true;
    state.loadingPromise = null;
    return state;
  };

  state.loadingPromise = doLoad();
  return state.loadingPromise;
}

export async function saveStore(vaultPath: string): Promise<void> {
  const state = stateFor(vaultPath);
  if (!state.dirty) return;
  if (state.providerId === null || state.model === null) return; // nothing valid to write
  if (!isPersistenceEnabled()) {
    state.dirty = false;
    return;
  }

  // If a save is already in flight, mark that another pass is needed and
  // return. The in-flight save will re-check the flag when it finishes.
  if (state.saving) {
    state.saveAgain = true;
    return;
  }

  state.saving = true;
  try {
    await doSave(vaultPath, state);
  } finally {
    state.saving = false;
  }

  // If someone requested another save while we were writing, run one more
  // pass to pick up any changes that arrived after we serialized.
  if (state.saveAgain) {
    state.saveAgain = false;
    await saveStore(vaultPath);
  }
}

async function doSave(vaultPath: string, state: StoreState): Promise<void> {
  const snapshot: StoreSnapshot = {
    version: STORE_VERSION,
    vaultRoot: path.resolve(vaultPath),
    providerId: state.providerId!,
    model: state.model!,
    dimension: state.dimension ?? 0,
    noteHashes: Object.fromEntries(state.noteHashes),
    embeddings: Array.from(state.byKey.values()),
  };
  const serialized = JSON.stringify(snapshot);
  // Guard against unbounded on-disk growth. Serialize once, measure the
  // result, and refuse to persist if it would exceed MAX_EMBEDDING_BYTES.
  // The in-memory store stays intact (current-process queries still work);
  // we just degrade cold-start performance until the user prunes the vault
  // or switches to a dedicated vector backend. `Buffer.byteLength` on the
  // UTF-8 string gives the actual write size, not the JS string length.
  const byteLength = Buffer.byteLength(serialized, "utf-8");
  if (byteLength > maxEmbeddingBytes) {
    log.warn("embedding-store: snapshot exceeds MAX_EMBEDDING_BYTES, persistence skipped", {
      bytes: byteLength,
      max: maxEmbeddingBytes,
      chunks: state.byKey.size,
      notes: state.byNote.size,
    });
    return;
  }
  let file: string;
  try {
    file = await storePath(vaultPath);
  } catch (err) {
    log.warn("embedding-store: snapshot path failed vault-boundary check", { err: err as Error });
    return;
  }
  // Include a random suffix so two concurrent saves in the same process
  // (same PID) don't fight over the same tmp file and clobber each other.
  const tmp = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    try {
      await fs.writeFile(tmp, serialized, { encoding: "utf-8", mode: 0o600 });
      await renameWithRetry(tmp, file);
    } catch (innerErr) {
      // Best-effort cleanup: if writeFile succeeded but rename failed, the
      // tmp file is still on disk. ENOENT (writeFile never created it) is
      // fine to swallow here.
      try { await fs.unlink(tmp); } catch { /* ignore */ }
      throw innerErr;
    }
    state.dirty = false;
  } catch (err) {
    log.warn("embedding-store: failed to persist snapshot", { err: err as Error });
  }
}

/** Drop everything we know about this vault. The next `loadStore` re-reads
 *  from disk; pass `removeSnapshot: true` to also unlink the snapshot file
 *  (e.g. when the user wants to fully reset the index). */
export async function clearStore(
  vaultPath: string,
  options?: { removeSnapshot?: boolean },
): Promise<void> {
  stores.delete(path.resolve(vaultPath));
  if (options?.removeSnapshot) {
    try { await fs.unlink(await storePath(vaultPath)); } catch { /* ignore */ }
  }
}

/** Drop a snapshot incompatible with the current provider/model (different
 *  dimension or label). Called by the indexer at startup. */
export function invalidateIfIncompatible(
  vaultPath: string,
  providerId: string,
  model: string,
): void {
  const state = stateFor(vaultPath);
  if (!state.loaded) return;
  if (state.providerId === providerId && state.model === model) return;
  state.byKey.clear();
  state.byNote.clear();
  state.noteHashes.clear();
  state.providerId = providerId;
  state.model = model;
  state.dimension = null;
  state.dirty = true;
}

/** Has the given note's content changed since the last index pass? */
export function noteIsCurrent(vaultPath: string, notePath: string, contentHash: string): boolean {
  const state = stateFor(vaultPath);
  return state.noteHashes.get(notePath) === contentHash;
}

/** Replace all chunks for `notePath`. Pass empty `chunks` to drop a note. */
export function setNoteChunks(
  vaultPath: string,
  notePath: string,
  contentHash: string,
  chunks: ChunkEmbedding[],
  providerId: string,
  model: string,
): void {
  const state = stateFor(vaultPath);
  let nextDimension = state.dimension;
  for (const ch of chunks) {
    const error = validateVector(ch.vector, nextDimension);
    if (error !== null) {
      throw new Error(`Invalid embedding for ${ch.notePath}#${ch.chunkIndex}: ${error}`);
    }
    if (nextDimension === null) nextDimension = ch.vector.length;
  }
  // Drop any prior chunks owned by this note.
  const prior = state.byNote.get(notePath);
  if (prior) {
    for (const k of prior) state.byKey.delete(k);
  }
  if (chunks.length === 0) {
    state.byNote.delete(notePath);
    state.noteHashes.delete(notePath);
  } else {
    const owned = new Set<string>();
    for (const ch of chunks) {
      const k = key(ch.notePath, ch.chunkIndex);
      state.byKey.set(k, ch);
      owned.add(k);
    }
    state.dimension = nextDimension;
    state.byNote.set(notePath, owned);
    state.noteHashes.set(notePath, contentHash);
  }
  state.providerId = providerId;
  state.model = model;
  state.dirty = true;
}

/** Drop chunks for notes that no longer exist in the vault. Called at the
 *  end of an index pass. */
export function pruneMissingNotes(vaultPath: string, currentNotes: Iterable<string>): number {
  const state = stateFor(vaultPath);
  const live = new Set<string>(currentNotes);
  let pruned = 0;
  for (const note of Array.from(state.byNote.keys())) {
    if (live.has(note)) continue;
    const owned = state.byNote.get(note);
    if (owned) {
      for (const k of owned) state.byKey.delete(k);
    }
    state.byNote.delete(note);
    state.noteHashes.delete(note);
    pruned++;
  }
  if (pruned > 0) state.dirty = true;
  return pruned;
}

export function snapshotForTests(vaultPath: string): {
  totalChunks: number;
  totalNotes: number;
  providerId: string | null;
  model: string | null;
  dimension: number | null;
} {
  const state = stateFor(vaultPath);
  return {
    totalChunks: state.byKey.size,
    totalNotes: state.byNote.size,
    providerId: state.providerId,
    model: state.model,
    dimension: state.dimension,
  };
}

// ─── cosine similarity + search ─────────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `cosineSimilarity: dimension mismatch (a.length=${a.length}, b.length=${b.length})`,
    );
  }
  if (a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface SearchHit {
  notePath: string;
  chunkIndex: number;
  headingPath: string[];
  text: string;
  score: number;
}

export interface SearchOptions {
  limit?: number;
  /** Restrict to a folder prefix. */
  folder?: string;
  /** Excluded note paths — used by `find_similar_notes` to drop the source
   *  note from its own results. */
  excludeNotes?: ReadonlySet<string>;
  /** Optional policy check applied before scoring/ranking each stored note. */
  filterNote?: (notePath: string) => boolean;
}

export function searchEmbeddings(
  vaultPath: string,
  queryVector: number[],
  options: SearchOptions = {},
): SearchHit[] {
  const state = stateFor(vaultPath);
  const limit = options.limit ?? 10;
  const folder = options.folder
    ? options.folder.replace(/^\/+|\/+$/g, "")
    : null;
  const exclude = options.excludeNotes ?? null;
  const filterNote = options.filterNote ?? null;

  const hits: SearchHit[] = [];
  for (const entry of state.byKey.values()) {
    if (folder !== null) {
      if (entry.notePath !== folder && !entry.notePath.startsWith(folder + "/")) continue;
    }
    if (exclude && exclude.has(entry.notePath)) continue;
    if (filterNote && !filterNote(entry.notePath)) continue;
    const score = cosineSimilarity(queryVector, entry.vector);
    hits.push({
      notePath: entry.notePath,
      chunkIndex: entry.chunkIndex,
      headingPath: entry.headingPath,
      text: entry.text,
      score,
    });
  }
  // Per-note ranking: keep the highest-scoring chunk for the snippet, but
  // sort notes with a small focus signal from their top chunks. This avoids
  // one incidental perfect chunk outranking notes that are consistently about
  // the query.
  const byNote = new Map<string, { best: SearchHit; scores: number[] }>();
  for (const h of hits) {
    const existing = byNote.get(h.notePath);
    if (!existing) {
      byNote.set(h.notePath, { best: h, scores: [h.score] });
    } else {
      existing.scores.push(h.score);
      if (h.score > existing.best.score) existing.best = h;
    }
  }
  const out = Array.from(byNote.values()).map(({ best, scores }) => {
    const score = noteFocusScore(scores);
    return { ...best, score };
  }).sort((a, b) => {
    const scoreDelta = b.score - a.score;
    if (scoreDelta !== 0) return scoreDelta;
    return a.notePath.localeCompare(b.notePath);
  });
  return out.slice(0, limit);
}

function noteFocusScore(scores: number[]): number {
  const sorted = scores.toSorted((a, b) => b - a);
  const top = sorted.slice(0, NOTE_FOCUS_CHUNKS);
  const best = top[0] ?? 0;
  const focus = top.reduce((sum, score) => sum + score, 0) / top.length;
  return NOTE_BEST_CHUNK_WEIGHT * best + NOTE_FOCUS_WEIGHT * focus;
}

export function buildSimilarNotesQueryVector(chunks: readonly ChunkEmbedding[]): number[] {
  const firstChunk = chunks[0];
  if (!firstChunk) return [];

  const dim = firstChunk.vector.length;
  const anchor = firstChunk.vector;
  const out = new Array<number>(dim).fill(0);
  let totalWeight = 0;

  for (const chunk of chunks) {
    const anchorSimilarity = Math.max(0, cosineSimilarity(anchor, chunk.vector));
    const weight = chunk === firstChunk
      ? 1
      : Math.max(SIMILAR_SOURCE_MIN_CHUNK_WEIGHT, anchorSimilarity ** SIMILAR_SOURCE_ANCHOR_POWER);
    for (let d = 0; d < dim; d++) {
      out[d] = out[d]! + chunk.vector[d]! * weight;
    }
    totalWeight += weight;
  }

  if (totalWeight === 0) return out;
  for (let d = 0; d < dim; d++) {
    out[d] = out[d]! / totalWeight;
  }
  return out;
}

/** Get the embeddings owned by a specific note (used by find_similar). */
export function getNoteEmbeddings(vaultPath: string, notePath: string): ChunkEmbedding[] {
  const state = stateFor(vaultPath);
  const owned = state.byNote.get(notePath);
  if (!owned) return [];
  const out: ChunkEmbedding[] = [];
  for (const k of owned) {
    const e = state.byKey.get(k);
    if (e) out.push(e);
  }
  return out;
}
