import fs from "fs/promises";
import path from "path";
import { createHash } from "crypto";
import { log } from "./logger.js";

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

function storePath(vaultPath: string): string {
  return path.join(path.resolve(vaultPath), STORE_REL_PATH);
}

function key(notePath: string, chunkIndex: number): string {
  return `${notePath}::${chunkIndex}`;
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

export async function loadStore(vaultPath: string): Promise<StoreState> {
  const state = stateFor(vaultPath);
  if (state.loaded) return state;
  state.loaded = true;

  let raw: string;
  try {
    raw = await fs.readFile(storePath(vaultPath), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("embedding-store: failed to read snapshot", { err: err as Error });
    }
    return state;
  }
  let snapshot: StoreSnapshot;
  try {
    snapshot = JSON.parse(raw) as StoreSnapshot;
  } catch (err) {
    log.warn("embedding-store: snapshot is invalid JSON; ignoring", { err: err as Error });
    return state;
  }
  if (
    !snapshot ||
    snapshot.version !== STORE_VERSION ||
    !Array.isArray(snapshot.embeddings) ||
    typeof snapshot.providerId !== "string" ||
    typeof snapshot.model !== "string"
  ) {
    log.warn("embedding-store: snapshot has unexpected shape; ignoring");
    return state;
  }
  const expectedRoot = path.resolve(vaultPath);
  if (snapshot.vaultRoot !== expectedRoot) {
    log.info("embedding-store: snapshot vault root differs; discarding", {
      snapshotRoot: snapshot.vaultRoot,
      currentRoot: expectedRoot,
    });
    return state;
  }
  state.providerId = snapshot.providerId;
  state.model = snapshot.model;
  state.dimension = snapshot.dimension;
  for (const entry of snapshot.embeddings) {
    if (!entry || !Array.isArray(entry.vector)) continue;
    state.byKey.set(key(entry.notePath, entry.chunkIndex), entry);
    let owned = state.byNote.get(entry.notePath);
    if (!owned) {
      owned = new Set();
      state.byNote.set(entry.notePath, owned);
    }
    owned.add(key(entry.notePath, entry.chunkIndex));
  }
  for (const [note, hash] of Object.entries(snapshot.noteHashes ?? {})) {
    if (typeof hash === "string") state.noteHashes.set(note, hash);
  }
  return state;
}

export async function saveStore(vaultPath: string): Promise<void> {
  const state = stateFor(vaultPath);
  if (!state.dirty) return;
  if (state.providerId === null || state.model === null) return; // nothing valid to write
  const snapshot: StoreSnapshot = {
    version: STORE_VERSION,
    vaultRoot: path.resolve(vaultPath),
    providerId: state.providerId,
    model: state.model,
    dimension: state.dimension ?? 0,
    noteHashes: Object.fromEntries(state.noteHashes),
    embeddings: Array.from(state.byKey.values()),
  };
  const file = storePath(vaultPath);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(snapshot), "utf-8");
    await fs.rename(tmp, file);
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
    try { await fs.unlink(storePath(vaultPath)); } catch { /* ignore */ }
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
      if (state.dimension === null) state.dimension = ch.vector.length;
    }
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
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
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

  const hits: SearchHit[] = [];
  for (const entry of state.byKey.values()) {
    if (folder !== null) {
      if (entry.notePath !== folder && !entry.notePath.startsWith(folder + "/")) continue;
    }
    if (exclude && exclude.has(entry.notePath)) continue;
    const score = cosineSimilarity(queryVector, entry.vector);
    hits.push({
      notePath: entry.notePath,
      chunkIndex: entry.chunkIndex,
      headingPath: entry.headingPath,
      text: entry.text,
      score,
    });
  }
  // Per-note dedup: keep the highest-scoring chunk per note. The semantic
  // search tool surfaces note-level results; chunk-level granularity is
  // available through the score breakdown but rarely useful for ranking.
  const bestPerNote = new Map<string, SearchHit>();
  for (const h of hits) {
    const existing = bestPerNote.get(h.notePath);
    if (!existing || h.score > existing.score) {
      bestPerNote.set(h.notePath, h);
    }
  }
  const out = Array.from(bestPerNote.values()).sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
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
