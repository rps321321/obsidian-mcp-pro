import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  listNotes,
  readNote,
  updateNote,
  withFileLock,
  vaultRewriteLockKey,
} from "../../lib/vault.js";
import { isValidTagName, rewriteAllTags } from "../../lib/tag-rewriter.js";
import { sanitizeError, escapeControlChars } from "../../lib/errors.js";
import { mapConcurrent } from "../../lib/concurrency.js";
import { elicitTextConfirmation } from "../../lib/confirmation.js";
import { makeProgressReporter } from "../../lib/progress.js";
import { log } from "../../lib/logger.js";
import { defineTool, richText, text, error } from "../../lib/tool-seam.js";

import { displayTagValue } from "./shared.js";

export function registerRenameTag(server: McpServer, vaultPath: string): void {
  defineTool(
    server,
    vaultPath,
    {
      name: "rename_tag",
      title: "Rename Tag",
      description:
        "Rename a tag everywhere it appears across the vault, in both inline #tags and frontmatter `tags:` fields. Non-dry-run rewrites require `confirmTag` to match the new tag name. With `hierarchical: true` (default), nested tags also rebase: renaming `project` to `client` also renames `project/alpha` → `client/alpha`. With `dryRun: true`, returns the planned counts without writing. Strip the leading `#` from oldName/newName — they're tag names, not tag tokens.",
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
          .refine(
            isValidTagName,
            "Tag name contains characters Obsidian's tag parser will not recognize"
          )
          .describe("Existing tag name (without leading #), e.g. 'project'."),
        newName: z
          .string()
          .min(1)
          .max(200)
          .refine(
            isValidTagName,
            "Tag name contains characters Obsidian's tag parser will not recognize"
          )
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
        confirmTag: z
          .string()
          .max(200)
          .optional()
          .describe(
            "Required when dryRun is false: re-type the new tag name to confirm vault-wide tag rewriting."
          ),
      },
    },
    async (
      { oldName, newName, hierarchical, dryRun, confirmTag },
      { extra }
    ) => {
      if (oldName === newName) return error("oldName and newName must differ");
      if (!dryRun) {
        if (confirmTag?.trim() !== newName) {
          return error(
            `Vault-wide tag rewriting to #${displayTagValue(newName)} requires confirmTag="${displayTagValue(newName)}". ` +
              "Set dryRun=true to preview without writing."
          );
        }
        const confirmation = await elicitTextConfirmation(server, {
          tool: "rename_tag",
          message:
            `Rename #${displayTagValue(oldName)} to #${displayTagValue(newName)} across the vault? ` +
            "This can rewrite many notes. Type the new tag name to confirm.",
          fieldName: "confirmTag",
          fieldDescription:
            "Re-type the new tag name to confirm vault-wide tag rewriting.",
          expectedValue: newName,
        });
        if (confirmation.status === "cancelled") {
          return text(
            `Rename of #${displayTagValue(oldName)} to #${displayTagValue(newName)} cancelled.`
          );
        }
        if (confirmation.status === "mismatch") {
          return error(
            `Confirmation tag did not match #${displayTagValue(newName)}; rename aborted.`
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
            await reportProgress(
              processed,
              notes.length,
              `Scanned ${processed}/${notes.length} notes`
            );
            return undefined;
          },
          (err, notePath) => {
            log.warn("rename_tag: note read failed", {
              note: notePath,
              err: err as Error,
            });
          }
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

      return richText("rename_tag failed notes", (b) => {
        b.trusted(
          `${verb} #${displayTagValue(oldName)} → #${displayTagValue(newName)}${hierarchical ? " (and nested sub-tags)" : ""}`
        );
        b.trusted(`  Files affected: ${updatedFiles}`);
        b.trusted(`  Inline #tag occurrences: ${totalInline}`);
        b.trusted(`  Frontmatter occurrences: ${totalFrontmatter}`);
        if (failed.length > 0) {
          b.trusted(`  Skipped due to errors: ${failed.length}`);
          for (const f of failed.slice(0, 5)) {
            b.untrusted(
              "rename_tag failed note",
              `- ${escapeControlChars(f.path)}: ${sanitizeError(f.error)}`,
              "    "
            );
          }
          if (failed.length > 5)
            b.trusted(`    ...and ${failed.length - 5} more`);
        }
      });
    }
  );
}
