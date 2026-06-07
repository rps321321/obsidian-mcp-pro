import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listNotes, readNote, resolveVaultPath, vaultRewriteLockKey, withFileLock } from "../lib/vault.js";
import { readAllCached } from "../lib/index-cache.js";
import { chunkNote } from "../lib/chunker.js";
import { getActiveProvider } from "../lib/embedding-providers.js";
import {
  loadStore,
  saveStore,
  hashText,
  noteIsCurrent,
  setNoteChunks,
  dropNoteChunks,
  pruneMissingNotes,
  searchEmbeddings,
  getNoteEmbeddings,
  buildSimilarNotesQueryVector,
  snapshotForTests,
  invalidateIfIncompatible,
  validateEmbeddingVector,
  type ChunkEmbedding,
  type SearchHit,
} from "../lib/embedding-store.js";
import { makeProgressReporter } from "../lib/progress.js";
import { escapeControlChars, sanitizeError } from "../lib/errors.js";
import {
  formatUntrustedFailedPath,
  formatUntrustedVaultContent,
  indentBlock,
  untrustedVaultContentMeta,
} from "../lib/tool-output.js";
import { log } from "../lib/logger.js";
import { mapConcurrent } from "../lib/concurrency.js";

const MISSING_PROVIDER_HINT =
  "Set OBSIDIAN_EMBEDDING_PROVIDER=ollama (default) and run an Ollama server with `ollama pull nomic-embed-text`. " +
  "For OpenAI, set OBSIDIAN_EMBEDDING_PROVIDER=openai and OBSIDIAN_EMBEDDING_API_KEY.";

const INDEX_VAULT_CONFIRMATION = "send-vault-text-to-embedding-provider";
const EMBED_BATCH_SIZE = 16;

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function untrustedVaultTextResult(text: string, label: string) {
  return {
    content: [{
      type: "text" as const,
      text,
      _meta: untrustedVaultContentMeta(label),
    }],
  };
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

const displaySemanticValue = escapeControlChars;

function displayHeadingPath(path: readonly string[]): string {
  return path.map(displaySemanticValue).join(" / ");
}

function semanticHeadingBlock(headingPath: readonly string[]): string {
  return indentBlock(
    formatUntrustedVaultContent("semantic heading", displayHeadingPath(headingPath)),
    "    ",
  );
}

function semanticPathBlock(label: string, notePath: string, indent = "    "): string {
  return indentBlock(
    formatUntrustedVaultContent(label, displaySemanticValue(notePath)),
    indent,
  );
}

function canReadStoredEmbeddingNote(vaultPath: string, notePath: string): boolean {
  try {
    resolveVaultPath(vaultPath, notePath, "read");
    return true;
  } catch {
    return false;
  }
}

function headingPathsEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((part, index) => part === b[index]);
}

function storedChunksMatchLiveChunks(
  vaultPath: string,
  notePath: string,
  chunks: ReturnType<typeof chunkNote>,
): boolean {
  const stored = getNoteEmbeddings(vaultPath, notePath);
  if (stored.length !== chunks.length) return false;
  const storedByIndex = new Map(stored.map((chunk) => [chunk.chunkIndex, chunk]));
  for (const chunk of chunks) {
    const storedChunk = storedByIndex.get(chunk.index);
    if (!storedChunk) return false;
    if (storedChunk.text !== chunk.text) return false;
    if (!headingPathsEqual(storedChunk.headingPath, chunk.headingPath)) return false;
  }
  return true;
}

async function storedNoteIsCurrent(vaultPath: string, notePath: string): Promise<boolean> {
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

async function pruneStaleStoredNote(vaultPath: string, notePath: string): Promise<boolean> {
  const current = await storedNoteIsCurrent(vaultPath, notePath);
  if (current) return false;
  return dropNoteChunks(vaultPath, notePath);
}

interface FreshSearchOptions {
  limit: number;
  folder?: string;
  excludeNotes?: ReadonlySet<string>;
  filterNote?: (notePath: string) => boolean;
}

async function searchFreshEmbeddings(
  vaultPath: string,
  queryVector: number[],
  options: FreshSearchOptions,
): Promise<{ hits: SearchHit[]; stalePruned: number }> {
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
        "Build or refresh the embedding index used by `search_semantic` and `find_similar_notes`. Splits readable notes into heading-aware chunks, sends those chunks to the configured embedding provider (Ollama by default, OpenAI optional), and persists the index to `<vault>/.obsidian/cache/mcp-pro-embeddings.json`. Requires `confirm: \"send-vault-text-to-embedding-provider\"` so callers explicitly acknowledge that vault text will leave this tool boundary. Incremental: notes whose content hash matches the prior pass are skipped. Use `force: true` to re-embed everything (e.g., after switching models). Emits progress notifications when the client subscribes.",
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
        confirm: z
          .literal(INDEX_VAULT_CONFIRMATION)
          .optional()
          .describe(
            `Required safety latch. Set exactly to "${INDEX_VAULT_CONFIRMATION}" to acknowledge that readable note chunks will be sent to the configured embedding provider.`,
          ),
      },
    },
    async ({ force, folder, confirm }, extra) => {
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
        if (confirm !== INDEX_VAULT_CONFIRMATION) {
          return errorResult(
            `index_vault sends readable note chunks to the configured embedding provider (${displaySemanticValue(provider.id)}/${displaySemanticValue(provider.model)}). ` +
              `Set confirm to "${INDEX_VAULT_CONFIRMATION}" to proceed.`,
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
          const chunks = chunkNote(content);
          if (
            !force &&
            noteIsCurrent(vaultPath, notePath, contentHash) &&
            storedChunksMatchLiveChunks(vaultPath, notePath, chunks)
          ) {
            stats.notesUnchanged++;
            stats.notesScanned++;
            await reportProgress(stats.notesScanned, notes.length, `Unchanged note ${stats.notesScanned}/${notes.length}`);
            continue;
          }
          noteHashByPath.set(notePath, contentHash);
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
          await reportProgress(stats.notesScanned, notes.length, `Chunked note ${stats.notesScanned}/${notes.length}`);
        }

        // Embed pending chunks in batches.
        const noteChunks = new Map<string, ChunkEmbedding[]>();
        const failedNotes = new Set<string>();
        let expectedVectorDimension: number | null = null;
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
            const vectorError = validateEmbeddingVector(vector, expectedVectorDimension);
            if (vectorError !== null) {
              stats.failed.push({ path: item.notePath, error: vectorError });
              failedNotes.add(item.notePath);
              continue;
            }
            expectedVectorDimension ??= vector.length;
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
          try {
            setNoteChunks(vaultPath, notePath, contentHash, chunks, provider.id, provider.model);
          } catch (err) {
            stats.failed.push({ path: notePath, error: (err as Error).message });
            failedNotes.add(notePath);
            continue;
          }
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
          for (const f of stats.failed.slice(0, 5)) {
            lines.push(formatUntrustedFailedPath(
              "index_vault failed note",
              f.path,
              f.error,
              "    ",
            ));
          }
          if (stats.failed.length > 5) lines.push(`    ...and ${stats.failed.length - 5} more`);
        }
        return stats.failed.length > 0
          ? untrustedVaultTextResult(lines.join("\n"), "index_vault failed notes")
          : textResult(lines.join("\n"));
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
        const vectorError = validateEmbeddingVector(vector, snap.dimension);
        if (vectorError !== null) {
          return errorResult(`Provider returned an invalid query vector: ${vectorError}.`);
        }
        const { hits } = await searchFreshEmbeddings(vaultPath, vector, {
          limit,
          ...(folder ? { folder } : {}),
          filterNote: (notePath) => canReadStoredEmbeddingNote(vaultPath, notePath),
        });
        if (hits.length === 0) {
          return textResult(`No matches for "${displaySemanticValue(query)}".`);
        }

        const lines: string[] = [`${hits.length} match(es) for "${displaySemanticValue(query)}":`, ""];
        for (const hit of hits) {
          lines.push(`- score: ${hit.score.toFixed(3)}`);
          lines.push("    Path:");
          lines.push(semanticPathBlock("search_semantic result path", hit.notePath));
          if (hit.headingPath.length > 0) {
            lines.push("    Heading:");
            lines.push(semanticHeadingBlock(hit.headingPath));
          }
          if (includeSnippet) {
            const snippet = hit.text.replace(/\s+/g, " ").trim().slice(0, 200);
            const clipped = `${displaySemanticValue(snippet)}${hit.text.length > 200 ? "..." : ""}`;
            lines.push(indentBlock(
              formatUntrustedVaultContent("semantic snippet", clipped),
              "    ",
            ));
          }
        }
        return untrustedVaultTextResult(lines.join("\n"), "search_semantic vault text");
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
        resolveVaultPath(vaultPath, notePath, "read");
        const ownChunks = getNoteEmbeddings(vaultPath, notePath);
        if (ownChunks.length === 0) {
          return errorResult(
            `No embeddings found for "${displaySemanticValue(notePath)}". Run \`index_vault\` first (or check the path is correct).`,
          );
        }
        if (await pruneStaleStoredNote(vaultPath, notePath)) {
          await saveStore(vaultPath);
          return errorResult(
            `No current embeddings found for "${displaySemanticValue(notePath)}". Run \`index_vault\` to refresh it.`,
          );
        }
        const queryVector = buildSimilarNotesQueryVector(ownChunks);
        const exclude = new Set([notePath]);
        const { hits } = await searchFreshEmbeddings(vaultPath, queryVector, {
          limit,
          excludeNotes: exclude,
          filterNote: (hitPath) => canReadStoredEmbeddingNote(vaultPath, hitPath),
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
          lines.push(`- score: ${r.score.toFixed(3)}`);
          lines.push("    Path:");
          lines.push(semanticPathBlock("find_similar_notes result path", r.notePath));
          if (r.headingPath.length > 0) {
            lines.push("    Heading:");
            lines.push(semanticHeadingBlock(r.headingPath));
          }
        }
        return untrustedVaultTextResult(lines.join("\n"), "find_similar_notes paths and headings");
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
