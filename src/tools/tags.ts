import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listNotes, readNote, updateNote, withFileLock, vaultRewriteLockKey } from "../lib/vault.js";
import { extractTags } from "../lib/markdown.js";
import { isValidTagName, rewriteAllTags } from "../lib/tag-rewriter.js";
import { readAllCached } from "../lib/index-cache.js";
import { makeProgressReporter } from "../lib/progress.js";
import { escapeControlChars, sanitizeError } from "../lib/errors.js";
import {
  formatUntrustedFailedPath,
  formatUntrustedVaultContent,
  indentBlock,
  untrustedVaultContentMeta,
} from "../lib/tool-output.js";
import { mapConcurrent } from "../lib/concurrency.js";
import { elicitTextConfirmation } from "../lib/confirmation.js";
import { log } from "../lib/logger.js";

import type { TagInfo } from "../types.js";

const TAG_INDEX_CACHE_LIMIT = 8;

interface TagIndexEntry {
  path: string;
  tags: string[];
}

interface TagIndexCacheEntry {
  fingerprint: string;
  noteOrder: Map<string, number>;
  tagInfos: TagInfo[];
  tagToFiles: Map<string, string[]>;
}

const tagIndexCache = new Map<string, TagIndexCacheEntry>();

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

function displayTagValue(value: string): string {
  return escapeControlChars(value);
}

function untrustedTagBlock(label: string, text: string, indent = ""): string {
  return indentBlock(formatUntrustedVaultContent(label, text), indent);
}

function tagIndexFingerprint(
  notes: readonly string[],
  contents: ReadonlyMap<string, string>,
  mtimes: ReadonlyMap<string, number>,
): string {
  return notes
    .map((notePath) => {
      const mtime = mtimes.get(notePath);
      return `${notePath}\0${contents.has(notePath) && mtime !== undefined ? mtime : "missing"}`;
    })
    .join("\0");
}

function getCachedTagIndex(
  vaultPath: string,
  notes: readonly string[],
  contents: ReadonlyMap<string, string>,
  mtimes: ReadonlyMap<string, number>,
): TagIndexCacheEntry {
  const fingerprint = tagIndexFingerprint(notes, contents, mtimes);
  const cached = tagIndexCache.get(vaultPath);
  if (cached?.fingerprint === fingerprint) {
    tagIndexCache.delete(vaultPath);
    tagIndexCache.set(vaultPath, cached);
    return cached;
  }

  const entries: TagIndexEntry[] = [];
  const noteOrder = new Map<string, number>();
  const tagMap = new Map<string, { tag: string; files: Set<string> }>();
  for (const notePath of notes) {
    const content = contents.get(notePath);
    if (content === undefined) continue;
    const tags = extractTags(content);
    noteOrder.set(notePath, entries.length);
    entries.push({ path: notePath, tags });
    for (const tag of tags) {
      const normalizedTag = tag.toLowerCase();
      const existing = tagMap.get(normalizedTag);
      if (existing) {
        existing.files.add(notePath);
      } else {
        tagMap.set(normalizedTag, {
          tag: normalizedTag,
          files: new Set([notePath]),
        });
      }
    }
  }

  const tagInfos: TagInfo[] = Array.from(tagMap.values()).map(({ tag, files }) => ({
    tag,
    count: files.size,
    files: [...files],
  }));
  const tagToFiles = new Map<string, string[]>();
  for (const info of tagInfos) tagToFiles.set(info.tag, info.files);

  const fresh = { fingerprint, noteOrder, tagInfos, tagToFiles };
  tagIndexCache.set(vaultPath, fresh);
  while (tagIndexCache.size > TAG_INDEX_CACHE_LIMIT) {
    const oldestKey = tagIndexCache.keys().next().value;
    if (oldestKey === undefined) break;
    tagIndexCache.delete(oldestKey);
  }

  return fresh;
}

export function registerTagTools(server: McpServer, vaultPath: string): void {
  server.registerTool(
    "list_tags",
    {
      title: "List All Tags",
      description:
        "Enumerate every unique tag used across the vault along with the number of notes each tag appears in. Detects tags from both inline #hashtags and YAML frontmatter, normalizes them case-insensitively, and returns a sorted list plus the total unique tag count. Use to build a tag cloud, pick categories, audit taxonomy, or discover available tags before calling search_by_tag.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        sortBy: z
          .enum(["count", "name"])
          .optional()
          .default("count")
          .describe("Sort order: 'count' = by usage count descending (most-used first, default), 'name' = alphabetical by tag name"),
      },
    },
    async ({ sortBy }) => {
      try {
        const notes = await listNotes(vaultPath);

        // Cached batch read: re-uses content for files whose mtime hasn't
        // moved since the last vault-wide scan. Per-file failures are
        // logged and dropped so one unreadable note can't abort the index.
        const { contents, mtimes } = await readAllCached(vaultPath, notes, (note, err) => {
          log.warn("list_tags: note read failed", { note, err });
        });

        const tagIndex = getCachedTagIndex(vaultPath, notes, contents, mtimes);
        const tagInfos: TagInfo[] = tagIndex.tagInfos.map((info) => ({
          tag: info.tag,
          count: info.count,
          files: [...info.files],
        }));

        if (sortBy === "name") {
          tagInfos.sort((a, b) => a.tag.localeCompare(b.tag));
        } else {
          tagInfos.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
        }

        const lines: string[] = [];
        lines.push(`Total unique tags: ${tagInfos.length}`);
        lines.push("");

        const tagLines: string[] = [];
        for (const info of tagInfos) {
          tagLines.push(`#${displayTagValue(info.tag)} (${info.count} ${info.count === 1 ? "note" : "notes"})`);
        }
        if (tagLines.length > 0) {
          lines.push(formatUntrustedVaultContent("list_tags values", tagLines.join("\n")));
        }

        return {
          content: [{
            type: "text" as const,
            text: lines.join("\n"),
            ...(tagLines.length > 0 ? { _meta: untrustedVaultContentMeta("list_tags values") } : {}),
          }],
        };
      } catch (err) {
        log.error("list_tags failed", { tool: "list_tags", err: err as Error });
        return errorResult(`Error listing tags: ${sanitizeError(err)}`);
      }
    },
  );

  server.registerTool(
    "search_by_tag",
    {
      title: "Search by Tag",
      description:
        "Find all notes tagged with a specific tag, including nested sub-tags (searching 'project' matches both #project and #project/alpha). Detects tags from both inline #hashtags and YAML frontmatter. Returns matching note paths with optional content previews. Use to collect notes belonging to a topic, area, or workflow stage.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        tag: z
          .string()
          .min(1)
          .max(200)
          .describe("Tag to search for, with or without # prefix (e.g., 'project' or '#project'). Matches nested tags like 'project/alpha'."),
        includeContent: z
          .boolean()
          .optional()
          .default(false)
          .describe("If true, include the first 200 characters of each matching note as a preview (default: false)"),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .default(100)
          .describe("Maximum number of matching notes to return (1-1000, default: 100)"),
      },
    },
    async ({ tag, includeContent, maxResults }) => {
      try {
        const searchTag = tag.replace(/^#/, "").toLowerCase();
        const notes = await listNotes(vaultPath);

        const { contents, mtimes } = await readAllCached(vaultPath, notes, (note, err) => {
          log.warn("search_by_tag: note read failed", { note, err });
        });

        const tagIndex = getCachedTagIndex(vaultPath, notes, contents, mtimes);
        const matchingPathSet = new Set<string>();
        for (const [normalizedTag, files] of tagIndex.tagToFiles) {
          if (normalizedTag === searchTag || normalizedTag.startsWith(`${searchTag}/`)) {
            for (const file of files) matchingPathSet.add(file);
          }
        }
        const matchingPaths = [...matchingPathSet]
          .sort((a, b) => (tagIndex.noteOrder.get(a) ?? 0) - (tagIndex.noteOrder.get(b) ?? 0))
          .slice(0, maxResults);
        const matchingNotes: { path: string; preview?: string }[] = matchingPaths.map((notePath) => {
          const entry: { path: string; preview?: string } = { path: notePath };
          if (includeContent) {
            const content = contents.get(notePath)!;
            const stripped = content.replace(/^---\n[\s\S]*?\n---\n/, "");
            entry.preview = stripped.slice(0, 200).trim();
          }
          return entry;
        });

        if (matchingNotes.length === 0) {
          return {
            content: [
              { type: "text" as const, text: `No notes found with tag #${displayTagValue(searchTag)}` },
            ],
          };
        }

        const lines: string[] = [];
        lines.push(
          `Found ${matchingNotes.length} ${matchingNotes.length === 1 ? "note" : "notes"} with tag #${displayTagValue(searchTag)}`,
        );
        lines.push("");

        for (const note of matchingNotes) {
          lines.push("Path:");
          lines.push(untrustedTagBlock(
            "search_by_tag result path",
            displayTagValue(note.path),
            "  ",
          ));
          if (note.preview) {
            lines.push("  Preview:");
            lines.push(indentBlock(
              formatUntrustedVaultContent("search_by_tag preview", displayTagValue(note.preview)),
              "    ",
            ));
            lines.push("");
          }
        }

        return {
          content: [{
            type: "text" as const,
            text: lines.join("\n"),
            _meta: untrustedVaultContentMeta(
              includeContent ? "search_by_tag paths and previews" : "search_by_tag paths",
            ),
          }],
        };
      } catch (err) {
        log.error("search_by_tag failed", { tool: "search_by_tag", err: err as Error });
        return errorResult(`Error searching by tag: ${sanitizeError(err)}`);
      }
    },
  );

  server.registerTool(
    "rename_tag",
    {
      title: "Rename Tag",
      description:
        "Rename a tag everywhere it appears across the vault, in both inline #tags and frontmatter `tags:` fields. With `hierarchical: true` (default), nested tags also rebase: renaming `project` to `client` also renames `project/alpha` → `client/alpha`. With `dryRun: true`, returns the planned counts without writing. Strip the leading `#` from oldName/newName — they're tag names, not tag tokens.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        oldName: z
          .string()
          .min(1)
          .max(200)
          .refine(isValidTagName, "Tag name contains characters Obsidian's tag parser will not recognize")
          .describe("Existing tag name (without leading #), e.g. 'project'."),
        newName: z
          .string()
          .min(1)
          .max(200)
          .refine(isValidTagName, "Tag name contains characters Obsidian's tag parser will not recognize")
          .describe("New tag name (without leading #), e.g. 'client'."),
        hierarchical: z
          .boolean()
          .optional()
          .default(true)
          .describe("Also rename nested sub-tags (default: true)."),
        dryRun: z
          .boolean()
          .optional()
          .default(false)
          .describe("If true, count matches without modifying any notes."),
      },
    },
    async ({ oldName, newName, hierarchical, dryRun }, extra) => {
      try {
        if (oldName === newName) return errorResult("oldName and newName must differ");
        if (!dryRun) {
          const confirmation = await elicitTextConfirmation(server, {
            tool: "rename_tag",
            message:
              `Rename #${displayTagValue(oldName)} to #${displayTagValue(newName)} across the vault? ` +
              "This can rewrite many notes. Type the new tag name to confirm.",
            fieldName: "confirmTag",
            fieldDescription: "Re-type the new tag name to confirm vault-wide tag rewriting.",
            expectedValue: newName,
          });
          if (confirmation.status === "cancelled") {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Rename of #${displayTagValue(oldName)} to #${displayTagValue(newName)} cancelled.`,
                },
              ],
            };
          }
          if (confirmation.status === "mismatch") {
            return errorResult(
              `Confirmation tag did not match #${displayTagValue(newName)}; rename aborted.`,
            );
          }
        }
        const notes = await listNotes(vaultPath);
        const opts = { oldName, newName, hierarchical };
        const reportProgress = makeProgressReporter(extra);

        let updatedFiles = 0;
        let totalInline = 0;
        let totalFrontmatter = 0;
        let processed = 0;
        const failed: Array<{ path: string; error: string }> = [];

        const runScan = async (): Promise<void> => {
          await mapConcurrent(
            notes,
            8,
            async (notePath) => {
              try {
                if (dryRun) {
                  // No write path — a single read outside any lock is fine
                  // because we only report counts.
                  const original = await readNote(vaultPath, notePath);
                  const result = rewriteAllTags(original, opts);
                  if (result.inlineCount + result.frontmatterCount > 0) {
                    updatedFiles++;
                    totalInline += result.inlineCount;
                    totalFrontmatter += result.frontmatterCount;
                  }
                } else {
                  // Apply the rewrite inside the per-file lock so a concurrent
                  // write between read and write can't be silently overwritten.
                  // `updateNote` re-reads under the lock and feeds `existing`
                  // into our transform, then atomically renames the result.
                  let inline = 0;
                  let frontmatter = 0;
                  let changed = false;
                  await updateNote(vaultPath, notePath, (existing) => {
                    const result = rewriteAllTags(existing, opts);
                    inline = result.inlineCount;
                    frontmatter = result.frontmatterCount;
                    if (inline + frontmatter === 0) return existing;
                    changed = result.content !== existing;
                    return result.content;
                  });
                  if (inline + frontmatter > 0 && changed) {
                    updatedFiles++;
                    totalInline += inline;
                    totalFrontmatter += frontmatter;
                  }
                }
              } catch (err) {
                failed.push({ path: notePath, error: (err as Error).message });
              }
              processed++;
              await reportProgress(processed, notes.length, `Scanned ${processed}/${notes.length} notes`);
              return undefined;
            },
            (err, notePath) => {
              log.warn("rename_tag: note read failed", { note: notePath, err: err as Error });
            },
          );
        };

        // Serialize the bulk-write phase under the same vault-level lock
        // that move_note / delete_note (with removeReferences) take. Without
        // this, an in-flight rename_tag could shift bytes mid-plan in a
        // concurrent move_note, surfacing as "content changed during move"
        // failures with stale links left behind. Dry-run skips the lock —
        // it doesn't write — and so can't conflict.
        if (!dryRun) {
          await withFileLock(vaultRewriteLockKey(vaultPath), runScan);
        } else {
          await runScan();
        }

        const verb = dryRun ? "Would rewrite" : "Rewrote";
        const lines = [
          `${verb} #${displayTagValue(oldName)} → #${displayTagValue(newName)}${hierarchical ? " (and nested sub-tags)" : ""}`,
          `  Files affected: ${updatedFiles}`,
          `  Inline #tag occurrences: ${totalInline}`,
          `  Frontmatter occurrences: ${totalFrontmatter}`,
        ];
        if (failed.length > 0) {
          lines.push(`  Skipped due to errors: ${failed.length}`);
          for (const f of failed.slice(0, 5)) {
            lines.push(formatUntrustedFailedPath(
              `rename_tag failed note: ${f.path}`,
              f.path,
              f.error,
              "    ",
            ));
          }
          if (failed.length > 5) lines.push(`    ...and ${failed.length - 5} more`);
        }
        return {
          content: [{
            type: "text" as const,
            text: lines.join("\n"),
            ...(failed.length > 0 ? { _meta: untrustedVaultContentMeta("rename_tag failed notes") } : {}),
          }],
        };
      } catch (err) {
        log.error("rename_tag failed", { tool: "rename_tag", err: err as Error });
        return errorResult(`Error renaming tag: ${sanitizeError(err)}`);
      }
    },
  );
}
