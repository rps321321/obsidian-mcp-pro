import fs from "fs/promises";
import path from "path";
import { createHash, randomBytes } from "crypto";
import { log } from "./logger.js";
import {
  openVaultInternalFileForRead,
  resolveVaultInternalPathSafe,
} from "./vault-fs.js";
import { renameWithRetry } from "./fs-ops.js";

/**
 * Persistent embedding store.
 *
 * Each handle is bound to exactly one resolved vault root and owns all mutable
 * index state for that vault. There is intentionally no module-global vault
 * registry: callers open one handle and share it across the semantic tools.
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
const MAX_EMBEDDING_BYTES_DEFAULT = 256 * 1024 * 1024;

/** Whether the embedding store may persist to disk. Disabled via
 * `OBSIDIAN_CACHE_DISABLED` (`1`/`true`/`yes`). */
function isPersistenceEnabled(): boolean {
  const v = process.env.OBSIDIAN_CACHE_DISABLED;
  return !(v === "1" || v === "true" || v === "yes");
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

export interface EmbeddingStoreStats {
  totalChunks: number;
  totalNotes: number;
  providerId: string | null;
  model: string | null;
  dimension: number | null;
}

export interface EmbeddingStoreOptions {
  /** Persistence cap for this handle. Intended primarily for tests/embedders
   * that need a stricter local cap; defaults to 256 MiB. */
  maxEmbeddingBytes?: number;
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

function key(notePath: string, chunkIndex: number): string {
  return `${notePath}::${chunkIndex}`;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isSnapshotEntry(entry: unknown): entry is ChunkEmbedding {
  if (!entry || typeof entry !== "object") return false;
  const candidate = entry as Partial<ChunkEmbedding>;
  return (
    typeof candidate.notePath === "string" &&
    candidate.notePath.length > 0 &&
    isPositiveInteger(candidate.chunkIndex) &&
    Array.isArray(candidate.headingPath) &&
    candidate.headingPath.every(
      (part): part is string => typeof part === "string"
    ) &&
    typeof candidate.text === "string" &&
    typeof candidate.hash === "string" &&
    Array.isArray(candidate.vector)
  );
}

export function validateEmbeddingVector(
  vector: unknown,
  expectedDimension: number | null
): string | null {
  if (!Array.isArray(vector) || vector.length === 0)
    return "vector must be a non-empty number array";
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

/**
 * A single-vault embedding index handle.
 *
 * Construction is synchronous and side-effect free. Call `load()` before
 * using persisted state; concurrent `load()` callers share one in-flight
 * promise. The handle is deliberately stateful so the ownership boundary is
 * explicit instead of hidden behind module globals.
 */
export class EmbeddingStore {
  readonly vaultPath: string;
  private readonly maxEmbeddingBytes: number;

  private readonly byKey = new Map<string, ChunkEmbedding>();
  private readonly byNote = new Map<string, Set<string>>();
  private readonly noteHashes = new Map<string, string>();

  private loaded = false;
  private dirty = false;
  private loadingPromise: Promise<void> | null = null;
  private saving = false;
  private saveAgain = false;
  private providerId: string | null = null;
  private model: string | null = null;
  private dimension: number | null = null;

  private constructor(vaultPath: string, options: EmbeddingStoreOptions = {}) {
    this.vaultPath = path.resolve(vaultPath);
    this.maxEmbeddingBytes =
      options.maxEmbeddingBytes ?? MAX_EMBEDDING_BYTES_DEFAULT;
  }

  static open(
    vaultPath: string,
    options: EmbeddingStoreOptions = {}
  ): EmbeddingStore {
    return new EmbeddingStore(vaultPath, options);
  }

  private storePath(): Promise<string> {
    return resolveVaultInternalPathSafe(this.vaultPath, STORE_REL_PATH);
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loadingPromise) return this.loadingPromise;

    const pending = this.loadFromDisk();
    this.loadingPromise = pending;
    try {
      await pending;
    } finally {
      if (this.loadingPromise === pending) this.loadingPromise = null;
    }
  }

  private async loadFromDisk(): Promise<void> {
    if (!isPersistenceEnabled()) {
      this.loaded = true;
      return;
    }

    let raw: string;
    try {
      const opened = await openVaultInternalFileForRead(
        this.vaultPath,
        STORE_REL_PATH
      );
      const stat = opened.stats;
      if (stat.size > this.maxEmbeddingBytes) {
        await opened.handle.close();
        log.warn(
          "embedding-store: snapshot exceeds MAX_EMBEDDING_BYTES; ignoring",
          {
            bytes: stat.size,
            max: this.maxEmbeddingBytes,
          }
        );
        this.loaded = true;
        return;
      }
      try {
        raw = await opened.handle.readFile("utf-8");
      } finally {
        await opened.handle.close();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("embedding-store: failed to read snapshot", {
          err: err as Error,
        });
      }
      this.loaded = true;
      return;
    }

    let snapshot: StoreSnapshot;
    try {
      snapshot = JSON.parse(raw) as StoreSnapshot;
    } catch (err) {
      log.warn("embedding-store: snapshot is invalid JSON; ignoring", {
        err: err as Error,
      });
      this.loaded = true;
      return;
    }

    if (
      !snapshot ||
      snapshot.version !== STORE_VERSION ||
      !Array.isArray(snapshot.embeddings) ||
      typeof snapshot.providerId !== "string" ||
      typeof snapshot.model !== "string" ||
      !isPositiveInteger(snapshot.dimension)
    ) {
      log.warn("embedding-store: snapshot has unexpected shape; ignoring");
      this.loaded = true;
      return;
    }

    if (snapshot.vaultRoot !== this.vaultPath) {
      log.info("embedding-store: snapshot vault root differs; discarding", {
        snapshotRoot: snapshot.vaultRoot,
        currentRoot: this.vaultPath,
      });
      this.loaded = true;
      return;
    }

    this.providerId = snapshot.providerId;
    this.model = snapshot.model;
    this.dimension = snapshot.dimension;
    for (const entry of snapshot.embeddings) {
      if (!isSnapshotEntry(entry)) continue;
      if (validateEmbeddingVector(entry.vector, snapshot.dimension) !== null)
        continue;
      const entryKey = key(entry.notePath, entry.chunkIndex);
      this.byKey.set(entryKey, entry);
      let owned = this.byNote.get(entry.notePath);
      if (!owned) {
        owned = new Set();
        this.byNote.set(entry.notePath, owned);
      }
      owned.add(entryKey);
    }
    for (const [note, hash] of Object.entries(snapshot.noteHashes ?? {})) {
      if (typeof hash === "string" && this.byNote.has(note)) {
        this.noteHashes.set(note, hash);
      }
    }
    this.loaded = true;
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    if (this.providerId === null || this.model === null) return;
    if (!isPersistenceEnabled()) {
      this.dirty = false;
      return;
    }

    if (this.saving) {
      this.saveAgain = true;
      return;
    }

    this.saving = true;
    try {
      await this.doSave();
    } finally {
      this.saving = false;
    }

    if (this.saveAgain) {
      this.saveAgain = false;
      await this.save();
    }
  }

  private async doSave(): Promise<void> {
    const snapshot: StoreSnapshot = {
      version: STORE_VERSION,
      vaultRoot: this.vaultPath,
      providerId: this.providerId!,
      model: this.model!,
      dimension: this.dimension ?? 0,
      noteHashes: Object.fromEntries(this.noteHashes),
      embeddings: Array.from(this.byKey.values()),
    };
    const serialized = JSON.stringify(snapshot);
    const byteLength = Buffer.byteLength(serialized, "utf-8");
    if (byteLength > this.maxEmbeddingBytes) {
      log.warn(
        "embedding-store: snapshot exceeds MAX_EMBEDDING_BYTES, persistence skipped",
        {
          bytes: byteLength,
          max: this.maxEmbeddingBytes,
          chunks: this.byKey.size,
          notes: this.byNote.size,
        }
      );
      return;
    }

    let file: string;
    try {
      file = await this.storePath();
    } catch (err) {
      log.warn("embedding-store: snapshot path failed vault-boundary check", {
        err: err as Error,
      });
      return;
    }

    const tmp = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      try {
        await fs.writeFile(tmp, serialized, {
          encoding: "utf-8",
          mode: 0o600,
        });
        await renameWithRetry(tmp, file);
      } catch (innerErr) {
        try {
          await fs.unlink(tmp);
        } catch {
          /* ignore */
        }
        throw innerErr;
      }
      this.dirty = false;
    } catch (err) {
      log.warn("embedding-store: failed to persist snapshot", {
        err: err as Error,
      });
    }
  }

  /** Reset this handle to a fresh in-memory state. The next `load()` reads the
   * snapshot again. Pass `removeSnapshot: true` to also unlink persisted data. */
  async clear(options?: { removeSnapshot?: boolean }): Promise<void> {
    this.byKey.clear();
    this.byNote.clear();
    this.noteHashes.clear();
    this.loaded = false;
    this.dirty = false;
    this.loadingPromise = null;
    this.saveAgain = false;
    this.providerId = null;
    this.model = null;
    this.dimension = null;

    if (options?.removeSnapshot) {
      try {
        await fs.unlink(await this.storePath());
      } catch {
        /* ignore */
      }
    }
  }

  /** Drop a snapshot incompatible with the current provider/model. */
  invalidateIfIncompatible(providerId: string, model: string): void {
    if (!this.loaded) return;
    if (this.providerId === providerId && this.model === model) return;
    this.byKey.clear();
    this.byNote.clear();
    this.noteHashes.clear();
    this.providerId = providerId;
    this.model = model;
    this.dimension = null;
    this.dirty = true;
  }

  /** Has the given note's content changed since the last index pass? */
  noteIsCurrent(notePath: string, contentHash: string): boolean {
    return this.noteHashes.get(notePath) === contentHash;
  }

  /** Replace all chunks for `notePath`. Pass empty `chunks` to drop a note. */
  setNoteChunks(
    notePath: string,
    contentHash: string,
    chunks: ChunkEmbedding[],
    providerId: string,
    model: string
  ): void {
    let nextDimension = this.dimension;
    for (const ch of chunks) {
      const error = validateEmbeddingVector(ch.vector, nextDimension);
      if (error !== null) {
        throw new Error(
          `Invalid embedding vector at chunk ${ch.chunkIndex}: ${error}`
        );
      }
      if (nextDimension === null) nextDimension = ch.vector.length;
    }

    const prior = this.byNote.get(notePath);
    if (prior) {
      for (const priorKey of prior) this.byKey.delete(priorKey);
    }

    if (chunks.length === 0) {
      this.byNote.delete(notePath);
      this.noteHashes.delete(notePath);
    } else {
      const owned = new Set<string>();
      for (const ch of chunks) {
        const chunkKey = key(ch.notePath, ch.chunkIndex);
        this.byKey.set(chunkKey, ch);
        owned.add(chunkKey);
      }
      this.dimension = nextDimension;
      this.byNote.set(notePath, owned);
      this.noteHashes.set(notePath, contentHash);
    }
    this.providerId = providerId;
    this.model = model;
    this.dirty = true;
  }

  dropNoteChunks(notePath: string): boolean {
    const owned = this.byNote.get(notePath);
    const hadHash = this.noteHashes.delete(notePath);
    if (!owned && !hadHash) return false;
    if (owned) {
      for (const ownedKey of owned) this.byKey.delete(ownedKey);
    }
    this.byNote.delete(notePath);
    this.dirty = true;
    return true;
  }

  /** Drop chunks for notes that no longer exist in the vault. */
  pruneMissingNotes(currentNotes: Iterable<string>): number {
    const live = new Set<string>(currentNotes);
    let pruned = 0;
    for (const note of Array.from(this.byNote.keys())) {
      if (live.has(note)) continue;
      if (this.dropNoteChunks(note)) pruned++;
    }
    return pruned;
  }

  stats(): EmbeddingStoreStats {
    return {
      totalChunks: this.byKey.size,
      totalNotes: this.byNote.size,
      providerId: this.providerId,
      model: this.model,
      dimension: this.dimension,
    };
  }

  isEmpty(): boolean {
    return this.byKey.size === 0;
  }

  search(queryVector: number[], options: SearchOptions = {}): SearchHit[] {
    const limit = options.limit ?? 10;
    const folder = normalizeSearchFolder(options.folder);
    const exclude = options.excludeNotes ?? null;
    const filterNote = options.filterNote ?? null;

    const hits: SearchHit[] = [];
    for (const entry of this.byKey.values()) {
      if (folder !== null) {
        if (
          entry.notePath !== folder &&
          !entry.notePath.startsWith(folder + "/")
        )
          continue;
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

    const byNote = new Map<string, { best: SearchHit; scores: number[] }>();
    for (const hit of hits) {
      const existing = byNote.get(hit.notePath);
      if (!existing) {
        byNote.set(hit.notePath, { best: hit, scores: [hit.score] });
      } else {
        existing.scores.push(hit.score);
        if (hit.score > existing.best.score) existing.best = hit;
      }
    }
    const out = Array.from(byNote.values())
      .map(({ best, scores }) => ({ ...best, score: noteFocusScore(scores) }))
      .sort((a, b) => {
        const scoreDelta = b.score - a.score;
        if (scoreDelta !== 0) return scoreDelta;
        return a.notePath.localeCompare(b.notePath);
      });
    return out.slice(0, limit);
  }

  /** Get the embeddings owned by a specific note. */
  getNoteEmbeddings(notePath: string): ChunkEmbedding[] {
    const owned = this.byNote.get(notePath);
    if (!owned) return [];
    const out: ChunkEmbedding[] = [];
    for (const ownedKey of owned) {
      const entry = this.byKey.get(ownedKey);
      if (entry) out.push(entry);
    }
    return out;
  }
}

export function openEmbeddingStore(
  vaultPath: string,
  options: EmbeddingStoreOptions = {}
): EmbeddingStore {
  return EmbeddingStore.open(vaultPath, options);
}

// ─── pure similarity helpers ────────────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `cosineSimilarity: dimension mismatch (a.length=${a.length}, b.length=${b.length})`
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

function normalizeSearchFolder(folder: string | undefined): string | null {
  if (!folder) return null;
  const slashed = folder
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!slashed) return null;
  const normalized = path.posix.normalize(slashed).replace(/^\/+|\/+$/g, "");
  if (normalized === "." || normalized === "") return null;
  if (normalized === ".." || normalized.startsWith("../")) return slashed;
  return normalized;
}

function noteFocusScore(scores: number[]): number {
  const sorted = scores.toSorted((a, b) => b - a);
  const top = sorted.slice(0, NOTE_FOCUS_CHUNKS);
  const best = top[0] ?? 0;
  const focus = top.reduce((sum, score) => sum + score, 0) / top.length;
  return NOTE_BEST_CHUNK_WEIGHT * best + NOTE_FOCUS_WEIGHT * focus;
}

export function buildSimilarNotesQueryVector(
  chunks: readonly ChunkEmbedding[]
): number[] {
  const firstChunk = chunks[0];
  if (!firstChunk) return [];

  const dim = firstChunk.vector.length;
  const anchor = firstChunk.vector;
  const out = new Array<number>(dim).fill(0);
  let totalWeight = 0;

  for (const chunk of chunks) {
    const anchorSimilarity = Math.max(
      0,
      cosineSimilarity(anchor, chunk.vector)
    );
    const weight =
      chunk === firstChunk
        ? 1
        : Math.max(
            SIMILAR_SOURCE_MIN_CHUNK_WEIGHT,
            anchorSimilarity ** SIMILAR_SOURCE_ANCHOR_POWER
          );
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
