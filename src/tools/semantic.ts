import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listNotes } from "../lib/vault.js";
import { readAllCached } from "../lib/index-cache.js";
import { chunkNote } from "../lib/chunker.js";
import { getActiveProvider } from "../lib/embedding-providers.js";
import {
  loadStore,
  saveStore,
  hashText,
  noteIsCurrent,
  setNoteChunks,
  pruneMissingNotes,
  searchEmbeddings,
  getNoteEmbeddings,
  snapshotForTests,
  invalidateIfIncompatible,
  type ChunkEmbedding,
} from "../lib/embedding-store.js";
import { makeProgressReporter } from "../lib/progress.js";
import { sanitizeError } from "../lib/errors.js";
import { log } from "../lib/logger.js";
import { mapConcurrent } from "../lib/concurrency.js";

const MISSING_PROVIDER_HINT =
  "Set OBSIDIAN_EMBEDDING_PROVIDER=ollama (default) and run an Ollama server with `ollama pull nomic-embed-text`. " +
  "For OpenAI, set OBSIDIAN_EMBEDDING_PROVIDER=openai and OBSIDIAN_EMBEDDING_API_KEY.";

const EMBED_BATCH_SIZE = 16;

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

interface IndexProgress {
  notesScanned: number;
  notesEmbedded: number;
  chunksEmbedded: number;
  notesUnchanged: number;
  notesPruned: number;
  failed: Array<{ path: string; error: string }>;
}

export function registerSemanticTools(server: McpServer, vaultPath: string): void {
  server.registerTool(
    "index_vault",
    {
      title: "Index Vault for Semantic Search",
      description:
        "Build or refresh the embedding index used by `search_semantic` and `find_similar_notes`. Splits each note into heading-aware chunks, embeds them via the configured provider (Ollama by default, OpenAI optional), and persists the index to `<vault>/.obsidian/cache/mcp-pro-embeddings.json`. Incremental: notes whose content hash matches the prior pass are skipped. Use `force: true` to re-embed everything (e.g., after switching models). Emits progress notifications when the client subscribes.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        force: z
          .boolean()
          .optional()
          .default(false)
          .describe("If true, re-embed every note even if its content hash matches the cached one."),
        folder: z
          .string()
          .optional()
          .describe("Restrict the indexing pass to this folder. Notes outside the folder are left untouched."),
      },
    },
    async ({ force, folder }, extra) => {
      try {
        const provider = getActiveProvider();
        if (!provider) {
          return errorResult(
            `Semantic search has no embedding provider configured. ${MISSING_PROVIDER_HINT}`,
          );
        }

        await loadStore(vaultPath);
        invalidateIfIncompatible(vaultPath, provider.id, provider.model);

        const reportProgress = makeProgressReporter(extra);
        const notes = await listNotes(vaultPath, folder);
        if (notes.length === 0) {
          return textResult(folder ? `No notes in "${folder}" to index.` : "Vault is empty — nothing to index.");
        }

        const { contents } = await readAllCached(vaultPath, notes, (note, err) => {
          log.warn("index_vault: note read failed", { note, err });
        });

        const stats: IndexProgress = {
          notesScanned: 0,
          notesEmbedded: 0,
          chunksEmbedded: 0,
          notesUnchanged: 0,
          notesPruned: 0,
          failed: [],
        };

        // Plan: per-note hash check + chunking. Notes that don't need
        // re-embedding are skipped without provider calls. We then batch
        // calls into the provider to minimize HTTP roundtrips.
        interface PendingChunk {
          notePath: string;
          contentHash: string;
          chunkIndex: number;
          headingPath: string[];
          text: string;
          textHash: string;
        }
        const pending: PendingChunk[] = [];
        const noteHashByPath = new Map<string, string>();

        for (const notePath of notes) {
          const content = contents.get(notePath);
          if (content === undefined) continue;
          const contentHash = hashText(content);
          noteHashByPath.set(notePath, contentHash);
          if (!force && noteIsCurrent(vaultPath, notePath, contentHash)) {
            stats.notesUnchanged++;
            stats.notesScanned++;
            await reportProgress(stats.notesScanned, notes.length, `Unchanged ${notePath}`);
            continue;
          }
          const chunks = chunkNote(content);
          for (const ch of chunks) {
            pending.push({
              notePath,
              contentHash,
              chunkIndex: ch.index,
              headingPath: ch.headingPath,
              text: ch.text,
              textHash: hashText(ch.text),
            });
          }
          stats.notesScanned++;
          await reportProgress(stats.notesScanned, notes.length, `Chunked ${notePath}`);
        }

        // Embed pending chunks in batches.
        const noteChunks = new Map<string, ChunkEmbedding[]>();
        for (let i = 0; i < pending.length; i += EMBED_BATCH_SIZE) {
          const batch = pending.slice(i, i + EMBED_BATCH_SIZE);
          let vectors: number[][];
          try {
            vectors = await provider.embed(batch.map((b) => b.text));
          } catch (err) {
            for (const item of batch) {
              stats.failed.push({ path: item.notePath, error: (err as Error).message });
            }
            continue;
          }
          for (let j = 0; j < batch.length; j++) {
            const item = batch[j];
            const vector = vectors[j];
            if (!Array.isArray(vector)) {
              stats.failed.push({ path: item.notePath, error: "provider returned no vector" });
              continue;
            }
            const list = noteChunks.get(item.notePath) ?? [];
            list.push({
              notePath: item.notePath,
              chunkIndex: item.chunkIndex,
              headingPath: item.headingPath,
              text: item.text,
              hash: item.textHash,
              vector,
            });
            noteChunks.set(item.notePath, list);
          }
          stats.chunksEmbedded += batch.length;
          await reportProgress(
            Math.min(i + batch.length, pending.length),
            pending.length,
            `Embedded ${Math.min(i + batch.length, pending.length)}/${pending.length} chunks`,
          );
        }

        for (const [notePath, chunks] of noteChunks) {
          const contentHash = noteHashByPath.get(notePath);
          if (!contentHash) continue;
          setNoteChunks(vaultPath, notePath, contentHash, chunks, provider.id, provider.model);
          stats.notesEmbedded++;
        }

        // Drop chunks for notes that no longer exist (only meaningful when
        // we just scanned the whole vault — if a folder was specified,
        // skipping the prune avoids wiping out unrelated notes).
        if (!folder) {
          stats.notesPruned = pruneMissingNotes(vaultPath, notes);
        }

        await saveStore(vaultPath);

        const lines = [
          `Indexed${folder ? ` "${folder}"` : ""} via ${provider.id}/${provider.model}`,
          `  Notes scanned:   ${stats.notesScanned}`,
          `  Notes embedded:  ${stats.notesEmbedded}`,
          `  Notes unchanged: ${stats.notesUnchanged}`,
          `  Chunks embedded: ${stats.chunksEmbedded}`,
        ];
        if (stats.notesPruned > 0) lines.push(`  Notes pruned:    ${stats.notesPruned}`);
        if (stats.failed.length > 0) {
          lines.push(`  Failures:        ${stats.failed.length}`);
          for (const f of stats.failed.slice(0, 5)) lines.push(`    - ${f.path}: ${sanitizeError(f.error)}`);
          if (stats.failed.length > 5) lines.push(`    ...and ${stats.failed.length - 5} more`);
        }
        return textResult(lines.join("\n"));
      } catch (err) {
        log.error("index_vault failed", { tool: "index_vault", err: err as Error });
        return errorResult(`Error indexing vault: ${sanitizeError(err)}`);
      }
    },
  );

  server.registerTool(
    "search_semantic",
    {
      title: "Semantic Search",
      description:
        "Search notes by meaning rather than keywords. Embeds the query with the configured provider, scores every chunk in the persisted index by cosine similarity, and returns the best-matching note per cluster (deduplicated to one hit per note). Run `index_vault` first to populate the index — this tool does not auto-index because the user should know they're paying the embedding cost. Pair with `get_note` to retrieve full bodies after picking a hit.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("Natural-language description of what you're looking for, e.g. 'notes about onboarding new hires'."),
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
          .optional()
          .describe("Restrict the search to a folder relative to the vault root."),
        includeSnippet: z
          .boolean()
          .optional()
          .default(true)
          .describe("If true (default), include a short snippet of the matching chunk under each hit."),
      },
    },
    async ({ query, limit, folder, includeSnippet }) => {
      try {
        const provider = getActiveProvider();
        if (!provider) {
          return errorResult(
            `Semantic search has no embedding provider configured. ${MISSING_PROVIDER_HINT}`,
          );
        }
        await loadStore(vaultPath);
        // Drop the persisted index if the active provider/model differs
        // from what produced the cached vectors. Without this, a query
        // embedded with model B would be cosine-scored against vectors
        // from model A and silently return meaningless results.
        invalidateIfIncompatible(vaultPath, provider.id, provider.model);
        const snap = snapshotForTests(vaultPath);
        if (snap.totalChunks === 0) {
          return errorResult(
            `Embedding index is empty${snap.providerId === null ? "" : " for the active provider/model"}. Run \`index_vault\` to build it before searching semantically.`,
          );
        }

        const [vector] = await provider.embed([query]);
        if (!Array.isArray(vector)) {
          return errorResult("Provider did not return a vector for the query.");
        }
        const hits = searchEmbeddings(vaultPath, vector, { limit, folder });
        if (hits.length === 0) {
          return textResult(`No matches for "${query}".`);
        }

        const lines: string[] = [`${hits.length} match(es) for "${query}":`, ""];
        for (const hit of hits) {
          const heading = hit.headingPath.length > 0 ? ` (${hit.headingPath.join(" / ")})` : "";
          lines.push(`- ${hit.notePath}${heading}  [score: ${hit.score.toFixed(3)}]`);
          if (includeSnippet) {
            const snippet = hit.text.replace(/\s+/g, " ").trim().slice(0, 200);
            lines.push(`    ${snippet}${hit.text.length > 200 ? "…" : ""}`);
          }
        }
        return textResult(lines.join("\n"));
      } catch (err) {
        log.error("search_semantic failed", { tool: "search_semantic", err: err as Error });
        return errorResult(`Error during semantic search: ${sanitizeError(err)}`);
      }
    },
  );

  server.registerTool(
    "find_similar_notes",
    {
      title: "Find Similar Notes",
      description:
        "Given a note path, return the K most semantically similar notes from the index (excluding the source note). Uses the source note's existing chunk embeddings — no live API call to the embedding provider, so this is fast and free. Run `index_vault` first to populate embeddings for both the source and the candidates.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe("Vault-relative path to the source note, e.g. 'projects/atlas.md'."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .default(10)
          .describe("Maximum number of similar notes to return (1-100, default: 10)."),
      },
    },
    async ({ path: notePath, limit }) => {
      try {
        await loadStore(vaultPath);
        // If the active provider/model differs from what produced the
        // cached vectors, drop them: scores between mismatched models are
        // meaningless. The user must re-run `index_vault` afterwards.
        const provider = getActiveProvider();
        if (provider) {
          invalidateIfIncompatible(vaultPath, provider.id, provider.model);
        }
        const ownChunks = getNoteEmbeddings(vaultPath, notePath);
        if (ownChunks.length === 0) {
          return errorResult(
            `No embeddings found for "${notePath}". Run \`index_vault\` first (or check the path is correct).`,
          );
        }
        // Score every other note's chunks against each of this note's chunks
        // and keep each candidate note's best match. Mean would dilute long
        // notes; max keeps the strongest signal.
        const exclude = new Set([notePath]);
        const aggregated = new Map<string, { score: number; chunkIndex: number; headingPath: string[]; text: string }>();
        for (const own of ownChunks) {
          const hits = searchEmbeddings(vaultPath, own.vector, { limit: 200, excludeNotes: exclude });
          for (const h of hits) {
            const cur = aggregated.get(h.notePath);
            if (!cur || h.score > cur.score) {
              aggregated.set(h.notePath, {
                score: h.score,
                chunkIndex: h.chunkIndex,
                headingPath: h.headingPath,
                text: h.text,
              });
            }
          }
        }
        const ranked = Array.from(aggregated.entries())
          .map(([np, info]) => ({ notePath: np, ...info }))
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);

        if (ranked.length === 0) {
          return textResult(`No similar notes found for "${notePath}".`);
        }
        const lines: string[] = [`${ranked.length} note(s) similar to ${notePath}:`, ""];
        for (const r of ranked) {
          const heading = r.headingPath.length > 0 ? ` (${r.headingPath.join(" / ")})` : "";
          lines.push(`- ${r.notePath}${heading}  [score: ${r.score.toFixed(3)}]`);
        }
        return textResult(lines.join("\n"));
      } catch (err) {
        log.error("find_similar_notes failed", { tool: "find_similar_notes", err: err as Error });
        return errorResult(`Error finding similar notes: ${sanitizeError(err)}`);
      }
    },
  );
}

// keep this import alive for tests that reach into the store directly via
// utility helpers without the indexer in between.
export { mapConcurrent };
