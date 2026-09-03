import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveVaultPath, readNote } from "../../lib/vault.js";
import { chunkNote } from "../../lib/chunker.js";
import { getActiveProvider } from "../../lib/embedding-providers.js";
import {
  hashText,
  buildSimilarNotesQueryVector,
  type EmbeddingStore,
  type SearchHit,
} from "../../lib/embedding-store-handle.js";
import { defineTool, text, richText, error } from "../../lib/tool-seam.js";
import {
  escapeControlChars,
  semanticPathBlock,
  semanticHeadingBlock,
} from "./shared.js";

interface FreshSearchOptions {
  limit: number;
  folder?: string;
  excludeNotes?: ReadonlySet<string>;
  filterNote?: (notePath: string) => boolean;
}

async function searchFreshEmbeddings(
  store: EmbeddingStore,
  vaultPath: string,
  queryVector: number[],
  options: FreshSearchOptions
): Promise<{ hits: SearchHit[]; stalePruned: number }> {
  const hits: SearchHit[] = [];
  const accepted = new Set<string>();
  const stale = new Set<string>();
  let stalePruned = 0;

  function headingPathsEqual(
    a: readonly string[],
    b: readonly string[]
  ): boolean {
    return a.length === b.length && a.every((part, index) => part === b[index]);
  }

  function storedChunksMatchLiveChunks(
    notePath: string,
    chunks: ReturnType<typeof chunkNote>
  ): boolean {
    const stored = store.getNoteEmbeddings(notePath);
    if (stored.length !== chunks.length) return false;
    const storedByIndex = new Map(
      stored.map((chunk) => [chunk.chunkIndex, chunk])
    );
    for (const chunk of chunks) {
      const storedChunk = storedByIndex.get(chunk.index);
      if (!storedChunk) return false;
      if (storedChunk.text !== chunk.text) return false;
      if (!headingPathsEqual(storedChunk.headingPath, chunk.headingPath))
        return false;
    }
    return true;
  }

  async function storedNoteIsCurrent(notePath: string): Promise<boolean> {
    try {
      const content = await readNote(vaultPath, notePath);
      const chunks = chunkNote(content);
      return (
        store.noteIsCurrent(notePath, hashText(content)) &&
        storedChunksMatchLiveChunks(notePath, chunks)
      );
    } catch {
      return false;
    }
  }

  async function pruneStaleStoredNote(notePath: string): Promise<boolean> {
    const current = await storedNoteIsCurrent(notePath);
    if (current) return false;
    return store.dropNoteChunks(notePath);
  }

  for (let pass = 0; pass < 10 && hits.length < options.limit; pass++) {
    const exclude = new Set<string>(options.excludeNotes);
    for (const notePath of accepted) exclude.add(notePath);
    for (const notePath of stale) exclude.add(notePath);
    const batchLimit = Math.min(100, Math.max(options.limit - hits.length, 20));
    const candidates = store.search(queryVector, {
      limit: batchLimit,
      ...(options.folder ? { folder: options.folder } : {}),
      ...(exclude.size > 0 ? { excludeNotes: exclude } : {}),
      ...(options.filterNote ? { filterNote: options.filterNote } : {}),
    });
    if (candidates.length === 0) break;
    let advanced = false;
    for (const hit of candidates) {
      if (accepted.has(hit.notePath)) continue;
      if (await pruneStaleStoredNote(hit.notePath)) {
        stale.add(hit.notePath);
        stalePruned++;
        advanced = true;
        continue;
      }
      hits.push(hit);
      accepted.add(hit.notePath);
      advanced = true;
      if (hits.length >= options.limit) break;
    }
    if (!advanced) break;
  }
  if (stalePruned > 0) await store.save();
  return { hits, stalePruned };
}

function canReadStoredEmbeddingNote(
  vaultPath: string,
  notePath: string
): boolean {
  try {
    resolveVaultPath(vaultPath, notePath, "read");
    return true;
  } catch {
    return false;
  }
}

export function registerFindSimilarNotesTool(
  server: McpServer,
  vaultPath: string,
  store: EmbeddingStore
): void {
  defineTool(
    server,
    vaultPath,
    {
      name: "find_similar_notes",
      title: "Find Similar Notes",
      description:
        "Given a note path, return the K most semantically similar notes from the index (excluding the source note). Uses the source note's existing chunk embeddings and anchors the source query to chunks aligned with the note's opening topic — no live API call to the embedding provider, so this is fast and free. Run `index_vault` first to populate embeddings for both the source and the candidates.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        path: z
          .string()
          .min(1)
          .max(500)
          .describe(
            "Vault-relative path to the source note, e.g. 'projects/atlas.md'."
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .default(10)
          .describe(
            "Maximum number of similar notes to return (1-100, default: 10)."
          ),
      },
    },
    async ({ path: notePath, limit }) => {
      await store.load();
      const provider = getActiveProvider();
      if (provider) {
        store.invalidateIfIncompatible(provider.id, provider.model);
      }
      resolveVaultPath(vaultPath, notePath, "read");
      const ownChunks = store.getNoteEmbeddings(notePath);
      if (ownChunks.length === 0) {
        return error(
          `No embeddings found for "${escapeControlChars(notePath)}". Run \`index_vault\` first (or check the path is correct).`
        );
      }

      function headingPathsEqual(
        a: readonly string[],
        b: readonly string[]
      ): boolean {
        return (
          a.length === b.length && a.every((part, index) => part === b[index])
        );
      }

      function storedChunksMatchLiveChunks(
        currentPath: string,
        chunks: ReturnType<typeof chunkNote>
      ): boolean {
        const stored = store.getNoteEmbeddings(currentPath);
        if (stored.length !== chunks.length) return false;
        const storedByIndex = new Map(
          stored.map((chunk) => [chunk.chunkIndex, chunk])
        );
        for (const chunk of chunks) {
          const storedChunk = storedByIndex.get(chunk.index);
          if (!storedChunk) return false;
          if (storedChunk.text !== chunk.text) return false;
          if (!headingPathsEqual(storedChunk.headingPath, chunk.headingPath))
            return false;
        }
        return true;
      }

      async function storedNoteIsCurrent(currentPath: string): Promise<boolean> {
        try {
          const content = await readNote(vaultPath, currentPath);
          const chunks = chunkNote(content);
          return (
            store.noteIsCurrent(currentPath, hashText(content)) &&
            storedChunksMatchLiveChunks(currentPath, chunks)
          );
        } catch {
          return false;
        }
      }

      async function pruneStaleStoredNote(currentPath: string): Promise<boolean> {
        const current = await storedNoteIsCurrent(currentPath);
        if (current) return false;
        return store.dropNoteChunks(currentPath);
      }

      if (await pruneStaleStoredNote(notePath)) {
        await store.save();
        return error(
          `No current embeddings found for "${escapeControlChars(notePath)}". Run \`index_vault\` to refresh it.`
        );
      }
      const queryVector = buildSimilarNotesQueryVector(ownChunks);
      const exclude = new Set([notePath]);
      const { hits } = await searchFreshEmbeddings(
        store,
        vaultPath,
        queryVector,
        {
          limit,
          excludeNotes: exclude,
          filterNote: (hitPath) =>
            canReadStoredEmbeddingNote(vaultPath, hitPath),
        }
      );
      const ranked = hits.map((h) => ({
        notePath: h.notePath,
        score: h.score,
        chunkIndex: h.chunkIndex,
        headingPath: h.headingPath,
        text: h.text,
      }));

      if (ranked.length === 0) {
        return text(
          `No similar notes found for "${escapeControlChars(notePath)}".`
        );
      }
      return richText("find_similar_notes paths and headings", (b) => {
        b.trusted(
          `${ranked.length} note(s) similar to ${escapeControlChars(notePath)}:`
        );
        b.trusted("");
        for (const r of ranked) {
          b.trusted(`- score: ${r.score.toFixed(3)}`);
          b.trusted("    Path:");
          semanticPathBlock(b, "find_similar_notes result path", r.notePath);
          if (r.headingPath.length > 0) {
            b.trusted("    Heading:");
            semanticHeadingBlock(b, r.headingPath);
          }
        }
      });
    }
  );
}
