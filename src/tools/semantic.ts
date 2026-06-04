import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listNotes, vaultRewriteLockKey, withFileLock } from "../lib/vault.js";
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
import { escapeControlChars, sanitizeError } from "../lib/errors.js";
import { formatFailedPath } from "../lib/tool-output.js";
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

const displaySemanticValue = escapeControlChars;

function displayHeadingPath(path: readonly string[]): string {
  return path.map(displaySemanticValue).join(" / ");
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
          .max(500)
          .optional()
          .describe("Restrict the indexing pass to this folder. Notes outside the folder are left untouched."),
      },
    },
    async ({ force, folder }, extra) => {
      // Serialize the entire index pass against itself per-vault. Two
      // concurrent index_vault calls would otherwise interleave
      // `setNoteChunks` + `pruneMissingNotes` operations on the same
      // in-memory store, with one call's prune wiping notes the other
      // is mid-way through embedding. Reusing the existing vault rewrite
      // lock key also serializes against rename_tag / move_note bulk
      // operations whose mtime bumps would otherwise invalidate cache
      // entries this pass just rebuilt.
      return withFileLock(vaultRewriteLockKey(vaultPath), async () => {
      try {
        const provider = getActiveProvider();
        if (!provider) {
          return errorResult(
            `Semantic search has no embedding provider configured. ${MISSING_PROVIDER_HINT}`,
          );
        }

        await loadStore(vaultPath);
        invalidateIfIncompatible(vaultPath, provider.id, provider.model);

        const progressMeta: Parameters<typeof makeProgressReporter>[0] = {
          ...(extra._meta?.progressToken != null
            ? { _meta: { progressToken: extra._meta.progressToken } }
            : {}),
          sendNotification: extra.sendNotification.bind(extra),
        };
        const reportProgress = makeProgressReporter(progressMeta);
        const notes = await listNotes(vaultPath, folder);
        if (notes.length === 0) {
          return textResult(
            folder ? `No notes in "${displaySemanticValue(folder)}" to index.` : "Vault is empty — nothing to index.",
          );
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
        }
        const pending: PendingChunk[] = [];
        const noteHashByPath = new Map<string, string>();
        const expectedChunksByNote = new Map<string, number>();

        for (const notePath of notes) {
          const content = contents.get(notePath);
          if (content === undefined) continue;
          const contentHash = hashText(content);
          if (!force && noteIsCurrent(vaultPath, notePath, contentHash)) {
            stats.notesUnchanged++;
            stats.notesScanned++;
            await reportProgress(stats.notesScanned, notes.length, `Unchanged ${displaySemanticValue(notePath)}`);
            continue;
          }
          noteHashByPath.set(notePath, contentHash);
          const chunks = chunkNote(content);
          expectedChunksByNote.set(notePath, chunks.length);
          for (const ch of chunks) {
            pending.push({
              notePath,
              contentHash,
              chunkIndex: ch.index,
              headingPath: ch.headingPath,
              text: ch.text,
            });
          }
          stats.notesScanned++;
          await reportProgress(stats.notesScanned, notes.length, `Chunked ${displaySemanticValue(notePath)}`);
        }

        // Embed pending chunks in batches.
        const noteChunks = new Map<string, ChunkEmbedding[]>();
        const failedNotes = new Set<string>();
        for (let i = 0; i < pending.length; i += EMBED_BATCH_SIZE) {
          const batch = pending.slice(i, i + EMBED_BATCH_SIZE);
          let vectors: number[][];
          try {
            vectors = await provider.embed(batch.map((b) => b.text));
          } catch (err) {
            for (const item of batch) {
              stats.failed.push({ path: item.notePath, error: (err as Error).message });
              failedNotes.add(item.notePath);
            }
            continue;
          }
          for (let j = 0; j < batch.length; j++) {
            const item = batch[j];
            if (!item) continue;
            const vector = vectors[j];
            if (!Array.isArray(vector)) {
              stats.failed.push({ path: item.notePath, error: "provider returned no vector" });
              failedNotes.add(item.notePath);
              continue;
            }
            const list = noteChunks.get(item.notePath) ?? [];
            list.push({
              notePath: item.notePath,
              chunkIndex: item.chunkIndex,
              headingPath: item.headingPath,
              text: item.text,
              // Per-chunk hash: the ChunkEmbedding interface requires this
              // field for the persisted schema, but no code path reads it
              // back for decisions. The per-*note* contentHash (noteHashes
              // map) drives incremental skip logic instead. We pass an
              // empty string to avoid a SHA-256 computation per chunk.
              hash: "",
              vector,
            });
            noteChunks.set(item.notePath, list);
            stats.chunksEmbedded++;
          }
          await reportProgress(
            Math.min(i + batch.length, pending.length),
            pending.length,
            `Embedded ${Math.min(i + batch.length, pending.length)}/${pending.length} chunks`,
          );
        }

        for (const [notePath, contentHash] of noteHashByPath) {
          const expectedChunks = expectedChunksByNote.get(notePath) ?? 0;
          const chunks = noteChunks.get(notePath) ?? [];
          if (failedNotes.has(notePath) || chunks.length !== expectedChunks) {
            if (!failedNotes.has(notePath)) {
              stats.failed.push({
                path: notePath,
                error: `embedded ${chunks.length}/${expectedChunks} chunks`,
              });
            }
            continue;
          }
          setNoteChunks(vaultPath, notePath, contentHash, chunks, provider.id, provider.model);
          if (chunks.length > 0) stats.notesEmbedded++;
        }

        // Drop chunks for notes that no longer exist (only meaningful when
        // we just scanned the whole vault — if a folder was specified,
        // skipping the prune avoids wiping out unrelated notes).
        if (!folder) {
          stats.notesPruned = pruneMissingNotes(vaultPath, notes);
        }

        await saveStore(vaultPath);

        const lines = [
          `Indexed${folder ? ` "${displaySemanticValue(folder)}"` : ""} via ${displaySemanticValue(provider.id)}/${displaySemanticValue(provider.model)}`,
          `  Notes scanned:   ${stats.notesScanned}`,
          `  Notes embedded:  ${stats.notesEmbedded}`,
          `  Notes unchanged: ${stats.notesUnchanged}`,
          `  Chunks embedded: ${stats.chunksEmbedded}`,
        ];
        if (stats.notesPruned > 0) lines.push(`  Notes pruned:    ${stats.notesPruned}`);
        if (stats.failed.length > 0) {
          lines.push(`  Failures:        ${stats.failed.length}`);
          for (const f of stats.failed.slice(0, 5)) lines.push(formatFailedPath(f.path, f.error, "    "));
          if (stats.failed.length > 5) lines.push(`    ...and ${stats.failed.length - 5} more`);
        }
        return textResult(lines.join("\n"));
      } catch (err) {
        log.error("index_vault failed", { tool: "index_vault", err: err as Error });
        return errorResult(`Error indexing vault: ${sanitizeError(err)}`);
      }
      });
    },
  );

  server.registerTool(
    "search_semantic",
    {
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
          .max(500)
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
        const hits = searchEmbeddings(vaultPath, vector, { limit, ...(folder ? { folder } : {}) });
        if (hits.length === 0) {
          return textResult(`No matches for "${displaySemanticValue(query)}".`);
        }

        const lines: string[] = [`${hits.length} match(es) for "${displaySemanticValue(query)}":`, ""];
        for (const hit of hits) {
          const heading = hit.headingPath.length > 0 ? ` (${displayHeadingPath(hit.headingPath)})` : "";
          lines.push(`- ${displaySemanticValue(hit.notePath)}${heading}  [score: ${hit.score.toFixed(3)}]`);
          if (includeSnippet) {
            const snippet = hit.text.replace(/\s+/g, " ").trim().slice(0, 200);
            lines.push(`    ${displaySemanticValue(snippet)}${hit.text.length > 200 ? "…" : ""}`);
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
          .max(500)
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
            `No embeddings found for "${displaySemanticValue(notePath)}". Run \`index_vault\` first (or check the path is correct).`,
          );
        }
        // Compute a centroid (mean) vector from all of the source note's
        // chunk embeddings, then run a single searchEmbeddings pass over
        // the store. This is O(totalChunks) instead of the previous
        // O(ownChunks * totalChunks) which compared every source chunk
        // against every stored chunk. The centroid is a standard
        // document-level representation; searchEmbeddings already
        // deduplicates per note (keeping the best-scoring chunk), so the
        // ranking quality stays high.
        const firstChunk = ownChunks[0]!;
        const dim = firstChunk.vector.length;
        // Build centroid: average all chunk vectors element-wise. Start
        // from a copy of the first vector, accumulate the rest, then
        // divide by count. This avoids strict-mode indexed-access issues
        // with typed arrays while keeping the logic straightforward.
        const centroid = firstChunk.vector.slice();
        for (let ci = 1; ci < ownChunks.length; ci++) {
          const vec = ownChunks[ci]!.vector;
          for (let d = 0; d < dim; d++) {
            centroid[d] = centroid[d]! + vec[d]!;
          }
        }
        for (let d = 0; d < dim; d++) {
          centroid[d] = centroid[d]! / ownChunks.length;
        }
        const exclude = new Set([notePath]);
        const hits = searchEmbeddings(vaultPath, centroid, {
          limit,
          excludeNotes: exclude,
        });
        const ranked = hits.map((h) => ({
          notePath: h.notePath,
          score: h.score,
          chunkIndex: h.chunkIndex,
          headingPath: h.headingPath,
          text: h.text,
        }));

        if (ranked.length === 0) {
          return textResult(`No similar notes found for "${displaySemanticValue(notePath)}".`);
        }
        const lines: string[] = [`${ranked.length} note(s) similar to ${displaySemanticValue(notePath)}:`, ""];
        for (const r of ranked) {
          const heading = r.headingPath.length > 0 ? ` (${displayHeadingPath(r.headingPath)})` : "";
          lines.push(`- ${displaySemanticValue(r.notePath)}${heading}  [score: ${r.score.toFixed(3)}]`);
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
