import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  listNotes,
  vaultRewriteLockKey,
  withFileLock,
} from "../../lib/vault.js";
import { readAllCached } from "../../lib/index-cache.js";
import { chunkNote } from "../../lib/chunker.js";
import { getActiveProvider } from "../../lib/embedding-providers.js";
import {
  loadStore,
  saveStore,
  getNoteEmbeddings,
  hashText,
  noteIsCurrent,
  setNoteChunks,
  pruneMissingNotes,
  invalidateIfIncompatible,
  validateEmbeddingVector,
  type ChunkEmbedding,
} from "../../lib/embedding-store.js";
import { makeProgressReporter } from "../../lib/progress.js";
import { sanitizeError } from "../../lib/errors.js";
import { formatUntrustedFailedPath } from "../../lib/tool-output.js";
import { log } from "../../lib/logger.js";
import {
  MISSING_PROVIDER_HINT,
  INDEX_VAULT_CONFIRMATION,
  EMBED_BATCH_SIZE,
  textResult,
  untrustedVaultTextResult,
  errorResult,
  displaySemanticValue,
} from "./shared.js";

interface IndexProgress {
  notesScanned: number;
  notesEmbedded: number;
  chunksEmbedded: number;
  notesUnchanged: number;
  notesPruned: number;
  failed: Array<{ path: string; error: string }>;
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

export function registerIndexVaultTool(server: McpServer, vaultPath: string): void {
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
                hash: "",
                vector,
              });
              noteChunks.set(item.notePath, list);
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
            stats.chunksEmbedded += chunks.length;
            if (chunks.length > 0) stats.notesEmbedded++;
          }

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
}
