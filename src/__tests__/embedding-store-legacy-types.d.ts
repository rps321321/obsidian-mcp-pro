import type {
  ChunkEmbedding,
  EmbeddingStore,
  EmbeddingStoreStats,
  SearchHit,
  SearchOptions,
} from "../lib/embedding-store.js";

/**
 * Typed half of the test-only embedding-store migration adapter.
 *
 * Vitest redirects legacy test imports of `lib/embedding-store.js` to
 * `embedding-store-legacy-adapter.ts` at runtime. ESLint's typed TypeScript
 * program does not consume Vite aliases, so without this augmentation those
 * removed legacy exports become `error` types during linting. Keeping the
 * declarations under `src/__tests__` makes the compatibility surface visible
 * to test tooling without adding it back to the production declaration/API.
 */
declare module "../lib/embedding-store.js" {
  export function loadStore(vaultPath: string): Promise<EmbeddingStore>;
  export function saveStore(vaultPath: string): Promise<void>;
  export function clearStore(
    vaultPath: string,
    options?: { removeSnapshot?: boolean }
  ): Promise<void>;
  export function invalidateIfIncompatible(
    vaultPath: string,
    providerId: string,
    model: string
  ): void;
  export function noteIsCurrent(
    vaultPath: string,
    notePath: string,
    contentHash: string
  ): boolean;
  export function setNoteChunks(
    vaultPath: string,
    notePath: string,
    contentHash: string,
    chunks: ChunkEmbedding[],
    providerId: string,
    model: string
  ): void;
  export function dropNoteChunks(
    vaultPath: string,
    notePath: string
  ): boolean;
  export function pruneMissingNotes(
    vaultPath: string,
    currentNotes: Iterable<string>
  ): number;
  export function snapshotForTests(
    vaultPath: string
  ): EmbeddingStoreStats;
  export function searchEmbeddings(
    vaultPath: string,
    queryVector: number[],
    options?: SearchOptions
  ): SearchHit[];
  export function getNoteEmbeddings(
    vaultPath: string,
    notePath: string
  ): ChunkEmbedding[];
  export function setMaxEmbeddingBytesForTests(
    bytes: number | null
  ): void;
}
