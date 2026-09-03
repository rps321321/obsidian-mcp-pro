import path from "path";
import {
  openEmbeddingStore,
  hashText,
  validateEmbeddingVector,
  cosineSimilarity,
  buildSimilarNotesQueryVector,
  type ChunkEmbedding,
  type EmbeddingStore,
  type SearchOptions,
} from "../lib/embedding-store-handle.js";

/**
 * Test-only migration adapter for the pre-handle regression suite.
 *
 * Production code has no vault-keyed store registry. Existing regression tests
 * deliberately keep their old call vocabulary here so the large historical
 * behavior matrix continues to run unchanged while dedicated handle tests
 * exercise the new public API directly.
 */
const stores = new Map<string, EmbeddingStore>();
let maxEmbeddingBytesForNewStores: number | undefined;

function storeFor(vaultPath: string): EmbeddingStore {
  const root = path.resolve(vaultPath);
  let store = stores.get(root);
  if (!store) {
    store = openEmbeddingStore(root, {
      ...(maxEmbeddingBytesForNewStores === undefined
        ? {}
        : { maxEmbeddingBytes: maxEmbeddingBytesForNewStores }),
    });
    stores.set(root, store);
  }
  return store;
}

export async function loadStore(vaultPath: string): Promise<EmbeddingStore> {
  const store = storeFor(vaultPath);
  await store.load();
  return store;
}

export async function saveStore(vaultPath: string): Promise<void> {
  await storeFor(vaultPath).save();
}

export async function clearStore(
  vaultPath: string,
  options?: { removeSnapshot?: boolean }
): Promise<void> {
  const root = path.resolve(vaultPath);
  const store = stores.get(root) ?? storeFor(root);
  await store.clear(options);
  stores.delete(root);
}

export function invalidateIfIncompatible(
  vaultPath: string,
  providerId: string,
  model: string
): void {
  storeFor(vaultPath).invalidateIfIncompatible(providerId, model);
}

export function noteIsCurrent(
  vaultPath: string,
  notePath: string,
  contentHash: string
): boolean {
  return storeFor(vaultPath).noteIsCurrent(notePath, contentHash);
}

export function setNoteChunks(
  vaultPath: string,
  notePath: string,
  contentHash: string,
  chunks: ChunkEmbedding[],
  providerId: string,
  model: string
): void {
  storeFor(vaultPath).setNoteChunks(
    notePath,
    contentHash,
    chunks,
    providerId,
    model
  );
}

export function dropNoteChunks(vaultPath: string, notePath: string): boolean {
  return storeFor(vaultPath).dropNoteChunks(notePath);
}

export function pruneMissingNotes(
  vaultPath: string,
  currentNotes: Iterable<string>
): number {
  return storeFor(vaultPath).pruneMissingNotes(currentNotes);
}

export function snapshotForTests(vaultPath: string) {
  return storeFor(vaultPath).stats();
}

export function searchEmbeddings(
  vaultPath: string,
  queryVector: number[],
  options: SearchOptions = {}
) {
  return storeFor(vaultPath).search(queryVector, options);
}

export function getNoteEmbeddings(
  vaultPath: string,
  notePath: string
): ChunkEmbedding[] {
  return storeFor(vaultPath).getNoteEmbeddings(notePath);
}

/** Configure the persistence cap used by subsequently opened test handles. */
export function setMaxEmbeddingBytesForTests(bytes: number | null): void {
  maxEmbeddingBytesForNewStores = bytes === null ? undefined : bytes;
}

export {
  hashText,
  validateEmbeddingVector,
  cosineSimilarity,
  buildSimilarNotesQueryVector,
};
export type { ChunkEmbedding, EmbeddingStore, SearchOptions };
