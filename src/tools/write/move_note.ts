import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { moveNote } from "../../lib/vault.js";
import { sanitizeError } from "../../lib/errors.js";
import {
  formatUntrustedFailedPath,
  untrustedVaultContentMeta,
} from "../../lib/tool-output.js";
import { elicitTextConfirmation } from "../../lib/confirmation.js";
import { log } from "../../lib/logger.js";
import { textResult, errorResult, displayWriteValue, ensureMdExtension } from "./shared.js";

export function registerMoveNote(server: McpServer, vaultPath: string): void {
  server.registerTool(
    "move_note",
    {
      title: "Move/Rename Note",
      description:
        "Move or rename a note within the vault, preserving its full content. Parent folders at the destination are created as needed. By default, wikilinks and file references are updated, matching Obsidian's \"Automatically update internal links\" behavior; this rewrite requires `confirmPath` to match the destination path after .md normalization. Pass `updateLinks: false` to skip the rewrite scan (faster on large vaults; pair with `find_broken_links` if you need to audit afterward). A .md extension is added automatically if omitted from either path.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        oldPath: z
          .string()
          .min(1)
          .max(500)
          .describe("Current relative path of the note from vault root (e.g., 'inbox/idea.md')"),
        newPath: z
          .string()
          .min(1)
          .max(500)
          .describe("Destination relative path from vault root (e.g., 'projects/idea.md'). Creates intermediate folders as needed."),
        updateLinks: z
          .boolean()
          .optional()
          .default(true)
          .describe("If true (default), update every wikilink, markdown link, and canvas node reference across the vault to point at the new path. Set false to skip the rewrite pass."),
        confirmPath: z
          .string()
          .max(500)
          .optional()
          .describe("Required when updateLinks is true: re-type the destination path after .md normalization to confirm vault-wide reference rewriting."),
      },
    },
    async ({ oldPath, newPath, updateLinks, confirmPath }) => {
      try {
        const resolvedOld = ensureMdExtension(oldPath);
        const resolvedNew = ensureMdExtension(newPath);
        if (updateLinks !== false) {
          if (confirmPath?.trim() !== resolvedNew) {
            return errorResult(
              `Reference rewriting for "${displayWriteValue(resolvedOld)}" requires confirmPath="${displayWriteValue(resolvedNew)}". ` +
              "Set updateLinks=false to move without rewriting references.",
            );
          }
          const confirmation = await elicitTextConfirmation(server, {
            tool: "move_note",
            message:
              `Move "${displayWriteValue(resolvedOld)}" to "${displayWriteValue(resolvedNew)}" and update references across the vault? ` +
              "This can rewrite many notes. Type the destination path to confirm.",
            fieldName: "confirmPath",
            fieldDescription: "Re-type the destination path to confirm vault-wide reference rewriting.",
            expectedValue: resolvedNew,
          });
          if (confirmation.status === "cancelled") {
            return textResult(`Move of "${displayWriteValue(resolvedOld)}" cancelled.`);
          }
          if (confirmation.status === "mismatch") {
            return errorResult(
              `Confirmation path did not match "${displayWriteValue(resolvedNew)}"; move aborted.`,
            );
          }
        }
        const result = await moveNote(vaultPath, resolvedOld, resolvedNew, { updateLinks });
        const lines: string[] = [
          `Moved note from '${displayWriteValue(resolvedOld)}' to '${displayWriteValue(resolvedNew)}'.`,
        ];
        let trustMeta: Record<string, unknown> | undefined;
        if (updateLinks !== false) {
          const updated = result.updatedReferrers.length;
          lines.push(
            updated === 0
              ? "No other notes referenced this file — nothing to rewrite."
              : `Updated references in ${updated} file(s).`,
          );
          if (result.failedReferrers.length > 0) {
            // Cap at 5 so a vault with hundreds of failures (e.g. a perms
            // glitch under a big folder) doesn't blow up the response.
            // Filenames are attacker-controllable, so escape control chars
            // in `path` and route `error` through `sanitizeError` to prevent
            // a `\n`-bearing name from injecting text into LLM context.
            const MAX_DISPLAY = 5;
            trustMeta = untrustedVaultContentMeta("move_note failed referrers");
            lines.push(`Warning: ${result.failedReferrers.length} file(s) could not be updated:`);
            for (const f of result.failedReferrers.slice(0, MAX_DISPLAY)) {
              lines.push(formatUntrustedFailedPath(
                "move_note failed referrer",
                f.path,
                f.error,
              ));
            }
            const remaining = result.failedReferrers.length - MAX_DISPLAY;
            if (remaining > 0) {
              lines.push(`  ...and ${remaining} more`);
            }
          }
        }
        return textResult(lines.join("\n"), trustMeta);
      } catch (err) {
        log.error("move_note failed", { tool: "move_note", err: err as Error });
        return errorResult(`Error moving note: ${sanitizeError(err)}`);
      }
    },
  );
}
