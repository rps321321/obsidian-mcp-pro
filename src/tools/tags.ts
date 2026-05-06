import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listNotes, readNote, updateNote, withFileLock, vaultRewriteLockKey } from "../lib/vault.js";
import { extractTags } from "../lib/markdown.js";
import { rewriteAllTags } from "../lib/tag-rewriter.js";
import { readAllCached } from "../lib/index-cache.js";
import { makeProgressReporter } from "../lib/progress.js";
import { sanitizeError } from "../lib/errors.js";
import { mapConcurrent } from "../lib/concurrency.js";
import { log } from "../lib/logger.js";

import type { TagInfo } from "../types.js";

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

export function registerTagTools(server: McpServer, vaultPath: string): void {
  server.registerTool(
    "get_tags",
    {
      title: "Get All Tags",
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
        const tagMap = new Map<string, { tag: string; files: Set<string> }>();

        // Cached batch read: re-uses content for files whose mtime hasn't
        // moved since the last vault-wide scan. Per-file failures are
        // logged and dropped so one unreadable note can't abort the index.
        const { contents } = await readAllCached(vaultPath, notes, (note, err) => {
          log.warn("get_tags: note read failed", { note, err });
        });

        for (const notePath of notes) {
          const content = contents.get(notePath);
          if (content === undefined) continue;
          const tags = extractTags(content);
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

        if (sortBy === "name") {
          tagInfos.sort((a, b) => a.tag.localeCompare(b.tag));
        } else {
          tagInfos.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
        }

        const lines: string[] = [];
        lines.push(`Total unique tags: ${tagInfos.length}`);
        lines.push("");

        for (const info of tagInfos) {
          lines.push(`#${info.tag} (${info.count} ${info.count === 1 ? "note" : "notes"})`);
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (err) {
        log.error("get_tags failed", { tool: "get_tags", err: err as Error });
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

        const { contents } = await readAllCached(vaultPath, notes, (note, err) => {
          log.warn("search_by_tag: note read failed", { note, err });
        });

        const matchingNotes: { path: string; preview?: string }[] = [];
        for (const notePath of notes) {
          if (matchingNotes.length >= maxResults) break;
          const content = contents.get(notePath);
          if (content === undefined) continue;
          const tags = extractTags(content);
          const hasMatch = tags.some((t) => {
            const normalized = t.toLowerCase();
            return normalized === searchTag || normalized.startsWith(`${searchTag}/`);
          });
          if (hasMatch) {
            const entry: { path: string; preview?: string } = { path: notePath };
            if (includeContent) {
              entry.preview = content.slice(0, 200).trim();
            }
            matchingNotes.push(entry);
          }
        }

        if (matchingNotes.length === 0) {
          return {
            content: [
              { type: "text" as const, text: `No notes found with tag #${searchTag}` },
            ],
          };
        }

        const lines: string[] = [];
        lines.push(`Found ${matchingNotes.length} ${matchingNotes.length === 1 ? "note" : "notes"} with tag #${searchTag}`);
        lines.push("");

        for (const note of matchingNotes) {
          lines.push(`- ${note.path}`);
          if (note.preview) {
            lines.push(`  ${note.preview}`);
            lines.push("");
          }
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
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
          .regex(/^[^#\s/][^\s]*$/, "Tag name must not start with # or whitespace; pass the bare name")
          .describe("Existing tag name (without leading #), e.g. 'project'."),
        newName: z
          .string()
          .min(1)
          .regex(/^[^#\s/][^\s]*$/, "Tag name must not start with # or whitespace; pass the bare name")
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
          `${verb} #${oldName} → #${newName}${hierarchical ? " (and nested sub-tags)" : ""}`,
          `  Files affected: ${updatedFiles}`,
          `  Inline #tag occurrences: ${totalInline}`,
          `  Frontmatter occurrences: ${totalFrontmatter}`,
        ];
        if (failed.length > 0) {
          lines.push(`  Skipped due to errors: ${failed.length}`);
          for (const f of failed.slice(0, 5)) lines.push(`    - ${f.path}: ${sanitizeError(f.error)}`);
          if (failed.length > 5) lines.push(`    ...and ${failed.length - 5} more`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        log.error("rename_tag failed", { tool: "rename_tag", err: err as Error });
        return errorResult(`Error renaming tag: ${sanitizeError(err)}`);
      }
    },
  );
}
