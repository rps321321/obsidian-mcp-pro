import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { deleteNote } from "../../lib/vault.js";
import { sanitizeError } from "../../lib/errors.js";
import { elicitTextConfirmation } from "../../lib/confirmation.js";
import { defineTool, text, error, richText } from "../../lib/tool-seam.js";
import { escapeControlChars, ensureMdExtension } from "./shared.js";

export function registerDeleteNote(server: McpServer, vaultPath: string): void {
  defineTool(
    server,
    vaultPath,
    {
      name: "delete_note",
      title: "Delete Note",
      description:
        "Delete a note. By default the file is moved to the vault's .trash folder (recoverable inside Obsidian); pass permanent=true to unlink it from disk immediately. When permanent=true, you can additionally pass removeReferences=true to strip wikilinks and markdown links to the deleted file across the vault (embeds are removed entirely; plain links fall back to their visible text). References are never rewritten when the file moves to .trash, since trashed files are recoverable.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        path: z
          .string()
          .min(1)
          .max(500)
          .describe(
            "Relative path from vault root to the note to delete (e.g., 'archive/old.md'). Extension optional."
          ),
        permanent: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "If true, delete the file permanently from disk; if false (default), move it to the vault's .trash folder so it can be recovered."
          ),
        confirm: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Safety latch: must be set to true when permanent=true to confirm the caller intends irreversible deletion. Ignored when permanent=false (trash deletes are recoverable). If permanent=true and confirm is not true, the tool returns an error without deleting."
          ),
        removeReferences: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "If true (and permanent=true), strip wikilinks and markdown links pointing at the deleted file across the vault. Embeds are removed entirely; plain links fall back to their visible text (alias if present, else the deleted file's basename). Ignored when permanent=false. Default false — opt in explicitly because the rewrite is irreversible."
          ),
      },
    },
    async ({ path: notePath, permanent, confirm, removeReferences }) => {
      const resolvedPath = ensureMdExtension(notePath);

      // Hard gate: permanent deletes require the caller to set confirm=true.
      // This protects against accidental permanent deletion in clients that
      // don't support elicitation. Trash deletes (permanent=false) are
      // recoverable, so no confirmation is needed for those.
      if (permanent && !confirm) {
        return error(
          `Permanent deletion of "${escapeControlChars(resolvedPath)}" requires confirm=true. ` +
            "This is a destructive, irreversible operation. Set confirm to true to proceed, " +
            "or omit permanent (or set it to false) to move the note to the vault's .trash folder instead."
        );
      }

      // Elicit a typed confirmation before permanent deletion. The shared
      // confirmation seam owns capability detection and best-effort fallback:
      // clients without elicitation support (or clients whose elicitation
      // request fails) return "skipped" and fall through to the delete. The
      // confirm=true hard gate above remains the mandatory safety latch.
      if (permanent) {
        const confirmation = await elicitTextConfirmation(server, {
          tool: "delete_note",
          message:
            `Permanently delete "${escapeControlChars(resolvedPath)}" from the vault?` +
            (removeReferences
              ? " References across the vault will also be stripped."
              : "") +
            ` This cannot be undone. Type the note's path to confirm.`,
          fieldName: "confirmPath",
          fieldDescription: "Re-type the path to confirm permanent deletion.",
          expectedValue: resolvedPath,
        });

        if (confirmation.status === "cancelled") {
          return text(
            `Deletion of "${escapeControlChars(resolvedPath)}" cancelled.`
          );
        }
        if (confirmation.status === "mismatch") {
          return error(
            `Confirmation path did not match "${escapeControlChars(resolvedPath)}"; deletion aborted.`
          );
        }
      }

      const result = await deleteNote(vaultPath, resolvedPath, {
        permanent,
        removeReferences,
      });
      const method = permanent ? "permanently deleted" : "moved to trash";

      return richText("delete_note failed referrers", (b) => {
        b.trusted(`Note '${escapeControlChars(resolvedPath)}' ${method}.`);
        if (removeReferences && permanent) {
          const updated = result.updatedReferrers.length;
          b.trusted(
            updated === 0
              ? "No other notes referenced this file — nothing to strip."
              : `Stripped references in ${updated} file(s).`
          );
          if (result.failedReferrers.length > 0) {
            const MAX_DISPLAY = 5;
            b.trusted(
              `Warning: ${result.failedReferrers.length} file(s) could not be updated:`
            );
            for (const f of result.failedReferrers.slice(0, MAX_DISPLAY)) {
              b.untrusted(
                "delete_note failed referrer",
                `- ${escapeControlChars(f.path)}: ${sanitizeError(f.error)}`,
                "  "
              );
            }
            const remaining = result.failedReferrers.length - MAX_DISPLAY;
            if (remaining > 0) {
              b.trusted("  ...and " + remaining + " more");
            }
          }
        }
      });
    }
  );
}
