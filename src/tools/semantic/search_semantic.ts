import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveVaultPath, readNote } from "../../lib/vault.js";
import { chunkNote } from "../../lib/chunker.js";
import { getActiveProvider } from "../../lib/embedding-providers.js";
import {
  loadStore,
  snapshotForTests,
  searchEmbeddings,
  invalidateIfIncompatible,
  validateEmbeddingVector,
  dropNoteChunks,
  getNoteEmbeddings,
  saveStore,
  hashText,
  noteIsCurrent,
  type SearchHit,
} from "../../lib/embedding-store.js";
import { defineTool, text, richText, error } from "../../lib/tool-seam.js";
import {
  MISSING_PROVIDER_HINT,
  displaySemanticValue,
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
  vaultPath: string,
  queryVector: number[],
  options: FreshSearchOptions
): Promise<{ hits: SearchHit[]; stalePruned: number }> {
  function headingPathsEqual(
    a: readonly string[],
    b: readonly string[]
  ): boolean {
    return a.length === b.length && a.every((part, index) => part === b[index]);
  }

  function storedChunksMatchLiveChunks(
    vaultPath: string,
    notePath: string,
    chunks: ReturnType<typeof chunkNote>
  ): boolean {
    const stored = getNoteEmbeddings(vaultPath, notePath);
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

  async function storedNoteIsCurrent(
    vaultPath: string,
    notePath: string
  ): Promise<boolean> {
    try {
      const content = await readNote(vaultPath, notePath);
      const chunks = chunkNote(content);
      return (
        noteIsCurrent(vaultPath, notePath, hashText(content)) &&
        storedChunksMatchLiveChunks(vaultPath, notePath, chunks)
      );
    } catch {
      return false;
    }
  }

  async function pruneStaleStoredNote(
    vaultPath: string,
    notePath: string
  ): Promise<boolean> {
    const current = await storedNoteIsCurrent(vaultPath, notePath);
    if (current) return false;
    return dropNoteChunks(vaultPath, notePath);
  }

  const hits: SearchHit[] = [];
  const accepted = new Set<string>();
  const stale = new Set<string>();
  let stalePruned = 0;
  for (let pass = 0; pass < 10 && hits.length < options.limit; pass++) {
    const exclude = new Set<string>(options.excludeNotes);
    for (const notePath of accepted) exclude.add(notePath);
    for (const notePath of stale) exclude.add(notePath);
    const batchLimit = Math.min(100, Math.max(options.limit - hits.length, 20));
    const candidates = searchEmbeddings(vaultPath, queryVector, {
      limit: batchLimit,
      ...(options.folder ? { folder: options.folder } : {}),
      ...(exclude.size > 0 ? { excludeNotes: exclude } : {}),
      ...(options.filterNote ? { filterNote: options.filterNote } : {}),
    });
    if (candidates.length === 0) break;
    let advanced = false;
    for (const hit of candidates) {
      if (accepted.has(hit.notePath)) continue;
      if (await pruneStaleStoredNote(vaultPath, hit.notePath)) {
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
  if (stalePruned > 0) await saveStore(vaultPath);
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

export function registerSearchSemanticTool(
  server: McpServer,
  vaultPath: string
): void {
  defineTool(
    server,
    vaultPath,
    {
      name: "search_semantic",
      title: "Semantic Search",
      description:
        "Search notes by meaning rather than keywords. Embeds the query with the configured provider, scores every chunk in the persisted index by cosine similarity, ranks one result per note using the best chunk plus a small top-chunk focus signal, and returns the best chunk as the snippet source. Run `index_vault` first to populate the index — this tool does not auto-index because the user should know they're paying the embedding cost. Pair with `get_note` to retrieve full bodies after picking a hit.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(10_000)
          .describe(
            "Natural-language description of what you're looking for, e.g. 'notes about onboarding new hires'."
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .default(10)
          .describe("Maximum number of notes to return (1-100, default: 10)."),
        folder: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Restrict the search to a folder relative to the vault root."
          ),
        includeSnippet: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            "If true (default), include a short snippet of the matching chunk under each hit."
          ),
      },
    },
    async ({ query, limit, folder, includeSnippet }) => {
      const provider = getActiveProvider();
      if (!provider) {
        return error(
          `Semantic search has no embedding provider configured. ${MISSING_PROVIDER_HINT}`
        );
      }
      await loadStore(vaultPath);
      invalidateIfIncompatible(vaultPath, provider.id, provider.model);
      const snap = snapshotForTests(vaultPath);
      if (snap.totalChunks === 0) {
        return error(
          `Embedding index is empty${snap.providerId === null ? "" : " for the active provider/model"}. Run \`index_vault\` to build it before searching semantically.`
        );
      }

      const [vector] = await provider.embed([query]);
      if (!Array.isArray(vector)) {
        return error("Provider did not return a vector for the query.");
      }
      const vectorError = validateEmbeddingVector(vector, snap.dimension);
      if (vectorError !== null) {
        return error(
          `Provider returned an invalid query vector: ${vectorError}.`
        );
      }
      const { hits } = await searchFreshEmbeddings(vaultPath, vector, {
        limit,
        ...(folder ? { folder } : {}),
        filterNote: (notePath) =>
          canReadStoredEmbeddingNote(vaultPath, notePath),
      });
      if (hits.length === 0) {
        return text(`No matches for "${displaySemanticValue(query)}".`);
      }

      return richText("search_semantic vault text", (b) => {
        b.trusted(
          `${hits.length} match(es) for "${displaySemanticValue(query)}":`
        );
        b.trusted("");
        for (const hit of hits) {
          b.trusted(`- score: ${hit.score.toFixed(3)}`);
          b.trusted("    Path:");
          semanticPathBlock(b, "search_semantic result path", hit.notePath);
          if (hit.headingPath.length > 0) {
            b.trusted("    Heading:");
            semanticHeadingBlock(b, hit.headingPath);
          }
          if (includeSnippet) {
            const snippet = hit.text.replace(/\s+/g, " ").trim().slice(0, 200);
            const clipped = `${displaySemanticValue(snippet)}${hit.text.length > 200 ? "..." : ""}`;
            b.untrusted("semantic snippet", clipped, "    ");
          }
        }
      });
    }
  );
}
